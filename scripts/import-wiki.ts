import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRemoteImportManifest, scanMarkdownSource, stageVerifiedManifestSource } from "../src/wiki/import-manifest";
import { evaluateStorageBudget } from "../src/config/budget";
import { indexDocument } from "../src/wiki/indexer";
import { CloudflareD1HttpDatabase } from "../src/wiki/d1-http";

const args = new Set(process.argv.slice(2));
const value = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const source = value("--source") ?? process.env.WIKI_SOURCE_ROOT;
const apply = args.has("--apply");
if (!source) throw new Error("Provide --source or WIKI_SOURCE_ROOT");
const manifest = await scanMarkdownSource(source);
const budget = evaluateStorageBudget(manifest.totalBytes);
if (budget.state === "blocked") throw new Error("Import exceeds the 10 GiB hard limit");
const manifestPath = resolve(value("--manifest") ?? ".tmp/import-manifest.json");
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", files: manifest.entries.length, bytes: manifest.totalBytes, budget: budget.state, manifestPath, sourceRead: manifest.sourceRead }));
if (!apply) process.exit(0);

const endpoint = process.env.R2_ENDPOINT;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;
const accountId = process.env.D1_ACCOUNT_ID;
const databaseId = process.env.D1_DATABASE_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !accountId || !databaseId || !apiToken) {
  throw new Error("R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, D1_ACCOUNT_ID, D1_DATABASE_ID and CLOUDFLARE_API_TOKEN are required for --apply");
}
const verifiedSource = await stageVerifiedManifestSource(manifest);
console.log(JSON.stringify({ state: "apply-source-preflight-complete", sourceRead: verifiedSource.receipt }));
try {
  const client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
  const db = new CloudflareD1HttpDatabase({ accountId, databaseId, apiToken });
  const remoteManifest = createRemoteImportManifest(manifest);
  const manifestHash = remoteManifest.manifestHash;
  await db.execute("UPDATE index_status SET state = 'indexing', updated_at = ? WHERE id = 1", [new Date().toISOString()]);
  let indexed = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    const bytes = await verifiedSource.read(entry.path);
    const content = bytes.toString("utf8");
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: `shadow/current/${entry.path}`, Body: bytes, ContentType: "text/markdown; charset=utf-8", Metadata: { sha256: entry.sha256 } }));
    await indexDocument(db, entry.path, content, entry.sha256);
    indexed += 1;
    if ((index + 1) % 100 === 0) console.log(JSON.stringify({ uploaded: index + 1, indexed, total: manifest.entries.length }));
  }
  const serializedRemoteManifest = JSON.stringify(remoteManifest);
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: `shadow/manifests/${manifestHash}.json`, Body: serializedRemoteManifest, ContentType: "application/json" }));
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: "shadow/manifests/current.json", Body: serializedRemoteManifest, ContentType: "application/json" }));
  await db.execute("UPDATE index_status SET state = 'ready', document_count = ?, manifest_hash = ?, updated_at = ? WHERE id = 1", [indexed, manifestHash, new Date().toISOString()]);
  console.log(JSON.stringify({ uploaded: manifest.entries.length, indexed, state: "shadow-import-and-index-complete" }));
} finally {
  await verifiedSource.dispose();
}
