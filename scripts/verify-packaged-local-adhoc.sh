#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(/usr/bin/uname -s)" != "Darwin" || "$(/usr/bin/uname -m)" != "arm64" ]]; then
  printf 'FAIL_PACKAGED_LOCAL_ADHOC platform\n' >&2
  exit 1
fi

shopt -s nullglob
apps=("$ROOT"/out/*/*.app)
if [[ "${#apps[@]}" -ne 1 ]]; then
  printf 'FAIL_PACKAGED_LOCAL_ADHOC app_count=%s\n' "${#apps[@]}" >&2
  exit 1
fi
app="${apps[0]}"
app_executable="$app/Contents/MacOS/Mnemosyne"
helper="$app/Contents/Resources/mnemosyne-trust-helper"
asar="$app/Contents/Resources/app.asar"

[[ -f "$app/Contents/Info.plist" ]] || { printf 'FAIL_PACKAGED_LOCAL_ADHOC app_info\n' >&2; exit 1; }
[[ -f "$app_executable" ]] || { printf 'FAIL_PACKAGED_LOCAL_ADHOC app_executable\n' >&2; exit 1; }
[[ -f "$helper" ]] || { printf 'FAIL_PACKAGED_LOCAL_ADHOC helper\n' >&2; exit 1; }
[[ -s "$asar" ]] || { printf 'FAIL_PACKAGED_LOCAL_ADHOC asar\n' >&2; exit 1; }
node "$ROOT/scripts/verify-production-asar.cjs" "$asar"

app_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")"
[[ "$app_id" == "com.jeremywinchester.mnemosyne" ]] || { printf 'FAIL_PACKAGED_LOCAL_ADHOC app_identifier\n' >&2; exit 1; }

app_arch="$(/usr/bin/lipo -archs "$app_executable")"
helper_arch="$(/usr/bin/lipo -archs "$helper")"
[[ "$app_arch" == "arm64" && "$helper_arch" == "arm64" ]] || { printf 'FAIL_PACKAGED_LOCAL_ADHOC architecture\n' >&2; exit 1; }

app_signature="$({ /usr/bin/codesign -d --verbose=4 "$app"; } 2>&1)"
helper_signature="$({ /usr/bin/codesign -d --verbose=4 "$helper"; } 2>&1)"
[[ "$app_signature" == *"Identifier=com.jeremywinchester.mnemosyne"* ]] || { printf 'FAIL_PACKAGED_LOCAL_ADHOC app_signature_identifier\n' >&2; exit 1; }
[[ "$helper_signature" == *"Identifier=com.jeremywinchester.mnemosyne.trust-helper"* ]] || { printf 'FAIL_PACKAGED_LOCAL_ADHOC helper_signature_identifier\n' >&2; exit 1; }
[[ "$app_signature" == *"TeamIdentifier=not set"* && "$helper_signature" == *"TeamIdentifier=not set"* ]] || { printf 'FAIL_PACKAGED_LOCAL_ADHOC signature_mode\n' >&2; exit 1; }

/usr/bin/codesign --verify --deep --strict "$app" >/dev/null 2>&1 || { printf 'FAIL_PACKAGED_LOCAL_ADHOC codesign\n' >&2; exit 1; }
fuses="$(npx --no-install @electron/fuses read --app "$app")"
for expected in \
  "Fuse Version: v1" \
  "RunAsNode is Disabled" \
  "EnableCookieEncryption is Enabled" \
  "EnableNodeOptionsEnvironmentVariable is Disabled" \
  "EnableNodeCliInspectArguments is Disabled" \
  "EnableEmbeddedAsarIntegrityValidation is Enabled" \
  "OnlyLoadAppFromAsar is Enabled" \
  "LoadBrowserProcessSpecificV8Snapshot is Disabled" \
  "GrantFileProtocolExtraPrivileges is Disabled" \
  "WasmTrapHandlers is Enabled"; do
  [[ "$fuses" == *"$expected"* ]] || { printf 'FAIL_PACKAGED_LOCAL_ADHOC fuse_contract\n' >&2; exit 1; }
done

printf 'PASS_PACKAGED_LOCAL_ADHOC app_id=%s helper_id=%s arch=%s asar=present fuses=verified signature=local-ad-hoc\n' \
  "$app_id" "com.jeremywinchester.mnemosyne.trust-helper" "$app_arch"
