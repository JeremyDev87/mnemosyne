import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker";

const MAX_HTTP_BODY_BYTES = 1_200_000;
const AUTH_HEADERS = { "x-mnemosyne-test-user": "owner@example.com" };
const TASKS_PATH = "brain/P6_prefrontal/personal-ops/tasks.md";
const TASKS_CONTENT = `| ID | Scope | 할일 | 상태 | 우선순위 | 출처 | 다음 액션 |
|---|---|---|---|---|---|---|
| 1 | personal | 테스트 | todo | - | user_explicit | 진행 |`;

interface Counters {
  r2: number;
  d1: number;
  ai: number;
  assets: number;
}

function createEnv(): { env: Env; calls: Counters } {
  const calls: Counters = { r2: 0, d1: 0, ai: 0, assets: 0 };
  const storedObject = {
    etag: "etag-current",
    uploaded: new Date("2026-08-01T00:00:00.000Z"),
    text: async () => TASKS_CONTENT
  } as unknown as R2ObjectBody;
  const statement = {
    bind() { return this; },
    async all() { return { results: [] }; }
  };
  const env = {
    AUTH_MODE: "test",
    ENVIRONMENT: "test",
    ALLOWED_EMAILS: "owner@example.com",
    WRITE_ENABLED: "false",
    WIKI: {
      async get() { calls.r2 += 1; return storedObject; },
      async head() { calls.r2 += 1; return null; },
      async put() { calls.r2 += 1; return null; }
    } as unknown as R2Bucket,
    WIKI_INDEX: {
      prepare() { calls.d1 += 1; return statement; },
      async batch() { calls.d1 += 1; return []; }
    } as unknown as D1Database,
    AI: {
      async run() { calls.ai += 1; return { response: "answer" }; }
    },
    ASSETS: {
      async fetch() { calls.assets += 1; return new Response("asset"); }
    } as unknown as Fetcher
  } satisfies Env;
  return { env, calls };
}

function apiRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(AUTH_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Request(`https://mnemosyne.test${path}`, { ...init, headers });
}

function streamRequest(path: string, stream: ReadableStream<Uint8Array>, headers: HeadersInit): Request {
  return apiRequest(path, {
    method: "POST",
    headers,
    body: stream,
    duplex: "half"
  } as RequestInit & { duplex: "half" });
}

function byteStream(bytes: Uint8Array, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  });
}

function jsonWithExactByteLength(byteLength: number): string {
  const encoder = new TextEncoder();
  const multibyte = "기억💾";
  const base = JSON.stringify({ question: "ok", padding: multibyte });
  const fillLength = byteLength - encoder.encode(base).byteLength;
  if (fillLength < 0) throw new Error("target byte length is too small");
  const payload = JSON.stringify({ question: "ok", padding: `${"x".repeat(fillLength)}${multibyte}` });
  if (encoder.encode(payload).byteLength !== byteLength) throw new Error("failed to construct exact byte payload");
  return payload;
}

async function fetchApi(request: Request, env: Env): Promise<Response> {
  return await worker.fetch(request, env);
}

function expectNoDownstreamCalls(calls: Counters): void {
  expect(calls.r2).toBe(0);
  expect(calls.d1).toBe(0);
  expect(calls.ai).toBe(0);
}

const BODY_ROUTES = [
  { method: "POST", path: "/api/wiki/search" },
  { method: "POST", path: "/api/wiki/ask" },
  { method: "POST", path: "/api/ops/validate" },
  { method: "PUT", path: "/api/ops/doc" }
] as const;

