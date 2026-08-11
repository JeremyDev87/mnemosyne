import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalAttestationPayload,
  snapshotAttestationId,
  snapshotPublicKeyId,
  type SnapshotAttestation,
  type SnapshotAttestationPayload,
  type SnapshotTrustAnchor
} from "../../src/wiki/snapshot-attestation";

const generation = "20260811T000000Z-fixed-root";
const documentPath = "domains/personal-ops/fixture.md";
const fixtureFiles = ["authority.json", "manifest.json", ".wikimap/index.db", "attestation.json", documentPath, "current.json"] as const;

export interface FixedRootCandidateRequest {
  readonly operation: "attest-candidate";
  readonly generation: string;
  readonly sequence: number;
  readonly previous_attestation_sha256: string | null;
}

export interface FixedRootFixture {
  readonly request: FixedRootCandidateRequest;
  readonly trust: SnapshotTrustAnchor;
  readonly response: Readonly<Record<string, unknown>>;
  readonly canonicalBytes: Buffer;
  readonly root: string;
  dispose(): Promise<void>;
  snapshot(): Promise<Readonly<Record<string, string>>>;
  write(relativePath: (typeof fixtureFiles)[number], bytes: Buffer | string): Promise<void>;
  symlinkToOutside(relativePath: (typeof fixtureFiles)[number]): Promise<void>;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Fixture canonical payload requires safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("Fixture canonical payload contains an unsupported value");
}

function signedAttestation(payload: SnapshotAttestationPayload, keyId: string, privateKey: KeyObject): SnapshotAttestation {
  return {
    payload,
    key_id: keyId,
    signature_algorithm: "ECDSA_P256_SHA256",
    signature: sign("sha256", canonicalAttestationPayload(payload), privateKey).toString("base64")
  };
}

export async function createFixedRootFixture(): Promise<FixedRootFixture> {
  const root = await mkdtemp(join(tmpdir(), "mnemosyne-fixed-root-attestor-"));
  const snapshotRoot = join(root, "snapshots", generation);
  const document = Buffer.from("# Fixed root\n\nattested fixture\n", "utf8");
  const manifestBytes = Buffer.from(JSON.stringify({
    schema_version: 2,
    generation,
    created_at: "2026-08-11T00:00:00Z",
    file_count: 1,
    files: [{ relative_path: documentPath, sha256: sha256(document), size: document.byteLength, state: "copied" }]
  }));
  const authorityBytes = Buffer.from(JSON.stringify({ schema_version: 1, generation, entries: [] }));
  const indexBytes = Buffer.from("fixed-root-index", "utf8");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const keyId = snapshotPublicKeyId(publicKeyPem);
  const previousAttestationId = "a".repeat(64);
  const payload: SnapshotAttestationPayload = {
    domain: "MNEMOSYNE-SNAPSHOT-ATTESTATION-V1",
    schema_version: 1,
    generation,
    sequence: 7,
    created_at: "2026-08-11T00:00:01Z",
    manifest_sha256: sha256(manifestBytes),
    authority_sha256: sha256(authorityBytes),
    wikimap_index_sha256: sha256(indexBytes),
    previous_attestation_sha256: previousAttestationId
  };
  const attestation = signedAttestation(payload, keyId, privateKey);
  const attestationBytes = Buffer.from(JSON.stringify(attestation));
  const trust: SnapshotTrustAnchor = {
    keyId,
    publicKeyPem,
    acceptedSequence: 6,
    acceptedAttestationId: previousAttestationId
  };
  const request: FixedRootCandidateRequest = {
    operation: "attest-candidate",
    generation,
    sequence: payload.sequence,
    previous_attestation_sha256: payload.previous_attestation_sha256
  };

  await mkdir(join(snapshotRoot, "domains", "personal-ops"), { recursive: true });
  await mkdir(join(snapshotRoot, ".wikimap"), { recursive: true });
  await writeFile(join(snapshotRoot, documentPath), document);
  await writeFile(join(snapshotRoot, "manifest.json"), manifestBytes);
  await writeFile(join(snapshotRoot, "authority.json"), authorityBytes);
  await writeFile(join(snapshotRoot, ".wikimap", "index.db"), indexBytes);
  await writeFile(join(snapshotRoot, "attestation.json"), attestationBytes);
  await writeFile(join(root, "current.json"), JSON.stringify({ schema_version: 2, generation, attestation_sha256: sha256(attestationBytes) }));

  const fixturePath = (relativePath: (typeof fixtureFiles)[number]): string => relativePath === "current.json"
    ? join(root, relativePath)
    : join(snapshotRoot, relativePath);
  return {
    request,
    trust,
    response: { status: "ok", ...attestation },
    canonicalBytes: canonicalAttestationPayload(payload),
    root,
    dispose: async () => rm(root, { recursive: true, force: true }),
    snapshot: async () => {
      const snapshot: Record<string, string> = {};
      for (const relativePath of fixtureFiles) {
        const absolute = fixturePath(relativePath);
        try {
          const info = await lstat(absolute);
          snapshot[relativePath] = info.isSymbolicLink()
            ? `symlink:${await readlink(absolute)}`
            : sha256(await readFile(absolute));
        } catch (error: unknown) {
          if (error instanceof Error && "code" in error) snapshot[relativePath] = "missing";
          else throw error;
        }
      }
      return snapshot;
    },
    write: (relativePath, bytes) => writeFile(fixturePath(relativePath), bytes),
    symlinkToOutside: async (relativePath) => {
      const absolute = fixturePath(relativePath);
      const outside = join(root, "outside-target");
      await writeFile(outside, "outside");
      await rm(absolute, { force: true });
      const target = relativePath === "current.json" ? outside : join("..", "..", "outside-target");
      await symlink(target, absolute);
    }
  };
}

export function independentCanonicalPayload(payload: SnapshotAttestationPayload): Buffer {
  return Buffer.from(`${payload.domain}\0${canonicalJson(payload)}`, "utf8");
}

export function fixedRootAttestationId(attestation: SnapshotAttestation): string {
  return snapshotAttestationId(attestation);
}
