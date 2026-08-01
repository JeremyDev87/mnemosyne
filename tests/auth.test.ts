import { describe, expect, it } from "vitest";
import { requireIdentity } from "../src/auth";

async function rejectionStatus(promise: Promise<unknown>): Promise<number> {
  try { await promise; return 0; } catch (error) { return error instanceof Response ? error.status : -1; }
}

describe("authentication fails closed", () => {
  const config = { AUTH_MODE: "test", ENVIRONMENT: "test", ALLOWED_EMAILS: "owner@example.com" };

  it("accepts only the explicit local-test allowlist", async () => {
    const request = new Request("http://localhost/api", { headers: { "x-mnemosyne-test-user": "owner@example.com" } });
    await expect(requireIdentity(request, config)).resolves.toMatchObject({ email: "owner@example.com" });
  });

  it("rejects an unknown local-test identity", async () => {
    const request = new Request("http://localhost/api", { headers: { "x-mnemosyne-test-user": "other@example.com" } });
    expect(await rejectionStatus(requireIdentity(request, config))).toBe(403);
  });

  it("does not permit test auth outside the test environment", async () => {
    const request = new Request("https://example.com/api", { headers: { "x-mnemosyne-test-user": "owner@example.com" } });
    expect(await rejectionStatus(requireIdentity(request, { ...config, ENVIRONMENT: "production" }))).toBe(503);
  });
});
