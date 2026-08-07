const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { WebpackPlugin } = require("@electron-forge/plugin-webpack");
const { MakerZIP } = require("@electron-forge/maker-zip");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const isE2EBuild = process.env.MNEMOSYNE_E2E_BUILD === "1";
const productName = isE2EBuild ? "Mnemosyne-E2E-UNSAFE" : "Mnemosyne";

module.exports = {
  outDir: isE2EBuild ? "out-e2e" : "out",
  packagerConfig: {
    asar: true,
    executableName: productName,
    appBundleId: isE2EBuild ? "com.jeremywinchester.mnemosyne.e2e-unsafe" : "com.jeremywinchester.mnemosyne",
    name: productName
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== "darwin" || packageResult.arch !== "arm64") {
        throw new Error("Mnemosyne packaging is restricted to darwin/arm64");
      }
      for (const outputPath of packageResult.outputPaths) {
        const appPath = outputPath.endsWith(".app") ? outputPath : join(outputPath, `${productName}.app`);
        if (!existsSync(appPath)) throw new Error(`Packaged app is missing at ${appPath}`);
        await flipFuses(appPath, {
          version: FuseVersion.V1,
          strictlyRequireAllFuses: true,
          [FuseV1Options.RunAsNode]: false,
          [FuseV1Options.EnableCookieEncryption]: true,
          [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
          [FuseV1Options.EnableNodeCliInspectArguments]: false,
          [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
          [FuseV1Options.OnlyLoadAppFromAsar]: true,
          [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
          [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
          [FuseV1Options.WasmTrapHandlers]: true
        });
        execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
      }
    }
  },
  makers: [new MakerZIP({}, ["darwin"])],
  plugins: [
    new WebpackPlugin({
      mainConfig: "./webpack.main.config.cjs",
      renderer: {
        config: "./webpack.renderer.config.cjs",
        entryPoints: [{
          html: "./src/renderer/index.html",
          js: "./src/renderer/index.tsx",
          name: "main_window",
          preload: { js: "./src/electron/preload.ts" }
        }]
      }
    })
  ]
};
