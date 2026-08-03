import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalManifestEntries,
  calculateManifestHash,
  createRemoteImportManifest,
  type ImportManifest,
  type ManifestEntry,
  type RemoteImportManifest
} from "../src/wiki/import-manifest";
import {
  CloudflareD1HttpDatabase,
  readD1ImportSnapshot,
  type D1ImportSnapshot
} from "../src/wiki/d1-http";

const CURRENT_PREFIX = "shadow/current/";
const CURRENT_MANIFEST_KEY = "shadow/manifests/current.json";
const RECEIPT_VERSION = 1 as const;

export interface R2ImportObject {
  path: string;
  size: number;
  sha256: string | null;
}

export interface ExactImportVerificationInput {
  manifest: Pick<ImportManifest, "entries">;
  remoteManifest: RemoteImportManifest | null;
  r2Objects: R2ImportObject[];
  d1: D1ImportSnapshot;
}

export interface ProjectionReceipt {
  expected: number;
  observed: number;
  matching: number;
  missing: number;
  mismatch: number;
  stale: number;
  extra: number;
  exact: boolean;
}

export interface ExactImportVerificationReceipt {
  version: typeof RECEIPT_VERSION;
  state: "exact" | "not-exact";
  passed: boolean;
  manifest: {
    expectedHash: string;
    remoteHash: string | null;
    expectedDocuments: number;
    remoteDocuments: number;
    expectedBytes: number;
    remoteBytes: number;
    exact: boolean;
  };
  r2: ProjectionReceipt;
  d1: ProjectionReceipt & {
    schemaReady: boolean;
    indexState: "empty" | "indexing" | "ready" | "error" | "missing" | "invalid";
    countReady: boolean;
    manifestReady: boolean;
  };
}

interface ProjectionValue {
  id: string;
  matches(entry: ManifestEntry): boolean;
}

const REQUIRED_OBJECTS = [
  ["index_status", "TABLE"],
  ["wiki_fts", "TABLE"],
  ["wiki_pages", "TABLE"],
  ["wiki_pages_authority_idx", "INDEX"]
] as const;

const REQUIRED_WIKI_PAGE_COLUMNS = [
  ["path", "TEXT"],
  ["title", "TEXT"],
  ["body", "TEXT"],
  ["hash", "TEXT"],
  ["authority_kind", "TEXT"],
  ["authority_priority", "INTEGER"],
  ["answerable_as_current", "INTEGER"],
  ["canonical_path", "TEXT"],
  ["status", "TEXT"],
  ["source_role", "TEXT"],
  ["last_verified", "TEXT"],
  ["indexed_at", "TEXT"]
] as const;

const REQUIRED_WIKI_FTS_COLUMNS = [
  ["path", ""],
  ["title", ""],
  ["body", ""]
] as const;

const REQUIRED_INDEX_STATUS_COLUMNS = [
  ["id", "INTEGER"],
  ["state", "TEXT"],
  ["document_count", "INTEGER"],
  ["manifest_hash", "TEXT"],
  ["updated_at", "TEXT"]
] as const;

function compareProjection(expected: readonly ManifestEntry[], observed: readonly ProjectionValue[]): ProjectionReceipt {
  const expectedById = new Map(expected.map((entry) => [entry.path, entry]));
  const seenExpected = new Set<string>();
  let matching = 0;
  let mismatch = 0;
  let extra = 0;

  for (const value of observed) {
    const expectedEntry = expectedById.get(value.id);
    if (!expectedEntry || seenExpected.has(value.id)) {
      extra += 1;
      continue;
    }
    seenExpected.add(value.id);
    if (value.matches(expectedEntry)) matching += 1;
    else mismatch += 1;
  }

  const missing = expected.length - seenExpected.size;
  const exact = matching === expected.length && missing === 0 && mismatch === 0 && extra === 0 && observed.length === expected.length;
  return {
    expected: expected.length,
    observed: observed.length,
    matching,
    missing,
    mismatch,
    stale: mismatch,
    extra,
    exact
  };
}

function normalizedPairs(values: ReadonlyArray<{ name: string; type: string }>): string[] {
  return values.map((value) => `${value.name}\u0000${value.type.toUpperCase()}`).sort();
}

function pairsEqual(
  actual: ReadonlyArray<{ name: string; type: string }>,
  expected: ReadonlyArray<readonly [string, string]>
): boolean {
  return JSON.stringify(normalizedPairs(actual)) === JSON.stringify(expected.map(([name, type]) => `${name}\u0000${type}`).sort());
}

function schemaIsReady(snapshot: D1ImportSnapshot): boolean {
  return pairsEqual(snapshot.objects, REQUIRED_OBJECTS) &&
    pairsEqual(snapshot.wikiPageColumns, REQUIRED_WIKI_PAGE_COLUMNS) &&
    pairsEqual(snapshot.wikiFtsColumns, REQUIRED_WIKI_FTS_COLUMNS) &&
    pairsEqual(snapshot.indexStatusColumns, REQUIRED_INDEX_STATUS_COLUMNS);
}

function normalizedIndexState(state: string | undefined): ExactImportVerificationReceipt["d1"]["indexState"] {
  if (state === undefined) return "missing";
  if (state === "empty" || state === "indexing" || state === "ready" || state === "error") return state;
  return "invalid";
}

function remoteManifestIsExact(expected: RemoteImportManifest, remote: RemoteImportManifest | null): boolean {
  if (!remote || remote.version !== RECEIPT_VERSION) return false;
  try {
    const remoteEntries = canonicalManifestEntries(remote.entries);
    const remoteHash = calculateManifestHash(remoteEntries);
    const remoteBytes = remoteEntries.reduce((sum, entry) => sum + entry.size, 0);
    return remote.manifestHash === remoteHash &&
      remote.totalBytes === remoteBytes &&
      remote.manifestHash === expected.manifestHash &&
      remote.totalBytes === expected.totalBytes &&
      JSON.stringify(remoteEntries) === JSON.stringify(expected.entries);
  } catch {
    return false;
  }
}

