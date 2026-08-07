import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rendererAssetPath, rendererEntryUrl, serveRendererAsset } from "../src/electron/renderer-protocol";

describe("Mnemosyne renderer protocol", () => {
  it("maps only the allowlisted bundled renderer assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-renderer-"));
    const rendererRoot = join(root, ".webpack", "renderer", "main_window");
    await mkdir(rendererRoot, { recursive: true });
    await writeFile(join(rendererRoot, "index.html"), "<!doctype html>");

    expect(rendererEntryUrl).toBe("mnemosyne://renderer/main_window/index.html");
    expect(rendererAssetPath(root, rendererEntryUrl)).toBe(join(rendererRoot, "index.html"));
    expect(rendererAssetPath(root, "mnemosyne://renderer/%2e%2e/private.md")).toBeUndefined();
    expect(rendererAssetPath(root, "file:///private/wiki/secret.md")).toBeUndefined();
    expect(rendererAssetPath(root, "mnemosyne://renderer/main_window/other.js")).toBeUndefined();

    const response = await serveRendererAsset(root, rendererEntryUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("<!doctype html>");
  });
});
