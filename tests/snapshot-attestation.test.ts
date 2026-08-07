import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalAttestationPayload,
  snapshotAttestationId,
  snapshotPublicKeyId,
  verifySnapshotAttestation,
  type SnapshotAttestation,
  type SnapshotAttestationPayload,
  type SnapshotTrustAnchor
} from "../src/wiki/snapshot-attestation";
import { pinCurrentSnapshot } from "../src/wiki/dobby-snapshot";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

async function signedFixture(sequence = 7) {
  const root = await mkdtemp(join(tmpdir(), "mnemosyne-attested-"));
  roots.push(root);
  const generation = "20260807T000000Z-attested";
  const snapshotRoot = join(root, "snapshots", generation);
  const document = Buffer.from("# Attested\n\ntrusted body");
  const relativePath = "domains/personal-ops/attested.md";
  const manifest = {
    schema_version: 2,
    generation,
    created_at: "2026-08-07T00:00:00Z",
    file_count: 1,
    files: [{ relative_path: relativePath, sha256: sha256(document), size: document.byteLength, state: "copied" }]
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const authorityBytes = Buffer.from(JSON.stringify({ schema_version: 1, generation, entries: [] }));
  const indexBytes = Buffer.from("fixture-index");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const keyId = snapshotPublicKeyId(publicKeyPem);
  const payload: SnapshotAttestationPayload = {
    domain: "MNEMOSYNE-SNAPSHOT-ATTESTATION-V1",
    schema_version: 1,
    generation,
    sequence,
    created_at: "2026-08-07T00:00:01Z",
    manifest_sha256: sha256(manifestBytes),
    authority_sha256: sha256(authorityBytes),
    wikimap_index_sha256: sha256(indexBytes),
    previous_attestation_sha256: null
  };
  const attestation: SnapshotAttestation = {
    payload,
    key_id: keyId,
    signature_algorithm: "ECDSA_P256_SHA256",
    signature: sign("sha256", canonicalAttestationPayload(payload), privateKey).toString("base64")
  };
  const attestationBytes = Buffer.from(JSON.stringify(attestation));
  const anchor: SnapshotTrustAnchor = {
    keyId,
    publicKeyPem,
    acceptedSequence: sequence,
    acceptedAttestationId: snapshotAttestationId(attestation)
  };

  await mkdir(join(snapshotRoot, "domains", "personal-ops"), { recursive: true });
  await mkdir(join(snapshotRoot, ".wikimap"), { recursive: true });
  await writeFile(join(snapshotRoot, relativePath), document);
  await writeFile(join(snapshotRoot, "manifest.json"), manifestBytes);
  await writeFile(join(snapshotRoot, "authority.json"), authorityBytes);
  await writeFile(join(snapshotRoot, ".wikimap", "index.db"), indexBytes);
  await writeFile(join(snapshotRoot, "attestation.json"), attestationBytes);
  await writeFile(join(root, "current.json"), JSON.stringify({ schema_version: 2, generation, attestation_sha256: sha256(attestationBytes) }));
  return { root, generation, snapshotRoot, anchor, attestation, manifestBytes, privateKey };
}

function signPayload(payload: SnapshotAttestationPayload, fixture: Awaited<ReturnType<typeof signedFixture>>): SnapshotAttestation {
  return {
    payload,
    key_id: fixture.anchor.keyId,
    signature_algorithm: "ECDSA_P256_SHA256",
    signature: sign("sha256", canonicalAttestationPayload(payload), fixture.privateKey).toString("base64")
  };
}

describe("snapshot attestation contract", () => {
  it("matches an independent literal canonicalization and attestation-ID vector", () => {
    const payload: SnapshotAttestationPayload = {
      domain: "MNEMOSYNE-SNAPSHOT-ATTESTATION-V1",
      schema_version: 1,
      generation: "vector-20260807",
      sequence: 42,
      created_at: "2026-08-07T00:00:00Z",
      manifest_sha256: "b".repeat(64),
      authority_sha256: "c".repeat(64),
      wikimap_index_sha256: "d".repeat(64),
      previous_attestation_sha256: "e".repeat(64)
    };
    const canonical = "MNEMOSYNE-SNAPSHOT-ATTESTATION-V1\0{\"authority_sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"created_at\":\"2026-08-07T00:00:00Z\",\"domain\":\"MNEMOSYNE-SNAPSHOT-ATTESTATION-V1\",\"generation\":\"vector-20260807\",\"manifest_sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"previous_attestation_sha256\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\"schema_version\":1,\"sequence\":42,\"wikimap_index_sha256\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"}";
    const attestation: SnapshotAttestation = {
      payload,
      key_id: "a".repeat(64),
      signature_algorithm: "ECDSA_P256_SHA256",
      signature: "AAAAAAAA"
    };

    expect(canonicalAttestationPayload(payload).toString("utf8")).toBe(canonical);
    expect(snapshotAttestationId(attestation)).toBe("31198da1bd2a76f1c092b6bc2d7d880f2204f3bb6a5c2525a68045e4ee926fce");
  });

  it("uses fixed canonical bytes and a stable signature-independent attestation identity", async () => {
    const fixture = await signedFixture();
    const canonical = canonicalAttestationPayload(fixture.attestation.payload).toString("utf8");
    expect(canonical).toBe(`MNEMOSYNE-SNAPSHOT-ATTESTATION-V1\0{"authority_sha256":"${fixture.attestation.payload.authority_sha256}","created_at":"2026-08-07T00:00:01Z","domain":"MNEMOSYNE-SNAPSHOT-ATTESTATION-V1","generation":"20260807T000000Z-attested","manifest_sha256":"${fixture.attestation.payload.manifest_sha256}","previous_attestation_sha256":null,"schema_version":1,"sequence":7,"wikimap_index_sha256":"${fixture.attestation.payload.wikimap_index_sha256}"}`);
    expect(snapshotPublicKeyId(fixture.anchor.publicKeyPem)).toBe(fixture.anchor.keyId);
    expect(snapshotAttestationId(fixture.attestation)).toBe(fixture.anchor.acceptedAttestationId);
    expect(() => verifySnapshotAttestation(fixture.attestation, fixture.anchor)).not.toThrow();
  });

  it("pins only an attested generation whose sidecars match the signed digests", async () => {
    const fixture = await signedFixture();
    const pinned = await pinCurrentSnapshot(fixture.root, fixture.anchor);
    expect(pinned.generationId).toBe(fixture.generation);
    expect(pinned.attestationSequence).toBe(7);
    expect(pinned.attestationId).toBe(fixture.anchor.acceptedAttestationId);
  });

  it("rejects unsigned legacy pointers, forged content, wrong keys, and lower-sequence replay", async () => {
    const unsigned = await signedFixture();
    await writeFile(join(unsigned.root, "current.json"), unsigned.manifestBytes);
    await expect(pinCurrentSnapshot(unsigned.root, unsigned.anchor)).rejects.toThrow(/pointer|schema|attestation/i);

    const forged = await signedFixture();
    await writeFile(join(forged.snapshotRoot, "manifest.json"), Buffer.from("{}"));
    await expect(pinCurrentSnapshot(forged.root, forged.anchor)).rejects.toThrow(/digest/i);

    const wrongKey = await signedFixture();
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
    await expect(pinCurrentSnapshot(wrongKey.root, { ...wrongKey.anchor, publicKeyPem: other })).rejects.toThrow(/key|signature/i);

    const replay = await signedFixture(4);
    await expect(pinCurrentSnapshot(replay.root, { ...replay.anchor, acceptedSequence: 5 })).rejects.toThrow(/replay|sequence/i);
  });

  it("rejects same-sequence forks and broken continuity while accepting the direct successor", async () => {
    const fixture = await signedFixture(7);
    const fork = signPayload({ ...fixture.attestation.payload, created_at: "2026-08-07T00:00:02Z" }, fixture);
    expect(() => verifySnapshotAttestation(fork, fixture.anchor)).toThrow(/fork/i);

    const successorPayload = {
      ...fixture.attestation.payload,
      generation: "20260807T000001Z-attested",
      sequence: 8,
      previous_attestation_sha256: fixture.anchor.acceptedAttestationId
    } satisfies SnapshotAttestationPayload;
    const successor = signPayload(successorPayload, fixture);
    expect(() => verifySnapshotAttestation(successor, fixture.anchor)).not.toThrow();

    const broken = signPayload({ ...successorPayload, previous_attestation_sha256: "0".repeat(64) }, fixture);
    expect(() => verifySnapshotAttestation(broken, fixture.anchor)).toThrow(/continuity/i);
  });

  it("rejects pointer and signed-sidecar drift", async () => {
    const pointerDrift = await signedFixture();
    await writeFile(join(pointerDrift.root, "current.json"), JSON.stringify({ schema_version: 2, generation: pointerDrift.generation, attestation_sha256: "0".repeat(64) }));
    await expect(pinCurrentSnapshot(pointerDrift.root, pointerDrift.anchor)).rejects.toThrow(/attestation digest/i);

    const sidecarDrift = await signedFixture();
    await writeFile(join(sidecarDrift.snapshotRoot, "authority.json"), "forged");
    await expect(pinCurrentSnapshot(sidecarDrift.root, sidecarDrift.anchor)).rejects.toThrow(/authority digest/i);
  });
});
