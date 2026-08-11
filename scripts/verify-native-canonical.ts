import { readFileSync } from "node:fs";
import { canonicalAttestationPayload, parseSnapshotAttestation } from "../src/wiki/snapshot-attestation";

const input = JSON.parse(readFileSync(0, "utf8")) as { payload?: unknown; canonical_base64?: unknown };
if (typeof input.canonical_base64 !== "string") throw new Error("Native harness omitted canonical bytes");
const attestation = parseSnapshotAttestation({
  payload: input.payload,
  key_id: "0".repeat(64),
  signature_algorithm: "ECDSA_P256_SHA256",
  signature: "AAAAAAAA"
});
const native = Buffer.from(input.canonical_base64, "base64");
const consumer = canonicalAttestationPayload(attestation.payload);
if (!native.equals(consumer)) throw new Error("Native canonical bytes differ from the TypeScript consumer");
process.stdout.write("PASS_NATIVE_TYPESCRIPT_CANONICAL_BYTES\n");
