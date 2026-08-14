# Mnemosyne Electron 운영 Runbook

## 현재 제품 상태

Mnemosyne은 Apple Silicon macOS (`darwin/arm64`) 단일 사용자를 위한 local-first Electron candidate입니다. 다른 platform/architecture package는 fail-closed합니다. renderer는 제한된 preload IPC만 호출하고, Electron main은 **서명 검증을 통과한** Dobby immutable snapshot에서 text-only Markdown을 읽습니다. iCloud Wiki 원본은 직접 읽거나 수정하지 않습니다.

Consumer-side authenticity contract, exact Dobby runtime admission, local-only Secure Enclave enrollment surface와 Keychain-authoritative activation coordinator가 구현되어 있습니다. ordinary startup은 신뢰 상태와 pointer를 읽기만 하며 enrollment, attestation, promotion, CAS 또는 recovery resume를 자동 실행하지 않습니다. 프로비저닝되지 않은 새 설치는 Wiki를 `unavailable`로 유지합니다. `MNEMOSYNE_E2E_*` 입력은 `MNEMOSYNE_E2E_BUILD=1`로 컴파일한 test package에만 적용됩니다.

문서화된 reference Mac에서는 L1–L4 enrollment·generation 0→1·read-only smoke가 완료됐습니다. 이 상태는 동일 Mac local ad-hoc 내부 alpha 증거이며 Developer ID identity, 공증, 외부 배포 또는 다른 Mac의 신뢰 상태를 보증하지 않습니다. 상세 판정은 [`internal-alpha-checklist.md`](internal-alpha-checklist.md)를 따릅니다.

## 실행·검증

```bash
npm ci
npm run check
npm run package
npm run verify:packaged-local-adhoc
npm run test:e2e
npm run make
npm run verify:local-pkg-recovery
```

- `npm run check`: ESLint, TypeScript, Vitest contract tests와 read-only canary
- `npm run package`: `out/`의 local ad-hoc codesigned production-default macOS `.app`
- `npm run verify:packaged-local-adhoc`: packaged app/helper의 local trust·admission 계약 검증
- `npm run test:e2e`: test-only ephemeral P-256 key와 격리 v2 generation을 만든 뒤 별도 `out-e2e/Mnemosyne-E2E-UNSAFE-*` packaged app을 loopback CDP로 실행
- packaged E2E 확인: 유효 signed fixture 소비, renderer UI, preload API allowlist, Node 권한 부재. wrong-key·fork/replay·drift negative matrix는 unit contract 증거입니다.
- `npm run make`: exact bundled Dobby runtime과 app을 포함한 동일 Mac 내부용 unsigned PKG 생성
- `npm run verify:local-pkg-recovery`: PKG를 임시 root에만 확장하여 payload, exact Dobby authority, symlink·mode·digest를 검증하고 copy/remove/identical-copy/dirty-target 거부/rollback을 **시뮬레이션**합니다. `installer(8)`과 production app/helper는 실행하지 않으므로 실제 install receipt·BOM ownership·cold start·installed-state rollback 증거가 아닙니다.

## 내부 alpha 승인·실행 경계

| 단계 | 실행 내용 | 중단 조건 |
|---|---|---|
| L0 | ad-hoc app/helper identity, PKG, 격리 payload matrix, 실제 설치 readback | digest/ownership/codesign 불일치 |
| L1 | packaged app을 통한 Secure Enclave `enroll`과 `key-info` readback | 기존 identity 불일치, helper timeout/malformed output |
| L2 | Mnemosyne 전용 root의 gen0 attestation→pointer promotion→Keychain CAS | attestation/digest/readback 불일치 |
| L3 | gen1 direct successor, cold start, recovery matrix | replay/fork/CAS ambiguity 또는 startup mutation |
| L4 | `health→search→getDocument→personalOps` read-only smoke | private-data diagnostic 위험, source-state drift, unusable corpus |

