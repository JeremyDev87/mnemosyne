import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProvisionedTrustAnchor } from "../src/trust/trust-anchor";
import { assertOwnerOnlyPath, assertTrustedBundleLayout, assertTrustedHelperPath, classifyTrustedSignaturePair, parseTrustedHelperFailureReason } from "../src/trust/trusted-helper";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const keyId = "a".repeat(64);
const attestationId = "b".repeat(64);
const publicKeyPem = "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n";

describe("trusted Secure Enclave helper seam", () => {
  it("distinguishes post-authorization invalid successor from generic rejection", () => {
    expect(parseTrustedHelperFailureReason('{"status":"error","error":"trust state successor is invalid"}')).toBe("invalid-successor");
    expect(parseTrustedHelperFailureReason('{"status":"error","error":"app caller identity mismatch"}')).toBe("rejected");
    expect(parseTrustedHelperFailureReason("not-json")).toBe("rejected");
  });

  it("accepts exact local ad-hoc or same-team identities and rejects mixed identities", () => {
    const helper = { identifier: "com.jeremywinchester.mnemosyne.trust-helper", teamIdentifier: "not set" };
    const app = { identifier: "com.jeremywinchester.mnemosyne", teamIdentifier: undefined };
    expect(classifyTrustedSignaturePair(helper, app)).toBe("local-ad-hoc");
    expect(classifyTrustedSignaturePair({ ...helper, teamIdentifier: "TEAM123" }, { ...app, teamIdentifier: "TEAM123" })).toBe("team-signed");
    expect(() => classifyTrustedSignaturePair({ ...helper, teamIdentifier: "TEAM123" }, app)).toThrow(/signer identity/i);
    expect(() => classifyTrustedSignaturePair(helper, { ...app, identifier: "com.example.copy" })).toThrow(/app identifier/i);
  });

  it("requires the helper and app executable to share one packaged app layout", () => {
    assertTrustedBundleLayout("/Applications/Mnemosyne.app/Contents/Resources/mnemosyne-trust-helper", "/Applications/Mnemosyne.app/Contents/MacOS/Mnemosyne");
    expect(() => assertTrustedBundleLayout("/tmp/mnemosyne-trust-helper", "/Applications/Mnemosyne.app/Contents/MacOS/Mnemosyne")).toThrow(/packaged app layout/i);
    expect(() => assertTrustedBundleLayout("/Applications/Copy.app/Contents/Resources/mnemosyne-trust-helper", "/Applications/Mnemosyne.app/Contents/MacOS/Mnemosyne")).toThrow(/co-bundled/i);
  });

  it("requires an absolute, owner-only regular executable path", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-helper-"));
    roots.push(root);
    const helper = join(root, "helper");
    await writeFile(helper, "fixture");
    await chmod(helper, 0o755);
    expect(assertTrustedHelperPath(helper)).toBe(realpathSync(helper));
    await chmod(helper, 0o775);
    expect(() => assertTrustedHelperPath(helper)).toThrow(/writable by group/i);
    expect(() => assertTrustedHelperPath("relative/helper")).toThrow(/absolute/i);
    expect(() => assertOwnerOnlyPath("/Applications", process.getuid?.())).not.toThrow();
  });

  it("only activates when key identity and Keychain trust state agree", async () => {
    const invoke = async (_path: string, request: Readonly<Record<string, unknown>>) => {
      if (request.operation === "key-info") return { status: "ok" as const, key_id: keyId, public_key_pem: publicKeyPem };
      return {
        status: "ok" as const,
        trust_state: { version: 1 as const, key_id: keyId, accepted_sequence: 4, accepted_attestation_id: attestationId }
      };
    };
    await expect(loadProvisionedTrustAnchor("/trusted/helper", invoke)).resolves.toEqual({
      keyId,
      publicKeyPem,
      acceptedSequence: 4,
      acceptedAttestationId: attestationId
    });

    const mismatched = async (_path: string, request: Readonly<Record<string, unknown>>) => {
      if (request.operation === "key-info") return { status: "ok" as const, key_id: keyId, public_key_pem: publicKeyPem };
      return {
        status: "ok" as const,
        trust_state: { version: 1 as const, key_id: "c".repeat(64), accepted_sequence: 4, accepted_attestation_id: attestationId }
      };
    };
    await expect(loadProvisionedTrustAnchor("/trusted/helper", mismatched)).resolves.toBeUndefined();
  });
});
