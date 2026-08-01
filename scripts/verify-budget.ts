import { readFile } from "node:fs/promises";
import { evaluateStorageBudget } from "../src/config/budget";
import type { ImportManifest } from "../src/wiki/import-manifest";

const index = process.argv.indexOf("--manifest");
const manifestPath = index >= 0 ? process.argv[index + 1] : undefined;
if (!manifestPath) throw new Error("Provide --manifest <path>");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImportManifest;
const result = evaluateStorageBudget(manifest.totalBytes);
console.log(JSON.stringify({ ...result, files: manifest.entries.length }));
if (result.state === "blocked") process.exitCode = 2;
