import type { SnapshotTrustAnchor } from "../wiki/snapshot-attestation";
import { invokeTrustedHelper, type TrustedHelperResponse } from "./trusted-helper";

export type HelperInvoker = (path: string, request: Readonly<Record<string, unknown>>) => Promise<TrustedHelperResponse>;

export async function loadProvisionedTrustAnchor(helperPath: string, invoke: HelperInvoker = invokeTrustedHelper): Promise<SnapshotTrustAnchor | undefined> {
  try {
    const keyInfo = await invoke(helperPath, { operation: "key-info" });
    const trust = await invoke(helperPath, { operation: "trust-read" });
    if (!keyInfo.key_id || !keyInfo.public_key_pem || !trust.trust_state) return undefined;
    if (trust.trust_state.key_id !== keyInfo.key_id) return undefined;
    return {
      keyId: keyInfo.key_id,
      publicKeyPem: keyInfo.public_key_pem,
      acceptedSequence: trust.trust_state.accepted_sequence,
      acceptedAttestationId: trust.trust_state.accepted_attestation_id
    };
  } catch {
    // Production remains fail-closed until the helper has an enrolled key and trust state.
    return undefined;
  }
}
