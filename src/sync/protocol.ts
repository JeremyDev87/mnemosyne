import { bodyDigest, signDeviceRequest, type DeviceRequest } from "./device-auth";
import { sanitizeSyncEntry, type SanitizedSyncEntry } from "./policy";
import type { KeyObject } from "node:crypto";

export const MAX_SYNC_BODY_BYTES = 5 * 1024 * 1024;

export interface SyncBatch { generationId: string; policyDigest: string; entries: SanitizedSyncEntry[] }

export function createSyncBatch(generationId: string, entries: SanitizedSyncEntry[]): SyncBatch {
  const policyDigests = new Set(entries.map((entry) => entry.policyDigest));
  if (policyDigests.size > 1) throw new Error("sync batch contains multiple policy digests");
  const batch = { generationId, policyDigest: entries[0]?.policyDigest ?? "", entries };
  if (Buffer.byteLength(JSON.stringify(batch), "utf8") > MAX_SYNC_BODY_BYTES) throw new Error("sync batch exceeds request body cap");
  return structuredClone(batch);
}

export function signSyncBatch(batch: SyncBatch, key: KeyObject, timestamp: number, nonce: string, deviceId: string): DeviceRequest {
  const body = JSON.stringify(batch);
  return signDeviceRequest({ deviceId, timestamp, nonce, method: "POST", path: "/api/ingest/generations", bodySha256: bodyDigest(body) }, key);
}

export { sanitizeSyncEntry };
