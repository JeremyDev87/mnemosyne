const { extractFile, listPackage, statFile } = require("@electron/asar");

const FORBIDDEN_MARKERS = Object.freeze([
  "MNEMOSYNE_E2E_",
  "Mnemosyne-E2E-UNSAFE",
  "com.jeremywinchester.mnemosyne.e2e-unsafe",
  "createTestSigningIdentity",
  "tests/helpers/signed-snapshot",
  "BEGIN PRIVATE KEY",
  "BEGIN EC PRIVATE KEY",
  "mnemosyne-e2e-home-",
  "fixture-derived verified body"
]);

function scanAsar(archivePath) {
  const findings = [];
  const entries = listPackage(archivePath, { isPack: false }).sort();

  for (const archiveEntry of entries) {
    const entry = archiveEntry.slice(1);
    const info = statFile(archivePath, entry, false);
    if ("files" in info || "link" in info) continue;
    const bytes = extractFile(archivePath, entry, false);
    for (const marker of FORBIDDEN_MARKERS) {
      if (bytes.includes(Buffer.from(marker, "utf8"))) {
        findings.push({ markerId: marker, entry: archiveEntry });
      }
    }
  }

  return findings;
}

function main() {
  const archivePath = process.argv[2];
  if (!archivePath || process.argv.length !== 3) {
    console.log("FAIL_PRODUCTION_ASAR_MARKERS usage");
    process.exitCode = 2;
    return;
  }

  try {
    const findings = scanAsar(archivePath);
    if (findings.length === 0) {
      console.log("PASS_PRODUCTION_ASAR_MARKERS");
      return;
    }
    for (const finding of findings) {
      console.log(`FAIL_PRODUCTION_ASAR_MARKERS marker=${finding.markerId} entry=${finding.entry}`);
    }
    process.exitCode = 1;
  } catch {
    console.log("FAIL_PRODUCTION_ASAR_MARKERS archive");
    process.exitCode = 1;
  }
}

module.exports = { scanAsar };

if (require.main === module) main();
