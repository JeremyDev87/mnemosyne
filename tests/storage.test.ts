import { describe, expect, it } from "vitest";
import { objectKey, savePersonalOpsDocument } from "../src/wiki/storage";

const path = "brain/P6_prefrontal/personal-ops/tasks.md";
const before = `# Tasks\n\n| ID | Scope | 할일 | 상태 | 출처 |\n|---|---|---|---|---|\n| 1 | personal | 정리 | todo | user_explicit |`;
const after = `# Tasks\n\n| ID | Scope | 할일 | 상태 | 출처 |\n|---|---|---|---|---|\n| 1 | personal | 정리 | doing | user_explicit |`;

class FakeBucket {
  objects = new Map<string, { value: string; etag: string; metadata?: Record<string, string> }>();
  constructor() { this.objects.set(objectKey("shadow", path), { value: before, etag: "etag-before" }); }
  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { etag: object.etag, uploaded: new Date("2026-08-01T00:00:00Z"), text: async () => object.value };
  }
  async head(key: string) { return this.objects.has(key) ? { etag: this.objects.get(key)?.etag } : null; }
  async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string }; customMetadata?: Record<string, string> }) {
    const current = this.objects.get(key);
    if (options?.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    const etag = `etag-${this.objects.size + 1}`;
    this.objects.set(key, { value, etag, metadata: options?.customMetadata });
    return { etag };
  }
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try { await promise; return 0; } catch (error) { return error instanceof Response ? error.status : -1; }
}

const fakeDb = { batch: async () => { throw new Error("index offline"); }, prepare: () => ({ bind: () => ({}) }) } as unknown as D1Database;

describe("conditional R2 write pipeline", () => {
  it("rejects writes while the kill switch is off", async () => {
    const bucket = new FakeBucket();
    expect(await statusOf(savePersonalOpsDocument({ bucket: bucket as unknown as R2Bucket, db: fakeDb, prefix: "shadow", path, content: after, baseEtag: "etag-before", actor: "owner", writeEnabled: false }))).toBe(403);
  });

  it("rejects stale ETags", async () => {
    const bucket = new FakeBucket();
    expect(await statusOf(savePersonalOpsDocument({ bucket: bucket as unknown as R2Bucket, db: fakeDb, prefix: "shadow", path, content: after, baseEtag: "stale", actor: "owner", writeEnabled: true }))).toBe(412);
  });

  it("preserves history and reports index_pending when canonical readback succeeds", async () => {
    const bucket = new FakeBucket();
    const result = await savePersonalOpsDocument({ bucket: bucket as unknown as R2Bucket, db: fakeDb, prefix: "shadow", path, content: after, baseEtag: "etag-before", actor: "owner", writeEnabled: true });
    expect(result.state).toBe("index_pending");
    expect(result.document.content).toBe(after);
    expect([...bucket.objects.keys()].some((key) => key.includes(`/history/${path}/`))).toBe(true);
  });
});
