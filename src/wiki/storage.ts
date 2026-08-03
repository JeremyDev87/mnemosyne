import { createPatch } from "diff";
import { evaluateStorageBudget } from "../config/budget";
import { assertEditablePath, validatePersonalOpsDocument } from "../personal-ops/policy";
import { indexDocument } from "./indexer";
import {
  StorageBudgetError,
  acquireStorageBudgetLease,
  releaseStorageBudgetLease,
  scanR2LogicalUsage,
  type StorageBudgetLease
} from "./storage-budget";

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

function storageBudgetResponse(error: StorageBudgetError): Response {
  const message = error.code === "LEASE_UNAVAILABLE"
    ? "Storage writer state changed or is busy; retry with a fresh request"
    : "Storage budget verification is unavailable; write blocked";
  return new Response(message, { status: 503 });
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

  const encoder = new TextEncoder();
  const beforeBytes = current.size;
  const afterBytes = encoder.encode(args.content).byteLength;
  if (!Number.isSafeInteger(beforeBytes) || beforeBytes < 0 || encoder.encode(before).byteLength !== beforeBytes) {
    throw storageBudgetResponse(new StorageBudgetError("USAGE_SCAN_INCOMPLETE", "Current object size does not match its logical content size"));
  }
  const cleanPrefix = args.prefix.replace(/^\/+|\/+$/g, "");
  const historyKey = `${cleanPrefix ? `${cleanPrefix}/` : ""}history/${args.path}/${beforeHash}.md`;
  let historyExists: boolean;
  try {
    historyExists = Boolean(await args.bucket.head(historyKey));
  } catch (error) {
    throw storageBudgetResponse(new StorageBudgetError("USAGE_SCAN_FAILED", "Unable to verify the history projection", { cause: error }));
  }

  let receipt;
  try {
    receipt = await scanR2LogicalUsage(args.bucket, args.prefix);
  } catch (error) {
    if (error instanceof StorageBudgetError) throw storageBudgetResponse(error);
    throw error;
  }
  if (receipt.bytes < beforeBytes) {
    throw storageBudgetResponse(new StorageBudgetError("USAGE_SCAN_INCOMPLETE", "Usage scan omitted the current object"));
  }

  const projectedBytes = receipt.bytes + (historyExists ? 0 : beforeBytes) + afterBytes - beforeBytes;
  const budget = evaluateStorageBudget(receipt.bytes, projectedBytes);
  if (budget.state === "blocked") {
    throw new Response("R2 logical usage hard limit reached", { status: 507 });
  }

  let lease: StorageBudgetLease;
  try {
    lease = await acquireStorageBudgetLease(args.db, { receipt, projectedBytes });
  } catch (error) {
    if (error instanceof StorageBudgetError) throw storageBudgetResponse(error);
    throw error;
  }

  const warnings: unknown[] = [...validation.warnings];
  if (budget.state === "warning") {
    warnings.push({ code: "R2_BUDGET_WARNING", bytes: budget.bytes, limit: budget.limit });
  }

  const changeId = crypto.randomUUID();
  let logicalBytesAfterMutation = receipt.bytes;
  let result: SaveResult | undefined;
  let operationError: unknown;

  try {
    let historyExistsAtWrite = historyExists;
    if (!historyExistsAtWrite) historyExistsAtWrite = Boolean(await args.bucket.head(historyKey));
    if (!historyExistsAtWrite) {
      await args.bucket.put(historyKey, before, { customMetadata: { hash: beforeHash, replacedBy: afterHash, changeId } });
      logicalBytesAfterMutation += beforeBytes;
    }
    const put = await args.bucket.put(objectKey(args.prefix, args.path), args.content, {
      onlyIf: { etagMatches: args.baseEtag },
      customMetadata: { hash: afterHash, baseHash: beforeHash, actor: args.actor, changedAt: new Date().toISOString(), changeId }
    });
    if (!put) throw new Response("Document changed; reload before saving", { status: 412 });
    logicalBytesAfterMutation += afterBytes - beforeBytes;

    const readback = await readDocument(args.bucket, args.prefix, args.path);
    if (!readback || readback.hash !== afterHash) throw new Error("R2 readback hash mismatch");
    try {
      await indexDocument(args.db, args.path, args.content, afterHash);
      result = { state: "saved", document: readback, changeId, warnings };
    } catch {
      result = { state: "index_pending", document: readback, changeId, warnings: [...warnings, { code: "INDEX_PENDING" }] };
    }
  } catch (error) {
    operationError = error instanceof StorageBudgetError ? storageBudgetResponse(error) : error;
  }

  try {
    await releaseStorageBudgetLease(args.db, lease, logicalBytesAfterMutation);
  } catch {
    if (!operationError) {
      warnings.push({ code: "BUDGET_LEASE_RELEASE_PENDING" });
      if (result?.state === "index_pending") result.warnings = [...warnings, { code: "INDEX_PENDING" }];
    }
  }

  if (operationError) throw operationError;
  if (!result) throw new Error("Storage write completed without a result");
  return result;
}
