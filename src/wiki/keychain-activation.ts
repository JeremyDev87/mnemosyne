import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { invokeTrustedHelper, type TrustedHelperResponse } from "../trust/trusted-helper";
import { acquireActivationLock } from "./activation-coordinator";
import { parseSnapshotAttestation, snapshotAttestationId, verifySnapshotAttestation } from "./snapshot-attestation";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const generationSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/u);
const trustSchema = z.object({
  keyId: sha256Schema,
  acceptedSequence: z.number().int().nonnegative().safe(),
  acceptedAttestationId: sha256Schema
}).strict();
const pointerSchema = z.object({
  schema_version: z.literal(2),
  generation: generationSchema,
  attestation_sha256: sha256Schema
}).strict();
const journalSchema = z.object({
  schema_version: z.literal(1),
  operation_id: z.string().uuid(),
  expected_generation: generationSchema.nullable(),
  expected_sequence: z.number().int().nonnegative().safe().nullable(),
  expected_attestation_id: sha256Schema.nullable(),
  expected_pointer_attestation_sha256: sha256Schema.nullable(),
  next_generation: generationSchema,
  next_sequence: z.number().int().nonnegative().safe(),
  attestation_sha256: sha256Schema,
  accepted_attestation_id: sha256Schema,
  pointer_sha256: sha256Schema,
  state: z.enum(["prepared", "pointer_promoted", "trust_committed"])
}).strict();
const receiptSchema = z.object({
  schema_version: z.literal(1),
  authority: z.literal("keychain-trust-cas"),
  operation_id: z.string().uuid(),
  generation: generationSchema,
  accepted_sequence: z.number().int().nonnegative().safe(),
  accepted_attestation_id: sha256Schema
}).strict();

export type KeychainTrustState = z.infer<typeof trustSchema>;
type Pointer = z.infer<typeof pointerSchema>;
type Journal = z.infer<typeof journalSchema>;
export type KeychainActivationState = Journal["state"];

export interface KeychainTrustStore {
  keyInfo(): Promise<Readonly<{ keyId: string; publicKeyPem: string }>>;
  read(): Promise<KeychainTrustState | null>;
  compareAndSwap(expected: KeychainTrustState | null, next: KeychainTrustState): Promise<KeychainTrustState>;
}

export type TrustedHelperInvoker = (path: string, request: Readonly<Record<string, unknown>>) => Promise<TrustedHelperResponse>;

function responseTrust(response: TrustedHelperResponse): KeychainTrustState | null {
  const value = response.trust_state;
  return value ? trustSchema.parse({
    keyId: value.key_id,
    acceptedSequence: value.accepted_sequence,
    acceptedAttestationId: value.accepted_attestation_id
  }) : null;
}

export class TrustedHelperKeychainStore implements KeychainTrustStore {
  constructor(
    private readonly helperPath: string,
    private readonly invoke: TrustedHelperInvoker = invokeTrustedHelper
  ) {}

  async keyInfo(): Promise<Readonly<{ keyId: string; publicKeyPem: string }>> {
    const response = await this.invoke(this.helperPath, { operation: "key-info" });
    if (!response.key_id || !response.public_key_pem) throw new Error("Trusted helper omitted enrolled key identity");
    return { keyId: sha256Schema.parse(response.key_id), publicKeyPem: response.public_key_pem };
  }

  async read(): Promise<KeychainTrustState | null> {
    return responseTrust(await this.invoke(this.helperPath, { operation: "trust-read" }));
  }

  async compareAndSwap(expected: KeychainTrustState | null, next: KeychainTrustState): Promise<KeychainTrustState> {
    const response = await this.invoke(this.helperPath, {
      operation: "trust-cas",
      expected_sequence: expected?.acceptedSequence,
      expected_attestation_id: expected?.acceptedAttestationId,
      accepted_sequence: next.acceptedSequence,
      accepted_attestation_id: next.acceptedAttestationId
    });
    const committed = responseTrust(response);
    if (!committed) throw new Error("Trusted helper omitted authoritative trust state");
    return committed;
  }
}

export interface KeychainActivationCandidate {
  readonly expectedGeneration: string | null;
  readonly nextGeneration: string;
  readonly attestationPath: string;
  readonly attestationSha256: string;
}

export type KeychainRecoveryVerdict = "no_journal" | "complete" | "needs_pointer_promotion" | "needs_trust_commit" | "inconsistent_fail_closed";
export interface KeychainRecoveryReport {
  readonly verdict: KeychainRecoveryVerdict;
  readonly pointer: Pointer | null;
  readonly trust: KeychainTrustState | null;
  readonly journal: Journal | null;
  readonly reason?: string;
}

