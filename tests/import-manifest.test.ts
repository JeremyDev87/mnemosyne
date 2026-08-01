import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanMarkdownSource } from "../src/wiki/import-manifest";

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
  });
});
