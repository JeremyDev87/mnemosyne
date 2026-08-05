import { requireIdentity, type AuthConfig } from "./auth";
import { buildPersonalOpsSummary } from "./personal-ops/parser";
import { assertEditablePath, validatePersonalOpsDocument } from "./personal-ops/policy";
import { searchWiki } from "./wiki/indexer";
import { createDocumentPatch, readDocument, savePersonalOpsDocument } from "./wiki/storage";

export interface Env extends AuthConfig {
  WIKI: R2Bucket;
  WIKI_INDEX: D1Database;
  ASSETS: Fetcher;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  AI_ENABLED?: string;
  R2_PREFIX?: string;
  WRITE_ENABLED?: string;
}

const OPS_PATHS = {
  tasks: "brain/P6_prefrontal/personal-ops/tasks.md",
  schedule: "domains/personal-ops/schedule.md",
  inbox: "domains/personal-ops/inbox.md"
} as const;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

const MAX_HTTP_BODY_BYTES = 1_200_000;

async function body<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Response("Unsupported content type", { status: 415 });

  const reader = request.body?.getReader();
  if (!reader) throw new Response("Malformed JSON", { status: 400 });
  const bytes = new Uint8Array(MAX_HTTP_BODY_BYTES);
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const nextByteLength = byteLength + value.byteLength;
    if (nextByteLength > MAX_HTTP_BODY_BYTES) {
      void reader.cancel("Payload too large").catch(() => undefined);
      throw new Response("Payload too large", { status: 413 });
    }
    bytes.set(value, byteLength);
    byteLength = nextByteLength;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, byteLength)));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON body must be an object");
    }
    return parsed as T;
  } catch {
    throw new Response("Malformed JSON", { status: 400 });
  }
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/health") return json({ status: "ok", service: "mnemosyne", writes: env.WRITE_ENABLED === "true" });
  const identity = await requireIdentity(request, env);
  const prefix = env.R2_PREFIX ?? "shadow";

  if (request.method === "POST" && url.pathname === "/api/wiki/search") {
    const payload = await body<{ query?: unknown }>(request);
    const query = typeof payload.query === "string" ? payload.query.trim() : "";
    if (!query.trim()) return json({ error: "query is required" }, 400);
    if (query.length > 512) return json({ error: "query is too long" }, 413);
    return json({ results: await searchWiki(env.WIKI_INDEX, query) });
  }

  if (request.method === "POST" && url.pathname === "/api/wiki/ask") {
    const payload = await body<{ question?: string }>(request);
    const question = payload.question?.trim() ?? "";
    if (!question) return json({ error: "question is required" }, 400);
    const results = await searchWiki(env.WIKI_INDEX, question, 8);
    return json({ answer: null, mode: "citation-search", citations: results });
  }

  if (request.method === "GET" && url.pathname === "/api/ops/summary") {
    const [tasks, schedule, inbox] = await Promise.all(Object.values(OPS_PATHS).map((path) => readDocument(env.WIKI, prefix, path)));
    if (!tasks || !schedule || !inbox) return json({ error: "Personal Ops shadow documents are not imported", missing: [!tasks && OPS_PATHS.tasks, !schedule && OPS_PATHS.schedule, !inbox && OPS_PATHS.inbox].filter(Boolean) }, 424);
    return json(buildPersonalOpsSummary({ tasks: tasks.content, schedule: schedule.content, inbox: inbox.content }));
  }

  if (request.method === "GET" && url.pathname === "/api/ops/doc") {
    const path = url.searchParams.get("path") ?? "";
    try { assertEditablePath(path); } catch { return json({ error: "read-only path" }, 403); }
    const document = await readDocument(env.WIKI, prefix, path);
    return document ? json(document) : json({ error: "document not found" }, 404);
  }

  if (request.method === "POST" && url.pathname === "/api/ops/validate") {
    const payload = await body<{ path?: string; content?: string; baseEtag?: string }>(request);
    const path = payload.path ?? "";
    const content = payload.content ?? "";
    try { assertEditablePath(path); } catch { return json({ error: "read-only path" }, 403); }
    const current = await readDocument(env.WIKI, prefix, path);
    if (!current) return json({ error: "document not found" }, 404);
    if (payload.baseEtag !== current.etag) return json({ error: "document changed; reload" }, 412);
    const validation = validatePersonalOpsDocument(path, content);
    return json({ validation, patch: createDocumentPatch(path, current.content, content), changed: current.content !== content });
  }

  if (request.method === "PUT" && url.pathname === "/api/ops/doc") {
    const payload = await body<{ path?: string; content?: string; baseEtag?: string }>(request);
    if (!payload.path || typeof payload.content !== "string" || !payload.baseEtag) return json({ error: "path, content and baseEtag are required" }, 400);
    return json(await savePersonalOpsDocument({
      bucket: env.WIKI, db: env.WIKI_INDEX, prefix, path: payload.path, content: payload.content,
      baseEtag: payload.baseEtag, actor: identity.email, writeEnabled: env.WRITE_ENABLED === "true"
    }));
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      return await env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof Response) return error.headers.get("content-type")?.includes("application/json") ? error : json({ error: await error.text() }, error.status);
      console.error("request_failed", { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      return json({ error: "internal error" }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
