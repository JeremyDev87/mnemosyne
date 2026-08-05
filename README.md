# Mnemosyne

개인의 지식과 업무를 이해하고 관리하는 **privacy-first personal operating system**입니다. 이름은 그리스 신화의 기억의 여신에서 가져왔습니다.

## 현재 상태

이 브랜치는 기존 provider 결합 런타임을 제거하고, Vercel 이행 전 재사용 가능한 도메인·검증 코어만 남긴 상태입니다. HTTP 진입점, 인증 어댑터, 저장소 어댑터, 배포 설정은 다음 Vercel 이행 작업에서 다시 구현해야 하므로 현재 `dev`·`build`·배포 명령은 제공하지 않습니다.

## 보존된 코어

- Brain authority 판정과 안전한 FTS query 컴파일
- `tasks / schedule / inbox` Personal Ops 파싱·정합성·편집 allowlist
- bounded source reader와 SHA-256 import manifest 검증
- provider-neutral SQLite-shaped indexing/search contract
- 정적 Dashboard 자산

## 로컬 검증

```bash
npm install
npm run check
```

`npm run check`는 lint, TypeScript typecheck, provider-neutral unit test를 실행합니다. 외부 계정, 원격 데이터, iCloud 원본, 배포에는 접근하지 않습니다.

## 주요 경로

- `src/personal-ops/` — ledger parsing, integrity rules, edit allowlist
- `src/wiki/authority.ts` — authority metadata/compiler
- `src/wiki/indexer.ts` — storage adapter가 주입되는 indexing/search contract
- `src/wiki/import-manifest.ts` — source manifest와 byte/hash drift 검증
- `src/wiki/source-reader.ts` — bounded local source reader
- `public/` — Dashboard 정적 자산
- `tests/` — provider-neutral core regression tests

## 다음 Vercel 이행 경계

다음 작업에서 별도로 결정·구현·검증해야 하는 항목은 HTTP runtime, authentication, relational database, object/blob storage, iCloud import execution, preview/production deployment, rollback, 그리고 write activation입니다. 이 브랜치에서는 해당 외부 리소스 생성·시크릿 설정·DNS·배포·데이터 import를 수행하지 않습니다.

## 라이선스

MIT License