export class KeychainActivationConflictError extends Error {}
export class KeychainActivationRecoveryError extends Error {}

function equalTrust(left: KeychainTrustState | null, right: KeychainTrustState | null): boolean {
  return left === null ? right === null : right !== null
    && left.keyId === right.keyId
    && left.acceptedSequence === right.acceptedSequence
    && left.acceptedAttestationId === right.acceptedAttestationId;
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}

async function readJson<T>(path: string, parser: z.ZodType<T>): Promise<T | null> {
  try { return parser.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new KeychainActivationRecoveryError(`invalid durable JSON at ${path}`);
  }
}

export class KeychainActivationCoordinator {
  readonly paths: Readonly<{ root: string; pointerPath: string; journalPath: string; receiptPath: string; lockPath: string }>;

  constructor(
    root: string,
    private readonly store: KeychainTrustStore,
    private readonly onBoundary: (state: KeychainActivationState) => void | Promise<void> = () => undefined
  ) {
    const resolved = resolve(root);
    this.paths = {
      root: resolved,
      pointerPath: join(resolved, "current.json"),
      journalPath: join(resolved, "activation.keychain.journal.json"),
      receiptPath: join(resolved, "activation.keychain.receipt.json"),
      lockPath: join(resolved, "activation.keychain.lock")
    };
  }

  async activate(candidate: KeychainActivationCandidate, operationId = randomUUID()): Promise<void> {
    if (!z.string().uuid().safeParse(operationId).success) throw new Error("operation id must be UUID");
    generationSchema.parse(candidate.nextGeneration);
    if (candidate.expectedGeneration !== null) generationSchema.parse(candidate.expectedGeneration);
    sha256Schema.parse(candidate.attestationSha256);
    const release = await acquireActivationLock(this.paths.lockPath);
    try {
    const existingJournal = await this.readJournal();
    if (existingJournal && (await this.inspectRecovery()).verdict !== "complete") {
      throw new KeychainActivationRecoveryError("unresolved Keychain activation journal requires recovery");
    }
    const pointer = await this.readPointer();
    const trust = await this.store.read();
    await this.assertBaseline(pointer, trust, candidate.expectedGeneration);
    const attestationBytes = await readFile(candidate.attestationPath);
    if (createHash("sha256").update(attestationBytes).digest("hex") !== candidate.attestationSha256) {
      throw new KeychainActivationRecoveryError("durable attestation digest mismatch");
    }
    const attestation = parseSnapshotAttestation(JSON.parse(attestationBytes.toString("utf8")));
    const keyInfo = await this.store.keyInfo();
    const enrolledKeyId = trust?.keyId ?? keyInfo.keyId;
    const nextSequence = trust === null ? 0 : trust.acceptedSequence + 1;
    const acceptedAttestationId = snapshotAttestationId(attestation);
    if (attestation.key_id !== enrolledKeyId || attestation.payload.generation !== candidate.nextGeneration || attestation.payload.sequence !== nextSequence) {
      throw new KeychainActivationRecoveryError("attestation identity, generation, or sequence mismatch");
    }
    if (attestation.payload.previous_attestation_sha256 !== (trust?.acceptedAttestationId ?? null)) {
      throw new KeychainActivationRecoveryError("attestation chain continuity mismatch");
    }
    verifySnapshotAttestation(attestation, {
      keyId: enrolledKeyId,
      publicKeyPem: keyInfo.publicKeyPem,
      acceptedSequence: nextSequence,
      acceptedAttestationId
    });
    const nextTrust: KeychainTrustState = {
      keyId: enrolledKeyId,
      acceptedSequence: nextSequence,
      acceptedAttestationId
    };
    const nextPointer: Pointer = { schema_version: 2, generation: candidate.nextGeneration, attestation_sha256: candidate.attestationSha256 };
    const journal: Journal = {
      schema_version: 1,
      operation_id: operationId,
      expected_generation: candidate.expectedGeneration,
      expected_sequence: trust?.acceptedSequence ?? null,
      expected_attestation_id: trust?.acceptedAttestationId ?? null,
      expected_pointer_attestation_sha256: pointer?.attestation_sha256 ?? null,
      next_generation: candidate.nextGeneration,
      next_sequence: nextSequence,
      attestation_sha256: candidate.attestationSha256,
      accepted_attestation_id: acceptedAttestationId,
      pointer_sha256: digestJson(nextPointer),
      state: "prepared"
    };
    await this.writeJournal(journal);
    await this.onBoundary("prepared");
    await atomicWrite(this.paths.pointerPath, JSON.stringify(nextPointer) + "\n");
    if (digestJson(await this.requirePointer()) !== journal.pointer_sha256) throw new KeychainActivationRecoveryError("pointer readback mismatch");
    await this.writeJournal({ ...journal, state: "pointer_promoted" });
    await this.onBoundary("pointer_promoted");
    await this.commitTrustWithReadback(journal, trust, nextTrust);
    } finally {
      await release();
    }
  }

