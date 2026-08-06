import { createHash } from "node:crypto";

export const DEFAULT_SYNC_POLICY = {
  allowedPrefixes: ["brain/P6_prefrontal/personal-ops/", "domains/personal-ops/"],
  maxEntryBytes: 3 * 1024 * 1024,
  allowedExtension: ".md",
  version: 1
} as const;

export type SyncEntryState = "fresh" | "stale" | "quarantined" | "deleted";
export interface SyncEntryInput { documentId: string; relativePath: string; content: string; state?: SyncEntryState }
export interface SanitizedSyncEntry { documentId: string; relativePath: string; state: SyncEntryState; content: string; bytes: number; sha256: string; policyDigest: string }

export function normalizeRelativePath(path: string): string {
  const normalized = path.normalize("NFC").replaceAll("\\", "/");
  const parts = normalized.split("/");
  const hasControlCharacter = [...normalized].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
  if (!normalized || normalized !== path.normalize("NFC") || normalized.startsWith("/") || hasControlCharacter || parts.some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:\//.test(normalized)) throw new Error("unsafe relative path");
  return normalized;
}

export function policyDigest(policy = DEFAULT_SYNC_POLICY): string { return createHash("sha256").update(JSON.stringify(policy)).digest("hex"); }

export function sanitizeSyncEntry(input: SyncEntryInput, policy = DEFAULT_SYNC_POLICY): SanitizedSyncEntry {
  const path = normalizeRelativePath(input.relativePath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.documentId)) throw new Error("invalid document id");
  const state = input.state ?? "fresh";
  if (!(new Set<SyncEntryState>(["fresh", "stale", "quarantined", "deleted"])).has(state)) throw new Error("invalid sync state");
  if (!policy.allowedPrefixes.some((prefix) => path.startsWith(prefix)) || !path.endsWith(policy.allowedExtension)) throw new Error("path denied by sync policy");
  const content = input.content.replaceAll("\u0000", "");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > policy.maxEntryBytes) throw new Error("sync entry exceeds policy size cap");
  return { documentId: input.documentId, relativePath: path, state, content, bytes, sha256: createHash("sha256").update(content).digest("hex"), policyDigest: policyDigest(policy) };
}
