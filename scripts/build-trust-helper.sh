#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/native/bin"
xcrun swiftc -O "$ROOT/native/trust-helper/main.swift" -o "$ROOT/native/bin/mnemosyne-trust-helper"
/usr/bin/xattr -cr "$ROOT/native/bin/mnemosyne-trust-helper"
/usr/bin/codesign --force --sign - --identifier com.jeremywinchester.mnemosyne.trust-helper "$ROOT/native/bin/mnemosyne-trust-helper"
/usr/bin/codesign --verify --strict "$ROOT/native/bin/mnemosyne-trust-helper"
