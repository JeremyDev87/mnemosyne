import { createHash } from "node:crypto";

export type SnapshotEntryState = "fresh" | "stale" | "quarantined" | "deleted";
export type SnapshotState = "pending" | "finalized" | "active" | "rejected";

export interface SnapshotEntry {
  readonly documentId: string;
  readonly relativePath: string;
  readonly state: SnapshotEntryState;
  readonly sha256: string;
  readonly bytes: number;
  readonly content: string;
  readonly provenance: string;
}

export interface SnapshotGeneration {
  readonly id: string;
  readonly sequence: number;
  readonly state: SnapshotState;
  readonly policyDigest: string;
  readonly expectedCount: number;
  readonly expectedBytes: number;
  readonly expectedTreeHash: string;
  readonly entries: readonly SnapshotEntry[];
}

type MutableSnapshotGeneration = {
  -readonly [Key in keyof SnapshotGeneration]: SnapshotGeneration[Key] extends readonly (infer Entry)[] ? Entry[] : SnapshotGeneration[Key];
};

function cloneGeneration(generation: MutableSnapshotGeneration): SnapshotGeneration {
  return structuredClone(generation) as SnapshotGeneration;
}

function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function validateEntry(entry: SnapshotEntry): void {
  const normalizedPath = entry.relativePath.normalize("NFC").replaceAll("\\", "/");
  const pathParts = normalizedPath.split("/");
  const hasControlCharacter = [...normalizedPath].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
  if (!entry.relativePath || normalizedPath !== entry.relativePath || normalizedPath.startsWith("/") || hasControlCharacter || pathParts.some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:\//.test(normalizedPath)) throw new Error("invalid snapshot relative path");
  const normalizedProvenance = entry.provenance.normalize("NFC");
  if (!entry.provenance || normalizedProvenance !== entry.provenance || [...normalizedProvenance].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) throw new Error("invalid entry provenance");
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("invalid entry hash");
  if (entry.sha256 !== contentDigest(entry.content)) throw new Error("entry content hash mismatch");
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== Buffer.byteLength(entry.content, "utf8")) throw new Error("entry byte length mismatch");
}

export function snapshotTreeHash(entries: readonly SnapshotEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => a.documentId.localeCompare(b.documentId, "en") || a.relativePath.localeCompare(b.relativePath, "en") || a.provenance.localeCompare(b.provenance, "en"))
    .map((entry) => [entry.documentId, entry.relativePath, entry.state, entry.sha256, entry.bytes, entry.provenance]);
  return contentDigest(JSON.stringify(canonical));
}

export class SnapshotLedger {
  private readonly generations = new Map<string, MutableSnapshotGeneration>();
  private active: { id: string; sequence: number } | null = null;
  private nextSequence = 1;

  createPending(input: Omit<SnapshotGeneration, "id" | "sequence" | "state" | "entries">): SnapshotGeneration {
    if (!/^[a-f0-9]{64}$/.test(input.policyDigest)) throw new Error("invalid policy digest");
    if (!Number.isSafeInteger(input.expectedCount) || input.expectedCount < 0) throw new Error("invalid expected entry count");
    if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 0) throw new Error("invalid expected byte count");
    if (!/^[a-f0-9]{64}$/.test(input.expectedTreeHash)) throw new Error("invalid expected tree hash");
    const generation: MutableSnapshotGeneration = { ...input, id: crypto.randomUUID(), sequence: this.nextSequence++, state: "pending", entries: [] };
    this.generations.set(generation.id, generation);
    return cloneGeneration(generation);
  }

  addEntry(id: string, entry: SnapshotEntry): void {
    const generation = this.getMutable(id);
    if (generation.state !== "pending") throw new Error("snapshot is immutable after finalize");
    if (generation.entries.some((candidate) => candidate.documentId === entry.documentId)) throw new Error("duplicate snapshot entry");
    validateEntry(entry);
    generation.entries.push(structuredClone(entry));
  }

  finalize(id: string): SnapshotGeneration {
    const generation = this.getMutable(id);
    if (generation.state !== "pending") throw new Error("snapshot is not pending");
    try {
      for (const entry of generation.entries) validateEntry(entry);
      const bytes = generation.entries.reduce((total, entry) => total + entry.bytes, 0);
      const treeHash = snapshotTreeHash(generation.entries);
      if (generation.entries.length !== generation.expectedCount || bytes !== generation.expectedBytes || treeHash !== generation.expectedTreeHash) throw new Error("snapshot completeness or tree hash mismatch");
      generation.state = "finalized";
      return cloneGeneration(generation);
    } catch (error) {
      generation.state = "rejected";
      throw error;
    }
  }

  activate(id: string, expectedActiveSequence: number | null): SnapshotGeneration {
    const generation = this.getMutable(id);
    if (generation.state !== "finalized") throw new Error("only finalized snapshots can activate");
    if ((this.active?.sequence ?? null) !== (expectedActiveSequence ?? null)) throw new Error("active snapshot compare-and-swap conflict");
    if (this.active && generation.sequence <= this.active.sequence) throw new Error("snapshot sequence must increase monotonically");
    if (this.active) this.getMutable(this.active.id).state = "finalized";
    generation.state = "active";
    this.active = { id, sequence: generation.sequence };
    return cloneGeneration(generation);
  }

  getActive(): SnapshotGeneration | null {
    return this.active ? this.get(this.active.id) : null;
  }

  get(id: string): SnapshotGeneration {
    return cloneGeneration(this.getMutable(id));
  }

  private getMutable(id: string): MutableSnapshotGeneration {
    const generation = this.generations.get(id);
    if (!generation) throw new Error("snapshot not found");
    return generation;
  }
}
