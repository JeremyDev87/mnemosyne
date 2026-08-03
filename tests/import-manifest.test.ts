import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateManifestHash,
  createRemoteImportManifest,
  scanMarkdownSource,
  stageVerifiedManifestSource,
  verifyManifestEntryBytes,
  type ImportManifest
} from "../src/wiki/import-manifest";

describe("streaming import manifest", () => {
  it("includes knowledge markdown while excluding hidden and binary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-"));
    await mkdir(join(root, "domains"), { recursive: true });
    await mkdir(join(root, ".hermes"), { recursive: true });
    const markdown = "# 한글\n본문";
    await writeFile(join(root, "domains", "한글.md"), markdown);
    await writeFile(join(root, "image.png"), "not really an image");
    await writeFile(join(root, ".hermes", "backup.md"), "hidden");

    const manifest = await scanMarkdownSource(root);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["domains/한글.md"]);
    expect(manifest.entries[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.totalBytes).toBe(Buffer.byteLength(markdown));
    expect(manifest.sourceRead).toMatchObject({ discovered: 1, readable: 1, failed: 0 });
  });

  it("verifies apply bytes against the same manifest size and digest", () => {
    const bytes = Buffer.from("# stable");
    const entry = { path: "stable.md", size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };

    expect(() => verifyManifestEntryBytes(entry, bytes)).not.toThrow();
    expect(() => verifyManifestEntryBytes(entry, Buffer.from("# drifted"))).toThrow(/source drift/i);
  });

  it("stages every verified apply byte on disk before exposing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-stage-"));
    await writeFile(join(root, "stable.md"), "# stable");
    const manifest = await scanMarkdownSource(root);

    const stage = await stageVerifiedManifestSource(manifest);
    expect((await stage.read("stable.md")).toString()).toBe("# stable");
    const stagedRoot = stage.directory;
    await stage.dispose();
    await expect(readFile(stagedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects source drift before creating a usable apply stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-drift-"));
    const path = join(root, "stable.md");
    await writeFile(path, "# stable");
    const manifest = await scanMarkdownSource(root);

    await writeFile(path, "# drifted");
    await expect(stageVerifiedManifestSource(manifest)).rejects.toThrow(/source drift/i);
  });

  it("rejects a discovered file replaced by an external symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-link-root-"));
    const outside = await mkdtemp(join(tmpdir(), "mnemosyne-link-outside-"));
    const path = join(root, "stable.md");
    await writeFile(path, "# stable");
    await writeFile(join(outside, "private.md"), "# private");
    const manifest = await scanMarkdownSource(root);

    await rm(path);
    await symlink(join(outside, "private.md"), path);
    await expect(stageVerifiedManifestSource(manifest)).rejects.toThrow(/ESYMLINK|EBOUNDARY/);
  });

  it("keeps the canonical hash stable across generations and local roots", () => {
    const entries = [
      { path: "z.md", size: 2, sha256: "b".repeat(64) },
      { path: "a.md", size: 1, sha256: "a".repeat(64) }
    ];
    const first: ImportManifest = {
      generatedAt: "2026-08-01T00:00:00.000Z",
      sourceRoot: "/Users/alice/Private Wiki",
      entries,
      totalBytes: 3,
      sourceRead: {
        discovered: 2,
        readable: 2,
        failed: 0,
        peakBufferedBytes: 2,
        hydration: { available: false, requested: 0, accepted: 0, failed: 0 },
        waves: [],
        finalErrorClasses: {}
      }
    };
    const second: ImportManifest = {
      ...first,
      generatedAt: "2026-08-02T12:34:56.000Z",
      sourceRoot: "/Volumes/another-private-root",
      entries: [...entries].reverse(),
      sourceRead: { ...first.sourceRead, peakBufferedBytes: 999 }
    };

    expect(calculateManifestHash(first)).toBe(calculateManifestHash(second));
    expect(createRemoteImportManifest(first)).toEqual(createRemoteImportManifest(second));
  });

  it("projects a deterministic remote manifest without local source metadata", () => {
    const manifest: ImportManifest = {
      generatedAt: "2026-08-01T00:00:00.000Z",
      sourceRoot: "/Users/alice/Private Wiki",
      entries: [{ path: "docs/public.md", size: 7, sha256: "c".repeat(64) }],
      totalBytes: 7,
      sourceRead: {
        discovered: 1,
        readable: 1,
        failed: 0,
        peakBufferedBytes: 7,
        hydration: { available: false, requested: 0, accepted: 0, failed: 0 },
        waves: [],
        finalErrorClasses: {}
      }
    };

    const remote = createRemoteImportManifest(manifest);
    const serialized = JSON.stringify(remote);
    expect(remote).toEqual({
      version: 1,
      manifestHash: calculateManifestHash(manifest),
      entries: [{ path: "docs/public.md", size: 7, sha256: "c".repeat(64) }],
      totalBytes: 7
    });
    expect(serialized).not.toContain(manifest.sourceRoot);
    expect(serialized).not.toContain("sourceRoot");
    expect(serialized).not.toContain("sourceRead");
    expect(serialized).not.toContain("generatedAt");
  });
});
