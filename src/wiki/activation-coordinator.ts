import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const generationSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/u);
const pointerSchema = z.object({
  schema_version: z.literal(1),
  generation: generationSchema,
  attestation_sha256: sha256Schema
}).strict();
const casSchema = z.object({
  schema_version: z.literal(1),
  generation: generationSchema,
  attestation_sha256: sha256Schema,
  operation_id: z.string().uuid()
}).strict();
const journalSchema = z.object({
  schema_version: z.literal(1),
  operation_id: z.string().uuid(),
  expected_generation: generationSchema.nullable(),
  next_generation: generationSchema,
  attestation_sha256: sha256Schema,
  pointer_sha256: sha256Schema,
  state: z.enum(["prepared", "attested", "pointer_promoted", "verified", "cas_committed"]),
  updated_at: z.string().datetime({ offset: true })
}).strict();
const lockSchema = z.object({
  schema_version: z.literal(1),
  pid: z.number().int().positive().safe(),
  token: z.string().uuid()
}).strict();

type Pointer = z.infer<typeof pointerSchema>;
type CasRecord = z.infer<typeof casSchema>;
type Journal = z.infer<typeof journalSchema>;
export type ActivationState = Journal["state"];
export type RecoveryVerdict =
  | "no_journal"
  | "complete"
  | "prepared_needs_attestation"
  | "attested_needs_pointer_promotion"
  | "pointer_promoted_needs_verification"
  | "verified_needs_cas_commit"
  | "inconsistent_fail_closed";

export interface ActivationPaths {
  readonly root: string;
  readonly pointerPath: string;
  readonly casPath: string;
  readonly journalPath: string;
  readonly lockPath: string;
}

export interface ActivationCandidate {
  readonly expectedGeneration: string | null;
  readonly nextGeneration: string;
  readonly attestationSha256: string;
}

export interface RecoveryReport {
  readonly verdict: RecoveryVerdict;
  readonly journal: Journal | null;
  readonly pointer: Pointer | null;
  readonly cas: CasRecord | null;
  readonly reason?: string;
}

export type BoundaryHook = (state: ActivationState) => void | Promise<void>;

export class ActivationConflictError extends Error {}
export class ActivationRecoveryError extends Error {}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function now(): string {
  return new Date().toISOString();
}

function paths(root: string): ActivationPaths {
  const resolved = resolve(root);
  return {
    root: resolved,
    pointerPath: join(resolved, "current.json"),
    casPath: join(resolved, "cas.json"),
    journalPath: join(resolved, "activation.journal.json"),
    lockPath: join(resolved, "activation.lock")
  };
}

