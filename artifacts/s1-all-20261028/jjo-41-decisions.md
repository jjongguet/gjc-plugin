# JJO 41건 판정표 (S1 세션 01a17e5b · 2026-10-28 KST)

- 정본 계획: `/Users/kyeongminkim/jjongguet/lanes/all-s1-gjc-plugin-20261028/.gjc/_session-01a17e5b-85a8-7672-aa35-4ea864b8f966/plans/ralplan/s1-workspace-ops-20261028/stage-02-revision.md` (sha256 `a4d0f0c463d291454bcbd7f5333c2df6cb4648cb487685b3be333e33b7bace44`). 이 세션 전용 `.gjc` 상태라 레인 정리 후에는 읽을 수 없다 — 그래서 이 파일이 자기완결 사본이다.
- 합계: 행 41 · 상태 In Review 7 / Todo 13 / Backlog 5 / Blocked 16 · 행동 실행 0 / 판정만 25 / 차단확인 16.

## 근거 코드 (E0–E9)

주의: 아래 `E0`–`E9`는 계획의 **실행 단위 E1–E8**(명령 묶음)과 다른 계열이다. 이 표의 근거 열은 아래 코드만 쓴다.

| 코드 | 의미 |
|---|---|
| E0 | 이 저장소 open PR 0 — `gh pr list --state open` 빈 배열(2026-10-28 02:2x KST) |
| E1 | 해당 티켓 번호가 이 저장소 전체 ref 커밋 메시지에 0건 — `git log --all --grep=JJO-<id>` |
| E2 | 도구·플러그인 실체가 `~/.gjc-user-policy/` 아래(lane-gjc·lane-orchestrate·handoff-check·agents-freshness.mjs·linear-trace.py·skill-audit) |
| E3 | `~/.gjc/agent/gjc-plugins/registry.json` 실측 — agents-freshness source uri가 `.gjc-user-policy/plugins/agents-freshness` |
| E4 | 핸드오프 §4 표와 `get_issue` 41건 상태 대조(7/13/5/16). 정책·의존·배차 판단(577 상하위, 866·826 Penpot 선행, 567 배차, 364·747 정책, 659 표본)의 근거 코드로도 쓴다 |
| E5 | 저장소 문서·테스트 file:line 실측 |
| E6 | 금지 경계 — 유료 실행·운영 쓰기·삭제·시크릿 회전·CI 우회 |
| E7 | git ref·브랜치 실측(`git show --stat`·`git branch --merged`·`git ls-remote`) |
| E8 | `verification_run` 실행 관찰 — tests 7 / pass 6 / skip 1 / fail 0, exit 0, receipt `b9c3ee64` |
| E9 | JJO-456 본문 지목 표면 3개 — `self-improve/evidence/audit-20261022/tools/render-battery.mjs:22`, `.../README.md:74-77`, `.github`의 executedAt 대조 0건 |

---

