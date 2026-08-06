import { describe, expect, it } from "vitest";
import { readRuntimeConfig } from "../src/config/env";
import { OwnerAuthorizationError, privateNoStoreHeaders, requireOwner } from "../src/auth/owner";

describe("owner authorization contract", () => {
  const session = { authenticated: true, githubAccountId: "12345", expiresAt: 2_000 };
  it("accepts only the configured immutable account id", () => {
    expect(requireOwner(session, "12345", 1_000)).toEqual({ githubAccountId: "12345" });
    expect(() => requireOwner({ ...session, githubAccountId: "spoofed" }, "12345", 1_000)).toThrowError(new OwnerAuthorizationError("NOT_OWNER"));
  });
  it("fails closed for missing, unauthenticated, and expired sessions", () => {
    expect(() => requireOwner(null, "12345", 1_000)).toThrow(/UNAUTHENTICATED/);
    expect(() => requireOwner({ ...session, authenticated: false }, "12345", 1_000)).toThrow(/UNAUTHENTICATED/);
    expect(() => requireOwner(session, undefined, 1_000)).toThrow(/OWNER_NOT_CONFIGURED/);
    expect(() => requireOwner(session, "12345", 2_000)).toThrow(/SESSION_EXPIRED/);
  });
  it("fails closed for malformed owner configuration", () => {
    expect(() => readRuntimeConfig({ NODE_ENV: "test", OWNER_GITHUB_ACCOUNT_ID: "owner@example.com" })).toThrow(/immutable numeric/);
  });
  it("marks protected responses private and uncached", () => {
    expect(privateNoStoreHeaders().get("Cache-Control")).toBe("private, no-store");
  });
});