  async inspectRecovery(): Promise<KeychainRecoveryReport> {
    try {
      const journal = await this.readJournal();
      const pointer = await this.readPointer();
      const trust = await this.store.read();
      if (!journal) return { verdict: "no_journal", pointer, trust, journal: null };
      const expectedTrust = this.expectedTrust(journal, trust?.keyId);
      const nextTrust = this.nextTrust(journal, trust?.keyId ?? expectedTrust?.keyId);
      const pointerExpected = (pointer?.generation ?? null) === journal.expected_generation
        && (pointer?.attestation_sha256 ?? null) === journal.expected_pointer_attestation_sha256;
      const pointerNext = pointer?.generation === journal.next_generation
        && pointer.attestation_sha256 === journal.attestation_sha256
        && digestJson(pointer) === journal.pointer_sha256;
      if (journal.state === "trust_committed") {
        return pointerNext && equalTrust(trust, nextTrust)
          ? { verdict: "complete", pointer, trust, journal }
          : { verdict: "inconsistent_fail_closed", pointer, trust, journal, reason: "committed records disagree" };
      }
      if (nextTrust !== null && equalTrust(trust, nextTrust)) {
        return pointerNext
          ? { verdict: "needs_trust_commit", pointer, trust, journal }
          : { verdict: "inconsistent_fail_closed", pointer, trust, journal, reason: "Keychain advanced without matching pointer" };
      }
      if (!equalTrust(trust, expectedTrust)) return { verdict: "inconsistent_fail_closed", pointer, trust, journal, reason: "authoritative Keychain state drifted" };
      if (journal.state === "prepared" && pointerExpected) return { verdict: "needs_pointer_promotion", pointer, trust, journal };
      if (pointerNext) return { verdict: "needs_trust_commit", pointer, trust, journal };
      return { verdict: "inconsistent_fail_closed", pointer, trust, journal, reason: "pointer does not match journal" };
    } catch (error) {
      return { verdict: "inconsistent_fail_closed", pointer: null, trust: null, journal: null, reason: (error as Error).message };
    }
  }

  async resumeRecovered(): Promise<void> {
    const release = await acquireActivationLock(this.paths.lockPath);
    try {
    let report = await this.inspectRecovery();
    if (!report.journal || report.verdict === "inconsistent_fail_closed" || report.verdict === "no_journal") {
      throw new KeychainActivationRecoveryError(`recovery cannot resume from ${report.verdict}`);
    }
    const journal = report.journal;
    const pointer: Pointer = { schema_version: 2, generation: journal.next_generation, attestation_sha256: journal.attestation_sha256 };
    if (report.verdict === "needs_pointer_promotion") {
      await this.verifyJournalAttestation(journal);
      await atomicWrite(this.paths.pointerPath, JSON.stringify(pointer) + "\n");
      if (digestJson(await this.requirePointer()) !== journal.pointer_sha256) throw new KeychainActivationRecoveryError("recovered pointer readback mismatch");
      await this.writeJournal({ ...journal, state: "pointer_promoted" });
      report = await this.inspectRecovery();
    }
    if (report.verdict !== "needs_trust_commit" || !report.journal) throw new KeychainActivationRecoveryError(`recovery cannot resume from ${report.verdict}`);
    await this.verifyJournalAttestation(report.journal);
    const expected = this.expectedTrust(report.journal, report.trust?.keyId);
    const recoveryKeyId = report.trust?.keyId ?? expected?.keyId ?? (await this.store.keyInfo()).keyId;
    const next = this.nextTrust(report.journal, recoveryKeyId);
    if (!next) throw new KeychainActivationRecoveryError("recovery key identity is unavailable");
    if (!equalTrust(report.trust, next)) await this.commitTrustWithReadback(report.journal, expected, next);
    else await this.finalizeCommitted(report.journal, next);
    } finally {
      await release();
    }
  }

