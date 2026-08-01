import { createPatch } from "diff";
import { indexDocument } from "./indexer";
import { assertEditablePath, validatePersonalOpsDocument } from "../personal-ops/policy";

export interface StoredDocument { path: string; content: string; etag: string; hash: string; uploaded: string }
export interface SaveResult { state: "saved" | "index_pending"; document: StoredDocument; changeId: string; warnings: unknown[] }

export function objectKey(prefix: string, path: string): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return `${cleanPrefix ? `${cleanPrefix}/` : ""}current/${path}`;
}

export async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readDocument(bucket: R2Bucket, prefix: string, path: string): Promise<StoredDocument | null> {
  const object = await bucket.get(objectKey(prefix, path));
  if (!object) return null;
  const content = await object.text();
  return { path, content, etag: object.etag, hash: await sha256(content), uploaded: object.uploaded.toISOString() };
}

export function createDocumentPatch(path: string, before: string, after: string): string {
  return createPatch(path, before, after, "current", "proposed", { context: 3 });
}

export async function savePersonalOpsDocument(args: {
  bucket: R2Bucket; db: D1Database; prefix: string; path: string; content: string; baseEtag: string; actor: string; writeEnabled: boolean;
}): Promise<SaveResult> {
  if (!args.writeEnabled) throw new Response("Writes are disabled", { status: 403 });
  assertEditablePath(args.path);
  const validation = validatePersonalOpsDocument(args.path, args.content);
  if (!validation.valid) throw new Response(JSON.stringify(validation), { status: 422, headers: { "content-type": "application/json" } });
  const current = await args.bucket.get(objectKey(args.prefix, args.path));
  if (!current) throw new Response("Document not found", { status: 404 });
  if (current.etag !== args.baseEtag) throw new Response("Document changed; reload before saving", { status: 412 });
  const before = await current.text();
  const beforeHash = await sha256(before);
  const afterHash = await sha256(args.content);
  if (beforeHash === afterHash) throw new Response("No changes", { status: 409 });
  const changeId = crypto.randomUUID();
  const historyKey = `${args.prefix.replace(/^\/+|\/+$/g, "")}/history/${args.path}/${beforeHash}.md`;
  if (!await args.bucket.head(historyKey)) {
    await args.bucket.put(historyKey, before, { customMetadata: { hash: beforeHash, replacedBy: afterHash, changeId } });
  }
  const put = await args.bucket.put(objectKey(args.prefix, args.path), args.content, {
    onlyIf: { etagMatches: args.baseEtag },
    customMetadata: { hash: afterHash, baseHash: beforeHash, actor: args.actor, changedAt: new Date().toISOString(), changeId }
  });
  if (!put) throw new Response("Document changed; reload before saving", { status: 412 });
  const readback = await readDocument(args.bucket, args.prefix, args.path);
  if (!readback || readback.hash !== afterHash) throw new Error("R2 readback hash mismatch");
  try {
    await indexDocument(args.db, args.path, args.content, afterHash);
    return { state: "saved", document: readback, changeId, warnings: validation.warnings };
  } catch {
    return { state: "index_pending", document: readback, changeId, warnings: [...validation.warnings, { code: "INDEX_PENDING" }] };
  }
}
