import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { readSourceFiles, type SourceReaderOptions, type SourceReadReceipt } from "./source-reader";

export interface ManifestEntry { path: string; sha256: string; size: number }
export interface ImportManifest { generatedAt: string; sourceRoot: string; entries: ManifestEntry[]; totalBytes: number; sourceRead: SourceReadReceipt }

const SKIP_DIRECTORIES = new Set([".git", ".hermes", ".omo", "node_modules", "hermes-artifacts"]);

async function walk(directory: string, paths: string[]): Promise<void> {
  const handle = await opendir(directory);
  for await (const item of handle) {
    if (item.isSymbolicLink()) continue;
    const absolute = resolve(directory, item.name);
    if (item.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(item.name) && !item.name.startsWith(".")) await walk(absolute, paths);
      continue;
    }
    if (!item.isFile() || !item.name.toLowerCase().endsWith(".md")) continue;
    paths.push(absolute);
  }
}

export function verifyManifestEntryBytes(entry: ManifestEntry, bytes: Buffer): void {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (entry.size !== bytes.byteLength || entry.sha256 !== digest) {
    throw new Error(`Source drift detected before remote mutation; pathDigest=${createHash("sha256").update(entry.path).digest("hex").slice(0, 12)}`);
  }
}

export async function scanMarkdownSource(sourceRoot: string, readerOptions: SourceReaderOptions = {}): Promise<ImportManifest> {
  const root = resolve(sourceRoot);
  const paths: string[] = [];
  await walk(root, paths);
  paths.sort((a, b) => a.localeCompare(b, "en"));
  const source = await readSourceFiles(paths, readerOptions);
  const entries = paths.map((absolute) => {
    const bytes = source.files.get(absolute);
    if (!bytes) throw new Error("Source reader completed without bytes for a discovered file");
    return {
      path: relative(root, absolute).split(sep).join("/").normalize("NFC"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength
    };
  });
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return {
    generatedAt: new Date().toISOString(),
    sourceRoot: root,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    sourceRead: source.receipt
  };
}

export async function readVerifiedManifestSource(manifest: ImportManifest, readerOptions: SourceReaderOptions = {}): Promise<{ files: Map<string, Buffer>; receipt: SourceReadReceipt }> {
  const root = resolve(manifest.sourceRoot);
  const absolutePaths = manifest.entries.map((entry) => {
    const absolute = resolve(root, entry.path);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error("Manifest path escapes source root");
    return absolute;
  });
  const source = await readSourceFiles(absolutePaths, readerOptions);
  const files = new Map<string, Buffer>();
  for (const [index, entry] of manifest.entries.entries()) {
    const bytes = source.files.get(absolutePaths[index] ?? "");
    if (!bytes) throw new Error("Verified source reader completed without manifest bytes");
    verifyManifestEntryBytes(entry, bytes);
    files.set(entry.path, bytes);
  }
  return { files, receipt: source.receipt };
}
