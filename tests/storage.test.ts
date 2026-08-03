import { describe, expect, it } from "vitest";
import { R2_BLOCK_BYTES, R2_WARNING_BYTES } from "../src/config/budget";
import { objectKey, savePersonalOpsDocument, sha256 } from "../src/wiki/storage";

const path = "brain/P6_prefrontal/personal-ops/tasks.md";
const before = `# Tasks\n\n| ID | Scope | 할일 | 상태 | 출처 |\n|---|---|---|---|---|\n| 1 | personal | 정리 | todo | user_explicit |`;
const after = `# Tasks\n\n| ID | Scope | 할일 | 상태 | 출처 |\n|---|---|---|---|---|\n| 1 | personal | 정리 | doing | user_explicit |`;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

interface FakeObject { value: string; etag: string; size: number; metadata?: Record<string, string> }

class FakeBucket {
  objects = new Map<string, FakeObject>();
  putCount = 0;
  listError = false;
  incompleteList = false;
  private pauseNextPut: Promise<void> | null = null;
  private notifyPutStarted: (() => void) | null = null;

  constructor(logicalBytes = byteLength(before)) {
    this.objects.set(objectKey("shadow", path), { value: before, etag: "etag-before", size: byteLength(before) });
    const fillerBytes = logicalBytes - byteLength(before);
    if (fillerBytes > 0) this.objects.set("shadow/manifests/filler.json", { value: "", etag: "filler", size: fillerBytes });
  }

  pauseOnePut(): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    this.pauseNextPut = new Promise<void>((resolve) => { release = resolve; });
    this.notifyPutStarted = markStarted;
    return { started, release };
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { etag: object.etag, size: object.size, uploaded: new Date("2026-08-01T00:00:00Z"), text: async () => object.value };
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { etag: object.etag, size: object.size } : null;
  }

  async list() {
    if (this.listError) throw new Error("R2 list offline");
    if (this.incompleteList) return { objects: [], truncated: true };
    return {
      objects: [...this.objects].map(([key, object]) => ({ key, size: object.size })),
      truncated: false
    };
  }

  async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string }; customMetadata?: Record<string, string> }) {
    this.putCount += 1;
    if (this.pauseNextPut) {
      this.notifyPutStarted?.();
      const paused = this.pauseNextPut;
      this.pauseNextPut = null;
      this.notifyPutStarted = null;
      await paused;
    }
    const current = this.objects.get(key);
    if (options?.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    const etag = `etag-${this.objects.size + this.putCount}`;
    this.objects.set(key, { value, size: byteLength(value), etag, metadata: options?.customMetadata });
    return { etag };
  }
}

interface LeaseRow { owner: string | null; expiresAt: number; logicalBytes: number; reservedBytes: number; receiptAt: number; updatedAt: number }

class FakeDb {
  lease: LeaseRow | null = null;
  leaseMutations = 0;
  indexAttempts = 0;
  constructor(private readonly indexOffline = true) {}

  prepare(sql: string) {
    const statement = {
      bind: (...params: unknown[]) => ({
        ...statement,
        first: async () => {
          if (sql.includes("INSERT INTO storage_budget_leases")) {
            const [, owner, expiresAt, logicalBytes, reservedBytes, receiptAt, now] = params as [string, string, number, number, number, number, number];
            if (this.lease) {
              const eligible = this.lease.owner === null
                ? receiptAt > this.lease.updatedAt
                : this.lease.expiresAt <= now && receiptAt > this.lease.expiresAt;
              if (!eligible) return null;
            }
            this.lease = { owner, expiresAt, logicalBytes, reservedBytes, receiptAt, updatedAt: now };
            this.leaseMutations += 1;
            return { leaseOwner: owner, leaseExpiresAt: expiresAt };
          }
          if (sql.includes("UPDATE storage_budget_leases")) {
            const [logicalBytes, receiptAt, updatedAt, , owner] = params as [number, number, number, string, string];
            if (!this.lease || this.lease.owner !== owner) return null;
            this.lease = { owner: null, expiresAt: 0, logicalBytes, reservedBytes: 0, receiptAt, updatedAt };
            this.leaseMutations += 1;
            return { prefix: "shadow" };
          }
          throw new Error(`Unexpected first(): ${sql}`);
        }
      })
    };
    return statement;
  }

  async batch() {
    this.indexAttempts += 1;
    if (this.indexOffline) throw new Error("index offline");
    return [];
  }
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try { await promise; return 0; } catch (error) { return error instanceof Response ? error.status : -1; }
}

function save(bucket: FakeBucket, db: FakeDb, content = after) {
  return savePersonalOpsDocument({
    bucket: bucket as unknown as R2Bucket,
    db: db as unknown as D1Database,
    prefix: "shadow",
    path,
    content,
    baseEtag: "etag-before",
    actor: "owner",
    writeEnabled: true
  });
}

