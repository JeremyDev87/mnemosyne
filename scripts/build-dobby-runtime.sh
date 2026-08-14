#!/usr/bin/env bash
set -euo pipefail

source_root="${MNEMOSYNE_DOBBY_RUNTIME_SOURCE:-}"
package_authority="${MNEMOSYNE_DOBBY_AUTHORITY:-}"
wheel_path="${MNEMOSYNE_DOBBY_WHEEL:-}"
if [[ -z "$source_root" || -z "$package_authority" || -z "$wheel_path" ]]; then
  printf 'FAIL_DOBBY_RUNTIME_ADMISSION missing_explicit_runtime_inputs\n' >&2
  exit 2
fi
source_root="$(cd "$source_root" && pwd -P)"
package_authority="$(cd "$(dirname "$package_authority")" && pwd -P)/$(basename "$package_authority")"
wheel_path="$(cd "$(dirname "$wheel_path")" && pwd -P)/$(basename "$wheel_path")"
python_source="$source_root/python/bin/python3"
[[ -f "$python_source" && -x "$python_source" ]] || { printf 'FAIL_DOBBY_RUNTIME_ADMISSION missing_pinned_python\n' >&2; exit 2; }
[[ -f "$package_authority" ]] || { printf 'FAIL_DOBBY_RUNTIME_ADMISSION missing_package_authority\n' >&2; exit 2; }
[[ -f "$wheel_path" ]] || { printf 'FAIL_DOBBY_RUNTIME_ADMISSION missing_wheel\n' >&2; exit 2; }

rm -rf native/bin/dobby-runtime
mkdir -p native/bin
ditto "$source_root" native/bin/dobby-runtime
mkdir -p native/bin/dobby-runtime/bin
python_bundle="native/bin/dobby-runtime/python"
python_real="$(cd "$(dirname "$python_source")" && realpath "$(basename "$python_source")")"
[[ -f "$python_real" && -x "$python_real" ]] || { printf 'FAIL_DOBBY_RUNTIME_ADMISSION invalid_python_target\n' >&2; exit 2; }
if [[ "$python_real" != "$source_root/python/"* ]]; then
  python_prefix="$(cd "$(dirname "$python_real")/.." && pwd -P)"
  [[ -f "$python_prefix/lib/libpython3.12.dylib" ]] || { printf 'FAIL_DOBBY_RUNTIME_ADMISSION missing_python_runtime_library\n' >&2; exit 2; }
  site_packages="$(mktemp -d "${TMPDIR:-/tmp}/mnemosyne-python-site.XXXXXX")"
  trap 'rm -rf "$site_packages"' EXIT
  ditto "$python_bundle/lib/python3.12/site-packages" "$site_packages/site-packages"
  rm -rf "$python_bundle"
  mkdir -p "$python_bundle/bin"
  ditto "$python_prefix/lib" "$python_bundle/lib"
  rm -rf "$python_bundle/lib/python3.12/site-packages"
  ditto "$site_packages/site-packages" "$python_bundle/lib/python3.12/site-packages"
fi
# Wheel data files are installed outside site-packages. Preserve the verified
# RECORD layout so the runtime can locate and authenticate its Wikimap vendor.
"$python_real" - "$wheel_path" "$python_bundle" <<'PY'
import pathlib, sys, zipfile
wheel, prefix = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
suffix = ".data/data/"
with zipfile.ZipFile(wheel) as archive:
    members = [name for name in archive.namelist() if suffix in name and not name.endswith("/")]
    for name in members:
        relative = name.split(suffix, 1)[1]
        target = prefix / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.read(name))
PY
cp "$python_real" "$python_bundle/bin/python.mnemosyne"
chmod 755 "$python_bundle/bin/python.mnemosyne"
rm -f "$python_bundle/bin/python" "$python_bundle/bin/python3" "$python_bundle/bin/python3.12"
ln -s python.mnemosyne "$python_bundle/bin/python3"
cat > native/bin/dobby-runtime/bin/dobby-wiki <<'SH'
#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$here/../python/bin/python3" -m dobby_wiki.cli "$@"
SH
chmod 755 native/bin/dobby-runtime/bin/dobby-wiki native/bin/dobby-runtime/python/bin/python3
native/bin/dobby-runtime/bin/dobby-wiki --help >/dev/null
native/bin/dobby-runtime/python/bin/python3 - <<'PY'
from pathlib import Path
from dobby_wiki.vendor import find_wikimap_path, verify_vendor
path = find_wikimap_path(Path(__import__("dobby_wiki.projection", fromlist=["__file__"]).__file__))
if path is None:
    raise SystemExit("FAIL_DOBBY_RUNTIME_ADMISSION missing_verified_wikimap_vendor")
verify_vendor(path.parent)
PY
find native/bin/dobby-runtime -type f \( -name direct_url.json -o -name '*.egg-link' \) -delete
if find native/bin/dobby-runtime -type d \( -name .git -o -name .hg -o -name .svn \) -print -quit | grep -q .; then
  printf 'FAIL_DOBBY_RUNTIME_ADMISSION vcs_metadata\n' >&2
  exit 2
fi
command_path="$(cd native/bin/dobby-runtime/bin && pwd -P)/dobby-wiki"
command_sha256="$(shasum -a 256 "$command_path" | cut -d' ' -f1)"
python_path="$(cd native/bin/dobby-runtime/python/bin && pwd -P)/python3"
python_sha256="$(shasum -a 256 "$python_path" | cut -d' ' -f1)"
wheel_sha256="$(shasum -a 256 "$wheel_path" | cut -d' ' -f1)"
command_mode="$(stat -f '%Lp' "$command_path")"
node - "$package_authority" "$wheel_sha256" "$command_sha256" "$python_sha256" "$command_mode" > native/bin/dobby-runtime/authority.json <<'NODE'
const fs = require("node:fs");
const [authorityPath, wheelSha256, commandSha256, pythonSha256, commandMode] = process.argv.slice(2);
const packageAuthority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
const knownWheels = Array.isArray(packageAuthority.wheel_sha256) ? packageAuthority.wheel_sha256 : [packageAuthority.wheel_sha256];
if (!knownWheels.includes(wheelSha256)) throw new Error("wheel digest is not covered by package authority");
if (packageAuthority.status !== "verified-candidate") throw new Error("package authority status is not verified-candidate");
if (!/^[a-f0-9]{64}$/.test(packageAuthority.semantic_members_sha256 ?? "")) throw new Error("package authority semantic digest is invalid");
const output = {
  schema_version: 1,
  package_name: packageAuthority.package_name,
  package_version: packageAuthority.package_version,
  source_commit: packageAuthority.source_commit,
  semantic_members_sha256: packageAuthority.semantic_members_sha256,
  wheel_sha256: [wheelSha256],
  command_sha256: commandSha256,
  python_sha256: pythonSha256,
  command_mode: Number.parseInt(commandMode, 8),
  signature_mode: "app-bundle-codesign"
};
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
NODE
printf 'PASS_DOBBY_RUNTIME_ADMISSION version=%s source_commit=%s command_sha256=%s wheel_sha256=%s\n' \
  "$(node -p 'JSON.parse(require("fs").readFileSync("native/bin/dobby-runtime/authority.json", "utf8")).package_version')" \
  "$(node -p 'JSON.parse(require("fs").readFileSync("native/bin/dobby-runtime/authority.json", "utf8")).source_commit')" \
  "$command_sha256" "$wheel_sha256"