describe("default worker fetch routes", () => {
  it("serves health without authentication or downstream calls", async () => {
    const { env, calls } = createEnv();
    const response = await fetchApi(new Request("https://mnemosyne.test/api/health"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", service: "mnemosyne", writes: false });
    expectNoDownstreamCalls(calls);
  });

  it("preserves authentication before protected route work", async () => {
    const { env, calls } = createEnv();
    const response = await fetchApi(new Request("https://mnemosyne.test/api/wiki/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "memory" })
    }), env);

    expect(response.status).toBe(403);
    expectNoDownstreamCalls(calls);
  });

  it("searches through D1 for an authenticated request", async () => {
    const { env, calls } = createEnv();
    const response = await fetchApi(apiRequest("/api/wiki/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "memory" })
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [] });
    expect(calls.d1).toBe(1);
    expect(calls.r2).toBe(0);
    expect(calls.ai).toBe(0);
  });

  it("never accepts a search query in the URL", async () => {
    const { env, calls } = createEnv();
    const response = await fetchApi(apiRequest("/api/wiki/search?q=private-query"), env);

    expect(response.status).toBe(404);
    expectNoDownstreamCalls(calls);
  });

  it("keeps ask in citation-search mode even when an AI binding is present", async () => {
    const { env, calls } = createEnv();
    env.AI_ENABLED = "true";
    env.WIKI_INDEX = {
      prepare() {
        calls.d1 += 1;
        return {
          bind() { return this; },
          async all() {
            return { results: [{
              path: "docs/current.md",
              title: "Current",
              excerpt: "evidence",
              authority_kind: "brain-p1",
              authority_priority: 10,
              answerable_as_current: 1,
              canonical_path: null,
              status: "current",
              source_role: "canonical",
              last_verified: "2026-08-04"
            }] };
          }
        };
      }
    } as unknown as D1Database;
    const response = await fetchApi(apiRequest("/api/wiki/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "memory" })
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ answer: null, mode: "citation-search", citations: [{ path: "docs/current.md" }] });
    expect(calls.d1).toBe(1);
    expect(calls.ai).toBe(0);
  });

  it("validates a JSON document through R2", async () => {
    const { env, calls } = createEnv();
    const response = await fetchApi(apiRequest("/api/ops/validate", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ path: TASKS_PATH, content: TASKS_CONTENT, baseEtag: "etag-current" })
    }), env);

    expect(response.status).toBe(200);
    expect(calls.r2).toBe(1);
    expect(calls.d1).toBe(0);
    expect(calls.ai).toBe(0);
  });

  it("routes a valid write body to the existing write policy", async () => {
    const { env, calls } = createEnv();
    const response = await fetchApi(apiRequest("/api/ops/doc", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: TASKS_PATH, content: TASKS_CONTENT, baseEtag: "etag-current" })
    }), env);

    expect(response.status).toBe(403);
    expectNoDownstreamCalls(calls);
  });
});

