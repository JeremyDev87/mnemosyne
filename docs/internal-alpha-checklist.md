# Mnemosyne 내부 read-only alpha — L0–L4 실행·증거 체크리스트

이 문서는 **실행 권한이 아니라 sanitized evidence와 operator gate**입니다. 앱의 ordinary startup은 read-only inspection만 수행하며 enrollment, attestation, pointer promotion, Keychain CAS, recovery resume를 자동 실행하지 않습니다.

## 공통 기록 규칙

- 기록 가능: exact app/helper identifiers, artifact SHA-256, aggregate file counts, generation IDs, PASS/FAIL boolean.
- 기록 금지: private corpus 본문·제목·상대경로·query, secret, key bytes, Keychain payload, 사용자 홈 경로.
- 즉시 중단: package/runtime digest drift, unreadable/quarantine-only generation, symlink escape, replay/fork, ambiguous CAS readback, 다른 key identity, private-data diagnostic 가능성.
- 실패 시 pointer/Keychain을 임의로 맞추거나 unsigned/PATH/local receipt로 fallback하지 않고 `unavailable`을 유지합니다.

## Evidence class

| Class | 의미 | 다른 class를 대신하는가 |
|---|---|---|
| merged implementation | 코드가 `main`에 존재하고 CI를 통과 | actual install/live evidence를 대신하지 않음 |
| synthetic/package | fixture, packaged E2E, 임시 root payload matrix | installer receipt·installed rollback을 대신하지 않음 |
| actual install | receipt, ownership, codesign, cold-start readback | live enrollment/activation을 대신하지 않음 |
| owner-approved live activation + read-only product smoke | Secure Enclave/Keychain activation은 승인된 mutation이며, 이후 product smoke만 read-only | Wiki write·배포 readiness를 의미하지 않음 |

## L0 — package/identity

- [x] exact Dobby source `40870e2a6896df7c41e33d03641e481191e33f72`
- [x] package `0.2.0rc2`, semantic members `4554dfa7c590a019a2a5ae9bf006b481b4e7b066e5bdb9d46e68f307148a9856`
- [x] local ad-hoc app/helper identifiers 및 strict codesign readback
- [x] unsigned PKG payload 격리 copy/remove/identical-copy/dirty-target-reject/rollback **simulation**
- [x] 승인된 실제 install과 replacement reinstall, receipt/BOM ownership, production cold-start readback
- [x] receipt `com.jeremywinchester.mnemosyne` 0.1.0 및 app/runtime `root:wheel`
- [ ] 실제 uninstall 후 이전 installed app/runtime 상태로 rollback — 현재 확보된 근거로는 확인 불가

> 현재 설치된 역사적 PKG artifact SHA-256: `ed0c49bc14966eff6b2dc0b2e6156d0d2b9484da825fa3aee26fbd0c7883f7e8`. 이 값은 설치 증거이며 재빌드 간 byte reproducibility 보장이 아닙니다. BOM의 `._*` 표시는 resource-fork metadata record였고 실제 설치 tree의 `._*` 파일 수는 0이었습니다.

## L1 — Secure Enclave enrollment

1. packaged app과 co-bundled helper identity를 재확인합니다.
2. 먼저 `key-info`를 읽습니다. 기존 key가 있으면 새 enroll을 수행하지 않습니다.
3. key가 없고 해당 단계의 owner 승인이 있을 때만 `enroll`을 한 번 실행합니다.
4. authoritative `key-info` 재읽기로 같은 key identity를 확인합니다.
5. 다른 key, malformed output, helper timeout이면 중단합니다.

- [x] 2026-08-14 승인 실행: CryptoKit Secure Enclave key 신규 enrollment 1회 성공
- [x] packaged `key-info` identity exact readback 일치
- [x] opaque Secure Enclave key reference만 owner `0600`으로 저장; private key export 없음
- [x] Developer ID signing/notarization 없음; local ad-hoc 동일-Mac 경계 유지

## L2 — generation 0

1. canonical source와 분리된 staging root에서 generation 0을 생성합니다.
2. manifest/authority/index/document bytes를 fixed-root attestor가 재읽고 검증합니다.
3. durable `attestation.json` SHA-256을 재읽은 뒤에만 pointer를 promotion합니다.
4. promoted pointer 재읽기 성공 후 native helper `trust-cas(null → sequence 0)`을 호출합니다.
5. timeout/오류는 Keychain `trust-read`로만 판정합니다.

- [x] producer-compatible attestation, schema-v2 pointer promotion, trusted CAS sequence 0, authoritative readback PASS

## L3 — generation 1 및 복구

1. sequence 1과 sequence 0의 previous canonical-attestation ID 연결을 확인합니다.
2. pointer-first, helper-CAS-second 순서를 반복합니다.
3. cold start에서는 `trust-read`와 pointer readback만 수행되는지 확인합니다.
4. pointer promotion 후 crash, CAS 직후 crash, timeout-after-CAS를 격리 검증합니다.
5. fork/replay/drift/race에서 winner 하나만 authoritative인지 확인합니다.

- [x] generation 1 direct-successor/sequence 1/predecessor binding PASS
- [x] prepared/pointer/CAS/timeout/fork/replay/drift/race recovery matrix 35/35 PASS
- [x] ordinary installed-app cold start 전후 activation/canonical-state roots invariant

## L4 — private corpus read-only smoke

1. 실행 전 canonical metadata inventory를 생성합니다.
2. `health → search → getDocument → personalOps`만 실행합니다.
3. 증거에는 aggregate counts와 PASS boolean만 남깁니다.
4. canonical/activation state가 전후 동일한지 확인합니다.
5. FileProvider 오류 또는 usable copied/stale 0이면 중단합니다.

- [x] installed production app: health `ok`, snapshot `fresh`, 821 documents
- [x] bounded search 3 hits, opaque-capability document read PASS, Personal Ops aggregate parse PASS
- [x] activation/canonical-state pre/post inventory digests 및 entry counts unchanged

## 판정

- **기능 판정:** L1–L4 owner-approved activation과 read-only product smoke는 동일 Mac에서 PASS했습니다.
- **제품 경계:** 동일 Mac 내부 read-only alpha이며 Wiki write, Personal Ops edit, production signing/notarization/distribution/auto-update는 포함하지 않습니다.
- **Tracker 판정:** #37의 실제 installed-state rollback 근거가 없으므로 P3/P5/Epic의 전체 closeout은 보류해야 합니다. payload simulation이나 git patch apply-check를 그 근거로 대체하지 않습니다.
