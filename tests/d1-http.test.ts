import { describe, expect, it } from "vitest";
import { CloudflareD1HttpDatabase, readD1ImportSnapshot, type D1QueryDatabase } from "../src/wiki/d1-http";

describe("Cloudflare D1 HTTP adapter", () => {
  it("sends parameterized queries to the configured database", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const db = new CloudflareD1HttpDatabase({
      accountId: "account",
      databaseId: "database",
      apiToken: "token",
      fetchImpl: async (input, init) => {
        request = { url: String(input), init: init ?? {} };
        return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
      }
    });

    await db.execute("SELECT * FROM wiki_pages WHERE path = ?", ["docs/example.md"]);

    expect(request?.url).toBe("https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/query");
    expect(request?.init.headers).toMatchObject({ authorization: "Bearer token", "content-type": "application/json" });
    expect(JSON.parse(String(request?.init.body))).toEqual({ sql: "SELECT * FROM wiki_pages WHERE path = ?", params: ["docs/example.md"] });
  });

  it("returns rows from the D1 result envelope", async () => {
    const db = new CloudflareD1HttpDatabase({
      accountId: "account",
      databaseId: "database",
      apiToken: "token",
      fetchImpl: async () => new Response(JSON.stringify({
        success: true,
        result: [{ success: true, results: [{ path: "docs/example.md", hash: "abc" }] }]
      }), { status: 200 })
    });

    await expect(db.query<{ path: string; hash: string }>("SELECT path, hash FROM wiki_pages")).resolves.toEqual([
      { path: "docs/example.md", hash: "abc" }
    ]);
  });

  it("reads the complete D1 import snapshot contract", async () => {
    const database: D1QueryDatabase = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes("sqlite_schema")) return [{ name: "wiki_pages", type: "table" }] as T[];
        if (sql === "PRAGMA table_info(wiki_pages)") return [{ name: "path", type: "TEXT" }] as T[];
        if (sql === "PRAGMA table_info(wiki_fts)") return [{ name: "path", type: "" }] as T[];
        if (sql === "PRAGMA table_info(index_status)") return [{ name: "state", type: "TEXT" }] as T[];
        if (sql.includes("FROM index_status")) return [{ state: "ready", documentCount: 1, manifestHash: "abc" }] as T[];
        if (sql.includes("FROM wiki_pages")) return [{ path: "docs/example.md", hash: "abc" }] as T[];
        return [];
      }
    };

    await expect(readD1ImportSnapshot(database)).resolves.toEqual({
      objects: [{ name: "wiki_pages", type: "table" }],
      wikiPageColumns: [{ name: "path", type: "TEXT" }],
      wikiFtsColumns: [{ name: "path", type: "" }],
      indexStatusColumns: [{ name: "state", type: "TEXT" }],
      status: { state: "ready", documentCount: 1, manifestHash: "abc" },
      rows: [{ path: "docs/example.md", hash: "abc" }]
    });
  });

  it("fails without exposing the API token when D1 rejects a query", async () => {
    const db = new CloudflareD1HttpDatabase({
      accountId: "account",
      databaseId: "database",
      apiToken: "super-secret-token",
      fetchImpl: async () => new Response(JSON.stringify({ success: false, errors: [{ message: "schema mismatch" }] }), { status: 400 })
    });

    await expect(db.execute("SELECT 1")).rejects.toThrow("Cloudflare D1 query failed: schema mismatch");
    await expect(db.execute("SELECT 1")).rejects.not.toThrow("super-secret-token");
  });
});
