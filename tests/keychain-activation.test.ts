import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KeychainActivationConflictError,
  KeychainActivationCoordinator,
  type KeychainActivationState,
  type KeychainTrustState,
  type KeychainTrustStore,
  TrustedHelperKeychainStore
} from "../src/wiki/keychain-activation";
import type { TrustedHelperResponse } from "../src/trust/trusted-helper";
import { canonicalAttestationPayload, snapshotAttestationId, snapshotPublicKeyId, type SnapshotAttestationPayload } from "../src/wiki/snapshot-attestation";

const roots: string[] = [];
const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKeyPem = signing.publicKey.export({ format: "pem", type: "spki" }).toString();
const keyId = snapshotPublicKeyId(publicKeyPem);
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

class MemoryKeychain implements KeychainTrustStore {
  state: KeychainTrustState | null = null;
  ambiguousCommit = false;
  rejectCommit = false;
  calls: string[] = [];

  async keyInfo(): Promise<Readonly<{ keyId: string; publicKeyPem: string }>> { this.calls.push("key-info"); return { keyId, publicKeyPem }; }
  async read(): Promise<KeychainTrustState | null> { this.calls.push("trust-read"); return this.state; }
  async compareAndSwap(expected: KeychainTrustState | null, next: KeychainTrustState): Promise<KeychainTrustState> {
    this.calls.push("trust-cas");
    if (this.rejectCommit || JSON.stringify(expected) !== JSON.stringify(this.state)) throw new Error("CAS rejected");
    this.state = next;
    if (this.ambiguousCommit) throw new Error("synthetic timeout after commit");
    return next;
  }
}

async function setup(store = new MemoryKeychain(), boundary?: (state: KeychainActivationState) => void | Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "mnemosyne-keychain-activation-"));
  roots.push(root);
  const attestationPath = join(root, "snapshots", "gen-0", "attestation.json");
  await mkdir(join(root, "snapshots", "gen-0"), { recursive: true });
  const payload: SnapshotAttestationPayload = {
    domain: "MNEMOSYNE-SNAPSHOT-ATTESTATION-V1",
    schema_version: 1,
    generation: "gen-0",
    sequence: 0,
    created_at: "2026-08-14T00:00:00Z",
    manifest_sha256: sha("manifest"),
    authority_sha256: sha("authority"),
    wikimap_index_sha256: sha("index"),
    previous_attestation_sha256: null
  };
  const attestation = {
    payload,
    key_id: keyId,
    signature_algorithm: "ECDSA_P256_SHA256" as const,
    signature: sign("sha256", canonicalAttestationPayload(payload), signing.privateKey).toString("base64")
  };
  const bytes = Buffer.from(JSON.stringify(attestation), "utf8");
  await writeFile(attestationPath, bytes, { mode: 0o600 });
  const candidate = { expectedGeneration: null, nextGeneration: "gen-0", attestationPath, attestationSha256: createHash("sha256").update(bytes).digest("hex") } as const;
  return { root, store, candidate, attestation, coordinator: new KeychainActivationCoordinator(root, store, boundary) };
}

