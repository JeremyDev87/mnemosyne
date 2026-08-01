# Mnemosyne

개인의 지식과 업무를 이해하고 관리하는 **cloud-first personal operating system**입니다. 이름은 그리스 신화의 기억의 여신에서 가져왔습니다.

## MVP

- Brain authority를 반영한 Wiki 검색과 citation-first 설명
- `tasks / schedule / inbox`의 상태·정합성 Dashboard
- 세 Personal Ops ledger만 허용하는 diff/validation/ETag 편집 API
- Cloudflare Access + Worker + private R2 canonical + 재생성 가능한 D1 FTS5 projection
- R2 history/readback과 `WRITE_ENABLED=false` 기본 kill switch

범용 wiki 편집, 자동 agent 실행, 다중 사용자, 외부 캘린더·알림, 로컬 corpus/index/DB/model runtime은 포함하지 않습니다.

## 로컬 검증

```bash
npm install
npm run seed:local
npm test
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```

`npm run dev`는 별도 `wrangler.local.jsonc`와 `.tmp/wrangler`만 사용합니다. synthetic fixture만 적재하며 실제 iCloud wiki나 원격 Cloudflare 자원에 접근하지 않습니다.

## 주요 경로

- `src/worker.ts` — API router 및 static assets entry
- `src/wiki/` — authority, R2 storage, D1 indexing, import manifest
- `src/personal-ops/` — ledger parsing, integrity rules, edit allowlist
- `public/` — Dashboard, Wiki Search, Ops Editor
- `scripts/import-wiki.ts` — 기본 dry-run, `--apply`일 때만 shadow R2 upload
- `migrations/` — 재생성 가능한 D1 FTS schema
- `docs/runbook.md` — provider setup/cutover/rollback gate

## 보안·배포 경계

Production은 `AUTH_MODE=access`로 fail-closed하며 `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ALLOWED_EMAILS`가 모두 필요합니다. R2 bucket은 공개하면 안 됩니다. 실제 provider 생성, remote migration, deployment, write activation, canonical cutover는 이 저장소의 로컬 구현과 별도 승인 단계입니다.

## 라이선스

MIT License
