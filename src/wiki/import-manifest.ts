import { createHash } from "node:crypto";
import { opendir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export interface ManifestEntry { path: string; sha256: string; size: number }
export interface ImportManifest { generatedAt: string; sourceRoot: string; entries: ManifestEntry[]; totalBytes: number }

const SKIP_DIRECTORIES = new Set([".git", ".hermes", ".omo", "node_modules", "hermes-artifacts"]);

async function walk(root: string, directory: string, entries: ManifestEntry[]): Promise<void> {
  const handle = await opendir(directory);
  for await (const item of handle) {
    if (item.isSymbolicLink()) continue;
    const absolute = resolve(directory, item.name);
    if (item.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(item.name) && !item.name.startsWith(".")) await walk(root, absolute, entries);
      continue;
    }
    if (!item.isFile() || !item.name.toLowerCase().endsWith(".md")) continue;
    const info = await stat(absolute);
    const bytes = await readFile(absolute);
    entries.push({
      path: relative(root, absolute).split(sep).join("/").normalize("NFC"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: info.size
    });
  }
}

export async function scanMarkdownSource(sourceRoot: string): Promise<ImportManifest> {
  const root = resolve(sourceRoot);
  const entries: ManifestEntry[] = [];
  await walk(root, root, entries);
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return {
    generatedAt: new Date().toISOString(),
    sourceRoot: root,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0)
  };
}
