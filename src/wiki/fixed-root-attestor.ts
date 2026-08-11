import { z } from "zod";
import {
  parseSnapshotAttestation,
  verifySnapshotAttestation,
  type SnapshotAttestation,
  type SnapshotTrustAnchor
} from "./snapshot-attestation";
import { invokeTrustedHelper, type TrustedHelperResponse } from "../trust/trusted-helper";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const generationSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/u).refine((value) => value !== "." && value !== "..", {
  message: "Generation must be a canonical path leaf"
});
const candidateRequestSchema = z.object({
  operation: z.literal("attest-candidate"),
  generation: generationSchema,
  sequence: z.number().int().nonnegative().safe(),
  previous_attestation_sha256: sha256Schema.nullable()
}).strict();
const candidateResponseSchema = z.object({
  status: z.literal("ok"),
  payload: z.unknown(),
  key_id: sha256Schema,
  signature_algorithm: z.literal("ECDSA_P256_SHA256"),
  signature: z.string().min(8).max(256).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
}).strict();

export type FixedRootCandidateRequest = z.infer<typeof candidateRequestSchema>;
export type FixedRootHelperInvoker = (path: string, request: FixedRootCandidateRequest) => Promise<unknown>;

export function parseFixedRootCandidateRequest(input: unknown): FixedRootCandidateRequest {
  return candidateRequestSchema.parse(input);
}

function parseCandidateAttestation(input: unknown): SnapshotAttestation {
  const response = candidateResponseSchema.parse(input);
  const attestation = parseSnapshotAttestation({
    payload: response.payload,
    key_id: response.key_id,
    signature_algorithm: response.signature_algorithm,
    signature: response.signature
  });
  return attestation;
}

export function verifyFixedRootAttestationResponse(
  input: unknown,
  requestInput: unknown,
  anchor: SnapshotTrustAnchor
): SnapshotAttestation {
  const request = parseFixedRootCandidateRequest(requestInput);
  const attestation = parseCandidateAttestation(input);
  if (attestation.payload.generation !== request.generation) throw new Error("Fixed-root attestation generation binding mismatch");
  if (attestation.payload.sequence !== request.sequence) throw new Error("Fixed-root attestation sequence binding mismatch");
  if (attestation.payload.previous_attestation_sha256 !== request.previous_attestation_sha256) {
    throw new Error("Fixed-root attestation predecessor binding mismatch");
  }
  return verifySnapshotAttestation(attestation, anchor);
}

export async function attestFixedRootCandidate(
  helperPath: string,
  requestInput: unknown,
  anchor: SnapshotTrustAnchor,
  invoke: FixedRootHelperInvoker = invokeTrustedHelper
): Promise<SnapshotAttestation> {
  const request = parseFixedRootCandidateRequest(requestInput);
  const response: TrustedHelperResponse | unknown = await invoke(helperPath, request);
  return verifyFixedRootAttestationResponse(response, request, anchor);
}
