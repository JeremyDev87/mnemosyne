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

`--apply`에는 R2 S3 endpoint/access key/bucket와 D1 HTTP API용 `D1_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN` 환경변수가 모두 필요합니다. 기본 실행은 dry-run입니다. Apply는 로컬 root/time/read receipt를 제외한 canonical manifest를 `shadow/manifests/<manifest-hash>.json`과 `shadow/manifests/current.json`에 기록하고, 같은 canonical hash를 D1 `index_status`에 기록합니다.

`verify:import`도 같은 R2/D1 read credential이 필요하며 provider 상태를 변경하지 않습니다. verifier는 current manifest의 hash/count/bytes, `shadow/current/` 전체 key의 exact size/SHA-256 metadata(누락·불일치·extra 포함), D1 migration schema, `index_status=ready`/document count/manifest hash, `wiki_pages` 전체 path/hash projection을 함께 확인합니다. R2만 일치하거나 D1/R2 중 하나가 partial이면 PASS하지 않습니다. JSON receipt는 schema version과 aggregate count/hash/state만 출력하며 private path/content/query/identity/secret을 출력하지 않습니다. 관측 순서와 무관하게 동일 receipt를 만들고 exit `0`은 exact, `1`은 검증 불일치/partial, `2`는 인자·credential·transport 실패입니다. Verifier는 stale/extra 데이터를 삭제하지 않으므로 정리는 별도 승인된 mutation 절차로 수행해야 합니다.

macOS iCloud placeholder가 `errno=-11`/`EAGAIN`/`ENOENT`를 반환하면 importer는 누락하지 않고 실패 파일 전체에 `brctl download`를 요청한 뒤 5초 단위 batch wave로만 재시도합니다. 각 read는 reader의 `AbortSignal` 협조 여부와 무관한 15초 hard deadline을 가지며, 파일별 sleep은 없습니다. 24개 wave 뒤에도 읽지 못한 파일이 있으면 private path 대신 오류 종류와 개수만 남기고 manifest 생성 전 fail-closed합니다. `sourceRead` receipt의 `discovered/readable/failed`, `peakBufferedBytes`, hydration 합계, wave별 오류 집계가 완료 근거입니다. 이 과정은 로컬 placeholder를 다운로드하지만 Wiki 내용을 수정하지 않습니다.

각 파일은 `O_NOFOLLOW` descriptor와 canonical root/inode 검증을 통과해야 하며, 파일당 8 MiB를 초과하면 `EFBIG`로 차단합니다. Importer는 concurrency 8인 한 chunk만 메모리에 유지하므로 총 10 GiB corpus budget과 프로세스 메모리 한계를 분리합니다. Scan은 chunk를 즉시 해제하면서 동일한 bytes에서 size와 SHA-256을 함께 계산합니다. `--apply`는 전체 source를 다시 읽어 manifest와 size/hash가 일치하는 bytes만 권한 제한 임시 디렉터리에 staging한 후에만 D1/R2 mutation을 시작합니다. 하나라도 symlink boundary 위반이나 drift가 있으면 aggregate error/path digest만 기록하고 staging을 삭제한 뒤 모든 remote mutation 전에 중단합니다. 업로드 중에도 staged Markdown을 한 파일씩 읽어 R2 `shadow/current/`와 D1 `wiki_pages/wiki_fts`에 projection하고, 성공·실패와 관계없이 stage를 정리합니다. D1 projection 중 오류가 나면 완료 상태를 출력하지 않으며, 다음 실행에서 해당 manifest를 재처리해야 합니다.

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
