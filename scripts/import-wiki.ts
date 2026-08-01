import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanMarkdownSource } from "../src/wiki/import-manifest";
import { evaluateStorageBudget } from "../src/config/budget";

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
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", files: manifest.entries.length, bytes: manifest.totalBytes, budget: budget.state, manifestPath }));
if (!apply) process.exit(0);

const endpoint = process.env.R2_ENDPOINT;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;
if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) throw new Error("R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required for --apply");
const client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
for (const [index, entry] of manifest.entries.entries()) {
  const bytes = await readFile(resolve(manifest.sourceRoot, entry.path));
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: `shadow/current/${entry.path}`, Body: bytes, ContentType: "text/markdown; charset=utf-8", Metadata: { sha256: entry.sha256 } }));
  if ((index + 1) % 100 === 0) console.log(JSON.stringify({ uploaded: index + 1, total: manifest.entries.length }));
}
await client.send(new PutObjectCommand({ Bucket: bucket, Key: `shadow/manifests/${Date.now()}.json`, Body: JSON.stringify(manifest), ContentType: "application/json" }));
console.log(JSON.stringify({ uploaded: manifest.entries.length, state: "shadow-import-complete" }));
