import { describe, expect, it } from "vitest";
import { R2_BLOCK_BYTES, R2_WARNING_BYTES } from "../src/config/budget";
import {
  StorageBudgetError,
  acquireStorageBudgetLease,
  releaseStorageBudgetLease,
  scanR2LogicalUsage,
  type LogicalUsageReceipt
} from "../src/wiki/storage-budget";

interface ListedObject { key: string; size: number }

class PagedBucket {
  constructor(
    private readonly pages: Array<{ objects: ListedObject[]; truncated: boolean; cursor?: string }>,
    private readonly failurePage = -1
  ) {}

  async list(options?: { cursor?: string }) {
    const pageIndex = options?.cursor ? Number(options.cursor.replace("page-", "")) : 0;
    if (pageIndex === this.failurePage) throw new Error("R2 list unavailable");
    return this.pages[pageIndex] ?? { objects: [], truncated: false };
  }
}

interface LeaseRow {
  owner: string | null;
  expiresAt: number;
  logicalBytes: number;
  reservedBytes: number;
  receiptAt: number;
  updatedAt: number;
}

class FakeLeaseDb {
  row: LeaseRow | null = null;
  mutations = 0;

  prepare(sql: string) {
    return {
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (sql.includes("INSERT INTO storage_budget_leases")) {
            const [prefix, owner, expiresAt, logicalBytes, reservedBytes, receiptAt, updatedAt] = params as [string, string, number, number, number, number, number];
            void prefix;
            if (this.row) {
              const eligible = this.row.owner === null
                ? receiptAt > this.row.updatedAt
                : this.row.expiresAt <= updatedAt && receiptAt > this.row.expiresAt;
              if (!eligible) return null;
            }
            this.row = { owner, expiresAt, logicalBytes, reservedBytes, receiptAt, updatedAt };
            this.mutations += 1;
            return { leaseOwner: owner, leaseExpiresAt: expiresAt };
          }
          if (sql.includes("UPDATE storage_budget_leases")) {
            const [logicalBytes, receiptAt, updatedAt, prefix, owner] = params as [number, number, number, string, string];
            void prefix;
            void updatedAt;
            if (!this.row || this.row.owner !== owner) return null;
            this.row = { owner: null, expiresAt: 0, logicalBytes, reservedBytes: 0, receiptAt, updatedAt };
            this.mutations += 1;
            return { prefix: "shadow" };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }
      })
    };
  }
}

function receipt(bytes: number, scannedAt: number): LogicalUsageReceipt {
  return { prefix: "shadow", bytes, objects: 1, pages: 1, scannedAt };
}

describe("aggregate R2 logical usage scan", () => {
  it("aggregates every budgeted root across every page and ignores other roots", async () => {
    const bucket = new PagedBucket([
      {
        objects: [
          { key: "shadow/current/a.md", size: 11 },
          { key: "shadow/history/a.md/hash.md", size: 13 },
          { key: "shadow/other/cache", size: 10_000 }
        ],
        truncated: true,
        cursor: "page-1"
      },
      {
        objects: [
          { key: "shadow/manifests/import.json", size: 17 },
          { key: "shadow/import-evidence/receipt.json", size: 19 },
          { key: "unrelated/current/a.md", size: 20_000 }
        ],
        truncated: false
      }
    ]);

    await expect(scanR2LogicalUsage(bucket as unknown as R2Bucket, "shadow", { now: () => 1234 })).resolves.toEqual({
      prefix: "shadow",
      bytes: 60,
      objects: 4,
      pages: 2,
      scannedAt: 1234
    });
  });

  it("fails closed on list errors, missing continuation cursors, and cursor loops", async () => {
    const listError = new PagedBucket([{ objects: [], truncated: true, cursor: "page-1" }], 1);
    const incomplete = new PagedBucket([{ objects: [], truncated: true }]);
    const loop = new PagedBucket([
      { objects: [], truncated: true, cursor: "page-1" },
      { objects: [], truncated: true, cursor: "page-1" }
    ]);

    await expect(scanR2LogicalUsage(listError as unknown as R2Bucket, "shadow")).rejects.toMatchObject({ code: "USAGE_SCAN_FAILED" });
    await expect(scanR2LogicalUsage(incomplete as unknown as R2Bucket, "shadow")).rejects.toMatchObject({ code: "USAGE_SCAN_INCOMPLETE" });
    await expect(scanR2LogicalUsage(loop as unknown as R2Bucket, "shadow")).rejects.toMatchObject({ code: "USAGE_SCAN_INCOMPLETE" });
  });
});