| 티켓 | 상태 | 다음 행동 | 근거 | 완료 판정 기준 |
|---|---|---|---|---|
| JJO-662 | In Review | 판정만 | E0·E1·E8: open PR 0, 이 저장소 커밋 0. 결함 표면은 gjc 워크플로(본문 지목 저장소/릴리스) | `gh pr list --repo <본문 지목 저장소> --state all --search JJO-662` 또는 `git -C <경로> log --all --grep=JJO-662` 출력에서 PR/커밋 ≥1 관찰 → Done 후보. 출력이 0건이면 In Review 유지·Done 금지 |
| JJO-933 | In Review | 판정만 | E0·E1·E2: `lane-orchestrate` 실체는 `.gjc-user-policy/bin`. 이 저장소 대응물 `supervisor/`는 JJO-913으로 머지 완료(`a7ccd36`~`e6e38a1`) | `grep -rn "JJO-933" /Users/kyeongminkim/.gjc-user-policy` 출력 file:line ≥1 + `lane-orchestrate --help`에 중복 PR/빈 머지 방지 옵션 노출을 관찰 → Done 후보. 미관찰이면 유지 |
| JJO-573 | In Review | 판정만 | E0·E1: whoos·notelier·ARM은 다른 제품 저장소 | 본문에서 승격 증거 토큰(PR 번호 또는 SHA)을 추출해 **3/3** 확인 → Done 후보. N/3 (N<3)이면 Done 금지 |
| JJO-771 | In Review | 판정만 | E0·E1·E5: `managed_append_identity_mismatch`는 gjc 본체. 이 저장소에는 `supervisor/README.md:6`의 동기 언급뿐 | `gjc` 릴리스 노트/이슈에서 해당 결함 수정 확인 → 링크 1건 기록. 미확인이면 유지 |
| JJO-820 | In Review | 판정만 | E0·E1: Penpot 로컬 인스턴스·자격증명 위생은 인프라 표면 | 본문이 지목한 인스턴스 정본 경로·자격증명 보관 위치 **2개**가 문서 1건에 존재함을 관찰 → Done 후보. 미관찰이면 유지 |
| JJO-773 | In Review | 판정만 | E0·E1·E2: Linear 기록 규칙은 `rule://linear-work`(워크스페이스 룰) | **조건 충족 관측**: `search "완료된 실행" ~/.gjc/agent/rules/linear-work.md` → line 112·119 적중. **Done 제안**, 전이는 오너/다음 세션 결정 |
| JJO-564 | In Review | 판정만 | E0·E1·E2: Aside 규칙은 `rule://aside-browser` 표면 | **조건 충족 관측**: `search -i "유료|오클릭|확인 후 실행" ~/.gjc/agent/rules/aside-browser.md` → line 51·57·59 적중. **Done 제안**, 전이는 오너/다음 세션 결정 |
| JJO-273 | Todo | 판정만 | E2·E3: `agents-freshness` v0.1.0 source는 `.gjc-user-policy/plugins/agents-freshness`, 이 저장소 grep 0건 | 완료 조건 표면 1개 확정 + E8 관찰값(변경 파일 기준) 기록 |
| JJO-941 | Todo | 판정만 | E2·E3·E5: `agents-freshness.mjs`가 지도로 쓰는 `docs/portfolio/AGENTS.md`는 이 저장소에 없고(`find` 0건), 제거는 `CHANGELOG.md:156`에 기록 | 드리프트 3분류(워크스페이스/룰/이 저장소) 표 + 이 저장소 몫 "없음" 확정 |
| JJO-904 | Todo | 판정만 | E6: 노출 경로는 `~/.gjc/agent/mcp.json` 취급·진단 출력. 이 저장소 리댁션은 `self-improve/lib/loading-receipt.mjs:67`(경로만, 토큰 아님) | 노출 경로 1건 특정 + 회전 필요 여부 판정. 회전 실행 금지 |
| JJO-590 | Todo | 판정만 | E6: 디스크·캐시 회수·ComfyUI 보관 정리는 삭제 동반(로컬 ComfyUI는 그래프 편집만 허용) | 대상·회수량 추정·승인 필요 항목이 분리된 목록 1건 |
| JJO-821 | Todo | 판정만 | E2: Penpot 쓰기 경로 실증은 외부 인스턴스 의존 | `penpot-mcp` vs plugin API 중 실증 대상 1개 결정 |
| JJO-822 | Todo | 판정만 | E2: 입력 정규화 파서는 Penpot 제품군 표면 | 파서 결함 1건 재현 입력 확보 여부 판정 |
| JJO-577 | Todo | 판정만 | E4: 상위 티켓. 하위 578·579·580·588·589로 분해 | 상위-하위 매핑표 + 이 세션 몫 0건 명시 |
| JJO-579 | Todo | 판정만 | E2: 생성 산출물 계약은 `rule://generation-execution` 표면 | 계약을 강제할 지점 1개(문서/스크립트) 확정 |
| JJO-578 | Todo | 판정만 | E2: 루트 폴더 유형 기준표는 워크스페이스 루트 표면 | 기준표 소유 파일 1건 확정 |
| JJO-572 | Todo | 판정만 | E2: 디자인 키트 결함 3종은 디자인 제품 표면 | 결함 3종 각각의 재현 입력 확보 여부 판정 |
| JJO-456 | Todo | 판정만 | **본문 비범위 인용**: 「이 이슈 자체는 코드 변경을 하지 않는다. 각 레포의 실제 수정은 해당 프로젝트 백로그로 별도 처리」. 본문 지목 표면 **3개** 실측(E9): ① `self-improve/evidence/audit-20261022/tools/render-battery.mjs:22` ② README 수치 서술 `.../README.md:74-77`·`verdicts.md:3-6`·`sweeps.md:11-12` ③ CI executedAt 대조 부재(`grep -rn executedAt .github` 0건) | 3개 항목 각각의 현재 상태가 file:line과 함께 기록되고, 수정은 각 레포 백로그 이관으로 명시됨. 코드 변경 0건 |
| JJO-589 | Todo | 판정만 | E6: 저장소 아카이브·개명은 오너 결정(O3) | 선택지·권고·기본값이 담긴 결정 요청 1건 |
| JJO-588 | Todo | 판정만 | E7: 이 워크트리의 ref는 공유 `.git` 스토어를 공유 → 삭제는 다른 체크아웃에 영향. O4 기본값 "삭제 없음"과 일치 | 삭제 후보/보존 후보/승인 필요 목록이 근거 명령 출력과 함께 확정. 삭제 실행 0건 |
| JJO-939 | Backlog | 판정만 | E1: GJC 0.19.0 skill 지연 전달·심링크 cwd 결함은 gjc 본체 | 착수 여부 결론(보류·업스트림) + 근거 1건 |
| JJO-935 | Backlog | 판정만 | E6: 1.7GB 삭제는 오너 승인 범위 | 보류·승인 필요 결론 + 대상 목록 |
| JJO-934 | Backlog | 판정만 | E1: 큐 메시지 소실은 gjc 본체, 제목 자체가 "재현 미확보" | 재현 절차 확보 여부 판정 |
| JJO-922 | Backlog | 판정만 | E5: `supervisor/`는 수집·판정만 하고 수명주기 정리는 없다(`supervisor/README.md`) | 착수 여부 결론 + 이 저장소 몫(있다면 파일 1개) 판정 |
| JJO-890 | Backlog | 판정만 | E7: `origin/feat/jjo890-skill-audit-mini-m5` 2커밋·21파일·4407줄 미머지(`git show --stat 2fedff2`) | 재개/폐기/보존 판정 1건(O2). 새 플러그인 표면이라 오너 승인 필요 |
| JJO-584 | Blocked | 차단확인 | E5: 이 저장소 PR 레인은 자동 실행 없음(`ci.yml`·`pr-validate.yml`·`policy:check`) → 남은 차단은 저장소 밖 토큰·운영 lane | 차단 사유 1문장 + 해소 조건 1문장. 상태 유지 |
| JJO-593 | Blocked | 차단확인 | E6: 로컬 런타임 잔재 삭제는 승인 필요 | 차단 사유·해소 조건 기록. 상태 유지 |
| JJO-580 | Blocked | 차단확인 | E5: `CONTRIBUTING.md:43` — workspace-standard validator가 `../shared/workspace-standard/validator/cli.mjs`로 저장소 밖에 있고 CI에서 계획 제외(`ci.yml` 주석) | 형상관리 밖 자산 목록 + Git화/공식 제외 결정 요청. 상태 유지 |
| JJO-866 | Blocked | 차단확인 | E4: Penpot 디자인 시트(820·821·822·826) 선행 의존 | 선행 티켓 목록과 해소 조건 기록. 상태 유지 |
| JJO-513 | Blocked | 차단확인 | **E8로 차단 확인 완료**: `verification_run` tests 7 / pass 6 / skip 1 / fail 0, exit 0, receipt `b9c3ee64`. skip 사유 원문: "upstream succession close gap (JJO-513) still present in gjc/0.19.0: complete-goals refused by the outgoing fence" | 차단 확인 완료로 표시. gjc 릴리스에서 이 갭이 사라지면 `scripts/tests/ultragoal-succession.test.mjs`의 close 단언이 skip→assert로 바뀌어 자동 감지. 상태 유지 |
| JJO-364 | Blocked | 차단확인 | E4: GitHub·Linear 운영 정책은 오너 결정 | 차단 사유·해소 조건 기록. 상태 유지 |
| JJO-664 | Blocked | 차단확인 | E8: 같은 receipt에서 `self-improve/tests/unit/isolation-runtime.test.mjs` 통과. 격리 프로브는 `5653e92`(PR #12)로 머지 → **남은 차단은 예산·유료 실행** | isolation 통과 관찰값 + 예산 승인 필요 명시. 상태 유지 |
| JJO-271 | Blocked | 차단확인 | E5: `artifacts/harness2-rrsi-20261027/run.md:83` — M1이 모델-인-루프가 아니라 경험 학습 근거 부족 | 해소 조건(M1 pilot 완료) 기록. 상태 유지 |
| JJO-567 | Blocked | 차단확인 | E4: S6·S8·S9·S10 배차는 다른 세션 소유 | 오너 배차 결정 필요 명시. 상태 유지 |
| JJO-272 | Blocked | 차단확인 | E5: JJO-271과 동일 근거(`run.md:83`) | 해소 조건(M2 선행) 기록. 상태 유지 |
| JJO-847 | Blocked | 차단확인 | E2: mini 동기화 실측 필요(`mini-sync`·`mini-drift-watch`는 `.gjc-user-policy/bin`) | 재측정 대상 4건 목록 + 측정 명령 기록. 상태 유지 |
| JJO-826 | Blocked | 차단확인 | E4: Penpot 820·821·822 선행 의존 | 선행 티켓·해소 조건 기록. 상태 유지 |
| JJO-659 | Blocked | 차단확인 | E4: pstack 라우터 n>=8은 실사용 표본 필요 | 표본 확보 조건 기록. 상태 유지 |
| JJO-534 | Blocked | 차단확인 | E1: GJC TUI CPU 점유는 gjc 본체. 저장소 커밋 0건 | 업스트림 이슈 링크 1건 + 재현 조건 기록. 상태 유지 |
| JJO-747 | Blocked | 차단확인 | E4: Linear GitHub 앱 도입은 오너 결정 | 선택지·비용·권한 영향 요약 1건. 상태 유지 |
| JJO-663 | Blocked | 차단확인 | E4·E6: 티켓 제목 자체가 "승인 필요" | 승인 요청 1건(무엇을 승인하는지 1문장). 상태 유지 |