async function readJson<T>(path: string, parser: z.ZodType<T>): Promise<T | null> {
  try {
    return parser.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ActivationRecoveryError(`invalid durable JSON at ${path}`);
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}

export async function acquireActivationLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  const candidate = `${path}.${token}.candidate`;
  const ownerPath = join(candidate, "owner.json");
  const publish = async (): Promise<boolean> => {
    await mkdir(candidate, { mode: 0o700 });
    await atomicWrite(ownerPath, JSON.stringify({ schema_version: 1, pid: process.pid, token }) + "\n");
    try {
      await rename(candidate, path);
      await fsyncDirectory(dirname(path));
      return true;
    } catch (error) {
      await rm(candidate, { recursive: true, force: true });
      if (["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  };

  if (!await publish()) {
    let existing: z.infer<typeof lockSchema>;
    try {
      existing = lockSchema.parse(JSON.parse(await readFile(join(path, "owner.json"), "utf8")));
    } catch {
      throw new ActivationConflictError("activation writer lock is held or malformed");
    }
    try {
      process.kill(existing.pid, 0);
      throw new ActivationConflictError("activation writer lock is held");
    } catch (probe) {
      if (probe instanceof ActivationConflictError) throw probe;
      if ((probe as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new ActivationConflictError("activation writer lock ownership cannot be verified");
      }
    }
    const quarantine = `${path}.${randomUUID()}.stale`;
    try {
      await rename(path, quarantine);
    } catch {
      throw new ActivationConflictError("activation writer lock changed during stale recovery");
    }
    try {
      const isolated = lockSchema.parse(JSON.parse(await readFile(join(quarantine, "owner.json"), "utf8")));
      if (isolated.token !== existing.token || isolated.pid !== existing.pid) {
        await rename(quarantine, path).catch(() => undefined);
        throw new ActivationConflictError("activation writer lock identity changed during stale recovery");
      }
      await rm(quarantine, { recursive: true, force: true });
      if (!await publish()) throw new ActivationConflictError("activation writer lock was concurrently reacquired");
    } catch (error) {
      await rm(candidate, { recursive: true, force: true });
      throw error;
    }
  }

  return async () => {
    const quarantine = `${path}.${randomUUID()}.release`;
    try {
      const current = lockSchema.parse(JSON.parse(await readFile(join(path, "owner.json"), "utf8")));
      if (current.token !== token) return;
      await rename(path, quarantine);
      const isolated = lockSchema.parse(JSON.parse(await readFile(join(quarantine, "owner.json"), "utf8")));
      if (isolated.token === token) await rm(quarantine, { recursive: true, force: true });
      else await rename(quarantine, path).catch(() => undefined);
      await fsyncDirectory(dirname(path));
    } catch {
      // Never remove a lock whose ownership cannot be proven.
    }
  };
}

export class ActivationCoordinator {
  readonly paths: ActivationPaths;
  private readonly boundaryHook: BoundaryHook;

  constructor(root: string, options: Readonly<{ onBoundary?: BoundaryHook }> = {}) {
    this.paths = paths(root);
    this.boundaryHook = options.onBoundary ?? (() => undefined);
  }

  async activate(candidate: ActivationCandidate, operationId = randomUUID()): Promise<Journal> {
    if (!z.string().uuid().safeParse(operationId).success) throw new Error("operation id must be UUID");
    generationSchema.parse(candidate.nextGeneration);
    if (candidate.expectedGeneration !== null) generationSchema.parse(candidate.expectedGeneration);
    sha256Schema.parse(candidate.attestationSha256);
    const release = await acquireActivationLock(this.paths.lockPath);
    try {
      const existing = await this.readJournal();
      if (existing && existing.state !== "cas_committed") throw new ActivationRecoveryError("unresolved journal requires recovery inspection");
      const currentPointer = await this.readPointer();
      const currentCas = await this.readCas();
      if ((currentPointer?.generation ?? null) !== candidate.expectedGeneration || (currentCas?.generation ?? null) !== candidate.expectedGeneration) {
        throw new ActivationConflictError("expected generation does not match pointer and CAS");
      }
      const pointer: Pointer = { schema_version: 1, generation: candidate.nextGeneration, attestation_sha256: candidate.attestationSha256 };
      let journal: Journal = {
        schema_version: 1,
        operation_id: operationId,
        expected_generation: candidate.expectedGeneration,
        next_generation: candidate.nextGeneration,
        attestation_sha256: candidate.attestationSha256,
        pointer_sha256: digestJson(pointer),
        state: "prepared",
        updated_at: now()
      };
      await this.writeJournal(journal);
      await this.boundaryHook("prepared");
      journal = { ...journal, state: "attested", updated_at: now() };
      await this.writeJournal(journal);
      await this.boundaryHook("attested");
      await atomicWrite(this.paths.pointerPath, JSON.stringify(pointer) + "\n");
      journal = { ...journal, state: "pointer_promoted", updated_at: now() };
      await this.writeJournal(journal);
      await this.boundaryHook("pointer_promoted");
      const promoted = await this.readPointer();
      if (!promoted || digestJson(promoted) !== journal.pointer_sha256) throw new ActivationRecoveryError("pointer readback mismatch");
      journal = { ...journal, state: "verified", updated_at: now() };
      await this.writeJournal(journal);
      await this.boundaryHook("verified");
      const casBeforeCommit = await this.readCas();
      if ((casBeforeCommit?.generation ?? null) !== candidate.expectedGeneration) throw new ActivationConflictError("CAS changed before second-phase commit");
      const cas: CasRecord = { schema_version: 1, generation: candidate.nextGeneration, attestation_sha256: candidate.attestationSha256, operation_id: operationId };
      await atomicWrite(this.paths.casPath, JSON.stringify(cas) + "\n");
      journal = { ...journal, state: "cas_committed", updated_at: now() };
      await this.writeJournal(journal);
      await this.boundaryHook("cas_committed");
      return journal;
    } finally {
      await release();
    }
  }

  async inspectRecovery(): Promise<RecoveryReport> {
    let journal: Journal | null;
    try {
      journal = await this.readJournal();
    } catch (error) {
      return { verdict: "inconsistent_fail_closed", journal: null, pointer: null, cas: null, reason: (error as Error).message };
    }
    if (!journal) {
      let pointer: Pointer | null;
      let cas: CasRecord | null;
      try {
        pointer = await this.readPointer();
        cas = await this.readCas();
      } catch (error) {
        return { verdict: "inconsistent_fail_closed", journal: null, pointer: null, cas: null, reason: (error as Error).message };
      }
      if ((pointer === null) !== (cas === null)) {
        return { verdict: "inconsistent_fail_closed", journal: null, pointer, cas, reason: "pointer and CAS baseline completeness mismatch" };
      }
      if (pointer && cas && (pointer.generation !== cas.generation || pointer.attestation_sha256 !== cas.attestation_sha256)) {
        return { verdict: "inconsistent_fail_closed", journal: null, pointer, cas, reason: "pointer and CAS disagree without a recovery journal" };
      }
      return { verdict: "no_journal", journal: null, pointer, cas };
    }
    let pointer: Pointer | null;
    let cas: CasRecord | null;
    try {
      pointer = await this.readPointer();
      cas = await this.readCas();
    } catch (error) {
      return { verdict: "inconsistent_fail_closed", journal, pointer: null, cas: null, reason: (error as Error).message };
    }
    const pointerIsExpected = (pointer?.generation ?? null) === journal.expected_generation;
    const casIsExpected = (cas?.generation ?? null) === journal.expected_generation;
    const pointerIsNext = pointer?.generation === journal.next_generation
      && pointer.attestation_sha256 === journal.attestation_sha256
      && digestJson(pointer) === journal.pointer_sha256;
    const casIsNext = cas?.generation === journal.next_generation
      && cas.attestation_sha256 === journal.attestation_sha256
      && cas.operation_id === journal.operation_id;
    if (journal.state === "cas_committed") {
      if (pointerIsNext && casIsNext) return { verdict: "complete", journal, pointer, cas };
      return { verdict: "inconsistent_fail_closed", journal, pointer, cas, reason: "committed durable records do not match journal" };
    }
    if (pointerIsNext && casIsNext) return { verdict: "complete", journal, pointer, cas };
    if (!casIsExpected) {
      return { verdict: "inconsistent_fail_closed", journal, pointer, cas, reason: "CAS does not match expected generation" };
    }
    if (journal.state === "prepared") {
      if (!pointerIsExpected) return { verdict: "inconsistent_fail_closed", journal, pointer, cas, reason: "prepared baseline drift" };
      return { verdict: "prepared_needs_attestation", journal, pointer, cas };
    }
    if (journal.state === "attested" && pointerIsExpected) {
      return { verdict: "attested_needs_pointer_promotion", journal, pointer, cas };
    }
    if (!pointerIsNext) {
      return { verdict: "inconsistent_fail_closed", journal, pointer, cas, reason: "pointer does not match journal" };
    }
    if (journal.state === "attested") return { verdict: "pointer_promoted_needs_verification", journal, pointer, cas };
    if (journal.state === "pointer_promoted") return { verdict: "pointer_promoted_needs_verification", journal, pointer, cas };
    return { verdict: "verified_needs_cas_commit", journal, pointer, cas };
  }

  async resumeRecovered(): Promise<Journal> {
    const release = await acquireActivationLock(this.paths.lockPath);
    try {
      let report = await this.inspectRecovery();
      if (!report.journal) throw new ActivationRecoveryError(`recovery cannot resume from ${report.verdict}`);
      let journal = report.journal;
      const pointer: Pointer = { schema_version: 1, generation: journal.next_generation, attestation_sha256: journal.attestation_sha256 };
      if (report.verdict === "prepared_needs_attestation") {
        journal = { ...journal, state: "attested", updated_at: now() };
        await this.writeJournal(journal);
        report = await this.inspectRecovery();
      }
      if (report.verdict === "attested_needs_pointer_promotion") {
        await atomicWrite(this.paths.pointerPath, JSON.stringify(pointer) + "\n");
        journal = { ...journal, state: "pointer_promoted", updated_at: now() };
        await this.writeJournal(journal);
        report = await this.inspectRecovery();
      }
      if (report.verdict === "pointer_promoted_needs_verification") {
        if (!report.pointer || digestJson(report.pointer) !== journal.pointer_sha256) throw new ActivationRecoveryError("recovered pointer readback mismatch");
        journal = { ...journal, state: "verified", updated_at: now() };
        await this.writeJournal(journal);
        report = await this.inspectRecovery();
      }
      if (report.verdict !== "verified_needs_cas_commit") throw new ActivationRecoveryError(`recovery cannot resume from ${report.verdict}`);
      if ((report.cas?.generation ?? null) !== journal.expected_generation) throw new ActivationConflictError("CAS changed during recovery");
      const cas: CasRecord = { schema_version: 1, generation: journal.next_generation, attestation_sha256: journal.attestation_sha256, operation_id: journal.operation_id };
      await atomicWrite(this.paths.casPath, JSON.stringify(cas) + "\n");
      const committed = { ...journal, state: "cas_committed" as const, updated_at: now() };
      await this.writeJournal(committed);
      return committed;
    } finally {
      await release();
    }
  }

  async commitRecovered(): Promise<Journal> { return this.resumeRecovered(); }

  async clearCommittedJournal(): Promise<void> {
    const release = await acquireActivationLock(this.paths.lockPath);
    try {
      const journal = await this.readJournal();
      if (journal?.state !== "cas_committed") throw new ActivationRecoveryError("only a committed journal may be cleared");
      await rm(this.paths.journalPath, { force: true });
      await fsyncDirectory(this.paths.root);
    } finally {
      await release();
    }
  }

  private async readPointer(): Promise<Pointer | null> { return readJson(this.paths.pointerPath, pointerSchema); }
  private async readCas(): Promise<CasRecord | null> { return readJson(this.paths.casPath, casSchema); }
  private async readJournal(): Promise<Journal | null> { return readJson(this.paths.journalPath, journalSchema); }
  private async writeJournal(journal: Journal): Promise<void> { await atomicWrite(this.paths.journalPath, JSON.stringify(journal) + "\n"); }
}
