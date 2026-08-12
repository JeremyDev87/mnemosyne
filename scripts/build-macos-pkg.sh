#!/usr/bin/env bash
set -euo pipefail

app="out/Mnemosyne-darwin-arm64/Mnemosyne.app"
runtime="native/bin/dobby-runtime"
output="out/make/Mnemosyne-0.1.0-arm64.pkg"
[[ -d "$app" && -d "$runtime" ]] || { printf 'FAIL_MACOS_PKG missing_payload\n' >&2; exit 2; }

root="$(mktemp -d "${TMPDIR:-/tmp}/mnemosyne-pkg.XXXXXX")"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/Applications" "$root/Library/Application Support/Mnemosyne"
ditto "$app" "$root/Applications/Mnemosyne.app"
ditto "$runtime" "$root/Library/Application Support/Mnemosyne/dobby-runtime"
chmod -R go-w "$root/Library/Application Support/Mnemosyne"
mkdir -p "$(dirname "$output")"
/usr/bin/pkgbuild \
  --root "$root" \
  --identifier com.jeremywinchester.mnemosyne \
  --version 0.1.0 \
  --install-location / \
  --ownership recommended \
  "$output"
printf 'PASS_MACOS_PKG %s\n' "$output"
