# Mnemosyne

개인의 지식과 업무를 이해하고 관리하는 **privacy-first personal operating system**입니다.

## 현재 구현 상태

현재 로컬 candidate는 **Next.js App Router + TypeScript + Tailwind CSS v4 + source-generated shadcn/ui** 기반의 synthetic read-only shell입니다.

- Next.js `16.3.0`, React `19.2.8`
- Tailwind CSS `4.3.3`, shadcn CLI `4.16.1`
- Node.js 24 CI 기준
- `/` public shell, `/login` owner entrypoint, `/api/health` no-store synthetic health
- 보호 데이터·실제 Wiki·OAuth·Neon 원격 연결·Vercel 배포는 아직 비활성

## 보안·데이터 계약

- `requireOwner()`는 이메일/username이 아닌 immutable GitHub account ID만 허용합니다.
- owner ID가 없거나 세션이 만료/불일치하면 fail-closed합니다.
- 보호 응답은 `private, no-store`이며 실제 원문을 synthetic UI에 넣지 않습니다.
- snapshot ledger는 `pending → finalized → active`만 허용하고 count/bytes/tree-hash 검증 및 monotonic CAS를 적용합니다.
- sync policy는 승인된 Personal Ops Markdown prefix만 허용하고 경로 escape, 비승인 namespace, 3 MiB 초과 항목을 거부합니다.
- Mac device sync 계약은 브라우저 세션과 분리된 Ed25519 서명, timestamp window, nonce replay 방지를 사용합니다.
- 검색 telemetry에는 raw query·본문·경로를 기록하지 않고 길이/result-count bucket만 남깁니다.

## 로컬 검증

```bash
npm ci
npm run check
npm run build
npm run test:e2e
```

`npm run test:e2e`는 로컬 Next dev server를 띄워 public shell과 `/api/health`의 실제 Chromium surface를 검증합니다. 외부 계정, 원격 데이터, iCloud 원본, provider API, DNS, 배포에는 접근하지 않습니다.

## 주요 경로

- `app/` — Next.js App Router shell과 health route
- `components/ui/` — shadcn 스타일 source-generated primitives
- `src/auth/` — owner-ID authorization contract
- `src/snapshots/` — append-only generation/CAS contract
- `src/sync/` — default-deny policy와 Ed25519 device request contract
- `src/search/` — truthful lifecycle state와 synthetic search/telemetry contract
- `src/wiki/` — authority, source-reader, manifest validation core
- `src/personal-ops/` — ledger parsing, integrity rules, edit allowlist
- `tests/`, `e2e/` — unit/contract/Chromium evidence

## 외부 운영 경계

다음 작업은 별도 승인 후에만 수행합니다.

1. Better Auth/GitHub OAuth dependency resolution 및 OAuth app 설정
2. Neon project/branch/secret 생성과 migration 실행
3. Vercel project/env 연결 및 preview deploy
4. iCloud allowlist 확정과 sanitized real-data import
5. production domain/cutover/rollback
6. write/change-request 활성화

## 라이선스

MIT License