describe("D1 storage budget lease/reservation", () => {
  it("rejects stale usage receipts without mutating D1", async () => {
    const db = new FakeLeaseDb();
    await expect(acquireStorageBudgetLease(db as unknown as D1Database, {
      receipt: receipt(R2_WARNING_BYTES - 1, 1_000),
      projectedBytes: R2_WARNING_BYTES - 1,
      owner: "writer-a",
      now: 31_001,
      receiptMaxAgeMs: 30_000
    })).rejects.toMatchObject({ code: "USAGE_RECEIPT_STALE" });
    expect(db.mutations).toBe(0);
  });

  it("admits only one writer while a lease is live", async () => {
    const db = new FakeLeaseDb();
    const first = await acquireStorageBudgetLease(db as unknown as D1Database, {
      receipt: receipt(100, 1_000), projectedBytes: 120, owner: "writer-a", now: 1_000
    });
    await expect(acquireStorageBudgetLease(db as unknown as D1Database, {
      receipt: receipt(100, 1_001), projectedBytes: 120, owner: "writer-b", now: 1_001
    })).rejects.toMatchObject({ code: "LEASE_UNAVAILABLE" });
    expect(db.mutations).toBe(1);
    await releaseStorageBudgetLease(db as unknown as D1Database, first, 120, 1_002);
    expect(db.row).toMatchObject({ owner: null, logicalBytes: 120, reservedBytes: 0 });
  });

  it("reclaims an expired lease and reconciles stale reservation totals from a fresh scan", async () => {
    const db = new FakeLeaseDb();
    db.row = { owner: "dead-writer", expiresAt: 999, logicalBytes: 50, reservedBytes: R2_BLOCK_BYTES, receiptAt: 500, updatedAt: 500 };
    const lease = await acquireStorageBudgetLease(db as unknown as D1Database, {
      receipt: receipt(400, 1_000), projectedBytes: 450, owner: "writer-b", now: 1_000
    });
    expect(lease.owner).toBe("writer-b");
    expect(db.row).toMatchObject({ owner: "writer-b", logicalBytes: 400, reservedBytes: 50, receiptAt: 1_000 });
  });

  it("rejects a pre-expiry scan when reclaiming an expired writer", async () => {
    const db = new FakeLeaseDb();
    db.row = { owner: "dead-writer", expiresAt: 1_000, logicalBytes: 50, reservedBytes: 25, receiptAt: 500, updatedAt: 500 };
    await expect(acquireStorageBudgetLease(db as unknown as D1Database, {
      receipt: receipt(75, 999), projectedBytes: 80, owner: "writer-b", now: 1_000
    })).rejects.toMatchObject({ code: "LEASE_UNAVAILABLE" });
    expect(db.mutations).toBe(0);
  });

  it("prevents double-spend from a scan completed before the prior writer released", async () => {
    const db = new FakeLeaseDb();
    const first = await acquireStorageBudgetLease(db as unknown as D1Database, {
      receipt: receipt(100, 1_000), projectedBytes: 120, owner: "writer-a", now: 1_000
    });
    await releaseStorageBudgetLease(db as unknown as D1Database, first, 120, 1_002);

    await expect(acquireStorageBudgetLease(db as unknown as D1Database, {
      receipt: receipt(100, 1_001), projectedBytes: 130, owner: "writer-b", now: 1_003
    })).rejects.toMatchObject({ code: "LEASE_UNAVAILABLE" });

    await expect(acquireStorageBudgetLease(db as unknown as D1Database, {
      receipt: receipt(120, 1_003), projectedBytes: 130, owner: "writer-b", now: 1_003
    })).resolves.toMatchObject({ owner: "writer-b", projectedBytes: 130 });
  });

  it("uses typed fail-closed errors", () => {
    expect(new StorageBudgetError("LEASE_UNAVAILABLE", "busy")).toMatchObject({ name: "StorageBudgetError", code: "LEASE_UNAVAILABLE" });
  });
});
