#!/bin/bash
set -euo pipefail

USER_TEMP="$(/usr/bin/getconf DARWIN_USER_TEMP_DIR)"
ROOT="$(mktemp -d "${USER_TEMP%/}/mnemosyne-local-adhoc-gate.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
APP="$ROOT/Mnemosyne.app"
HELPER="$APP/Contents/Resources/mnemosyne-trust-helper"
LAUNCHER="$APP/Contents/MacOS/Electron"
HARNESS="$ROOT/invoke-trusted-helper.cjs"
JS_ROOT="$ROOT/js"
node -e 'require("electron")' >/dev/null
ELECTRON_EXECUTABLE="$(node -p 'require("electron")')"
ELECTRON_APP="${ELECTRON_EXECUTABLE%/Contents/MacOS/Electron}"
/usr/bin/ditto --norsrc --noextattr "$ELECTRON_APP" "$APP"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.jeremywinchester.mnemosyne' "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources" "$JS_ROOT"

xcrun swiftc native/trust-helper/main.swift -o "$HELPER"
node_modules/.bin/tsc src/trust/trusted-helper.ts --outDir "$JS_ROOT" --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --skipLibCheck
ln -s "$PWD/node_modules" "$JS_ROOT/node_modules"
/usr/bin/codesign --force --sign - --identifier com.jeremywinchester.mnemosyne.trust-helper "$HELPER" >/dev/null
/usr/bin/codesign --force --deep --sign - --identifier com.jeremywinchester.mnemosyne "$APP" >/dev/null
/usr/bin/codesign --verify --deep --strict "$APP"

signature="$({ /usr/bin/codesign -d --verbose=4 "$APP"; } 2>&1)"
grep -q '^Identifier=com.jeremywinchester.mnemosyne$' <<<"$signature"
grep -q '^TeamIdentifier=not set$' <<<"$signature"

trust_metadata_digest() {
  { /usr/bin/security find-generic-password -s com.jeremywinchester.mnemosyne.snapshot.trust.v1 -a device; printf 'status=%s\n' "$?"; } 2>&1 | /usr/bin/shasum -a 256
}
trust_before="$(trust_metadata_digest)"

cat > "$HARNESS" <<'JAVASCRIPT'
const { app } = require("electron");
const { invokeTrustedHelper, TrustedHelperRejectedError } = require("./js/trusted-helper.js");
app.whenReady().then(async () => {
  try {
    await invokeTrustedHelper(process.argv[2], { operation: "trust-cas" });
    app.exit(2);
  } catch (error) {
    if (!(error instanceof TrustedHelperRejectedError) || error.reason !== "invalid-successor") app.exit(3);
    else {
      process.stdout.write("PASS_WRAPPER_AUTH_INVALID_CAS\n");
      app.exit(0);
    }
  }
});
JAVASCRIPT

for request in \
  '{"operation":"enroll"}' \
  '{"operation":"key-info"}' \
  '{"operation":"trust-read"}' \
  '{"operation":"trust-cas"}'; do
  set +e
  shell_output="$(printf '%s\n' "$request" | "$HELPER" 2>/dev/null)"
  shell_status=$?
  set -e
  test "$shell_status" -ne 0
  grep -q 'app caller identity mismatch' <<<"$shell_output"
done
set +e
app_output="$("$LAUNCHER" "$HARNESS" "$HELPER" 2>/dev/null)"
app_status=$?
set -e

test "$app_status" -eq 0
grep -q 'PASS_WRAPPER_AUTH_INVALID_CAS' <<<"$app_output"
trust_after="$(trust_metadata_digest)"
test "$trust_before" = "$trust_after"
printf 'PASS_LOCAL_ADHOC_AUTH_NO_MUTATION\n'