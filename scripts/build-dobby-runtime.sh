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
cat > native/bin/dobby-runtime/bin/dobby-wiki <<'SH'
#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$here/../python/bin/python3" -m dobby_wiki.cli "$@"
SH
chmod 755 native/bin/dobby-runtime/bin/dobby-wiki native/bin/dobby-runtime/python/bin/python3
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
const output = {
  schema_version: 1,
  package_name: packageAuthority.package_name,
  package_version: packageAuthority.package_version,
  source_commit: packageAuthority.source_commit,
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