실행 surface는 `key-info`, `enroll`, generation-bound `activate`만 허용합니다. generic native-helper invocation이나 renderer IPC는 제공하지 않습니다. helper 직접 호출은 app caller admission을 통과하지 못하면 거부되어야 합니다.

`activation.keychain.receipt.json`은 감사용 receipt일 뿐 anti-replay authority가 아닙니다. production authority는 co-bundled native helper가 `trust-read`/`trust-cas`로 관리하는 Keychain state입니다. timeout이나 비정상 종료는 ambiguous로 처리하고 authoritative readback 전에는 성공으로 판정하지 않습니다.

Local ad-hoc 경로의 signing key는 CryptoKit `SecureEnclave.P256.Signing.PrivateKey`로 생성합니다. 디스크에는 private key bytes가 아니라 Secure Enclave가 보호하는 opaque reference만 owner `0600`으로 저장합니다. packaged app은 `Contents/Resources/mnemosyne-trust-helper`를 통해 같은 key identity를 재읽습니다.

## Snapshot v2 trust contract

1. activation `current.json`은 `schema_version: 2`, generation binding과 attestation SHA-256을 보유합니다.
2. generation의 `attestation.json`은 domain-separated canonical payload와 `ECDSA_P256_SHA256` signature를 보유합니다.
3. payload는 generation, monotonic sequence, manifest/authority/Wikimap-index SHA-256, previous canonical-attestation ID를 묶습니다.
4. Electron은 provisioned P-256 public-key fingerprint와 trusted `(accepted sequence, canonical attestation ID)`를 기준으로 현재 identity 또는 정확한 direct successor만 수용합니다. successor는 previous-ID continuity가 일치해야 합니다.
5. signature 검증 후에만 manifest를 parse하고 NFC/path/collision/symlink/size/SHA-256 gate를 적용합니다.
6. CLI search metadata는 신뢰하지 않습니다. signed manifest에 존재하는 path만 hint로 수용하고 title/domain/authority는 verified document에서 계산합니다.

production Dobby command view의 별도 `current.json` schema와 activation pointer schema는 역할이 다릅니다. command view를 activation authority로 사용하거나 local receipt를 Keychain authority로 승격하지 않습니다.

## 데이터·보안 경계

- renderer 공개 API: `health`, `search`, `getDocument`, `personalOps`만 허용
- snapshot: signed pointer가 선택한 exact immutable generation만 pin
- renderer bundle: `mnemosyne://renderer` custom protocol의 allowlisted asset만 제공하며 file protocol extra privileges를 사용하지 않음
- 실제 개인 Wiki 원문, 경로, query, 비밀, private key는 fixture·로그·GitHub evidence·package artifact에 포함하지 않음
- Fuses: RunAsNode, Node options, Node CLI inspect, file protocol extra privileges disabled; ASAR integrity와 ASAR-only loading enabled

## 장애·rollback 판정

trust anchor/command가 없거나 signature, sequence, manifest, sidecar, NFC, collision, file digest 검증 중 하나라도 실패하면 앱은 원본이나 unsigned generation으로 fallback하지 않고 안전한 `unavailable` 상태를 표시합니다.

payload simulation의 `remove`/`rollback` PASS와 실제 installed-state rollback은 별도 증거입니다. 현재 tracker closeout은 실제 install/reinstall/cold-start는 확인했지만 uninstall 후 이전 설치 상태 복원 증거는 별도 gate로 유지합니다. 그 증거를 만들기 위해 P5가 앱·runtime·Keychain·Secure Enclave를 파괴적으로 변경해서는 안 됩니다.

## 비범위·승인 경계

Wiki write, Personal Ops edit, producer/runtime mutation, 새 Secure Enclave·Keychain provisioning, production signing/notarization/distribution, auto-update는 별도 명시 승인과 독립 검증 없이는 수행하지 않습니다.
