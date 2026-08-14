import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  documentRequestSchema,
  documentResultSchema,
  healthResultSchema,
  personalOpsResultSchema,
  searchRequestSchema,
  searchResultSchema,
  type DocumentRequest,
  type DocumentResult,
  type HealthResult,
  type PersonalOpsResult,
  type SearchRequest,
  type SearchResult
} from "../electron/contracts";
import { buildPersonalOpsSummary } from "../personal-ops/parser";
import { parseWikiDocument } from "./authority";
import { pinCurrentSnapshot, readPinnedDocument, type PinnedSnapshot } from "./dobby-snapshot";
import type { SnapshotTrustAnchor } from "./snapshot-attestation";

const execFileAsync = promisify(execFile);
const healthOutputSchema = z.object({
  status: z.literal("ok"),
  degraded: z.boolean(),
  snapshot_state_counts: z.record(z.string(), z.number().int().nonnegative())
}).passthrough();
const searchOutputSchema = z.object({
  status: z.literal("ok"),
  degraded: z.boolean(),
  results: z.array(z.object({
    canonical_path: z.string(),
    title: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    source_role: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    do_not_answer_as_current: z.boolean().nullable().optional()
  }).passthrough())
}).passthrough();

export type CommandRunner = (command: string, args: readonly string[]) => Promise<unknown>;

async function defaultCommandRunner(command: string, args: readonly string[]): Promise<unknown> {
  const result = await execFileAsync(command, [...args], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    shell: false,
    encoding: "utf8"
  });
  return JSON.parse(result.stdout);
}

export interface DobbyWikiAdapterOptions {
  stateRoot: string;
  commandStateRoot?: string;
  command?: string;
  admitCommand?: () => Promise<string>;
  runCommand?: CommandRunner;
  trustAnchor?: SnapshotTrustAnchor;
}

export function buildVerifiedExcerpt(body: string, maximumLength = 500): string {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 0) throw new Error("Excerpt length is invalid");
  return body.replace(/\s+/gu, " ").trim().slice(0, maximumLength);
}

export class DobbyWikiAdapter {
  readonly #stateRoot: string;
  readonly #commandStateRoot: string;
  readonly #command?: string;
  readonly #admitCommand?: () => Promise<string>;
  readonly #runCommand: CommandRunner;
  readonly #trustAnchor?: SnapshotTrustAnchor;
  readonly #documentPaths = new Map<string, string>();
  #pinnedSnapshot?: Promise<PinnedSnapshot>;

  constructor(options: DobbyWikiAdapterOptions) {
    this.#stateRoot = options.stateRoot;
    this.#commandStateRoot = options.commandStateRoot ?? options.stateRoot;
    this.#command = options.command;
    this.#admitCommand = options.admitCommand;
    this.#runCommand = options.runCommand ?? defaultCommandRunner;
    this.#trustAnchor = options.trustAnchor;
  }

  #snapshot(): Promise<PinnedSnapshot> {
    if (!this.#trustAnchor) return Promise.reject(new Error("Snapshot trust anchor is not provisioned"));
    this.#pinnedSnapshot ??= pinCurrentSnapshot(this.#stateRoot, this.#trustAnchor);
    return this.#pinnedSnapshot;
  }

  async #execute(args: readonly string[]): Promise<unknown> {
    const command = this.#admitCommand ? await this.#admitCommand() : this.#command;
    if (!command) throw new Error("Trusted Wiki command is not provisioned");
    return this.#runCommand(command, args);
  }

  async health(): Promise<HealthResult> {
    try {
      const snapshot = await this.#snapshot();
      const raw = await this.#execute(["--state-root", this.#commandStateRoot, "--pretty", "health"]);
      const health = healthOutputSchema.parse(raw);
      if (health.degraded) throw new Error("degraded");
      const copied = [...snapshot.entries.values()].filter((entry) => entry.state === "copied").length;
      return healthResultSchema.parse({ status: "ok", snapshotState: "fresh", documentCount: copied, message: "Local Wiki snapshot is ready" });
    } catch {
      return healthResultSchema.parse({ status: "unavailable", snapshotState: "unavailable", documentCount: 0, message: "Local Wiki is unavailable" });
    }
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const input = searchRequestSchema.parse(request);
    try {
      const snapshot = await this.#snapshot();
      const raw = await this.#execute(["--state-root", this.#commandStateRoot, "--pretty", "-n", String(input.limit), "search", input.query]);
      const output = searchOutputSchema.parse(raw);
      if (output.degraded) throw new Error("degraded");
      const hits = [];
      for (const candidate of output.results.slice(0, input.limit)) {
        const entry = snapshot.entries.get(candidate.canonical_path);
        if (!entry || entry.state !== "copied") continue;
        const content = await readPinnedDocument(snapshot, candidate.canonical_path);
        const document = parseWikiDocument(candidate.canonical_path, content);
        const documentId = createHash("sha256").update(candidate.canonical_path).digest("hex");
        this.#documentPaths.set(documentId, candidate.canonical_path);
        const domain = candidate.canonical_path.startsWith("domains/")
          ? candidate.canonical_path.split("/")[1] ?? null
          : null;
        hits.push({
          documentId,
          title: document.title.slice(0, 300),
          excerpt: buildVerifiedExcerpt(document.body),
          domain: domain?.slice(0, 120) ?? null,
          authority: document.authority.kind
        });
      }
      return searchResultSchema.parse({ hits, snapshotState: "fresh" });
    } catch {
      throw new Error("Wiki search request failed");
    }
  }

  async getDocument(request: DocumentRequest): Promise<DocumentResult> {
    const input = documentRequestSchema.parse(request);
    const path = this.#documentPaths.get(input.documentId);
    if (!path) throw new Error("Unknown document capability");
    try {
      const snapshot = await this.#snapshot();
      const entry = snapshot.entries.get(path);
      if (!entry || entry.size > 2 * 1024 * 1024) throw new Error("document rejected");
      const content = await readPinnedDocument(snapshot, path);
      const document = parseWikiDocument(path, content);
      return documentResultSchema.parse({
        documentId: input.documentId,
        title: document.title.slice(0, 300),
        body: document.body,
        authority: document.authority.kind
      });
    } catch {
      throw new Error("Wiki document request failed");
    }
  }

  async personalOps(): Promise<PersonalOpsResult> {
    const paths = {
      tasks: "brain/P6_prefrontal/personal-ops/tasks.md",
      schedule: "domains/personal-ops/schedule.md",
      inbox: "domains/personal-ops/inbox.md"
    } as const;
    try {
      const snapshot = await this.#snapshot();
      const [tasks, schedule, inbox] = await Promise.all([
        readPinnedDocument(snapshot, paths.tasks),
        readPinnedDocument(snapshot, paths.schedule),
        readPinnedDocument(snapshot, paths.inbox)
      ]);
      const summary = buildPersonalOpsSummary({ tasks, schedule, inbox });
      return personalOpsResultSchema.parse({
        tasks: { total: summary.tasks.total, byStatus: summary.tasks.byStatus },
        schedule: { total: summary.schedule.total, byStatus: summary.schedule.byStatus },
        inbox: { total: summary.inbox.total, open: summary.inbox.open },
        issueCount: summary.issues.length,
        generatedAt: summary.generatedAt
      });
    } catch {
      throw new Error("Personal Ops request failed");
    }
  }
}
