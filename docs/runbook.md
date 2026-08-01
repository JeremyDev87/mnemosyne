# Mnemosyne 운영 Runbook

## 상태 분리

1. **implementation GREEN** — unit/lint/type/build가 로컬에서 통과
2. **integration verified** — local D1/R2 fixture와 browser E2E 통과
3. **provider provisioned** — 승인 후 private R2, D1, Access application 생성
4. **shadow imported** — 승인 후 Markdown manifest를 R2 `shadow/current/`에 업로드
5. **preview deployed** — 승인된 URL에서 Access deny/pass, 검색, read-only Dashboard 검증
6. **write enabled** — disposable object의 history/If-Match/readback/restore가 통과한 뒤 세 ledger에만 활성화
7. **canonical cutover** — 별도 승인 후 getwiki/setwiki adapter와 canonical owner 전환

앞 단계의 PASS는 뒤 단계의 승인이 아닙니다.

## Production 필수 설정

- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`
- `ALLOWED_EMAILS`
- `AUTH_MODE=access`
- `R2_PREFIX=shadow` — cutover 전 유지
- `WRITE_ENABLED=false` — disposable write gate 전 유지

Secret 값은 repository, 문서, 로그에 기록하지 않습니다. R2 bucket public access와 `workers.dev` 공개 route를 허용하지 않습니다.

## Shadow import

```bash
WIKI_SOURCE_ROOT=/path/to/wiki npm run import:scan
npm run verify:budget -- --manifest .tmp/import-manifest.json
# 별도 remote migration 승인 후에만:
npm run import:scan -- --source /path/to/wiki --manifest .tmp/import-manifest.json --apply
npm run verify:import -- --manifest .tmp/import-manifest.json
```

`--apply`에는 R2 S3 endpoint/access key/bucket와 D1 HTTP API용 `D1_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN` 환경변수가 모두 필요합니다. Importer는 Markdown을 한 파일씩 읽어 R2 `shadow/current/`에 업로드하고, 같은 파일을 D1 `wiki_pages/wiki_fts`에 projection한 뒤 `index_status=ready`로 전환합니다. D1 projection 중 오류가 나면 완료 상태를 출력하지 않으며, 다음 실행에서 해당 manifest를 재처리해야 합니다. 기본 실행은 dry-run입니다.

## Write activation gate

- Access 무인증 `401`, 비허용 identity `403`
- `raw/*`, P0/P1, 일반 domain path `403`
- invalid scope/status, 근거 없는 `done` `422`
- stale ETag `412`, no-op `409`
- history object 존재, current metadata와 SHA-256 readback 일치
- D1 실패 시 canonical은 유지하고 `index_pending` 표시
- restore drill이 동일 hash를 복구

## 비용 kill switch

- R2 logical bytes 8 GiB: warning
- 10 GiB: importer/write 차단
- Workers AI quota 초과: paid upgrade 없이 citation-search fallback
- 월별 usage receipt 확인 전 paid plan 전환 금지

## Rollback

1. `WRITE_ENABLED=false`로 먼저 쓰기를 차단합니다.
2. affected `current/<path>`의 `baseHash/changeId` metadata를 읽습니다.
3. `history/<path>/<baseHash>.md`를 disposable prefix에 복원합니다.
4. SHA-256 readback과 Personal Ops validation 후에만 current에 conditional restore합니다.
5. D1 projection을 재생성하고 `index_status=ready`를 확인합니다.

Source rollback은 기록한 base SHA에서 생성한 `git diff --binary` patch로 검증합니다. 배포·provider·remote data rollback은 각각 별도 승인 대상입니다.
