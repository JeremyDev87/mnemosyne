import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { invokeTrustedHelper, TrustedHelperRejectedError } from "./trusted-helper";
import { verifyFixedRootAttestationResponse } from "../wiki/fixed-root-attestor";
import { KeychainActivationCoordinator, TrustedHelperKeychainStore } from "../wiki/keychain-activation";
import { parseSnapshotAttestation, snapshotAttestationId } from "../wiki/snapshot-attestation";

const OWNER_OPERATION_PREFIX = "--mnemosyne-owner-operation=";
const GENERATION_PREFIX = "--mnemosyne-generation=";
const EXPECTED_GENERATION_PREFIX = "--mnemosyne-expected-generation=";
const ALLOWED_OWNER_OPERATIONS = new Set(["key-info", "enroll", "activate"] as const);
const GENERATION = /^[A-Za-z0-9._-]{1,160}$/u;

export type OwnerActivationOperation = "key-info" | "enroll" | "activate";
export type OwnerActivationCommand = Readonly<{
  operation: OwnerActivationOperation;
  generation?: string;
  expectedGeneration?: string | null;
}>;
export type OwnerActivationResult = Readonly<{
  status: "ok";
  operation: OwnerActivationOperation;
  disposition: "read" | "already-enrolled" | "enrolled" | "activated";
  key_id: string;
  sequence?: number;
}>;

type Invoke = typeof invokeTrustedHelper;

function oneValue(argv: readonly string[], prefix: string): string | undefined {
  const values = argv.filter((value) => value.startsWith(prefix));
  if (values.length > 1) throw new Error(`Duplicate ${prefix.slice(2, -1)} argument`);
  return values[0]?.slice(prefix.length);
}

export function parseOwnerActivationOperation(argv: readonly string[]): OwnerActivationCommand | undefined {
  const values = argv.filter((value) => value.startsWith(OWNER_OPERATION_PREFIX));
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new Error("Exactly one owner activation operation is required");
  const operation = values[0]?.slice(OWNER_OPERATION_PREFIX.length);
  if (!operation) throw new Error("Owner activation operation is empty");
  if (!ALLOWED_OWNER_OPERATIONS.has(operation as OwnerActivationOperation)) throw new Error("Unsupported owner activation operation");
  const typed = operation as OwnerActivationOperation;
  const generation = oneValue(argv, GENERATION_PREFIX);
  const expected = oneValue(argv, EXPECTED_GENERATION_PREFIX);
  if (typed !== "activate") {
    if (generation !== undefined || expected !== undefined) throw new Error("Generation arguments require activate operation");
    return { operation: typed };
  }
  if (!generation || !GENERATION.test(generation) || generation === "." || generation === "..") throw new Error("Activate generation is invalid");
  if (expected === undefined) throw new Error("Expected generation is required");
  if (expected !== "none" && (!GENERATION.test(expected) || expected === "." || expected === "..")) throw new Error("Expected generation is invalid");
  return { operation: typed, generation, expectedGeneration: expected === "none" ? null : expected };
}

function requireKeyIdentity(response: Awaited<ReturnType<Invoke>>): string {
  if (!response.key_id) throw new Error("Trusted helper omitted enrolled key identity");
  return response.key_id;
}

async function durableWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function runOwnerActivationOperation(
  helperPath: string,
  command: OwnerActivationCommand,
  invoke: Invoke = invokeTrustedHelper,
  stateRoot?: string
): Promise<OwnerActivationResult> {
  const operation = command.operation;
  if (operation === "key-info") {
    const keyId = requireKeyIdentity(await invoke(helperPath, { operation: "key-info" }));
    return { status: "ok", operation, disposition: "read", key_id: keyId };
  }

  if (operation === "activate") {
    if (!stateRoot || !command.generation || command.expectedGeneration === undefined) throw new Error("Activate state root and generation binding are required");
    const store = new TrustedHelperKeychainStore(helperPath, invoke);
    const key = await store.keyInfo();
    const trust = await store.read();
    const sequence = trust === null ? 0 : trust.acceptedSequence + 1;
    const request = {
      operation: "attest-candidate" as const,
      generation: command.generation,
      sequence,
      previous_attestation_sha256: trust?.acceptedAttestationId ?? null
    };
    const response = await invoke(helperPath, request);
    const parsed = parseSnapshotAttestation({
      payload: response.payload,
      key_id: response.key_id,
      signature_algorithm: response.signature_algorithm,
      signature: response.signature
    });
    const attestation = verifyFixedRootAttestationResponse(response, request, {
      keyId: key.keyId,
      publicKeyPem: key.publicKeyPem,
      acceptedSequence: sequence,
      acceptedAttestationId: snapshotAttestationId(parsed)
    });
    const bytes = Buffer.from(JSON.stringify(attestation) + "\n", "utf8");
    const path = join(stateRoot, "snapshots", command.generation, "attestation.json");
    await durableWrite(path, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const coordinator = new KeychainActivationCoordinator(stateRoot, store);
    await coordinator.activate({ expectedGeneration: command.expectedGeneration, nextGeneration: command.generation, attestationPath: path, attestationSha256: digest });
    const readback = await store.read();
    if (!readback || readback.keyId !== key.keyId || readback.acceptedSequence !== sequence || readback.acceptedAttestationId !== snapshotAttestationId(attestation)) {
      throw new Error("Activated trust state readback mismatch");
    }
    return { status: "ok", operation, disposition: "activated", key_id: key.keyId, sequence };
  }

  try {
    const keyId = requireKeyIdentity(await invoke(helperPath, { operation: "key-info" }));
    return { status: "ok", operation, disposition: "already-enrolled", key_id: keyId };
  } catch (error) {
    if (!(error instanceof TrustedHelperRejectedError) || error.reason !== "not-enrolled") throw error;
  }

  const enrolledKeyId = requireKeyIdentity(await invoke(helperPath, { operation: "enroll" }));
  const readbackKeyId = requireKeyIdentity(await invoke(helperPath, { operation: "key-info" }));
  if (readbackKeyId !== enrolledKeyId) throw new Error("Enrolled key identity changed during authoritative readback");
  return { status: "ok", operation, disposition: "enrolled", key_id: readbackKeyId };
}
