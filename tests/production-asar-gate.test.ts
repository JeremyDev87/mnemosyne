import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import packageJson from "../package.json";
import scanner from "../scripts/verify-production-asar.cjs";

const { scanAsar } = scanner;
const scanResourceTree = (scanner as unknown as {
  scanResourceTree: (root: string) => Array<{ markerId: string; entry: string }>;
}).scanResourceTree;

const scannerPath = join(process.cwd(), "scripts", "verify-production-asar.cjs");
const roots: string[] = [];

const forbiddenMarkers = [
  "MNEMOSYNE_E2E_",
  "Mnemosyne-E2E-UNSAFE",
  "com.jeremywinchester.mnemosyne.e2e-unsafe",
  "createTestSigningIdentity",
  "tests/helpers/signed-snapshot",
  "BEGIN PRIVATE KEY",
  "BEGIN EC PRIVATE KEY",
  "mnemosyne-e2e-home-",
  "fixture-derived verified body"
] as const;

async function createFixture(
  files: readonly (readonly [string, string])[],
  options: {
    directories?: readonly string[];
    symlinks?: readonly (readonly [string, string])[];
  } = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mnemosyne-asar-gate-"));
  roots.push(root);
  const source = join(root, "source");
  const archive = join(root, "app.asar");
  for (const [relativePath, contents] of files) {
    const destination = join(source, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  for (const relativePath of options.directories ?? []) {
    await mkdir(join(source, relativePath), { recursive: true });
  }
  for (const [relativePath, target] of options.symlinks ?? []) {
    const destination = join(source, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(target, destination);
  }
  const packageStream = await createPackage(source, archive);
  await new Promise<void>((resolve, reject) => {
    packageStream.once("finish", resolve);
    packageStream.once("error", reject);
  });
  return archive;
}

describe("production ASAR forbidden-marker gate", () => {
  it("chains verification after production packaging without changing the E2E artifact", async () => {
    const packagedVerifier = await readFile(new URL("../scripts/verify-packaged-local-adhoc.sh", import.meta.url), "utf8");

    expect(packageJson.scripts.package).toContain("npm run verify:production-asar");
    expect(packageJson.scripts["verify:production-asar"]).toBe("node scripts/verify-production-asar.cjs out/*/*.app/Contents/Resources/app.asar");
    expect(packageJson.scripts["package:e2e"]).not.toContain("verify:production-asar");
    expect(packageJson.scripts["package:e2e"]).not.toContain("MNEMOSYNE_E2E_");
    expect(packagedVerifier).toContain('node "$ROOT/scripts/verify-production-asar.cjs" "$asar"');
  });

  it("accepts clean bytes and ignores markers outside the exact contract", async () => {
    const archive = await createFixture([
      ["dist/main.js", "const safe = 'direct_url dirty /tmp/path';"],
      ["docs/fixture.md", "fixture-derived verified content"]
    ]);

    expect(scanAsar(archive)).toEqual([]);
    expect(execFileSync(process.execPath, [scannerPath, archive], { encoding: "utf8" })).toBe("PASS_PRODUCTION_ASAR_MARKERS\n");
  });

  it("reports every exact marker with a stable entry and never emits archive bytes", async () => {
    const files = forbiddenMarkers.map((marker, index) => [`markers/${String(index).padStart(2, "0")}.txt`, `poison-${marker}-secret-payload`] as const);
    const archive = await createFixture(files);
    const findings = scanAsar(archive);
    const expected = forbiddenMarkers.map((marker, index) => ({ markerId: marker, entry: `/markers/${String(index).padStart(2, "0")}.txt` }));

    expect(findings).toEqual(expected);

    const result = spawnSync(process.execPath, [scannerPath, archive], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(expected.map(({ markerId, entry }) => `FAIL_PRODUCTION_ASAR_MARKERS marker=${markerId} entry=${JSON.stringify(entry)}`).join("\n") + "\n");
    expect(result.stdout).not.toContain("secret-payload");
    expect(result.stderr).toBe("");
  });

  it("rejects exact Python dirty-install metadata and VCS path segments only", async () => {
    const archive = await createFixture([
      ["site-packages/example-1.0.dist-info/direct_url.json", "{}"],
      ["site-packages/example.egg-link", "/workspace/example"],
      ["node_modules/example/.git/config", "[core]"],
      ["node_modules/example/.hg/store", "revlog"],
      ["node_modules/example/.svn/entries", "svn"],
      ["ordinary/direct_url.json.txt", "direct_url"],
      ["ordinary/example.egg-link.txt", "dirty"],
      ["ordinary/.gitignore", "/tmp /Users"],
    ]);

    expect(scanAsar(archive)).toEqual([
      { markerId: "VCS_METADATA_PATH", entry: "/node_modules/example/.git" },
      { markerId: "VCS_METADATA_PATH", entry: "/node_modules/example/.git/config" },
      { markerId: "VCS_METADATA_PATH", entry: "/node_modules/example/.hg" },
      { markerId: "VCS_METADATA_PATH", entry: "/node_modules/example/.hg/store" },
      { markerId: "VCS_METADATA_PATH", entry: "/node_modules/example/.svn" },
      { markerId: "VCS_METADATA_PATH", entry: "/node_modules/example/.svn/entries" },
      { markerId: "PYTHON_DIRECT_URL_METADATA", entry: "/site-packages/example-1.0.dist-info/direct_url.json" },
      { markerId: "PYTHON_EDITABLE_INSTALL_EGG_LINK", entry: "/site-packages/example.egg-link" },
    ]);
  });

  it("scans the unpacked bundled runtime for dirty install metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnemosyne-runtime-gate-"));
    roots.push(root);
    await mkdir(join(root, "python", "site-packages", "example.dist-info"), { recursive: true });
    await writeFile(join(root, "python", "site-packages", "example.dist-info", "direct_url.json"), "{}");
    expect(scanResourceTree(root)).toContainEqual({
      markerId: "PYTHON_DIRECT_URL_METADATA",
      entry: "python/site-packages/example.dist-info/direct_url.json"
    });
  });

  it("rejects forbidden paths even when the archive entry is an empty directory or symlink", async () => {
    const archive = await createFixture(
      [["editable-source/README.md", "safe"]],
      {
        directories: ["node_modules/example/.git"],
        symlinks: [["site-packages/example.egg-link", "../editable-source/README.md"]]
      }
    );

    expect(scanAsar(archive)).toEqual([
      { markerId: "VCS_METADATA_PATH", entry: "/node_modules/example/.git" },
      { markerId: "PYTHON_EDITABLE_INSTALL_EGG_LINK", entry: "/site-packages/example.egg-link" }
    ]);
  });

  it("escapes C0, C1, DEL, and Unicode line separators in one physical diagnostic line", async () => {
    const entry = "markers/evil\n\u001b\u007f\u0085\u009b\u2028\u2029.txt";
    const archive = await createFixture([[entry, "poison-secret-payload-BEGIN PRIVATE KEY"]]);
    const result = spawnSync(process.execPath, [scannerPath, archive], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      "FAIL_PRODUCTION_ASAR_MARKERS marker=BEGIN PRIVATE KEY entry=\"/markers/evil\\n\\u001b\\u007f\\u0085\\u009b\\u2028\\u2029.txt\"\n"
    );
    expect(result.stdout.split("\n")).toHaveLength(2);
    expect(Array.from(result.stdout.slice(0, -1), (character) => character.charCodeAt(0)).some((codePoint) =>
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029
    )).toBe(false);
    expect(result.stdout).not.toContain("poison-secret-payload");
    expect(result.stderr).toBe("");
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
