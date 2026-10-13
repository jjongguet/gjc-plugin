# gjc-plugin — 규칙 텍스트 정본 (rules-text)

이 파일은 jjongguet 워크스페이스 루트 `AGENTS.md`·`docs/portfolio/AGENTS.md`에 문서화된 규칙 중 `gjc-plugin` 저장소에 적용되는 부분의 **저장소 내 정본**이다. 문서가 아니라 계약으로 취급하며, 변경은 rules-text 도메인(`self-improve/domains/rules-text`)의 검증을 통과해야 한다.

## 목적

- 플러그인 서브트리마다 설치 표면·빌드 표면·검증 표면을 명시해 에이전트가 임의 추측 없이 작업하도록 한다.
- 규칙 서술은 가장 가까운 정본 한 곳에서 관리한다. 같은 사실을 두 번 적지 않는다.
- 모든 변경은 `bun run test` 전체 체인을 통과해야 한다. 검증 없는 채택은 하지 않는다.

## 저장소 레이아웃

- `jev-advisor/` — 제안·라우팅 측 플러그인(권고 계층, 비게이트).
- `verification-receipts/` — 검증 영수증·스모크 호스트.
- `ui-regression/` — 브라우저 회귀 실행 표면.
- `rrsi/` — 탐색 기록 저장·꿈 재생 도구(명시 호출, keyless).
- `self-improve/` — 검색 루프·검증 기록 파이프라인. 원장은 [ledger](../../self-improve/ledger.jsonl), 루프 설정은 [rrsi.json](../../self-improve/rrsi.json)이 정본이다.
- `wiki/`·`rea/`·`backplan/`·`aside-memory/`·`shared/` — 부속 표면. 각 서브트리의 `gajae-plugin.json`이 매니페스트 정본이다.

## 빌드·테스트

- 전체 검증: `bun run test` — 명령 정의는 [package.json](../../package.json)이 정본이다.
- 빌드: `bun run build`. 생성 표면(`tools/`, `hooks/`)은 빌드 산출물이며 손으로 편집하지 않는다.
- 특정 플러그인만 확인했더라도 최종적으로는 전체 체인을 다시 돌린다.

## 커밋·검증 규칙

- 변경 파일만 스테이징한다. `git add -A` 금지.
- 이 저장소는 `main` 직접 커밋이 허용되지만, 푸시 없는 로컬 종료는 금지다. 머지(또는 동등한 통합)가 완료의 정의다.
- 커밋 메시지는 conventional 형식을 따르고 scope는 플러그인 이름을 쓴다.
