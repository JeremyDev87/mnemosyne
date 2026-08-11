#!/usr/bin/env bash
set -euo pipefail

if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then
  printf 'BLOCKED_NO_LIVE_ATTESTOR platform\n' >&2
  exit 2
fi

ROOT="$(mktemp -d "${TMPDIR%/}/mnemosyne-no-live-attestor.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
umask 077
HELPER="$ROOT/mnemosyne-trust-helper"
HARNESS="$ROOT/mnemosyne-attestor-test-harness"

/usr/bin/xcrun swiftc -O native/trust-helper/main.swift -o "$HELPER"
/usr/bin/xcrun swiftc -O -D MNEMOSYNE_ATTESTOR_TEST \
  native/trust-helper/main.swift native/trust-helper/test-harness.swift -o "$HARNESS"

if /usr/bin/grep -ERn 'generateKeyPairSync|createTestSigningIdentity|tests/helpers|privateKey' \
  src/wiki/fixed-root-attestor.ts src/trust >/dev/null; then
  printf 'FAIL_NO_LIVE_ATTESTOR test-signer-marker\n' >&2
  exit 1
fi

candidate_source="$(/usr/bin/sed -n '/^func attestCandidate/,/^private func runMain/p' native/trust-helper/main.swift)"
if /usr/bin/grep -Eq 'enroll|trustCAS|trustDirectory|writeTrust' <<<"$candidate_source"; then
  printf 'FAIL_NO_LIVE_ATTESTOR candidate-mutation-marker\n' >&2
  exit 1
fi
if ! /usr/bin/sed -n '/case "attest-candidate":/,+2p' native/trust-helper/main.swift | /usr/bin/grep -q 'requireAuthorizedAppCaller()'; then
  printf 'FAIL_NO_LIVE_ATTESTOR missing-caller-authorization\n' >&2
  exit 1
fi

/usr/bin/python3 scripts/verify_no_live_attestor.py "$HELPER" "$HARNESS" "$ROOT"
