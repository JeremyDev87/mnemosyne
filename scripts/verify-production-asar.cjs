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

const FORBIDDEN_ARCHIVE_ENTRIES = Object.freeze([
  { markerId: "PYTHON_DIRECT_URL_METADATA", pattern: /(?:^|\/)[^/]+\.dist-info\/direct_url\.json$/ },
  { markerId: "PYTHON_EDITABLE_INSTALL_EGG_LINK", pattern: /(?:^|\/)[^/]+\.egg-link$/ },
  { markerId: "VCS_METADATA_PATH", pattern: /(?:^|\/)\.(?:git|hg|svn)(?:\/|$)/ }
]);

function scanAsar(archivePath) {
  const findings = [];
  const entries = listPackage(archivePath, { isPack: false }).sort();

  for (const archiveEntry of entries) {
    for (const { markerId, pattern } of FORBIDDEN_ARCHIVE_ENTRIES) {
      if (pattern.test(archiveEntry)) {
        findings.push({ markerId, entry: archiveEntry });
      }
    }
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

function formatDiagnosticEntry(entry) {
  return Array.from(JSON.stringify(entry), (character) => {
    const codePoint = character.charCodeAt(0);
    const mustEscape = codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029;
    return mustEscape ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
  }).join("");
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
      console.log(`FAIL_PRODUCTION_ASAR_MARKERS marker=${finding.markerId} entry=${formatDiagnosticEntry(finding.entry)}`);
    }
    process.exitCode = 1;
  } catch {
    console.log("FAIL_PRODUCTION_ASAR_MARKERS archive");
    process.exitCode = 1;
  }
}

module.exports = { scanAsar };

if (require.main === module) main();
