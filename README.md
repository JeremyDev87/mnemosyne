# Mnemosyne

개인의 지식과 업무를 다루는 **local-first macOS 데스크톱 애플리케이션**입니다.

## 현재 제품 경계

- Electron renderer → 좁은 typed preload IPC → Electron main → 검증된 Dobby Wiki snapshot
- macOS 단일 사용자, text-only, read-only
- `health`, `search`, `getDocument`, `personalOps` 네 capability만 renderer에 노출
- iCloud Wiki 원본은 직접 읽거나 수정하지 않습니다. 서명된 immutable generation의 copied Markdown만 size·SHA-256·realpath 검증 후 읽습니다.
- v2 pointer는 P-256 attestation을 통해 manifest, authority, Wikimap index를 묶습니다. key identity·minimum sequence·sidecar digest가 다르면 fail-closed합니다.
- 비정규 NFC 경로, case-fold collision, stale/quarantined entry, symlink, digest drift도 fail-closed합니다.
- Dobby CLI 결과는 검색 path hint로만 사용하며 title, domain, authority는 서명된 문서에서 다시 계산합니다.

## 활성화 상태

Authenticity consumer contract, exact Dobby `0.2.0rc2` runtime admission, Keychain-authoritative activation coordinator와 제한된 owner operation(`key-info`, `enroll`, `activate`)이 구현되어 있습니다. ordinary startup은 enrollment, attestation, pointer promotion, Keychain CAS, recovery resume를 자동 실행하지 않습니다. 신뢰가 프로비저닝되지 않은 새 설치는 Wiki를 `unavailable`로 유지하며 unsigned schema v1, PATH의 임의 `dobby-wiki`, local receipt로 fallback하지 않습니다.

문서화된 동일 Mac 내부 alpha 실행에서는 Secure Enclave enrollment, generation 0→1 activation, sequence 1 authoritative readback과 read-only product smoke가 완료됐습니다. 이는 해당 Mac의 local ad-hoc 설치 증거이며 production signing, 공증 또는 다른 Mac에서의 신원·배포 보증이 아닙니다. 단계별 증거와 잔여 tracker gap은 [`docs/internal-alpha-checklist.md`](docs/internal-alpha-checklist.md)에 기록합니다.

## 명시적 비범위

외부 웹 서비스·원격 API·ingest·tunnel·socket daemon·DB, Wiki 쓰기, Personal Ops 편집, production signing·공증·DMG 배포·자동 업데이트는 포함하지 않습니다.

## 로컬 검증

```bash
npm ci
npm run check
npm run package
npm run test:e2e
npm run make
npm run verify:local-pkg-recovery
```

`npm run package`는 local ad-hoc signed `.app`을 생성합니다. `npm run test:e2e`는 compile-time test build에서 임시 P-256 identity와 격리 snapshot을 만들고, 패키지된 macOS 앱의 signature/digest/replay gate, renderer UI, preload capability allowlist, Node 권한 부재를 확인합니다.

`npm run make`는 동일 Mac 내부용 unsigned PKG를 생성합니다. `npm run verify:local-pkg-recovery`는 임시 root에서 payload copy/remove/reinstall/dirty-target 거부/rollback만 시뮬레이션하며 실제 installer receipt, `/Applications`·`/Library` ownership, production cold start 또는 installed-state rollback 증거가 아닙니다. 실제 개인 Wiki 원문이나 경로를 fixture·로그·artifact에 넣지 않습니다.

## 주요 경로

- `src/electron/` — main, preload, IPC, renderer 보안 경계
- `src/renderer/` — local dashboard UI
- `src/trust/owner-activation.ts` — 제한된 owner-only enrollment/activation surface
- `src/wiki/dobby-{adapter,snapshot}.ts` — immutable snapshot read adapter
- `src/wiki/keychain-activation.ts` — pointer-first, native-helper Keychain-CAS-second activation/recovery contract
- `src/wiki/snapshot-attestation.ts` — P-256 signature, key identity, anti-replay consumer contract
- `src/wiki/{authority,import-manifest,source-reader}.ts` — provenance/allowlist 검증 코어
- `src/personal-ops/` — read-only summary parser
- `tests/`, `e2e/` — contract 및 packaged-app evidence

## 운영 경계

별도 명시 승인이 필요한 작업: Dobby snapshot producer/runtime 변경, 새 Secure Enclave·Keychain provisioning 또는 activation mutation, iCloud Wiki write, Personal Ops edit, production signing/notarization/distribution/auto-update, 원격 서비스 또는 GitHub 작업.

## 라이선스

MIT License
