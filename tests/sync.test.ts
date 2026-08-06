import { describe, expect, it } from "vitest";
import { bodyDigest, createDeviceKeyPair, InMemoryDeviceKeyRegistry, InMemoryNonceStore, signDeviceRequest, verifyDeviceRequest } from "../src/sync/device-auth";
import { sanitizeSyncEntry } from "../src/sync/policy";

const nonce = "nonce-00000000000001";

describe("default-deny sync policy", () => {
  it("allows only approved markdown prefixes and preserves policy evidence", () => {
    const entry = sanitizeSyncEntry({ documentId: "doc", relativePath: "domains/personal-ops/tasks.md", content: "# task\u0000" });
    expect(entry.relativePath).toBe("domains/personal-ops/tasks.md");
    expect(entry.state).toBe("fresh");
    expect(entry.content).toBe("# task");
    expect(entry.bytes).toBe(6);
    expect(() => sanitizeSyncEntry({ documentId: "bad/id", relativePath: "domains/personal-ops/tasks.md", content: "x" })).toThrow(/document/);
    expect(() => sanitizeSyncEntry({ documentId: "secret", relativePath: "raw/private.md", content: "x" })).toThrow(/denied/);
    expect(() => sanitizeSyncEntry({ documentId: "escape", relativePath: "domains/personal-ops/../raw.md", content: "x" })).toThrow(/unsafe/);
    expect(() => sanitizeSyncEntry({ documentId: "evil", relativePath: "domains/personal-ops/tasks\u0000.md", content: "x" })).toThrow(/unsafe/);
    expect(() => sanitizeSyncEntry({ documentId: "evil", relativePath: "domains/personal-ops/tasks.md", content: "x", state: "freshx" as never })).toThrow(/state/);
  });
});

describe("Ed25519 device request authentication", () => {
  it("binds device id to its registered key, verifies body, and rejects replay/tampering", () => {
    const { privateKey, publicKey } = createDeviceKeyPair();
    const registry = new InMemoryDeviceKeyRegistry();
    registry.register("mac-1", publicKey);
    const nonces = new InMemoryNonceStore();
    const now = 1_700_000_000_000;
    const body = "body";
    const signed = signDeviceRequest({ deviceId: "mac-1", timestamp: now, nonce, method: "post", path: "/api/ingest", bodySha256: bodyDigest(body) }, privateKey);
    expect(() => verifyDeviceRequest(signed, body, registry, nonces, now)).not.toThrow();
    expect(() => verifyDeviceRequest(signed, body, registry, nonces, now)).toThrow(/replay/);
    expect(() => verifyDeviceRequest(signed, "tampered", registry, new InMemoryNonceStore(), now)).toThrow(/body digest/);
    expect(() => verifyDeviceRequest({ ...signed, deviceId: "unknown-device" }, body, registry, new InMemoryNonceStore(), now)).toThrow(/unknown device/);
  });
  it("rejects requests outside the timestamp window", () => {
    const { privateKey, publicKey } = createDeviceKeyPair();
    const registry = new InMemoryDeviceKeyRegistry();
    registry.register("mac-1", publicKey);
    const signed = signDeviceRequest({ deviceId: "mac-1", timestamp: 1_000, nonce: "nonce-00000000000002", method: "POST", path: "/api/ingest", bodySha256: bodyDigest("") }, privateKey);
    expect(() => verifyDeviceRequest(signed, "", registry, new InMemoryNonceStore(), 1_000 + 300_001)).toThrow(/timestamp/);
    expect(() => verifyDeviceRequest(signed, "", registry, new InMemoryNonceStore(), 1_000 + 300_000)).toThrow(/timestamp/);
  });
});
