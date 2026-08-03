import { createHash } from "node:crypto";
import { mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { readSourceFiles, type SourceReaderOptions, type SourceReadReceipt } from "./source-reader";

export interface ManifestEntry { path: string; sha256: string; size: number }
export interface ImportManifest { generatedAt: string; sourceRoot: string; entries: ManifestEntry[]; totalBytes: number; sourceRead: SourceReadReceipt }
export interface RemoteImportManifest {
  version: 1;
  manifestHash: string;
  entries: ManifestEntry[];
  totalBytes: number;
}

function compareManifestPaths(left: ManifestEntry, right: ManifestEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function canonicalManifestEntry(entry: ManifestEntry): ManifestEntry {
  const path = entry.path.normalize("NFC");
  const segments = path.split("/");
  if (
    !path || path !== entry.path || path.startsWith("/") || /^[A-Za-z]:\//.test(path) ||
    path.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Manifest contains an unsafe or non-canonical relative path");
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Manifest contains an invalid entry size");
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Manifest contains an invalid SHA-256 digest");
  return { path, size: entry.size, sha256: entry.sha256 };
}

export function canonicalManifestEntries(manifest: Pick<ImportManifest, "entries"> | readonly ManifestEntry[]): ManifestEntry[] {
  const source: readonly ManifestEntry[] = Array.isArray(manifest)
    ? manifest
    : (manifest as Pick<ImportManifest, "entries">).entries;
  const entries = source.map(canonicalManifestEntry).sort(compareManifestPaths);
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error("Canonical manifest paths must be unique");
  return entries;
}

export function calculateManifestHash(manifest: Pick<ImportManifest, "entries"> | readonly ManifestEntry[]): string {
  return createHash("sha256").update(JSON.stringify(canonicalManifestEntries(manifest))).digest("hex");
}

export function createRemoteImportManifest(manifest: Pick<ImportManifest, "entries">): RemoteImportManifest {
  const entries = canonicalManifestEntries(manifest);
  return {
    version: 1,
    manifestHash: calculateManifestHash(entries),
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0)
  };
}

export interface VerifiedManifestStage {
  directory: string;
  receipt: SourceReadReceipt;
  read(path: string): Promise<Buffer>;
  dispose(): Promise<void>;
}

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

function relativeManifestPath(root: string, absolute: string): string {
  const path = relative(root, absolute).split(sep).join("/").normalize("NFC");
  if (!path || path === ".." || path.startsWith("../")) throw new Error("Source path escapes source root");
  return path;
}

function absoluteManifestPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (absolute === root || !absolute.startsWith(`${root}${sep}`)) throw new Error("Manifest path escapes source root");
  return absolute;
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
  const entries: ManifestEntry[] = [];
  await walk(root, paths);
  paths.sort((a, b) => a.localeCompare(b, "en"));
  const source = await readSourceFiles(paths, {
    ...readerOptions,
    root,
    onRead: async (absolute, bytes) => {
      entries.push({
        path: relativeManifestPath(root, absolute),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength
      });
    }
  });
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error("Normalized manifest paths must be unique");
  return {
    generatedAt: new Date().toISOString(),
    sourceRoot: root,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    sourceRead: source.receipt
  };
}

export async function stageVerifiedManifestSource(manifest: ImportManifest, readerOptions: SourceReaderOptions = {}): Promise<VerifiedManifestStage> {
  const root = resolve(manifest.sourceRoot);
  const directory = await mkdtemp(join(tmpdir(), "mnemosyne-import-stage-"));
  const stagedFiles = new Map<string, string>();
  const entriesByAbsolutePath = new Map<string, ManifestEntry>();

  for (const entry of manifest.entries) {
    const absolute = absoluteManifestPath(root, entry.path);
    if (entriesByAbsolutePath.has(absolute) || stagedFiles.has(entry.path)) throw new Error("Manifest paths must be unique before staging");
    entriesByAbsolutePath.set(absolute, entry);
  }

  try {
    const source = await readSourceFiles([...entriesByAbsolutePath.keys()], {
      ...readerOptions,
      root,
      onRead: async (absolute, bytes) => {
        const entry = entriesByAbsolutePath.get(absolute);
        if (!entry) throw new Error("Verified source reader returned an unknown manifest path");
        verifyManifestEntryBytes(entry, bytes);
        const stagedPath = join(directory, `${stagedFiles.size.toString().padStart(8, "0")}.md`);
        await writeFile(stagedPath, bytes, { mode: 0o600 });
        stagedFiles.set(entry.path, stagedPath);
      }
    });
    if (stagedFiles.size !== manifest.entries.length) throw new Error("Verified source staging is incomplete");

    let disposed = false;
    return {
      directory,
      receipt: source.receipt,
      async read(path: string): Promise<Buffer> {
        if (disposed) throw new Error("Verified source stage has been disposed");
        const stagedPath = stagedFiles.get(path);
        if (!stagedPath) throw new Error("Verified source stage is missing a manifest entry");
        return readFile(stagedPath);
      },
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        stagedFiles.clear();
        await rm(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
