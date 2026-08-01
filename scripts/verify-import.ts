import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import type { ImportManifest } from "../src/wiki/import-manifest";

const index = process.argv.indexOf("--manifest");
const manifestPath = index >= 0 ? process.argv[index + 1] : undefined;
if (!manifestPath) throw new Error("Provide --manifest <path>");
const endpoint = process.env.R2_ENDPOINT;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;
if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) throw new Error("Remote R2 credentials are required");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImportManifest;
const client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
const failures: Array<{ path: string; reason: string }> = [];
for (const entry of manifest.entries) {
  try {
    const remote = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `shadow/current/${entry.path}` }));
    if (remote.ContentLength !== entry.size || remote.Metadata?.sha256 !== entry.sha256) failures.push({ path: entry.path, reason: "size/hash mismatch" });
  } catch { failures.push({ path: entry.path, reason: "missing" }); }
}
console.log(JSON.stringify({ checked: manifest.entries.length, failures: failures.slice(0, 20), passed: failures.length === 0 }));
if (failures.length) process.exitCode = 1;
