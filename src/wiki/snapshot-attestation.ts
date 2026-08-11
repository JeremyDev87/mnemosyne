import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const base64Schema = z.string().min(8).max(256).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

const payloadSchema = z.object({
  domain: z.literal("MNEMOSYNE-SNAPSHOT-ATTESTATION-V1"),
  schema_version: z.literal(1),
  generation: z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/u).refine((value) => value !== "." && value !== "..", {
    message: "Generation must be a canonical path leaf"
  }),
  sequence: z.number().int().nonnegative().safe(),
  created_at: z.string().datetime({ offset: true }),
  manifest_sha256: sha256Schema,
  authority_sha256: sha256Schema,
  wikimap_index_sha256: sha256Schema,
  previous_attestation_sha256: sha256Schema.nullable()
}).strict();

const attestationSchema = z.object({
  payload: payloadSchema,
  key_id: sha256Schema,
  signature_algorithm: z.literal("ECDSA_P256_SHA256"),
  signature: base64Schema
}).strict();

export type SnapshotAttestationPayload = z.infer<typeof payloadSchema>;
export type SnapshotAttestation = z.infer<typeof attestationSchema>;

export interface SnapshotTrustAnchor {
  keyId: string;
  publicKeyPem: string;
  acceptedSequence: number;
  acceptedAttestationId: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Attestation contains a non-canonical number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Attestation contains an unsupported canonical value");
}

export function canonicalAttestationPayload(input: SnapshotAttestationPayload): Buffer {
  const payload = payloadSchema.parse(input);
  return Buffer.from(`${payload.domain}\0${canonicalJson(payload)}`, "utf8");
}

export function snapshotPublicKeyId(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Snapshot trust anchor must be a P-256 public key");
  }
  const der = key.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}

export function parseSnapshotAttestation(input: unknown): SnapshotAttestation {
  return attestationSchema.parse(input);
}

export function snapshotAttestationId(input: unknown): string {
  const attestation = parseSnapshotAttestation(input);
  const identity = {
    payload: attestation.payload,
    key_id: attestation.key_id,
    signature_algorithm: attestation.signature_algorithm
  };
  return createHash("sha256")
    .update(`MNEMOSYNE-SNAPSHOT-ATTESTATION-ID-V1\0${canonicalJson(identity)}`, "utf8")
    .digest("hex");
}

export function verifySnapshotAttestation(input: unknown, anchor: SnapshotTrustAnchor): SnapshotAttestation {
  const attestation = parseSnapshotAttestation(input);
  if (!Number.isSafeInteger(anchor.acceptedSequence) || anchor.acceptedSequence < 0) throw new Error("Snapshot trust sequence is invalid");
  if (!sha256Schema.safeParse(anchor.keyId).success) throw new Error("Snapshot trust key identity is invalid");
  if (!sha256Schema.safeParse(anchor.acceptedAttestationId).success) throw new Error("Snapshot trusted attestation identity is invalid");
  const actualKeyId = snapshotPublicKeyId(anchor.publicKeyPem);
  if (actualKeyId !== anchor.keyId || attestation.key_id !== anchor.keyId) throw new Error("Snapshot attestation key identity mismatch");
  const signature = Buffer.from(attestation.signature, "base64");
  if (signature.toString("base64") !== attestation.signature) throw new Error("Snapshot attestation signature encoding is not canonical");
  if (!verify("sha256", canonicalAttestationPayload(attestation.payload), anchor.publicKeyPem, signature)) {
    throw new Error("Snapshot attestation signature verification failed");
  }
  const attestationId = snapshotAttestationId(attestation);
  if (attestation.payload.sequence === anchor.acceptedSequence) {
    if (attestationId !== anchor.acceptedAttestationId) throw new Error("Snapshot attestation same-sequence fork rejected");
  } else if (attestation.payload.sequence === anchor.acceptedSequence + 1) {
    if (attestation.payload.previous_attestation_sha256 !== anchor.acceptedAttestationId) {
      throw new Error("Snapshot attestation chain continuity rejected");
    }
  } else {
    throw new Error("Snapshot attestation replay sequence rejected");
  }
  return attestation;
}
