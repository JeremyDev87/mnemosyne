import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("Electron package entry contract", () => {
  it("locks the Forge CommonJS entry and file-protocol fuse", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const forgeConfig = await readFile(new URL("../forge.config.cjs", import.meta.url), "utf8");
    expect(packageJson.main).toBe(".webpack/main");
    expect(packageJson.type).not.toBe("module");
    expect((packageJson.scripts as Record<string, string>).make).toBe("npm run package && npm run build:dobby-runtime && bash scripts/build-macos-pkg.sh");
    expect((packageJson.scripts as Record<string, string>).package).not.toContain("build:dobby-runtime");
    expect((packageJson.scripts as Record<string, string>).make).toContain("npm run build:dobby-runtime");
    expect(forgeConfig).toContain("[FuseV1Options.GrantFileProtocolExtraPrivileges]: false");
    expect(forgeConfig).toContain("strictlyRequireAllFuses: true");
    expect(forgeConfig).toContain("[FuseV1Options.WasmTrapHandlers]: true");
    expect(forgeConfig).not.toContain("new FusesPlugin");
    expect(forgeConfig).toContain('throw new Error("Mnemosyne packaging is restricted to darwin/arm64")');
    expect(forgeConfig).toContain('outDir: isE2EBuild ? "out-e2e" : "out"');
    expect(forgeConfig).not.toContain("MakerZIP");
    expect(forgeConfig).toContain('"Mnemosyne-E2E-UNSAFE"');
    expect(forgeConfig).toContain('"com.jeremywinchester.mnemosyne.e2e-unsafe"');
  });

  it.each([
    ["darwin", "x64"],
    ["linux", "arm64"]
  ])("fails closed for unsupported package target %s/%s", async (platform, arch) => {
    const forgeConfig = require("../forge.config.cjs") as {
      hooks: { postPackage: (config: unknown, result: { platform: string; arch: string; outputPaths: string[] }) => Promise<void> };
    };
    await expect(forgeConfig.hooks.postPackage({}, { platform, arch, outputPaths: [] }))
      .rejects.toThrow("Mnemosyne packaging is restricted to darwin/arm64");
  });
});
