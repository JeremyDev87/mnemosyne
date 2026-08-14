import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProvisionedTrustAnchor } from "../src/trust/trust-anchor";
import { assertOwnerOnlyPath, assertTrustedBundleLayout, assertTrustedHelperPath, classifyTrustedSignaturePair, parseTrustedHelperFailureReason, runTrustedHelperProcess, TrustedHelperRejectedError } from "../src/trust/trusted-helper";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const keyId = "a".repeat(64);
const attestationId = "b".repeat(64);
const publicKeyPem = "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n";

describe("trusted Secure Enclave helper seam", () => {
  it("exercises real helper-process stdin/stdout and preserves exact request sequencing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-helper-process-"));
    roots.push(root);
    const helper = join(root, "helper.sh");
    await writeFile(helper, "#!/bin/sh\ninput=$(cat)\nprintf '%s' \"$input\" > \"$0.request\"\nprintf '%s\\n' '{\"status\":\"ok\",\"key_id\":null}'\n");
    await chmod(helper, 0o700);
    const request = { operation: "key-info" };

    await expect(runTrustedHelperProcess(helper, request)).resolves.toEqual({ status: "ok", key_id: null });
    await expect(readFile(`${helper}.request`, "utf8")).resolves.toBe(JSON.stringify(request));
  });

  it("reports missing-key rejection only after the process receives the request", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-helper-missing-key-"));
    roots.push(root);
    const helper = join(root, "helper.sh");
    await writeFile(helper, "#!/bin/sh\ncat > \"$0.request\"\nprintf '%s\\n' '{\"status\":\"error\",\"error\":\"secure enclave signing key is not enrolled\"}'\nexit 1\n");
    await chmod(helper, 0o700);

    await expect(runTrustedHelperProcess(helper, { operation: "attest-candidate" })).rejects.toEqual(new TrustedHelperRejectedError("not-enrolled"));
    await expect(readFile(`${helper}.request`, "utf8")).resolves.toBe(JSON.stringify({ operation: "attest-candidate" }));
  });

  it("kills a real helper process on timeout and rejects malformed successful stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-helper-timeout-"));
    roots.push(root);
    const timeoutHelper = join(root, "timeout.sh");
    const malformedHelper = join(root, "malformed.sh");
    await writeFile(timeoutHelper, "#!/bin/sh\nexec /bin/sleep 5\n");
    await writeFile(malformedHelper, "#!/bin/sh\nprintf 'not-json'\n");
    await Promise.all([chmod(timeoutHelper, 0o700), chmod(malformedHelper, 0o700)]);

    await expect(runTrustedHelperProcess(timeoutHelper, { operation: "key-info" }, { timeoutMs: 50 })).rejects.toThrow(/timed out/i);
    await expect(runTrustedHelperProcess(malformedHelper, { operation: "key-info" })).rejects.toThrow(/malformed response/i);
  });

  it("kills helpers that exceed stdout or stderr byte ceilings", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-helper-output-limits-"));
    roots.push(root);
    const stdoutHelper = join(root, "stdout.sh");
    const stderrHelper = join(root, "stderr.sh");
    await writeFile(stdoutHelper, "#!/bin/sh\nprintf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'\n");
    await writeFile(stderrHelper, "#!/bin/sh\nprintf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >&2\nprintf '{}\\n'\n");
    await Promise.all([chmod(stdoutHelper, 0o700), chmod(stderrHelper, 0o700)]);

    await expect(runTrustedHelperProcess(stdoutHelper, { operation: "key-info" }, { maxStdoutBytes: 16 })).rejects.toThrow(/response exceeded/i);
    await expect(runTrustedHelperProcess(stderrHelper, { operation: "key-info" }, { maxStderrBytes: 16 })).rejects.toThrow(/diagnostics exceeded/i);
  });

  it("distinguishes post-authorization invalid successor from generic rejection", () => {
    expect(parseTrustedHelperFailureReason('{"status":"error","error":"trust state successor is invalid"}')).toBe("invalid-successor");
    expect(parseTrustedHelperFailureReason('{"status":"error","error":"secure enclave signing key is not enrolled"}')).toBe("not-enrolled");
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

  it.skipIf(process.platform !== "darwin")("requires an absolute, owner-only regular executable path", async () => {
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