  private async verifyJournalAttestation(journal: Journal): Promise<void> {
    const path = join(this.paths.root, "snapshots", journal.next_generation, "attestation.json");
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== journal.attestation_sha256) {
      throw new KeychainActivationRecoveryError("recovery attestation digest mismatch");
    }
    const attestation = parseSnapshotAttestation(JSON.parse(bytes.toString("utf8")));
    const keyInfo = await this.store.keyInfo();
    if (attestation.key_id !== keyInfo.keyId || attestation.payload.generation !== journal.next_generation || attestation.payload.sequence !== journal.next_sequence || snapshotAttestationId(attestation) !== journal.accepted_attestation_id) {
      throw new KeychainActivationRecoveryError("recovery attestation binding mismatch");
    }
    if (attestation.payload.previous_attestation_sha256 !== journal.expected_attestation_id) {
      throw new KeychainActivationRecoveryError("recovery attestation chain continuity mismatch");
    }
    verifySnapshotAttestation(attestation, {
      keyId: keyInfo.keyId,
      publicKeyPem: keyInfo.publicKeyPem,
      acceptedSequence: journal.next_sequence,
      acceptedAttestationId: journal.accepted_attestation_id
    });
  }

  private async assertBaseline(pointer: Pointer | null, trust: KeychainTrustState | null, expectedGeneration: string | null): Promise<void> {
    if ((pointer?.generation ?? null) !== expectedGeneration) throw new KeychainActivationConflictError("expected generation does not match pointer");
    if (pointer === null && trust !== null) throw new KeychainActivationConflictError("Keychain trust exists without a pointer");
    if (pointer !== null && trust === null) throw new KeychainActivationConflictError("pointer exists without authoritative Keychain trust");
    if (pointer && trust) {
      const baselineBytes = await readFile(join(this.paths.root, "snapshots", pointer.generation, "attestation.json"));
      if (createHash("sha256").update(baselineBytes).digest("hex") !== pointer.attestation_sha256) {
        throw new KeychainActivationConflictError("baseline attestation digest disagrees with pointer");
      }
      const baseline = parseSnapshotAttestation(JSON.parse(baselineBytes.toString("utf8")));
      if (baseline.key_id !== trust.keyId || baseline.payload.sequence !== trust.acceptedSequence || snapshotAttestationId(baseline) !== trust.acceptedAttestationId) {
        throw new KeychainActivationConflictError("baseline attestation disagrees with authoritative Keychain trust");
      }
    }
  }


  private expectedTrust(journal: Journal, keyId: string | undefined): KeychainTrustState | null {
    if (journal.expected_sequence === null || journal.expected_attestation_id === null) return null;
    if (!keyId) return null;
    return { keyId, acceptedSequence: journal.expected_sequence, acceptedAttestationId: journal.expected_attestation_id };
  }

  private nextTrust(journal: Journal, keyId: string | undefined): KeychainTrustState | null {
    return keyId ? { keyId, acceptedSequence: journal.next_sequence, acceptedAttestationId: journal.accepted_attestation_id } : null;
  }

  private async commitTrustWithReadback(journal: Journal, expected: KeychainTrustState | null, next: KeychainTrustState): Promise<void> {
    try { await this.store.compareAndSwap(expected, next); } catch {
      // Timeout/process failure is ambiguous: only authoritative readback may classify it.
    }
    const authoritative = await this.store.read();
    if (!equalTrust(authoritative, next)) throw new KeychainActivationConflictError("authoritative Keychain CAS did not commit expected successor");
    await this.finalizeCommitted(journal, next);
  }

  private async finalizeCommitted(journal: Journal, next: KeychainTrustState): Promise<void> {
    const receipt = receiptSchema.parse({
      schema_version: 1,
      authority: "keychain-trust-cas",
      operation_id: journal.operation_id,
      generation: journal.next_generation,
      accepted_sequence: next.acceptedSequence,
      accepted_attestation_id: next.acceptedAttestationId
    });
    await atomicWrite(this.paths.receiptPath, JSON.stringify(receipt) + "\n");
    await this.writeJournal({ ...journal, state: "trust_committed" });
    await this.onBoundary("trust_committed");
  }

  private async requirePointer(): Promise<Pointer> {
    const pointer = await this.readPointer();
    if (!pointer) throw new KeychainActivationRecoveryError("pointer is missing");
    return pointer;
  }
  private async readPointer(): Promise<Pointer | null> { return readJson(this.paths.pointerPath, pointerSchema); }
  private async readJournal(): Promise<Journal | null> { return readJson(this.paths.journalPath, journalSchema); }
  private async writeJournal(journal: Journal): Promise<void> { await atomicWrite(this.paths.journalPath, JSON.stringify(journal) + "\n"); }
}
