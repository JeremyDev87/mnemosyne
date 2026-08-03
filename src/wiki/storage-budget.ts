const DEFAULT_RECEIPT_MAX_AGE_MS = 30_000;
const DEFAULT_LEASE_TTL_MS = 60_000;

export type StorageBudgetErrorCode =
  | "USAGE_SCAN_FAILED"
  | "USAGE_SCAN_INCOMPLETE"
  | "USAGE_RECEIPT_STALE"
  | "LEASE_UNAVAILABLE"
  | "LEASE_RELEASE_FAILED";

export class StorageBudgetError extends Error {
  constructor(readonly code: StorageBudgetErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageBudgetError";
  }
}

export interface LogicalUsageReceipt {
  prefix: string;
  bytes: number;
  objects: number;
  pages: number;
  scannedAt: number;
}

export interface StorageBudgetLease {
  prefix: string;
  owner: string;
  expiresAt: number;
  receipt: LogicalUsageReceipt;
  projectedBytes: number;
}

interface ScanOptions {
  now?: () => number;
}

interface AcquireOptions {
  receipt: LogicalUsageReceipt;
  projectedBytes: number;
  owner?: string;
  now?: number;
  receiptMaxAgeMs?: number;
  leaseTtlMs?: number;
}

interface LeaseRow {
  leaseOwner: string;
  leaseExpiresAt: number;
}

interface ReleasedRow {
  prefix: string;
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function assertByteCount(bytes: number, label: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new StorageBudgetError("USAGE_SCAN_FAILED", `${label} must be a non-negative safe integer`);
}

function isBudgetedKey(key: string, prefix: string): boolean {
  const root = prefix ? `${prefix}/` : "";
  return ["current", "history", "manifests", "import-evidence"]
    .some((directory) => key.startsWith(`${root}${directory}/`));
}

export async function scanR2LogicalUsage(bucket: R2Bucket, rawPrefix: string, options: ScanOptions = {}): Promise<LogicalUsageReceipt> {
  const prefix = normalizePrefix(rawPrefix);
  let cursor: string | undefined;
  let bytes = 0;
  let objects = 0;
  let pages = 0;
  const seenCursors = new Set<string>();
  let hasMore = true;

  try {
    while (hasMore) {
      const page = await bucket.list({ prefix: prefix ? `${prefix}/` : undefined, cursor });
      pages += 1;
      for (const object of page.objects) {
        if (!isBudgetedKey(object.key, prefix)) continue;
        assertByteCount(object.size, `R2 object size for ${object.key}`);
        bytes += object.size;
        if (!Number.isSafeInteger(bytes)) throw new StorageBudgetError("USAGE_SCAN_FAILED", "Aggregate R2 logical usage exceeds the safe integer range");
        objects += 1;
      }

      if (page.truncated) {
        const nextCursor = page.cursor;
        if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) {
          throw new StorageBudgetError("USAGE_SCAN_INCOMPLETE", "R2 usage listing ended with an incomplete continuation cursor");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } else {
        hasMore = false;
      }
    }
  } catch (error) {
    if (error instanceof StorageBudgetError) throw error;
    throw new StorageBudgetError("USAGE_SCAN_FAILED", "Unable to complete the aggregate R2 logical usage scan", { cause: error });
  }

  const scannedAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(scannedAt) || scannedAt < 0) {
    throw new StorageBudgetError("USAGE_SCAN_FAILED", "Usage receipt timestamp is invalid");
  }
  return { prefix, bytes, objects, pages, scannedAt };
}

export async function acquireStorageBudgetLease(db: D1Database, options: AcquireOptions): Promise<StorageBudgetLease> {
  const now = options.now ?? Date.now();
  const receiptMaxAgeMs = options.receiptMaxAgeMs ?? DEFAULT_RECEIPT_MAX_AGE_MS;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const prefix = normalizePrefix(options.receipt.prefix);
  assertByteCount(options.receipt.bytes, "Receipt bytes");
  assertByteCount(options.projectedBytes, "Projected bytes");

  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0 || !Number.isSafeInteger(receiptMaxAgeMs) || receiptMaxAgeMs < 0) {
    throw new StorageBudgetError("USAGE_RECEIPT_STALE", "Storage budget timing configuration is invalid");
  }
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(options.receipt.scannedAt)
    || options.receipt.scannedAt < 0 || now < options.receipt.scannedAt
    || now - options.receipt.scannedAt > receiptMaxAgeMs) {
    throw new StorageBudgetError("USAGE_RECEIPT_STALE", "Aggregate R2 usage receipt is stale");
  }

  const owner = options.owner ?? crypto.randomUUID();
  const expiresAt = now + leaseTtlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new StorageBudgetError("LEASE_UNAVAILABLE", "Storage budget lease expiry is invalid");
  const reservedBytes = Math.max(0, options.projectedBytes - options.receipt.bytes);

  try {
    const row = await db.prepare(`INSERT INTO storage_budget_leases (
      prefix, lease_owner, lease_expires_at, logical_bytes, reserved_bytes, receipt_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(prefix) DO UPDATE SET
      lease_owner = excluded.lease_owner,
      lease_expires_at = excluded.lease_expires_at,
      logical_bytes = excluded.logical_bytes,
      reserved_bytes = excluded.reserved_bytes,
      receipt_at = excluded.receipt_at,
      updated_at = excluded.updated_at
    WHERE storage_budget_leases.lease_owner IS NULL
      AND excluded.receipt_at > storage_budget_leases.updated_at
    RETURNING lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt`)
      .bind(prefix, owner, expiresAt, options.receipt.bytes, reservedBytes, options.receipt.scannedAt, now)
      .first<LeaseRow>();
    if (!row || row.leaseOwner !== owner || row.leaseExpiresAt !== expiresAt) {
      throw new StorageBudgetError("LEASE_UNAVAILABLE", "Another storage writer holds the budget lease");
    }
  } catch (error) {
    if (error instanceof StorageBudgetError) throw error;
    throw new StorageBudgetError("LEASE_UNAVAILABLE", "Unable to acquire the D1 storage budget lease", { cause: error });
  }

  return { prefix, owner, expiresAt, receipt: { ...options.receipt, prefix }, projectedBytes: options.projectedBytes };
}

export async function releaseStorageBudgetLease(db: D1Database, lease: StorageBudgetLease, logicalBytes: number, now = Date.now()): Promise<void> {
  assertByteCount(logicalBytes, "Final logical bytes");
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new StorageBudgetError("LEASE_RELEASE_FAILED", "Storage budget lease release timestamp is invalid");
  }
  try {
    const row = await db.prepare(`UPDATE storage_budget_leases
      SET lease_owner = NULL,
          lease_expires_at = 0,
          logical_bytes = ?,
          reserved_bytes = 0,
          receipt_at = ?,
          updated_at = ?
      WHERE prefix = ? AND lease_owner = ?
      RETURNING prefix`)
      .bind(logicalBytes, now, now, lease.prefix, lease.owner)
      .first<ReleasedRow>();
    if (!row) throw new StorageBudgetError("LEASE_RELEASE_FAILED", "Storage budget lease ownership changed before release");
  } catch (error) {
    if (error instanceof StorageBudgetError) throw error;
    throw new StorageBudgetError("LEASE_RELEASE_FAILED", "Unable to release the D1 storage budget lease", { cause: error });
  }
}