describe("actual-byte JSON ingress", () => {
  for (const route of BODY_ROUTES) {
    it(`rejects unsupported Content-Type before downstream work for ${route.method} ${route.path}`, async () => {
      const { env, calls } = createEnv();
      const response = await fetchApi(apiRequest(route.path, {
        method: route.method,
        headers: { "content-type": "text/plain" },
        body: "{}"
      }), env);

      expect(response.status).toBe(415);
      expectNoDownstreamCalls(calls);
    });

    it(`returns 400 for malformed JSON before downstream work for ${route.method} ${route.path}`, async () => {
      const { env, calls } = createEnv();
      const response = await fetchApi(apiRequest(route.path, {
        method: route.method,
        headers: { "content-type": "application/json" },
        body: "{not-json"
      }), env);

      expect(response.status).toBe(400);
      expectNoDownstreamCalls(calls);
    });
  }

  const misleadingHeaders: Array<{ name: string; headers: HeadersInit }> = [
    { name: "absent Content-Length", headers: { "content-type": "application/json" } },
    { name: "false Content-Length", headers: { "content-type": "application/json", "content-length": "false" } },
    { name: "low Content-Length", headers: { "content-type": "application/json", "content-length": "1" } },
    { name: "non-numeric Content-Length", headers: { "content-type": "application/json", "content-length": "not-a-number" } },
    { name: "chunked transfer", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }
  ];

  for (const testCase of misleadingHeaders) {
    it(`returns 413 from streamed bytes with ${testCase.name}`, async () => {
      const { env, calls } = createEnv();
      const bytes = new Uint8Array(MAX_HTTP_BODY_BYTES + 1);
      bytes.fill(0x20);
      const request = streamRequest("/api/wiki/ask", byteStream(bytes), testCase.headers);
      const response = await fetchApi(request, env);

      expect(response.status).toBe(413);
      expectNoDownstreamCalls(calls);
    });
  }

  it("accepts a valid JSON envelope at the exact UTF-8 byte boundary", async () => {
    const { env, calls } = createEnv();
    const payload = jsonWithExactByteLength(MAX_HTTP_BODY_BYTES);
    const bytes = new TextEncoder().encode(payload);
    const response = await fetchApi(streamRequest("/api/wiki/ask", byteStream(bytes, 17_003), {
      "content-type": "application/json",
      "content-length": "1"
    }), env);

    expect(bytes.byteLength).toBe(MAX_HTTP_BODY_BYTES);
    expect(response.status).toBe(200);
    expect(calls.d1).toBe(1);
    expect(calls.r2).toBe(0);
    expect(calls.ai).toBe(0);
  });

  it("rejects a valid multibyte JSON envelope one UTF-8 byte over the boundary", async () => {
    const { env, calls } = createEnv();
    const payload = jsonWithExactByteLength(MAX_HTTP_BODY_BYTES + 1);
    const bytes = new TextEncoder().encode(payload);
    const response = await fetchApi(streamRequest("/api/wiki/ask", byteStream(bytes, 17_003), {
      "content-type": "application/json"
    }), env);

    expect(bytes.byteLength).toBe(MAX_HTTP_BODY_BYTES + 1);
    expect(response.status).toBe(413);
    expectNoDownstreamCalls(calls);
  });

  it("does not reject a small body solely because Content-Length claims it is large", async () => {
    const { env, calls } = createEnv();
    const response = await fetchApi(streamRequest("/api/wiki/ask", byteStream(new TextEncoder().encode('{"question":"ok"}')), {
      "content-type": "application/json",
      "content-length": String(MAX_HTTP_BODY_BYTES + 1)
    }), env);

    expect(response.status).toBe(200);
    expect(calls.d1).toBe(1);
  });

  for (const payload of ["null", "3", '"text"', "[]"]) {
    it(`returns 400 for non-object JSON ${payload} before downstream work`, async () => {
      const { env, calls } = createEnv();
      const response = await fetchApi(apiRequest("/api/wiki/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload
      }), env);

      expect(response.status).toBe(400);
      expectNoDownstreamCalls(calls);
    });
  }

  it("rejects malformed UTF-8 before downstream work", async () => {
    const { env, calls } = createEnv();
    const prefix = new TextEncoder().encode('{"question":"');
    const suffix = new TextEncoder().encode('"}');
    const bytes = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    bytes.set(prefix);
    bytes[prefix.byteLength] = 0xff;
    bytes.set(suffix, prefix.byteLength + 1);

    const response = await fetchApi(streamRequest("/api/wiki/ask", byteStream(bytes), {
      "content-type": "application/json"
    }), env);

    expect(response.status).toBe(400);
    expectNoDownstreamCalls(calls);
  });

  it("keeps one-byte chunks bounded while accepting the exact byte boundary", async () => {
    const { env, calls } = createEnv();
    const bytes = new TextEncoder().encode(jsonWithExactByteLength(MAX_HTTP_BODY_BYTES));
    const response = await fetchApi(streamRequest("/api/wiki/ask", byteStream(bytes, 1), {
      "content-type": "application/json"
    }), env);

    expect(response.status).toBe(200);
    expect(calls.d1).toBe(1);
  });

  it("returns 413 after cancellation starts without waiting for stalled teardown", async () => {
    const { env, calls } = createEnv();
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array(MAX_HTTP_BODY_BYTES));
        else if (pulls < 100) controller.enqueue(new Uint8Array(1));
        else controller.close();
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      }
    });

    const response = await fetchApi(streamRequest("/api/wiki/ask", stream, { "content-type": "application/json" }), env);

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(100);
    expectNoDownstreamCalls(calls);
  });
});
