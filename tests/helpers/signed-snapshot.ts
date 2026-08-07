import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalAttestationPayload,
  snapshotAttestationId,
  snapshotPublicKeyId,
  type SnapshotAttestation,
  type SnapshotAttestationPayload,
  type SnapshotTrustAnchor
} from "../../src/wiki/snapshot-attestation";

export interface TestSigningIdentity {
  privateKey: KeyObject;
  anchor: SnapshotTrustAnchor;
}

export const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

export function createTestSigningIdentity(acceptedSequence = 1): TestSigningIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return {
    privateKey,
    anchor: {
      keyId: snapshotPublicKeyId(publicKeyPem),
      publicKeyPem,
      acceptedSequence,
      acceptedAttestationId: "0".repeat(64)
    }
  };
}

export async function writeAttestedGeneration(options: {
  root: string;
  generation: string;
  manifest: Record<string, unknown>;
  identity: TestSigningIdentity;
  sequence?: number;
  authorityBytes?: Buffer;
  indexBytes?: Buffer;
}): Promise<void> {
  const snapshotRoot = join(options.root, "snapshots", options.generation);
  const manifestBytes = Buffer.from(JSON.stringify(options.manifest));
  const authorityBytes = options.authorityBytes ?? Buffer.from(JSON.stringify({ schema_version: 1, generation: options.generation, entries: [] }));
  const indexBytes = options.indexBytes ?? Buffer.from("fixture-index");
  const payload: SnapshotAttestationPayload = {
    domain: "MNEMOSYNE-SNAPSHOT-ATTESTATION-V1",
    schema_version: 1,
    generation: options.generation,
    sequence: options.sequence ?? options.identity.anchor.acceptedSequence,
    created_at: "2026-08-07T00:00:01Z",
    manifest_sha256: sha256(manifestBytes),
    authority_sha256: sha256(authorityBytes),
    wikimap_index_sha256: sha256(indexBytes),
    previous_attestation_sha256: null
  };
  const attestation: SnapshotAttestation = {
    payload,
    key_id: options.identity.anchor.keyId,
    signature_algorithm: "ECDSA_P256_SHA256",
    signature: sign("sha256", canonicalAttestationPayload(payload), options.identity.privateKey).toString("base64")
  };
  options.identity.anchor.acceptedSequence = payload.sequence;
  options.identity.anchor.acceptedAttestationId = snapshotAttestationId(attestation);
  const attestationBytes = Buffer.from(JSON.stringify(attestation));
  await mkdir(join(snapshotRoot, ".wikimap"), { recursive: true });
  await writeFile(join(snapshotRoot, "manifest.json"), manifestBytes);
  await writeFile(join(snapshotRoot, "authority.json"), authorityBytes);
  await writeFile(join(snapshotRoot, ".wikimap", "index.db"), indexBytes);
  await writeFile(join(snapshotRoot, "attestation.json"), attestationBytes);
  await writeFile(join(options.root, "current.json"), JSON.stringify({
    schema_version: 2,
    generation: options.generation,
    attestation_sha256: sha256(attestationBytes)
  }));
}