async function successor(value: Awaited<ReturnType<typeof setup>>, boundary?: (state: KeychainActivationState) => void | Promise<void>) {
  const generation = "gen-1";
  const attestationPath = join(value.root, "snapshots", generation, "attestation.json");
  await mkdir(join(value.root, "snapshots", generation), { recursive: true });
  const payload: SnapshotAttestationPayload = {
    ...value.attestation.payload,
    generation,
    sequence: 1,
    created_at: "2026-08-14T00:00:01Z",
    previous_attestation_sha256: snapshotAttestationId(value.attestation)
  };
  const attestation = {
    payload,
    key_id: keyId,
    signature_algorithm: "ECDSA_P256_SHA256" as const,
    signature: sign("sha256", canonicalAttestationPayload(payload), signing.privateKey).toString("base64")
  };
  const bytes = Buffer.from(JSON.stringify(attestation));
  await writeFile(attestationPath, bytes, { mode: 0o600 });
  return {
    candidate: { expectedGeneration: "gen-0", nextGeneration: generation, attestationPath, attestationSha256: createHash("sha256").update(bytes).digest("hex") } as const,
    coordinator: new KeychainActivationCoordinator(value.root, value.store, boundary)
  };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Keychain-authoritative activation", () => {
  it("promotes pointer before helper CAS and persists only a non-authoritative receipt", async () => {
    const observed: KeychainActivationState[] = [];
    const value = await setup(new MemoryKeychain(), (state) => { observed.push(state); });
    await value.coordinator.activate(value.candidate, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(observed).toEqual(["prepared", "pointer_promoted", "trust_committed"]);
    expect(value.store.calls).toEqual(["trust-read", "key-info", "trust-cas", "trust-read"]);
    expect(JSON.parse(await readFile(value.coordinator.paths.pointerPath, "utf8"))).toMatchObject({ schema_version: 2, generation: "gen-0" });
    expect((await value.coordinator.inspectRecovery()).verdict).toBe("complete");
    expect(JSON.parse(await readFile(value.coordinator.paths.receiptPath, "utf8"))).toMatchObject({
      authority: "keychain-trust-cas",
      accepted_sequence: 0,
      accepted_attestation_id: snapshotAttestationId(value.attestation)
    });
  });

  it("requires durable attestation digest readback before pointer promotion", async () => {
    const value = await setup();
    await writeFile(value.candidate.attestationPath, "forged");
    await expect(value.coordinator.activate(value.candidate)).rejects.toThrow(/attestation digest/i);
    await expect(readFile(value.coordinator.paths.pointerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(value.store.calls).toEqual(["trust-read"]);
  });

  it("rejects attestation identity before pointer promotion", async () => {
    const value = await setup();
    await writeFile(value.candidate.attestationPath, JSON.stringify({ ...value.attestation, key_id: "f".repeat(64) }));
    const forgedBytes = await readFile(value.candidate.attestationPath);
    await expect(value.coordinator.activate({
      ...value.candidate,
      attestationSha256: createHash("sha256").update(forgedBytes).digest("hex")
    })).rejects.toThrow(/identity/i);
    await expect(readFile(value.coordinator.paths.pointerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a timeout-after-CAS only through authoritative readback", async () => {
    const store = new MemoryKeychain();
    store.ambiguousCommit = true;
    const value = await setup(store);
    await expect(value.coordinator.activate(value.candidate)).resolves.toBeUndefined();
    expect(store.calls.slice(-2)).toEqual(["trust-cas", "trust-read"]);
    expect((await value.coordinator.inspectRecovery()).verdict).toBe("complete");
  });

  it("fails closed when helper CAS rejects and authoritative readback did not advance", async () => {
    const store = new MemoryKeychain();
    store.rejectCommit = true;
    const value = await setup(store);
    await expect(value.coordinator.activate(value.candidate)).rejects.toBeInstanceOf(KeychainActivationConflictError);
    expect((await value.coordinator.inspectRecovery()).verdict).toBe("needs_trust_commit");
  });

  it("recovers after pointer promotion and after a CAS committed before journal finalization", async () => {
    const preparedCrash = await setup(new MemoryKeychain(), (state) => { if (state === "prepared") throw new Error("crash-prepared"); });
    await expect(preparedCrash.coordinator.activate(preparedCrash.candidate)).rejects.toThrow("crash-prepared");
    const preparedRecovery = new KeychainActivationCoordinator(preparedCrash.root, preparedCrash.store);
    expect((await preparedRecovery.inspectRecovery()).verdict).toBe("needs_pointer_promotion");
    await preparedRecovery.resumeRecovered();
    expect((await preparedRecovery.inspectRecovery()).verdict).toBe("complete");

    const pointerCrash = await setup(new MemoryKeychain(), (state) => { if (state === "pointer_promoted") throw new Error("crash-pointer"); });
    await expect(pointerCrash.coordinator.activate(pointerCrash.candidate)).rejects.toThrow("crash-pointer");
    const pointerRecovery = new KeychainActivationCoordinator(pointerCrash.root, pointerCrash.store);
    expect((await pointerRecovery.inspectRecovery()).verdict).toBe("needs_trust_commit");
    await pointerRecovery.resumeRecovered();
    expect((await pointerRecovery.inspectRecovery()).verdict).toBe("complete");

    const casCrashStore = new MemoryKeychain();
    const casCrash = await setup(casCrashStore, (state) => { if (state === "trust_committed") throw new Error("crash-after-cas"); });
    await expect(casCrash.coordinator.activate(casCrash.candidate)).rejects.toThrow("crash-after-cas");
    const casRecovery = new KeychainActivationCoordinator(casCrash.root, casCrashStore);
    expect((await casRecovery.inspectRecovery()).verdict).toBe("complete");
  });

  it("recovers a successor prepared-crash without conflating pointer digest and semantic ID", async () => {
    const value = await setup();
    await value.coordinator.activate(value.candidate);
    const next = await successor(value, (state) => { if (state === "prepared") throw new Error("crash-successor-prepared"); });
    await expect(next.coordinator.activate(next.candidate)).rejects.toThrow("crash-successor-prepared");
    const recovery = new KeychainActivationCoordinator(value.root, value.store);
    expect((await recovery.inspectRecovery()).verdict).toBe("needs_pointer_promotion");
    await recovery.resumeRecovered();
    const report = await recovery.inspectRecovery();
    expect(report.verdict).toBe("complete");
    expect(report.trust).toMatchObject({ acceptedSequence: 1 });
  });

  it("rejects a coherently forged pointer-promoted journal before any recovery CAS", async () => {
    const store = new MemoryKeychain();
    const value = await setup(store, (state) => { if (state === "pointer_promoted") throw new Error("stop-before-cas"); });
    await expect(value.coordinator.activate(value.candidate)).rejects.toThrow("stop-before-cas");
    const journal = JSON.parse(await readFile(value.coordinator.paths.journalPath, "utf8"));
    const forgedSemanticId = sha("forged-semantic-id");
    await writeFile(value.coordinator.paths.journalPath, JSON.stringify({ ...journal, accepted_attestation_id: forgedSemanticId }));
    store.calls.length = 0;
    const recovery = new KeychainActivationCoordinator(value.root, store);
    await expect(recovery.resumeRecovered()).rejects.toThrow(/attestation binding/i);
    expect(store.calls).not.toContain("trust-cas");
    expect(store.state).toBeNull();
  });

  it("finalizes a post-CAS crash without comparing the predecessor to the new trust ID", async () => {
    const store = new MemoryKeychain();
    const value = await setup(store, (state) => { if (state === "pointer_promoted") throw new Error("stop-before-cas"); });
    await expect(value.coordinator.activate(value.candidate)).rejects.toThrow("stop-before-cas");
    const journal = JSON.parse(await readFile(value.coordinator.paths.journalPath, "utf8"));
    store.state = { keyId, acceptedSequence: journal.next_sequence, acceptedAttestationId: journal.accepted_attestation_id };
    store.calls.length = 0;
    const recovery = new KeychainActivationCoordinator(value.root, store);
    expect((await recovery.inspectRecovery()).verdict).toBe("needs_trust_commit");
    await recovery.resumeRecovered();
    expect(store.calls).not.toContain("trust-cas");
    expect((await recovery.inspectRecovery()).verdict).toBe("complete");
    expect(JSON.parse(await readFile(recovery.paths.receiptPath, "utf8"))).toMatchObject({
      accepted_attestation_id: journal.accepted_attestation_id
    });
  });

  it("fails closed on pointer/Keychain fork and Keychain drift", async () => {
    const value = await setup();
    await value.coordinator.activate(value.candidate);
    await writeFile(value.coordinator.paths.pointerPath, JSON.stringify({ schema_version: 2, generation: "fork", attestation_sha256: sha("fork") }));
    expect((await value.coordinator.inspectRecovery()).verdict).toBe("inconsistent_fail_closed");

    const drift = await setup();
    const crash = new KeychainActivationCoordinator(drift.root, drift.store, (state) => { if (state === "pointer_promoted") throw new Error("stop"); });
    await expect(crash.activate(drift.candidate)).rejects.toThrow("stop");
    drift.store.state = { keyId, acceptedSequence: 99, acceptedAttestationId: sha("drift") };
    expect((await new KeychainActivationCoordinator(drift.root, drift.store).inspectRecovery()).verdict).toBe("inconsistent_fail_closed");
  });

  it("maps typed helper requests without exposing a generic renderer surface", async () => {
    const requests: Readonly<Record<string, unknown>>[] = [];
    let state: KeychainTrustState | null = null;
    const invoke = async (_path: string, request: Readonly<Record<string, unknown>>): Promise<TrustedHelperResponse> => {
      requests.push(request);
      if (request.operation === "key-info") return { status: "ok", key_id: keyId, public_key_pem: publicKeyPem };
      if (request.operation === "trust-read") return { status: "ok", trust_state: state ? {
        version: 1, key_id: state.keyId, accepted_sequence: state.acceptedSequence, accepted_attestation_id: state.acceptedAttestationId
      } : null };
      state = { keyId, acceptedSequence: request.accepted_sequence as number, acceptedAttestationId: request.accepted_attestation_id as string };
      return { status: "ok", trust_state: { version: 1, key_id: keyId, accepted_sequence: state.acceptedSequence, accepted_attestation_id: state.acceptedAttestationId } };
    };
    const store = new TrustedHelperKeychainStore("/sealed/helper", invoke);
    expect(await store.keyInfo()).toEqual({ keyId, publicKeyPem });
    expect(await store.read()).toBeNull();
    await store.compareAndSwap(null, { keyId, acceptedSequence: 0, acceptedAttestationId: sha("a") });
    expect(requests).toEqual([
      { operation: "key-info" },
      { operation: "trust-read" },
      { operation: "trust-cas", expected_sequence: undefined, expected_attestation_id: undefined, accepted_sequence: 0, accepted_attestation_id: sha("a") }
    ]);
  });
});
