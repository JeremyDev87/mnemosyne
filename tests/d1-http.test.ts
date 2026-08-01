import { describe, expect, it } from "vitest";
import { CloudflareD1HttpDatabase } from "../src/wiki/d1-http";

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