export function verifyExactImport(input: ExactImportVerificationInput): ExactImportVerificationReceipt {
  const expected = createRemoteImportManifest(input.manifest);
  const remoteEntries = Array.isArray(input.remoteManifest?.entries) ? input.remoteManifest.entries : [];
  const remoteBytes = Number.isSafeInteger(input.remoteManifest?.totalBytes) && (input.remoteManifest?.totalBytes ?? -1) >= 0
    ? input.remoteManifest!.totalBytes
    : 0;
  const remoteHash = typeof input.remoteManifest?.manifestHash === "string" && /^[a-f0-9]{64}$/.test(input.remoteManifest.manifestHash)
    ? input.remoteManifest.manifestHash
    : null;
  const r2 = compareProjection(expected.entries, input.r2Objects.map((object) => ({
    id: object.path,
    matches: (entry) => object.size === entry.size && object.sha256 === entry.sha256
  })));
  const d1Projection = compareProjection(expected.entries, input.d1.rows.map((row) => ({
    id: row.path,
    matches: (entry) => row.hash === entry.sha256
  })));
  const schemaReady = schemaIsReady(input.d1);
  const indexState = normalizedIndexState(input.d1.status?.state);
  const countReady = input.d1.status?.documentCount === expected.entries.length;
  const manifestReady = input.d1.status?.manifestHash === expected.manifestHash;
  const manifestExact = remoteManifestIsExact(expected, input.remoteManifest);
  const d1Exact = d1Projection.exact && schemaReady && indexState === "ready" && countReady && manifestReady;
  const passed = manifestExact && r2.exact && d1Exact;

  return {
    version: RECEIPT_VERSION,
    state: passed ? "exact" : "not-exact",
    passed,
    manifest: {
      expectedHash: expected.manifestHash,
      remoteHash,
      expectedDocuments: expected.entries.length,
      remoteDocuments: remoteEntries.length,
      expectedBytes: expected.totalBytes,
      remoteBytes,
      exact: manifestExact
    },
    r2,
    d1: {
      ...d1Projection,
      schemaReady,
      indexState,
      countReady,
      manifestReady,
      exact: d1Exact
    }
  };
}

export function verificationExitCode(receipt: Pick<ExactImportVerificationReceipt, "passed">): 0 | 1 {
  return receipt.passed ? 0 : 1;
}

async function readRemoteManifest(client: S3Client, bucket: string): Promise<RemoteImportManifest | null> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: CURRENT_MANIFEST_KEY }));
    if (!response.Body) return null;
    return JSON.parse(await response.Body.transformToString()) as RemoteImportManifest;
  } catch (error) {
    const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function readR2Objects(client: S3Client, bucket: string): Promise<R2ImportObject[]> {
  const listed: Array<{ key: string; size: number }> = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: CURRENT_PREFIX,
      ContinuationToken: continuationToken
    }));
    for (const object of page.Contents ?? []) {
      if (object.Key === undefined) continue;
      listed.push({ key: object.Key, size: object.Size ?? -1 });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && continuationToken === undefined) throw new Error("R2 listing returned an incomplete page");
  } while (continuationToken !== undefined);

  listed.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const objects: R2ImportObject[] = [];
  for (const object of listed) {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object.key }));
    objects.push({
      path: object.key.startsWith(CURRENT_PREFIX) ? object.key.slice(CURRENT_PREFIX.length) : "",
      size: head.ContentLength ?? object.size,
      sha256: head.Metadata?.sha256 ?? null
    });
  }
  return objects;
}

interface VerifierEnvironment {
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  D1_ACCOUNT_ID?: string;
  D1_DATABASE_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

export async function runExactImportVerification(manifestPath: string, environment: VerifierEnvironment = process.env): Promise<ExactImportVerificationReceipt> {
  const endpoint = environment.R2_ENDPOINT;
  const accessKeyId = environment.R2_ACCESS_KEY_ID;
  const secretAccessKey = environment.R2_SECRET_ACCESS_KEY;
  const bucket = environment.R2_BUCKET;
  const accountId = environment.D1_ACCOUNT_ID;
  const databaseId = environment.D1_DATABASE_ID;
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !accountId || !databaseId || !apiToken) {
    throw new Error("Verifier credentials are incomplete");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImportManifest;
  const r2 = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
  const d1 = new CloudflareD1HttpDatabase({ accountId, databaseId, apiToken });
  const [remoteManifest, r2Objects, d1Snapshot] = await Promise.all([
    readRemoteManifest(r2, bucket),
    readR2Objects(r2, bucket),
    readD1ImportSnapshot(d1)
  ]);
  return verifyExactImport({ manifest, remoteManifest, r2Objects, d1: d1Snapshot });
}

async function runCommandLine(): Promise<void> {
  try {
    const index = process.argv.indexOf("--manifest");
    const manifestPath = index >= 0 ? process.argv[index + 1] : undefined;
    if (!manifestPath) throw new Error("Manifest argument is missing");
    const receipt = await runExactImportVerification(manifestPath);
    console.log(JSON.stringify(receipt));
    process.exitCode = verificationExitCode(receipt);
  } catch {
    console.log(JSON.stringify({ version: RECEIPT_VERSION, state: "error", passed: false, errorClass: "verification-failed" }));
    process.exitCode = 2;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) await runCommandLine();