describe("conditional R2 write pipeline", () => {
  it("rejects writes while the kill switch is off", async () => {
    const bucket = new FakeBucket();
    const db = new FakeDb();
    expect(await statusOf(savePersonalOpsDocument({ bucket: bucket as unknown as R2Bucket, db: db as unknown as D1Database, prefix: "shadow", path, content: after, baseEtag: "etag-before", actor: "owner", writeEnabled: false }))).toBe(403);
    expect(bucket.putCount).toBe(0);
    expect(db.leaseMutations).toBe(0);
  });

  it("rejects stale ETags before scanning or mutating storage", async () => {
    const bucket = new FakeBucket();
    const db = new FakeDb();
    expect(await statusOf(savePersonalOpsDocument({ bucket: bucket as unknown as R2Bucket, db: db as unknown as D1Database, prefix: "shadow", path, content: after, baseEtag: "stale", actor: "owner", writeEnabled: true }))).toBe(412);
    expect(bucket.putCount).toBe(0);
    expect(db.leaseMutations).toBe(0);
  });

  it.each([
    ["exact hard limit", R2_BLOCK_BYTES],
    ["over hard limit", R2_BLOCK_BYTES + 1]
  ])("blocks %s without history/current/D1 mutation", async (_label, logicalBytes) => {
    const bucket = new FakeBucket(logicalBytes);
    const db = new FakeDb();
    expect(await statusOf(save(bucket, db))).toBe(507);
    expect(bucket.putCount).toBe(0);
    expect(db.leaseMutations).toBe(0);
    expect(db.indexAttempts).toBe(0);
  });

  it("blocks an absent-history write whose projected append plus replacement reaches the exact limit", async () => {
    const bucket = new FakeBucket(R2_BLOCK_BYTES - byteLength(after));
    const db = new FakeDb();
    expect(await statusOf(save(bucket, db))).toBe(507);
    expect(bucket.putCount).toBe(0);
    expect(db.leaseMutations).toBe(0);
  });

  it("blocks an existing-history replacement whose projected delta reaches the exact limit", async () => {
    const replacementDelta = byteLength(after) - byteLength(before);
    expect(replacementDelta).toBeGreaterThan(0);
    const bucket = new FakeBucket(R2_BLOCK_BYTES - replacementDelta - byteLength(before));
    const historyKey = `shadow/history/${path}/${await sha256(before)}.md`;
    bucket.objects.set(historyKey, { value: before, size: byteLength(before), etag: "history-existing" });
    const db = new FakeDb();
    expect(await statusOf(save(bucket, db))).toBe(507);
    expect(bucket.putCount).toBe(0);
    expect(db.leaseMutations).toBe(0);
  });

  it("allows below-budget writes and emits a deterministic warning at 8 GiB", async () => {
    const belowBucket = new FakeBucket(1_024);
    const below = await save(belowBucket, new FakeDb());
    expect(below.warnings).not.toContainEqual(expect.objectContaining({ code: "R2_BUDGET_WARNING" }));

    const warningBucket = new FakeBucket(R2_WARNING_BYTES);
    const warning = await save(warningBucket, new FakeDb());
    expect(warning.warnings).toContainEqual(expect.objectContaining({ code: "R2_BUDGET_WARNING" }));
  });

  it.each(["error", "incomplete"])("fails closed when the aggregate usage scan is %s", async (failure) => {
    const bucket = new FakeBucket();
    if (failure === "error") bucket.listError = true;
    else bucket.incompleteList = true;
    const db = new FakeDb();
    expect(await statusOf(save(bucket, db))).toBe(503);
    expect(bucket.putCount).toBe(0);
    expect(db.leaseMutations).toBe(0);
  });

  it("preserves history and reports index_pending when canonical readback succeeds", async () => {
    const bucket = new FakeBucket();
    const result = await save(bucket, new FakeDb());
    expect(result.state).toBe("index_pending");
    expect(result.document.content).toBe(after);
    expect([...bucket.objects.keys()].some((key) => key.includes(`/history/${path}/`))).toBe(true);
  });

  it("reuses an existing idempotent history object without rewriting it", async () => {
    const bucket = new FakeBucket();
    const historyKey = `shadow/history/${path}/${await sha256(before)}.md`;
    bucket.objects.set(historyKey, { value: before, size: byteLength(before), etag: "history-existing" });
    const result = await save(bucket, new FakeDb());
    expect(result.document.content).toBe(after);
    expect(bucket.objects.get(historyKey)?.etag).toBe("history-existing");
    expect(bucket.putCount).toBe(1);
  });

  it("admits only one concurrent writer and leaves the rejected writer mutation-free", async () => {
    const bucket = new FakeBucket();
    const db = new FakeDb();
    const barrier = bucket.pauseOnePut();
    const first = save(bucket, db);
    await barrier.started;
    const putsBeforeSecond = bucket.putCount;
    expect(await statusOf(save(bucket, db))).toBe(503);
    expect(bucket.putCount).toBe(putsBeforeSecond);
    barrier.release();
    await expect(first).resolves.toMatchObject({ state: "index_pending" });
  });
});
