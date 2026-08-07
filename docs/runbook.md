# Mnemosyne Electron 운영 Runbook

## 현재 제품 상태

Mnemosyne은 Apple Silicon macOS (`darwin/arm64`) 단일 사용자를 위한 local-first Electron candidate입니다. 다른 platform/architecture package는 fail-closed합니다. renderer는 제한된 preload IPC만 호출하고, Electron main은 **서명 검증을 통과한** Dobby immutable snapshot에서 text-only Markdown을 읽습니다. iCloud Wiki 원본은 직접 읽거나 수정하지 않습니다.

Consumer-side authenticity contract는 구현됐지만 live producer/key provisioning은 아직 비활성입니다. 일반 package에는 trust anchor와 trusted command가 없으므로 Wiki는 의도대로 `unavailable`입니다. `MNEMOSYNE_E2E_*` 입력은 `MNEMOSYNE_E2E_BUILD=1`로 컴파일한 test package에만 적용됩니다.

## 실행·검증

```bash
npm ci
npm run check
npm run package
npm run test:e2e
```

- `npm run check`: ESLint, TypeScript, Vitest contract tests
- `npm run package`: `out/`의 local ad-hoc codesigned production-default macOS `.app`
- `npm run test:e2e`: test-only ephemeral P-256 key와 격리 v2 generation을 만든 뒤 별도 `out-e2e/Mnemosyne-E2E-UNSAFE-*` packaged app을 loopback CDP로 실행
- packaged E2E 확인: 유효 signed fixture 소비, renderer UI, preload API allowlist, Node 권한 부재. wrong-key·fork/replay·drift negative matrix는 unit contract 증거입니다.

## Snapshot v2 trust contract

1. `current.json`은 `schema_version`, `generation`, `attestation_sha256`만 보유합니다.
2. generation의 `attestation.json`은 domain-separated canonical payload와 `ECDSA_P256_SHA256` signature를 보유합니다.
3. payload는 generation, monotonic sequence, manifest/authority/Wikimap-index SHA-256, previous canonical-attestation ID를 묶습니다.
4. Electron은 provisioned P-256 public-key fingerprint와 trusted `(accepted sequence, canonical attestation ID)`를 기준으로 현재 identity 또는 정확한 direct successor만 수용합니다. successor는 previous-ID continuity가 일치해야 합니다.
5. signature 검증 후에만 manifest를 parse하고 NFC/path/collision/symlink/size/SHA-256 gate를 적용합니다.
6. CLI search metadata는 신뢰하지 않습니다. signed manifest에 존재하는 path만 hint로 수용하고 title/domain/authority는 verified document에서 계산합니다.

## 활성화 전 필수 Gate

- 현재 설치된 `dobby-wiki-retrieval 0.1.0`의 재현 가능한 canonical Git source와 exact artifact digest를 복구
- producer에서 NFC/case-fold collision을 거부하고 schema v2 generation을 atomic promotion
- generic signing oracle가 아닌 fixed-root Secure Enclave attestor 구현
- stable signed app/helper identity와 Keychain access group 검증
- Keychain에 public-key fingerprint와 마지막 수용 `(sequence, canonical attestation ID)`를 원자적으로 저장
- live unsigned v1, wrong key, forged sidecar, same-sequence fork, broken previous-ID, stale signed replay가 모두 fail-closed함을 확인

위 조건 전에는 unsigned fallback, software private key, PATH command discovery, live Wiki refresh를 금지합니다. attestation contract만 구현됐다는 사실을 live authenticity 완료로 해석하지 않습니다.

## 데이터·보안 경계

- renderer 공개 API: `health`, `search`, `getDocument`, `personalOps`만 허용
- snapshot: signed pointer가 선택한 exact immutable generation만 pin
- renderer bundle: `mnemosyne://renderer` custom protocol의 allowlisted asset만 제공하며 file protocol extra privileges를 사용하지 않음
- 실제 개인 Wiki 원문, 경로, 비밀, private key는 fixture·로그·테스트 결과·package artifact에 포함하지 않음
- Fuses: RunAsNode, Node options, Node CLI inspect, file protocol extra privileges disabled; ASAR integrity와 ASAR-only loading enabled

## 장애 상태

trust anchor/command가 없거나 signature, sequence, manifest, sidecar, NFC, collision, file digest 검증 중 하나라도 실패하면 앱은 원본이나 unsigned generation으로 fallback하지 않고 안전한 `unavailable` 상태를 표시합니다.

## 비범위·승인 경계

Wiki write, producer/runtime mutation, Secure Enclave·Keychain provisioning, production signing/notarization/distribution, auto-update는 별도 명시 승인과 독립 검증 없이는 수행하지 않습니다.
