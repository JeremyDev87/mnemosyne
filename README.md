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

Authenticity consumer contract와 ephemeral-key packaged E2E는 구현되어 있습니다. 하지만 production trust anchor, Keychain anti-replay state, trusted producer command는 아직 provisioning되지 않았으므로 일반 package는 Wiki를 `unavailable`로 유지합니다. unsigned schema v1이나 PATH의 임의 `dobby-wiki`로 fallback하지 않습니다.

Live 활성화에는 재현 가능한 canonical producer source, Secure Enclave attestor, stable signed app/helper identity, Keychain의 public-key fingerprint와 minimum sequence가 필요합니다. 테스트용 private key는 실행 중 메모리에서만 생성하며 source/package/artifact에 저장하지 않습니다.

## 명시적 비범위

외부 웹 서비스·원격 API·ingest·tunnel·socket daemon·DB, Wiki 쓰기, production signing·공증·DMG 배포·자동 업데이트는 포함하지 않습니다.

## 로컬 검증

```bash
npm ci
npm run check
npm run package
npm run test:e2e
```

`npm run package`는 local ad-hoc signed `.app`을 생성합니다. `npm run test:e2e`는 compile-time test build에서 임시 P-256 identity와 격리 snapshot을 만들고, 패키지된 macOS 앱의 signature/digest/replay gate, renderer UI, preload capability allowlist, Node 권한 부재를 확인합니다. 실제 개인 Wiki 원문이나 경로를 fixture·로그·artifact에 넣지 않습니다.

## 주요 경로

- `src/electron/` — main, preload, IPC, renderer 보안 경계
- `src/renderer/` — local dashboard UI
- `src/wiki/dobby-{adapter,snapshot}.ts` — immutable snapshot read adapter
- `src/wiki/snapshot-attestation.ts` — P-256 signature, key identity, anti-replay consumer contract
- `src/wiki/{authority,import-manifest,source-reader}.ts` — provenance/allowlist 검증 코어
- `src/personal-ops/` — read-only summary parser
- `tests/`, `e2e/` — contract 및 packaged-app evidence

## 운영 경계

별도 명시 승인이 필요한 작업: Dobby snapshot producer/runtime 변경, Secure Enclave·Keychain provisioning, iCloud Wiki write, production signing/notarization/distribution/auto-update, 원격 서비스 또는 GitHub 작업.

## 라이선스

MIT License
