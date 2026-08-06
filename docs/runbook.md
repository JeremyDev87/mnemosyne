# Mnemosyne 운영 경계

## 현재 상태

현재 candidate는 Next.js App Router 기반 synthetic read-only shell과 provider-neutral 보안/데이터 계약을 포함합니다. 외부 OAuth, Neon, iCloud 원본, Vercel project, preview/production deploy는 연결하지 않았습니다.

실제 개인 데이터는 화면·테스트·로그에 포함하지 않습니다.

## 검증 명령

```bash
npm ci
npm run check
npm run build
npm run test:e2e
```

현재 `npm run check`는 ESLint, TypeScript, Vitest contract tests를 실행합니다. `build`는 Next production compile/prerender, `test:e2e`는 로컬 Chromium에서 public shell과 no-store health route를 실행합니다.

## 계약 경계

- `src/auth/owner.ts`: owner ID 재인가와 private/no-store 응답 경계
- `src/snapshots/ledger.ts`: append-only pending/finalized/active, completeness, tree hash, monotonic CAS
- `src/sync/policy.ts`: default-deny path/size policy와 sanitized content
- `src/sync/device-auth.ts`: Ed25519 timestamp/nonce/body digest request authentication
- `src/search/state.ts`: configuration/no-active/empty/fresh/stale/incomplete/rejected 구분

## 안전 경계

- provider 계정·시크릿·DNS·원격 DB·원격 Wiki·배포를 이 단계에서 변경하지 않습니다.
- Better Auth 설치는 optional peer dependency 충돌이 확인되어 `--legacy-peer-deps`로 강행하지 않습니다. 실제 auth adapter 연결은 별도 dependency-resolution gate입니다.
- snapshot rollback은 낮은 sequence pointer 재활성화가 아니라 known-good 내용을 더 높은 sequence로 재게시하는 방식만 허용합니다.
- DB query 실패를 빈 목록으로 변환하지 않으며, 실제 import는 allowlist·freshness·sanitization 검증 전까지 차단합니다.

## 다음 승인 lane

1. Better Auth dependency graph와 GitHub account-ID OAuth contract 검증
2. local PostgreSQL/Drizzle migration integration test
3. synthetic machine ingest + CAS HTTP adapter
4. Vercel preview-only deploy/readback
5. fresh Wiki generation 이후 sanitized subset preview import
6. production/domain/write activation 별도 승인
