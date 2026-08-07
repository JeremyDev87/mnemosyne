import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import {
  parseSnapshotAttestation,
  snapshotAttestationId,
  verifySnapshotAttestation,
  type SnapshotTrustAnchor
} from "./snapshot-attestation";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const generationSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/u);
const entrySchema = z.object({
  relative_path: z.string(),
  sha256: sha256Schema,
  size: z.number().int().nonnegative(),
  state: z.enum(["copied", "stale", "quarantined", "deleted"])
}).strip();
const manifestSchema = z.object({
  schema_version: z.literal(2),
  generation: generationSchema,
  created_at: z.string().min(1),
  file_count: z.number().int().nonnegative(),
  files: z.array(entrySchema)
}).strip();
const pointerSchema = z.object({
  schema_version: z.literal(2),
  generation: generationSchema,
  attestation_sha256: sha256Schema
}).strict();

const MAX_POINTER_BYTES = 64 * 1024;
const MAX_ATTESTATION_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_AUTHORITY_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;

async function readRegularFileBelow(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new Error(`${label} exceeds the size limit`);
    const bytes = Buffer.allocUnsafe(info.size);
    let position = 0;
    while (position < info.size) {
      const { bytesRead } = await handle.read(bytes, position, info.size - position, position);
      if (bytesRead === 0) throw new Error(`${label} changed while reading`);
      position += bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const overflow = await handle.read(overflowProbe, 0, 1, info.size);
    const finalInfo = await handle.stat();
    if (overflow.bytesRead !== 0 || finalInfo.size !== info.size) throw new Error(`${label} changed while reading`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function hashRegularFileBelow(path: string, maximumBytes: number, label: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new Error(`${label} exceeds the size limit`);
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (position < info.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, info.size - position), position);
      if (bytesRead === 0) throw new Error(`${label} changed while hashing`);
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const finalInfo = await handle.stat();
    if (finalInfo.size !== info.size) throw new Error(`${label} changed while hashing`);
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

function decodeJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}

type SnapshotEntry = z.infer<typeof entrySchema>;
type SnapshotManifest = z.infer<typeof manifestSchema>;

export interface PinnedSnapshot {
  generationId: string;
  snapshotRoot: string;
  entries: ReadonlyMap<string, SnapshotEntry>;
  attestationSequence: number;
  attestationSha256: string;
  attestationId: string;
}

function canonicalKnowledgePath(path: string): string {
  if (!path || path !== path.normalize("NFC") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:\//u.test(path)) {
    throw new Error("Snapshot path is not canonical");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Snapshot path is unsafe");
  if (!path.toLowerCase().endsWith(".md")) throw new Error("Snapshot path is not Markdown");
  if (segments[0] !== "brain" && segments[0] !== "domains") throw new Error("Snapshot path is outside the knowledge allowlist");
  return path;
}

function buildEntryMap(manifest: SnapshotManifest): Map<string, SnapshotEntry> {
  if (manifest.file_count !== manifest.files.length) throw new Error("Snapshot manifest file count is inconsistent");
  const entries = new Map<string, SnapshotEntry>();
  const folded = new Set<string>();
  for (const entry of manifest.files) {
    const path = entry.relative_path.normalize("NFC");
    if (path !== entry.relative_path) throw new Error("Snapshot manifest contains a non-NFC path");
    canonicalKnowledgePath(path);
    const key = path.toLocaleLowerCase("en-US");
    if (entries.has(path) || folded.has(key)) throw new Error("Snapshot manifest contains colliding paths");
    entries.set(path, entry);
    folded.add(key);
  }
  return entries;
}

async function verifiedGenerationRoot(root: string, generation: string): Promise<string> {
  const snapshotsRoot = await realpath(resolve(root, "snapshots"));
  const candidate = resolve(snapshotsRoot, generation);
  if (!candidate.startsWith(`${snapshotsRoot}${sep}`)) throw new Error("Snapshot generation path escapes the state root");
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Snapshot generation must be a regular directory");
  const resolved = await realpath(candidate);
  if (!resolved.startsWith(`${snapshotsRoot}${sep}`)) throw new Error("Snapshot generation escapes through a symlink");
  return resolved;
}

export async function pinCurrentSnapshot(stateRoot: string, anchor: SnapshotTrustAnchor): Promise<PinnedSnapshot> {
  const root = resolve(stateRoot);
  const pointerBytes = await readRegularFileBelow(resolve(root, "current.json"), MAX_POINTER_BYTES, "Snapshot pointer");
  const pointer = pointerSchema.parse(decodeJson(pointerBytes, "Snapshot pointer"));
  const snapshotRoot = await verifiedGenerationRoot(root, pointer.generation);

  const attestationBytes = await readRegularFileBelow(resolve(snapshotRoot, "attestation.json"), MAX_ATTESTATION_BYTES, "Snapshot attestation");
  const attestationDigest = createHash("sha256").update(attestationBytes).digest("hex");
  if (attestationDigest !== pointer.attestation_sha256) throw new Error("Snapshot attestation digest mismatch");
  const parsedAttestation = parseSnapshotAttestation(decodeJson(attestationBytes, "Snapshot attestation"));
  const attestation = verifySnapshotAttestation(parsedAttestation, anchor);
  if (attestation.payload.generation !== pointer.generation) throw new Error("Snapshot attestation generation mismatch");

  const manifestPath = resolve(snapshotRoot, "manifest.json");
  const manifestBytes = await readRegularFileBelow(manifestPath, MAX_MANIFEST_BYTES, "Snapshot manifest");
  if (createHash("sha256").update(manifestBytes).digest("hex") !== attestation.payload.manifest_sha256) {
    throw new Error("Snapshot manifest digest mismatch");
  }
  const manifest = manifestSchema.parse(decodeJson(manifestBytes, "Snapshot manifest"));
  if (manifest.generation !== pointer.generation) throw new Error("Snapshot manifest generation mismatch");

  const authorityDigest = await hashRegularFileBelow(resolve(snapshotRoot, "authority.json"), MAX_AUTHORITY_BYTES, "Snapshot authority");
  if (authorityDigest !== attestation.payload.authority_sha256) throw new Error("Snapshot authority digest mismatch");
  const indexDigest = await hashRegularFileBelow(resolve(snapshotRoot, ".wikimap", "index.db"), MAX_INDEX_BYTES, "Snapshot Wikimap index");
  if (indexDigest !== attestation.payload.wikimap_index_sha256) throw new Error("Snapshot Wikimap index digest mismatch");

  return {
    generationId: pointer.generation,
    snapshotRoot,
    entries: buildEntryMap(manifest),
    attestationSequence: attestation.payload.sequence,
    attestationSha256: attestationDigest,
    attestationId: snapshotAttestationId(attestation)
  };
}

export async function readPinnedDocument(snapshot: PinnedSnapshot, requestedPath: string): Promise<string> {
  const path = canonicalKnowledgePath(requestedPath);
  const entry = snapshot.entries.get(path);
  if (!entry) throw new Error("Snapshot path is not present in the pinned manifest");
  if (entry.state !== "copied") throw new Error("Only fresh copied snapshot entries may be read");

  const absolute = resolve(snapshot.snapshotRoot, ...path.split("/"));
  if (!absolute.startsWith(`${snapshot.snapshotRoot}${sep}`)) throw new Error("Snapshot path escapes the pinned generation");
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Snapshot document must be a regular file");
  const resolved = await realpath(absolute);
  if (!resolved.startsWith(`${snapshot.snapshotRoot}${sep}`)) throw new Error("Snapshot document escapes through a symlink");
  const bytes = await readRegularFileBelow(resolved, MAX_DOCUMENT_BYTES, "Snapshot document");
  if (bytes.byteLength !== entry.size) throw new Error("Snapshot document size does not match the pinned manifest");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) throw new Error("Snapshot document digest does not match the pinned manifest");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
