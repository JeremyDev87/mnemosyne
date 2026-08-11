import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { scanAsar } from "../scripts/verify-production-asar.cjs";

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

async function createFixture(files: readonly (readonly [string, string])[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mnemosyne-asar-gate-"));
  roots.push(root);
  const source = join(root, "source");
  const archive = join(root, "app.asar");
  for (const [relativePath, contents] of files) {
    const destination = join(source, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  await createPackage(source, archive);
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
    expect(result.stdout).toBe(expected.map(({ markerId, entry }) => `FAIL_PRODUCTION_ASAR_MARKERS marker=${markerId} entry=${entry}`).join("\n") + "\n");
    expect(result.stdout).not.toContain("secret-payload");
    expect(result.stderr).toBe("");
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
