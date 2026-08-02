import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanMarkdownSource, stageVerifiedManifestSource, verifyManifestEntryBytes } from "../src/wiki/import-manifest";

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
});
