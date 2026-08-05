# Mnemosyne 운영 경계

## 현재 상태

현재 저장소는 provider-neutral 도메인·검증 코어만 포함합니다. HTTP runtime, authentication, database, object/blob storage, preview, production deployment는 아직 연결되지 않았습니다.

따라서 현재 유효한 검증은 다음 하나입니다.

```bash
npm install
npm run check
```

`npm run check`의 PASS는 코어 모듈의 정적 분석·타입 검사·unit test가 통과했다는 뜻일 뿐, preview/production 실행이나 외부 리소스 연결을 의미하지 않습니다.

## 안전 경계

- 외부 계정·시크릿·DNS·배포·원격 데이터 변경은 이 단계에서 수행하지 않습니다.
- provider adapter가 구현되기 전에는 HTTP API와 write activation을 주장하지 않습니다.
- source reader/import manifest는 입력 파일의 bounded read, symlink 경계, size/SHA-256 drift 검증만 담당합니다.
- iCloud 원본을 읽거나 import하는 실행 경로는 별도 승인·검증 작업으로 남겨 둡니다.

## 다음 작업의 완료 조건

Vercel 이행은 다음 순서로 별도 검증해야 합니다.

1. runtime·authentication·database·blob storage의 실제 선택과 계약 확정
2. provider-neutral 코어에 어댑터와 HTTP entrypoint 연결
3. 로컬 unit/type/lint와 실제 preview smoke 검증
4. rollback·readback·privacy·write gate 검증
5. 계정·시크릿·도메인·배포·data import·write activation을 각각 별도 승인 후 실행
