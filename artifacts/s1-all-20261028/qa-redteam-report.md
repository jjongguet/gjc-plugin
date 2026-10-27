# S1 기록·주장 QA/레드팀 보고서

> 범위 주의: generation 1–4는 **증거 번들 커밋 전 집합**(`sha256:39d95a9b…`, pathCount 0)을 검사했다. 커밋 후 번들 10파일에 대한 별도 QA는 `qa-bundle-report.md`(저장소 밖)에 있고, 이 문서의 "0건 잔존" 스캔 주장은 그 파일 자신을 포함하지 않는다.

- 작성: 2026-10-28 (KST) · 세션 `01a17e5b-85a8-7672-aa35-4ea864b8f966` QA 에이전트(`4-S1BoundaryQA`)
- 대상: `~/jjongguet/artifacts/s1-all-20261028/` 전체 · 핸드오프 `S1-워크스페이스운영-GJC도구.md` §8-1 · Linear JJO 배정 41건(읽기 전용 재조회)
- 동결 변경 집합: `sha256:39d95a9bd50b1802531f4051824f7962d35b982fce6d5f0a9f91dbda69010e9e`, pathCount 0 — `gjc ultragoal quality-gate source-hash --json`으로 재확인(§2-10)
- 시간대: 파일 mtime은 KST, Linear API는 UTC. UTC 값은 `Z`로 표기하고 필요 시 KST를 병기한다.
- 이 보고서 외에 저장소·Linear·핸드오프를 수정하지 않았다. Linear 호출은 `list_issues`·`get_issue`·`list_comments`(읽기 전용, `--publish` 미사용)뿐이다.
- **§0~§12는 generation 1(2026-10-28 02:55~03:02 KST) 시점의 판정**이다. 수정 후 재검증은 **§13(Gen 2) · §14(Gen 3) · §15(Gen 4)**에 있고, 최종 판정은 **§15-6 = PASS**이다.

---

## 0. 판정 요약

| 축 | 결과 | 근거 |
|---|---|---|
| E2E 재현 | **pass** | §2의 13개 재현 항목 전부 성공. 단 `grep -c` 직접 실행은 하네스 정책으로 차단되어 동등 측정 2종으로 대체(§2-2) |
| 레드팀 | **fail** | §7-B1(g003의 "41건 updatedAt 비교"는 인용 산출물로 재현 불가, 21/41만 커버) · §7-B2("실행 가능한 항목 실행 완료" 주장이 JJO-773·564에서 반증) |
| 기록 정확성 | 대체로 견고 | 핵심 수치(41행·27댓글·5커밋·0전이·PR 0) 전부 실측 일치. 불일치는 증거 범위·완료 서술에 국한 |

**한 줄 결론**: 산출물의 숫자는 전부 재현된다. 깨진 것은 "무엇을 근거로 그 숫자를 만들었는가"(B1)와 "무엇을 실행했다고 말하는가"(B2) 두 문장이다. 작업물 자체를 다시 할 필요는 없고 기록 문구와 누락 실행 2건을 고치면 된다.

---

## 1. 환경·방법

- cwd: `<repo>` (브랜치 `feat/all-s1-gjc-plugin-20261028`)
- HEAD: `dbea329bbc99c73cef1e51df9723b1faceca84b8` = `origin/main` (아래 실측)
- Linear 접근: `python3 ~/.gjc-user-policy/bin/linear-trace.py call|batch` — `list_issues`(4페이지 전수), `get_issue`×41, `list_comments`×41. 쓰기 도구 호출 0건.
- 기법: 각 주장에 대해 ① 주장된 명령을 그대로 재실행 ② 산출물 파일과 API 실측을 교차 비교 ③ 주장을 반증할 입력(잘못된 마커, 계약 블록 제거, 없는 경로)을 넣어 측정이 실제로 0/실패를 내는지 확인.

---

## 2. E2E 재현 (주장된 명령을 그대로 다시 실행)

### 2-1. `git status --porcelain` (빈 출력)

```
$ git rev-parse HEAD; git status --porcelain; git status -sb | head -1
dbea329bbc99c73cef1e51df9723b1faceca84b8
                                   ← 빈 출력(0줄)
[git status -sb] ## feat/all-s1-gjc-plugin-20261028
$ git rev-parse origin/main
dbea329bbc99c73cef1e51df9723b1faceca84b8
```

판정: **일치**. 핸드오프 §8-1 "HEAD `dbea329` = origin/main, 작업트리 clean" 재현.

### 2-2. 판정표 41행 (`grep -c`)

`grep -c '^| JJO-'` 직접 실행은 이 하네스가 코어유틸 사용을 차단한다(`Blocked: Use the search tool instead of grep/rg`). 동일 정규식 술어를 두 경로로 측정했다.

```
$ awk -F'|' '/^\| JJO-/{n++} END{print "ROWS="n}' ~/jjongguet/artifacts/s1-all-20261028/jjo-41-decisions.md
ROWS=41
```

`search` 도구(패턴 `^\| JJO-`, 대상 `jjo-41-decisions.md`): 3–43행에서 **41건** 매치. 두 측정 모두 41.

판정: **일치**(=41). 고유 ID 41개(중복 0).

### 2-3. 상태/행동 합계 재검산

```
$ awk -F'|' '/^\| JJO-/{gsub(/ /,"",$3); c[$3]++} END{for(k in c) print "STATUS",k,c[k]}' ... | sort
STATUS Backlog 5
STATUS Blocked 16
STATUS InReview 7
STATUS Todo 13
$ awk -F'|' '/^\| JJO-/{gsub(/ /,"",$4); c[$4]++} END{for(k in c) print "ACTION",k,c[k]}' ... | sort
ACTION 차단확인 16
ACTION 판정만 25
```

판정: **일치**. 7+13+5+16 = 41, 25+16 = 41.

### 2-4. `git log --all --oneline --grep=JJO-…` (총 5)

```
$ git log --all --oneline --grep=JJO-890
7fecbd8 test(skill-audit): boundary fixture outputs (JJO-890)
2fedff2 feat(skill-audit): installed-vs-used catalog audit from session transcripts
$ git log --all --oneline --grep=JJO-513
77138fb test(scripts): add an ultragoal succession lifecycle fixture for the installed gjc
$ git log --all --oneline --grep=JJO-664
485f1f9 Merge pull request #12 from jjongguet/fix/jjo664-pilot-isolation
5653e92 feat(self-improve): add an enforceable isolation runtime probe for live trials
$ git log --all --oneline --grep=JJO-890 --grep=JJO-513 --grep=JJO-664 | wc -l
       5
```

추가: 41건 전수 재실행 후 `git-grep-41.txt`와 대조 — **차이 0건**, 합계 5, 비영(非零)은 `JJO-890:2 · JJO-513:1 · JJO-664:2`뿐.

판정: **일치**(5커밋, 나머지 38건 0).

### 2-5. `gh pr list --state open`

```
$ gh pr list --state open
[]                      ← exit 0
$ gh pr list --state open --json number,title
[]
```

판정: **일치**(열린 PR 0).

### 2-6. `handoff-check` 정상 경로 / 실패 경로

```
$ ~/.gjc-user-policy/bin/handoff-check "~/Desktop/handoffs/all-linear-2026-10-28-021134/S1-워크스페이스운영-GJC도구.md"
(출력 없음)  exit 0
$ ~/.gjc-user-policy/bin/handoff-check /tmp/s1-handoff-missing-approval.md
handoff-check: '배포 승인 범위' 블록이 없다: /tmp/s1-handoff-missing-approval.md
  exit 1
```

판정: **일치**(exit 0 / exit 1, 메시지 원문 동일). 원문 백업 해시도 일치:

```
$ shasum -a 256 /tmp/s1-handoff-before.md
3f78d01b82db744d6a709469d4158458bcd29ed6f65c7473a7e37adeabc39d92
```
→ §8-1의 `sha256 3f78d01b…` 접두와 일치. (원문 핸드오프 현재 해시는 `316affd8…` — §8-1 추가로 달라진 것이 정상)

### 2-7. 5종 정적 검사 (재실행)

```
### build:check    exit=0 → "aside-memory generated surface in sync"
### evidence:check exit=0 → "evidence:check ok: 149 tracked self-improve files, 2 allowlisted hash-bound files"
### paths:check    exit=0 → "paths:check ok: 407 tracked files, 2 allowlisted hash-pinned line(s)"
### docs:check     exit=0 → "docs:check ok: 89 relative links in 46 tracked Markdown files"
### policy:check   exit=0 → "policy:check ok: 2 workflows; owner-dispatched pull-request lane is hosted, secret-free, pinned and verified"
```

판정: **일치**(§8-1·g002의 exit 0/0/0/0/0, 407·89·149·2 수치 전부 동일).

### 2-8. 초점 테스트 2파일 재실행

```
$ node --test scripts/tests/ultragoal-succession.test.mjs
﹣ ultragoal succession lifecycle of the installed gjc (JJO-513) (6248.4ms)
  # upstream succession close gap (JJO-513) still present in gjc/0.19.0: complete-goals refused by the outgoing fence
ℹ tests 1 · pass 0 · fail 0 · skipped 1        exit 0

$ node --test self-improve/tests/unit/isolation-runtime.test.mjs
ℹ tests 6 · pass 6 · fail 0 · skipped 0        exit 0
(마지막 케이스: "a real seatbelt runtime passes every probe on macOS")
```

합산 1+6 = 7 tests, pass 6, skip 1, fail 0 — `verification_run` 주장과 동일. skip 사유 원문도 한 글자 다르지 않다.

### 2-9. 영수증 `b9c3ee64` 실재·신선도

`verification_status(receiptId=b9c3ee64-7c33-4248-a970-3cf99cd0105a)` → `freshness: "fresh"`, `exitCode: 0`, `counts {tests:7, passed:6, failed:0, skipped:1}`, `durationMs: 6419`, `observedAt 2026-10-27T17:27:11.283Z`(= 02:27:11 KST), `before/after` 소스 digest 동일(`01e50aca…`, 405 files).

판정: **일치**. g002의 "6419ms"까지 동일.

### 2-10. 코드 변경 0건 (동결 변경 집합)

```
$ gjc ultragoal quality-gate source-hash --json
{ "sourceHash": "sha256:39d95a9bd50b1802531f4051824f7962d35b982fce6d5f0a9f91dbda69010e9e",
  "baseRef": "origin/main", "mergeBase": "dbea329…", "headRef": "HEAD", "pathCount": 0 }
```

판정: **일치**. 배정문의 동결 해시와 동일하고 pathCount 0.

### 2-11. `agents_freshness_check` (g004 주장)

동일 scope 5파일로 재실행 → `status: "needs_review"`, 5건 모두 `directory_entrypoint_only`(`via: AGENTS.md → artifacts`), `historicalComparison: "unavailable"`.
차이 1건: g004는 `unavailable (absent)`로 적었지만 실제 사유 필드는 `historicalComparisonReason: "scope_mismatch"`다(§7-F3).

### 2-12. `lane-gjc ls` (재현 불가 항목)

```
$ ~/.gjc-user-policy/bin/lane-gjc ls
세션 18건 (레인 12 / 루트 6) · state=ok · 2026-10-28T02:58:30+0900
…
lane-gjc tmux 세션: 0건 (확인됨)        exit 0
```

§8-1의 "기존 레인 8건 + 루트 세션 4건"과 숫자가 다르다. 이는 시점 의존 관측이며 **저장된 출력이 없다**. 레인 디렉터리 생성 시각은 `all-s1 02:14:48` ~ `all-s10 02:15:53`, `policy-session-contract 02:18:12`로, S1 세션 시작(02:14:48) 무렵 이미 all-* 레인 10개가 만들어져 있었다. "8건"은 살아있는 세션 수 기준으로는 가능하지만 **재현도 반증도 불가**(§7-F6). tmux 0건 문구는 그대로 재현.

### 2-13. E2E 진입점(§9 조건 1) 중 실체 확인 가능한 것

| 진입점 | 이번 재현 | 판정 |
|---|---|---|
| `handoff-check <원문>` | exit 0 | 확인 |
| `~/.gjc-user-policy/bin/lane-gjc ls` | exit 0, 18세션 | 확인(수치 drift) |
| `gjc` 세션 시작 | 이 세션이 `gjc` 런타임에서 실행 중(브랜치·HEAD 동일) | 간접 확인 |
| `agents_freshness_check` | needs_review(§2-11) | 확인 |

---

## 3. 레드팀 A — Linear 27건 마커 정밀 계수

방법: 41건 전부 `list_comments`(3 batch, 20/20/1). 각 티켓에서 부분문자열 `s1:01a17e5b:result`의 **댓글 내 출현 횟수**를 셌다(존재 여부가 아니라 출현 횟수).

```
TICKETS_WITH_MARKER 27
MARKER_OCCURRENCES_TOTAL 27
COMMENTS_WITH_>1 []
EVENT_KINDS_SEEN {'result': 27}
other_session_markers(다른 s1 세션 마커) 0
```

군별 대조(g003 표 ↔ 실측 마커 집합):

```
G003_GROUP_ROWS 27 · UNIQUE 27
SET_EQUAL True            (In Review 7 ∪ Todo 재배정 10 ∪ Todo 판정 3 ∪ Backlog 5 ∪ Blocked 2 == 마커 27)
ONLY_IN_GROUPS []
ONLY_IN_LINEAR []
```

| 티켓 | 전체 댓글 | 마커 | 티켓 | 전체 댓글 | 마커 | 티켓 | 전체 댓글 | 마커 |
|---|---|---|---|---|---|---|---|---|
| JJO-662 | 3 | 1 | JJO-577 | 5 | 1 | JJO-939 | 1 | 1 |
| JJO-933 | 2 | 1 | JJO-579 | 4 | 1 | JJO-935 | 1 | 1 |
| JJO-573 | 7 | 1 | JJO-578 | 5 | 1 | JJO-934 | 1 | 1 |
| JJO-771 | 9 | 1 | JJO-572 | 3 | 1 | JJO-922 | 3 | 1 |
| JJO-820 | 6 | 1 | JJO-456 | 4 | 1 | JJO-890 | 1 | 1 |
| JJO-773 | 2 | 1 | JJO-589 | 4 | 1 | JJO-513 | 8 | 1 |
| JJO-564 | 2 | 1 | JJO-588 | 4 | 1 | JJO-664 | 4 | 1 |
| JJO-273 | 10 | 1 | JJO-941 | 2 | 1 | (27건 합계) | — | **27** |
| JJO-904 | 3 | 1 | JJO-590 | 4 | 1 | | | |
| JJO-821 | 4 | 1 | JJO-822 | 5 | 1 | | | |

마커 댓글 시각: 최소 `2026-10-27T17:48:33.775Z`(02:48:33 KST), 최대 `2026-10-27T17:50:07.708Z`(02:50:07 KST).

판정: **주장 일치** — 27건 전부 markers=1, 중복 0, 누락 0, 다른 세션 마커 0. g003의 "27건 전부 markers=1(중복 0)"은 그대로 참이다.

---

## 4. 레드팀 B — Blocked 14건 무댓글 반증 시도

```
ZERO_MARKER_COUNT 14
ZERO_MARKER_HISTORICAL_TOTAL 47      ← 이 14건에 달린 기존 댓글 총계
ZERO_MARKER_LIST ['JJO-271','JJO-272','JJO-364','JJO-534','JJO-567','JJO-580','JJO-584',
                  'JJO-593','JJO-659','JJO-663','JJO-747','JJO-826','JJO-847','JJO-866']
ZERO_SET_EQUAL_BLOCKED14 True
```

| 티켓 | 전체 댓글 | 이번 세션 마커 | 티켓 | 전체 댓글 | 이번 세션 마커 |
|---|---|---|---|---|---|
| JJO-584 | 6 | 0 | JJO-567 | 2 | 0 |
| JJO-593 | 3 | 0 | JJO-272 | 3 | 0 |
| JJO-580 | 10 | 0 | JJO-847 | 2 | 0 |
| JJO-866 | 3 | 0 | JJO-826 | 1 | 0 |
| JJO-364 | 10 | 0 | JJO-659 | 1 | 0 |
| JJO-271 | 3 | 0 | JJO-534 | 1 | 0 |
| | | | JJO-747 | 1 | 0 |
| | | | JJO-663 | 1 | 0 |

판정: **문자 그대로는 반증, 의도한 주장은 성립**.
- "이 14건에 댓글이 0건"이라는 독법은 **거짓**이다(기존 댓글 47건, 최대 JJO-364·580 각 10건).
- g003이 실제로 쓴 문장은 "이번 세션에서 … 남기지 않았다 / 댓글을 반복하지 않았다"이고, 그 주장은 **참**이다(14건 전부 이번 세션 마커 0).
- 14건의 `updatedAt`도 모두 세션 창 이전 값 그대로다(예: JJO-866 `2026-10-26T07:19:52Z`, JJO-534 `2026-10-25T20:30:19Z`, JJO-663 `2026-10-25T19:18:48Z`). 세션 시작(2026-10-27T17:14:48Z) 이후 갱신 없음.
- 기록 개선점: 표 제목이 "의도적으로 댓글을 쓰지 않은 14건"이므로 수치를 인용할 때는 "이번 세션 마커 0 / 기존 댓글 47건"으로 병기해야 오독이 없다(§7-F5).

---

## 5. 레드팀 C — 상태 전이 0건 검증

```
FETCHED 41
STATUS_MISMATCH 0
LIVE_TALLY {'In Review': 7, 'Todo': 13, 'Backlog': 5, 'Blocked': 16}
```

즉 41건 전부 현재 `status`가 판정표·핸드오프 스냅샷과 동일(7/13/5/16). `jjo-open-snapshot.tsv`에 존재하는 21건은 상태 불일치 0.

`stateHistory` 전수 검사(41건, 창 = 2026-10-27T16:00Z 이후):

```
JJO-941  Backlog  start 2026-10-27T16:33:34.187Z  end 2026-10-27T16:33:56.977Z
JJO-941  Todo     start 2026-10-27T16:33:56.977Z  end (null)
그 외 40건: 창 내 시작/종료된 상태 엔트리 0건
```

- JJO-941 전이는 `2026-10-28 01:33 KST`(= 16:33Z)로, S1 세션 시작(레인 생성 02:14:48 KST / 첫 산출물 `jjo-open-snapshot.tsv` 02:16:01 KST = 17:16:01Z)보다 **41분 이상 앞선다**. 스냅샷 tsv의 JJO-941도 이미 `Todo`(`updatedAt 2026-10-27T16:33:56.989Z`)이므로 S1이 만든 전이가 아니다.
- 나머지 40건은 10-23~10-27 이전 상태 그대로이며 마지막 상태 엔트리가 닫히지 않았다(= 전이 없음).

판정: **주장 일치**(실행 상태 전이 0건). 단, "다른 세션이 갱신한 티켓 없음"의 근거는 §7-B1 참조.

---

## 6. 레드팀 D — 핸드오프 §8-1 11행 ↔ 실측 대조

| §8-1 주장 | 실측 | 판정 |
|---|---|---|
| `git rev-parse HEAD`·`status` → HEAD dbea329, clean | 동일 | 일치 |
| `lane-gjc ls` → 레인 8 + 루트 4, tmux 0 | 18(12/6), tmux 0 | **부분 불일치**(시점 의존, 출력 미보존) |
| `handoff-check` 원문 → 0 | exit 0, 무출력 | 일치 |
| 계약 블록 제거 픽스처 → 1, 메시지 | exit 1, 메시지 동일 | 일치 |
| `verification_run` → 7/6/1/0, receipt b9c3ee64 | receipt 존재·fresh, 7/6/1/0, 6419ms | 일치 |
| `node --test` succession → skip 1 + 사유 | 동일 원문 | 일치 |
| `build/evidence/paths/docs/policy:check` → 0×5, 407/89/149/2 | 동일 | 일치 |
| `gh pr list --state open` → 빈 배열 | `[]` | 일치 |
| `git log --grep=JJO-<id>` 41건 → 총 5(890 2·513 1·664 2) | 동일, 41건 전수 차이 0 | 일치 |
| `linear-trace.py batch --publish`(save_comment ×27) → 27건, 마커 전부 1 | 27 마커, 중복·누락 0 | 일치(재현은 읽기 전용으로만) |
| 산출물 목록 `jjo-41-decisions.md`·`g001~g003`·`git-grep-41.txt` | 5건 모두 존재. 단 `g004-evidence.md`(02:53:41)와 본 보고서가 추가로 존재 | 대체로 일치 |

추가: g003의 "41건 `updatedAt`을 세션 초 스냅샷과 비교: 변경 0건"은 **인용 산출물로 재현 불가**(§7-B1).

---

## 7. 레드팀 E — 발견 사항

### B1 (blocker, 기록 근거) g003의 "41건 updatedAt 비교"는 인용 산출물로 성립하지 않는다

- 주장: `g003-evidence.md` — "`list_issues(team=JJO, limit=250)` 재조회 후 41건 `updatedAt`을 세션 초 스냅샷과 비교: **변경 0건**."
- 실측 1: 스냅샷 산출물 `jjo-open-snapshot.tsv`는 **120행**이고, 배정 41건 중 **21건만** 들어 있다(20건 누락: 773·564·579·578·572·456·589·588·890·866·513·364·664·567·847·826·659·534·747·663).
- 실측 2: 파일은 `updatedAt` 내림차순 상위 120행(범위 `2026-10-26T16:30Z`~`2026-10-27T17:14Z`)이고 **Done 23건이 섞여 있어 "열린 이슈 스냅샷"이 아니다**.
- 실측 3: `list_issues(team=JJO, limit=250)` 1페이지는 250건·`hasNextPage=true`이며 배정 41건 중 **34건만** 포함한다(7건은 페이지 경계 `2026-10-26T02:52Z`보다 오래됨). 팀 전체는 4페이지 **790건**. 따라서 "limit=250 한 번"으로는 41건 비교가 성립하지 않는다.
- 결론(주장의 내용 자체)은 **다른 경로로 참임을 확인했다**: 41건 `stateHistory`상 창 내 전이 0건, `updatedAt`이 바뀐 27건은 전부 이 세션의 댓글 게시 시각(17:48:33–17:50:07Z)과 일치, 나머지 14건은 세션 창 이전 값 유지. 즉 "다른 세션 갱신 없음"은 참이지만 **기록된 방법·산출물이 그 결론을 뒷받침하지 않는다**.
- 조치 제안(택1): ① `g003` 문구를 "41건 중 스냅샷 21건 + API 재조회 41건 대조"로 정정하고 전수 페이지 스냅샷을 산출물로 저장 ② 비교 주장을 빼고 `stateHistory` 검사 결과로 대체.

### B2 (blocker, 완료 서술) "실행 가능한 항목은 실행·검증 완료"가 2건에서 반증된다

핸드오프 §2 완료 조건 ②와 g004의 "이 세션의 몫이 끝났다"는 아래 두 티켓에서 성립하지 않는다. 두 티켓의 **판정표에 적힌 완료 판정 기준 자체가 저장소 밖 읽기 전용 grep**이고, 그 기준은 지금 만족된다.

| 티켓 | 판정표에 적힌 기준 | 지금 실행 결과 | 판정표의 처리 |
|---|---|---|---|
| JJO-773 | `grep -n "완료된 실행" <rule 파일>` ≥1 → Done 후보 | `~/.gjc/agent/rules/linear-work.md:112`, `:119` — **2건 적중** | "판정만", 관찰 근거에 grep 출력 없음 |
| JJO-564 | `grep -n -i "유료\|오클릭\|확인 후 실행" <aside-browser 룰>` ≥1 → Done 후보 | `~/.gjc/agent/rules/aside-browser.md:51, 57, 59` — **3건 적중** | "판정만", 관찰 근거에 grep 출력 없음 |

- 두 검사는 다른 저장소·다른 레인을 편집하지 않고, 유료·권한·삭제도 건드리지 않는다(순수 읽기).
- g001~g004 어디에도 이 두 grep의 실행 결과가 없고, 판정표의 `근거` 칸도 룰 파일의 존재만 언급한다.
- 따라서 "27건 댓글 + 14건 무댓글" 기록은 맞지만, **"실행 가능한 항목 실행 완료 / 세션 몫 종료"는 2/41에서 미완**이다. (같은 시각 ultragoal 상태도 `G004: active` — ledger에 `goal_started G004`만 있고 checkpoint 없음.)
- 조치 제안: 두 grep을 실행해 관찰값을 g004/판정표에 남기고 JJO-773·564를 "Done 후보"로 갱신(댓글 1건씩). 실행하지 않을 거라면 "실행 가능 항목 실행 완료" 문구를 "코드 변경 0건"으로 한정.

### F3 (finding) g004의 최신성 사유 표기 불일치
`historicalComparison: unavailable (absent)`로 적었으나 실제 응답은 `unavailable` + `historicalComparisonReason: "scope_mismatch"`. 상태값은 맞고 사유 문구만 다르다.

### F4 (finding) `jjo-open-snapshot.tsv`의 이름과 내용 불일치
파일명은 `open`이지만 Done 23건 포함 120행이다. "열린 이슈 스냅샷"으로 인용하면 오독된다. 실측 팀 전체: 790건 중 Done 545·Canceled 18, 비종료 227건(그중 Duplicate 17).

### F5 (finding) 무댓글 14건의 수치 표기
"댓글을 쓰지 않은 14건"은 세션 마커 기준으로만 참(0). 기존 댓글은 47건 있다. 인용 시 "이번 세션 마커 0 / 기존 댓글 47" 병기 필요.

### F6 (finding) `lane-gjc ls` 수치 미보존
§8-1의 "레인 8 + 루트 4"는 저장된 출력이 없어 재현·반증이 불가하다(현재 12/6=18). 시점 의존 관측은 출력 원문을 증거 파일로 남겨야 한다. 또한 `lane-gjc`는 PATH에 없어(`which lane-gjc` 실패) 절대 경로 `~/.gjc-user-policy/bin/lane-gjc`로 실행해야 한다 — §8-1 행에는 경로 표기가 없다.

### F7 (finding) §9 조건 1의 "`gjc` 세션 시작" 관찰은 자기 참조
g002의 "이 세션이 실행 중"은 명령 출력이 아니라 자기 서술이다. 같은 조건의 `handoff-check`·`lane-gjc ls`·`agents_freshness_check`가 실측을 제공하므로 조건 자체는 충족되지만, 이 행은 증거로 쓰기엔 약하다.

### F8 (finding) 핸드오프 §11 "Linear 팀 JJO, 열린 이슈 41건"은 팀 수준에서 거짓
실측: 팀 JJO 790건, 비종료 227건(Duplicate 17 포함, 제외 시 210), 그중 이 세션 배정이 41건. 41은 **배정 목록** 수치다. 이 문장은 배차 핸드오프(02:12 작성)에 이미 있던 것으로 S1 산출물은 아니지만, 인용 시 오해를 만든다.

### F9 (finding) 경계 — 허용 쓰기 목록 밖 `/tmp` 파일 3건
세션 브리프의 허용 쓰기는 "워크트리 + 핸드오프 §8 + 증거 디렉터리"였다. 실제로는 `/tmp`에 3건을 썼다: `s1-handoff-before.md`(02:51), `s1-handoff-missing-approval.md`(02:47), `s1-ultragoal-brief.md`(02:45). 앞 2건은 g004에 기록됐고 3건째(brief 사본)는 기록이 없다. 공유·파괴 효과는 없고 모두 임시 경로다.

### F10 (관찰) QA 창구간 증거 표면이 계속 쓰였다
최초 `ls`(02:53 무렵)에는 없던 `g004-evidence.md`가 02:53:41에 생성됐다. QA 대상이 동결되지 않은 채 배정된 것이므로, 이후 보고는 각 파일 mtime을 함께 본다.

---

## 8. 실패 예시 (측정이 실제로 0/실패를 내는지 확인)

**예시 1 — 잘못된 마커로 재조회하면 0건**

```
WRONG_MARKER 's1:deadbeef:result'    -> 0
WRONG_MARKER 's1:01a17e5b:results'   -> 0   (오타 한 글자)
WRONG_MARKER 's1:01a17e5b:comment'   -> 0   (다른 이벤트 종류)
정상 마커 's1:01a17e5b:result'        -> 27
```
→ 마커 계수는 임의 문자열에 1을 돌려주는 눈금이 아니다. 동시에 14건이 0으로 나오므로 티켓별 판별력도 있다.

**예시 2 — 계약 블록 제거 픽스처**

```
$ ~/.gjc-user-policy/bin/handoff-check /tmp/s1-handoff-missing-approval.md
handoff-check: '배포 승인 범위' 블록이 없다: /tmp/s1-handoff-missing-approval.md   exit 1
```

**예시 3 — 두 번째 검사 분기도 실제로 작동한다(추가 공격)**

`## 사용할 스킬` 절에서 `skill_discovery` 문구만 제거한 사본을 만들어 검사:

```
$ handoff-check /tmp/qa-handoff-noskill.XXXXXX.md
handoff-check: 사용할 스킬 블록에 skill_discovery 조회 결과도 '설치 스킬 미해당' 사유도 없다: …   exit 1
(검사 후 파일 삭제)
```
→ 원문 exit 0은 첫 블록만 통과한 것이 아니라 **두 조건을 모두 통과**한 결과다.

**예시 4 — 부재 주장 반증**
`managed_append_identity_mismatch` 저장소 내 `git grep` = **0건**(JJO-771의 "gjc 본체" 판정 뒷받침). `find . -name AGENTS.md`(JJO-941 근거) = **0건**. `.github` 내 `executedAt` = **0건**(JJO-456 근거). 세 부재 주장 모두 반증되지 않았다.

---

## 9. 레드팀 F — 경계 위반 탐색

| 점검 | 명령 | 결과 |
|---|---|---|
| S1 워크트리 오염 | `git status --porcelain` | 빈 출력(0줄) |
| HEAD가 기준과 동일 | `git rev-parse HEAD origin/main` | 둘 다 `dbea329…` |
| 코드 변경 집합 | `gjc ultragoal quality-gate source-hash --json` | `pathCount 0`, sourceHash `39d95a9b…` |
| 워크트리 ref 공유 | `git rev-parse --git-dir --common-dir` | `.git/worktrees/all-s1-…` / `gjc-plugin/.git`(파일 기반 워크트리 — JJO-588 주장과 일치) |
| 다른 lane 편집 | `lanes/*` 전수 `git status --porcelain` | S1만 `dirty=0`. 다른 lane의 dirty는 각 세션 소유이며 이 세션 흔적 없음(S1은 코드 변경 0) |
| 핸드오프 디렉터리 | `stat` mtime | S1만 02:52:10 수정. 다른 핸드오프는 02:12:31, S10은 02:54:49(별도 lane) |
| `/tmp` 잔재 | `ls /tmp` 필터 | `s1-handoff-before.md`·`s1-handoff-missing-approval.md`·`s1-ultragoal-brief.md` 3건(§7-F9) |
| Linear 쓰기 | 호출 로그 | `--publish` 미사용, `save_*` 호출 0건. 이 QA 세션은 읽기 3도구만 사용 |

판정: **경계 위반 없음**. 파괴적 명령·삭제·커밋·푸시·Linear 쓰기 0건.

---

## 10. 레드팀 G — 인용 정확성 스폿체크 (과장 탐색)

| 판정표/근거 인용 | 실측 | 판정 |
|---|---|---|
| `supervisor/README.md:6` (JJO-771 동기) | 6행에 `(JJO-771)` 정확히 존재 | 일치 |
| `managed_append_identity_mismatch`는 gjc 본체 | 저장소 `git grep` 0건 | 일치 |
| `self-improve/lib/loading-receipt.mjs:67` (경로만 리댁션) | 67행 `export function redactValue(... agentDir ...)` | 일치 |
| `CHANGELOG.md:156` (docs/portfolio/AGENTS.md 제거) | 156행 정확 | 일치 |
| `CONTRIBUTING.md:43` (workspace-standard는 저장소 밖) | 43행 정확 | 일치 |
| `artifacts/harness2-rrsi-20261027/run.md:83` (M1이 모델-인-루프 아님) | 83행 원문 일치 | 일치 |
| `self-improve/evidence/audit-20261022/tools/render-battery.mjs:22` | 22행 `executedAt` 파싱 | 일치 |
| evidence `README.md:74-77`·`verdicts.md:3-6`·`sweeps.md:11-12` | 74-77 배터리 12/12, 3-6 claim graph 809행, 11-12 809 분해 | 일치 |
| `grep -rn executedAt .github` 0건 | `git grep` 0건 | 일치 |
| `find docs/portfolio/AGENTS.md` 이 저장소 0건 | `find . -name AGENTS.md` 0건(워크스페이스 루트에는 존재) | 일치 |
| JJO-890 `2fedff2` 2커밋·21파일·4407줄 미머지 | 21 files / 4407 insertions, `origin/main..branch` = 2, 브랜치 미머지 | 일치 |
| JJO-664 `5653e92` PR #12 머지 | `485f1f9` merge PR #12, 부모에 5653e92, origin/main 포함 | 일치 |
| JJO-913 `a7ccd36`~`e6e38a1` | 9커밋, supervisor/ 도입~Discord 요약 | 일치 |
| JJO-933 결과 댓글의 `gjc-user-policy PR #3(099bddb)` | `099bddb … (JJO-933) (#3)` 실재 | 일치 |
| JJO-513 skip 사유 원문 | 재실행 출력과 동일 | 일치 |
| `open PR 0`(662 등) | `gh pr list --state open` = `[]` | 일치 |

→ 인용 좌표 오류는 발견되지 않았다. 과장은 좌표가 아니라 **범위 서술**(B1)과 **완료 서술**(B2)에 있다.

---

## 11. 블로커 목록

1. **B1** — `g003-evidence.md`의 "41건 updatedAt 비교: 변경 0건"이 인용 산출물(`jjo-open-snapshot.tsv`, 21/41 커버)과 단일 `limit=250` 호출(34/41 커버)로 성립하지 않는다. 결론은 별도 검사로 참.
2. **B2** — 핸드오프 §2 ② / g004 "실행 가능한 항목 실행 완료 · 세션 몫 종료"가 JJO-773·564에서 미완(두 기준 모두 지금 적중, 실행·기록 없음).

비블로커 발견: F3~F10(표기·산출물 명명·미보존 출력·§11 수치·`/tmp` 3건·표면 비동결).

---

## 12. 재현 명령 부록

```bash
# E2E
cd ~/jjongguet/lanes/all-s1-gjc-plugin-20261028
git rev-parse HEAD origin/main; git status --porcelain
awk -F'|' '/^\| JJO-/{n++} END{print "ROWS="n}' ~/jjongguet/artifacts/s1-all-20261028/jjo-41-decisions.md
awk -F'|' '/^\| JJO-/{gsub(/ /,"",$3); c[$3]++} END{for(k in c) print k, c[k]}' ~/jjongguet/artifacts/s1-all-20261028/jjo-41-decisions.md | sort
git log --all --oneline --grep=JJO-890 --grep=JJO-513 --grep=JJO-664 | wc -l
gh pr list --state open
~/.gjc-user-policy/bin/handoff-check "~/Desktop/handoffs/all-linear-2026-10-28-021134/S1-워크스페이스운영-GJC도구.md"; echo $?
~/.gjc-user-policy/bin/handoff-check /tmp/s1-handoff-missing-approval.md; echo $?
for s in build:check evidence:check paths:check docs:check policy:check; do bun run --silent "$s" >/dev/null 2>&1; echo "$s=$?"; done
node --test scripts/tests/ultragoal-succession.test.mjs
node --test self-improve/tests/unit/isolation-runtime.test.mjs
gjc ultragoal quality-gate source-hash --json

# Linear (읽기 전용)
python3 ~/.gjc-user-policy/bin/linear-trace.py call list_issues --arguments '{"team":"JJO","limit":3}'
python3 ~/.gjc-user-policy/bin/linear-trace.py batch --call 'list_comments={"issueId":"JJO-773"}'   # 마커 0 확인
python3 ~/.gjc-user-policy/bin/linear-trace.py call list_comments --arguments '{"issueId":"JJO-933"}' # 마커 1 확인
# 41건 전수는 위 batch를 20개씩 3회(총 41 호출)로 돌리고, body 내 's1:01a17e5b:result' 출현 횟수를 센다.
```

분석 중 사용한 임시 JSON(`/tmp/qa_s1_*.json`)은 이 보고서 작성 후 삭제했다. 위 명령으로 동일 수치를 재생성할 수 있다.

---

**E2E 판정: passed** · **레드팀 판정: failed(블로커 2건)** · **저장소·Linear·핸드오프 변경: 0건(이 보고서 1개 파일만 신규)**

세션 종료: 가능 — QA 세션의 몫(재현·공격·보고)은 끝났다. S1 기록의 완료 판정은 **보류**: B1(증거 범위 문구)·B2(누락 실행 2건)를 소유 세션이 처리해야 한다.

---

## 13. Generation 2 재검증 (델타, 2026-10-28 03:05~03:12 KST)

수정된 표면: `g001-evidence.md`(03:04) · `g003-evidence.md`(03:04) · `g004-evidence.md`(03:04) · `jjo-41-decisions.md`(03:05) · 핸드오프 `S1-워크스페이스운영-GJC도구.md`(03:05:18). §13은 이 델타만 다시 공격한 결과다.

### 13-0. 동결 변경 집합 재확인(수정 후에도 불변)

```
$ git status --porcelain | wc -l   → 0
$ git rev-parse HEAD origin/main   → dbea329 / dbea329
$ gjc ultragoal quality-gate source-hash --json
  { "sourceHash": "sha256:39d95a9bd50b1802531f4051824f7962d35b982fce6d5f0a9f91dbda69010e9e",
    "mergeBase": "dbea329…", "pathCount": 0 }
```

### 13-1. B1 재검증 → **해소**

| 검증 | 명령 | 실측 | 판정 |
|---|---|---|---|
| tsv 커버리지 | 41건 ID ↔ tsv 행 매칭 | `TSV_ROWS 120 · COVERED 21/41` | g003의 "120행·21/41" **일치** |
| 250페이지 커버리지 | `list_issues(team=JJO,limit=250)` 1페이지 | 250건·`hasNextPage=true`, 배정 41건 중 **34건** 포함 | g003의 "34건만 덮었다" **일치** |
| 새 방법 재현 | `batch get_issue ×41`(3 batch) | `LIVE_TALLY {In Review 7, Todo 13, Backlog 5, Blocked 16}`, `MISMATCH_vs_TABLE []` | **일치**(불일치 0건) |
| g001 정정 | 동일 문구 + list_comments 10행 | 테이블 10행, 각 댓글 수 = 현행−1과 전부 일치 | **일치** |

판정: g003은 "41건 updatedAt 비교"를 **철회**하고, 저장소 산출물로 검증 가능한 방법(`get_issue` 41건)으로 교체했다. 철회 사유의 두 수치(34·21)도 정확하다. **원 blocker B1은 해소**.

### 13-2. B2 재검증 → **해소**

```
linear-work.md  /완료된 실행/                     → 2 hits: [112, 119]
 112: | 검증·머지·배포 | … 「수치 인용 — 완료된 실행만」 …
 119: ### 수치 인용 — 완료된 실행만
aside-browser.md /유료|오클릭|확인 후 실행/i     → 3 hits: [51, 57, 59]
  51: ## 유료·비가역 버튼 클릭 규칙
  57: - **미리보기·무료 경로 우선** …
  59: - **오클릭 시** …
```

g004의 표(line 112·119 / 51·57·59)와 **정확히 일치**하고, 룰 파일은 이 세션이 편집한 것이 아니다(`linear-work.md` mtime 2026-10-28 00:18:47, `aside-browser.md` 2026-10-26 21:46:25 — 둘 다 세션 시작 02:14:48 이전). g004의 판단(“조건은 이미 충족, 상태 전환은 오너/다음 세션 판단”)도 타당하다. **원 blocker B2는 해소**(실행·기록·게시 3박자 완비).

### 13-3. 신규 댓글 2건 · 기존 마커 27건 불변

```
RESULT_MARKER_OCCURRENCES   27 (티켓 27)   DUP []
VERIFICATION_MARKER_OCCURRENCES 2  DIST {'JJO-773':1, 'JJO-564':1}  DUP []
MARKER_KINDS {('01a17e5b','result'):27, ('01a17e5b','verification'):2}
TICKETS_WITH_ANY 27   other_session_markers 0
```

| 티켓 | 전체 댓글 | result | verification | 마커 시각 |
|---|---|---|---|---|
| JJO-773 | 3 | 1 | **1** | `2026-10-27T18:05:27.977Z`(03:05 KST) |
| JJO-564 | 3 | 1 | **1** | `2026-10-27T18:05:29.426Z`(03:05 KST) |

- 신규 댓글 본문도 실측과 일치: 773은 "line 112·119 적중", 564는 "line 51·57·59 적중"을 적고 있고, 564 댓글은 마커를 `<!-- s1:01a17e5b:verification:JJO-564 -->` 한 형태로만 쓴다(result 마커 없음).
- 상태 불변: `LIVE_TALLY 7/13/5/16`, `TRANSITIONS_SINCE_2026-10-27T17:14Z 0`, `updatedAt > 18:05:30Z` **0건**(이후 다른 세션 갱신 없음).
- 판정: **일치**(각 정확히 1개, 중복·누락 0, 기존 result 27건 변화 0).

### 13-4. 정정 문서의 잔여 수치 모순 스폿체크

| # | 기록된 값 | 실측 | 판정 |
|---|---|---|---|
| 1 | §8-1 115행 `jjo-open-snapshot.tsv … (41건 중 34건만 덮음)` | 파일 기준 **21/41** (34는 250페이지 수치) | **모순 → blocker R1** |
| 2 | §8-1 105행 `save_comment ×27`, g004 31행 `Linear 결과 댓글 27건` | 이 세션 댓글 **29건**(결과 27 + 검증 2), §8-1에 검증 2건 행 없음 | **미기록 → blocker R2** |
| 3 | 판정표 JJO-773·564행 `판정만` + 기준 미관찰 | g004는 동일 티켓을 "이미 충족"으로 기록 | 동기화 누락(F12) |
| 4 | g004 9행 `§8-1 표 11행` | §8-1 데이터 행 **13행** | 불일치(F13) |
| 5 | g004 18행 `historicalComparison: unavailable (absent)` | 실측 `unavailable` + 사유 `scope_mismatch` | 불일치(F3, 1차 미수정) |
| 6 | 판정표가 O2·O3·O4(및 g004·핸드오프의 O6) 사용 | 정의표는 E0–E9만 | 미정의(F11) |
| 7 | g002 39행 `agents_freshness_check … 실행 예정` | §8-1 108행에서 실행·기록됨 | 스테일(F14) |
| 8 | §8-1 산출물 "9개" + 9개 열거 | 디렉터리 9개(본 보고서 포함) | **일치** |
| 9 | g001 `batch list_comments 10건` | 테이블 10행 | **일치** |
| 10 | g003 `27건 전부 markers=1` | 27/27 | **일치** |
| 11 | E3 `registry.json`의 agents-freshness source uri | `"uri": "…/.gjc-user-policy/plugins/agents-freshness"` 실재 | **일치** |
| 12 | 판정표 합계 41행·7/13/5/16·0/25/16 | awk 재검산 동일 | **일치** |

### 13-5. 정확한 수정 제안(각 1줄, 재작업 없음)

1. §8-1 115행 → `jjo-open-snapshot.tsv — 세션 초 list_issues 페이지 발췌(250페이지가 34/41, 이 파일은 120행·21/41만 덮음 — 전수 근거로 쓰지 않음)`
2. §8-1 105행 다음에 행 추가 → `linear-trace.py batch --publish (save_comment ×2: verification) | 레인 워크트리 | 0 | JJO-773·564 검증 댓글 2건, 마커 s1:01a17e5b:verification:* 각 1`
3. 판정표 773·564행 완료 판정 기준 뒤에 → `2026-10-28 03:05 관찰: line 112·119 / 51·57·59 적중 → Done 후보`
4. g004 9행 `11행`→`13행`, 18행 `(absent)`→`(scope_mismatch)`
5. 판정표 E0–E9 정의표에 O2·O3·O4·O6 행 추가(또는 "plan stage-02-revision.md 정의 참조" 명시)

### 13-6. Generation 2 판정

| 축 | 결과 |
|---|---|
| E2E(델타 명령 재현) | **pass** — 13-0·13-1·13-2·13-3 전부 재현 |
| 레드팀 | **fail** — 잔여 blocker 2건(R1 수치 모순·R2 쓰기 기록 누락) + 비블로커 5건(F3·F11·F12·F13·F14) |
| 원 blocker B1·B2 | **해소 확인** (g003 철회·g001 정정 / 773·564 실행·기록·게시) |

**R1** §8-1 115행이 파일 커버리지를 34로 적었으나 실측 21 — 같은 문장 안에서 250페이지 수치(34)와 파일 수치(21)가 뒤섞였다.
**R2** §8-1·g004의 Linear 쓰기 기록이 27건에서 멈춰 있다 — 실제 29건(결과 27 + 검증 2). 감사 추적이 쓰기 2건을 빠뜨린다.

남은 작업은 문서 동기화 2건(±3줄)과 비블로커 표기 정정 3건이며, 판정·댓글·증거의 **내용**은 더 고칠 것이 없다.

세션 종료: 불가 — R1·R2 및 F3·F11·F12·F13·F14 표기 정정이 소유 세션에 남아 있다.

---

## 14. Generation 3 재검증 (델타, 2026-10-28 03:12~03:16 KST)

수정 표면(실측 mtime): 핸드오프 03:12:18 · `g004` 03:12:30 · `jjo-41-decisions.md` 03:12:47 · `g001` 03:12:50 · `g003` 03:12:56 · `g002` 무변경(02:47:55).

### 14-0. 동결 변경 집합(수정 후에도 불변)

```
$ git status --porcelain | wc -l  → 0      HEAD = origin/main = dbea329
$ gjc ultragoal quality-gate source-hash --json
  → sha256:39d95a9bd50b1802531f4051824f7962d35b982fce6d5f0a9f91dbda69010e9e · pathCount 0
```

### 14-1. R1 → **부분 해소**(21/34 분리는 정확, 행 수만 off-by-one)

§8-1 116행 현재 문구: `파일 기준 121행·배정 41건 중 21건만 포함`, `페이지 자체도 41건 중 34건만 덮었다(`hasNextPage`)`.

```
$ wc -l jjo-open-snapshot.tsv   → 120
$ python3: BYTES 16410 · ENDS_WITH_NEWLINE True · NEWLINE_COUNT 120
           NONEMPTY_LINES 120 · TAB_ROWS 120 · COVERED 21/41
```

- **21(파일)·34(페이지) 분리는 정확** — R1의 핵심 결함(두 수치 뒤섞임)은 해소.
- 행 수 **121은 틀렸다**: 파일의 레코드는 **120행**이다. 121은 개행 뒤 빈 문자열을 한 행으로 센 값(`split("\n")` = 121, 마지막 원소 `""`).
- g003은 같은 파일을 `120행·41건 중 21건`으로 적고 있다 → **§8-1과 g003이 서로 어긋남**.

### 14-2. R2 → **해소**

```
17:40Z 이후 댓글 29건 · 무마커 0건 · result 27 + verification 2 = 29
EARLIEST 2026-10-27T17:48:33.775Z · LATEST 2026-10-27T18:05:29.426Z
```

- §8-1 106행 `save_comment ×2` 행 추가 ✓ · 120행 `총 29건(결과 27 + 검증 2)` ✓ · g003 `합계 29건` ✓ — 세 곳 모두 실측과 일치.
- 판정: **해소**.

### 14-3. §8-1 데이터 행 수 → 13이 아니라 **14**

```
TABLE_LINES 16 · NON_SEPARATOR 15 = 헤더 1 + 데이터 14
```

- g004 9행은 `현재 데이터 13행(헤더 포함 14행)`이라고 적었지만 실제는 **데이터 14행 · 헤더 포함 15행**이다.
- 생산 산술: gen1 10행 → gen2 +3(검색 2 · agents_freshness 1) = 13 → gen3 +1(`save_comment ×2`) = **14**. `13`은 gen 3에서 행을 하나 더한 뒤 갱신되지 않은 값이다.

### 14-4. 부수 수정 확인

| 항목 | 실측 | 판정 |
|---|---|---|
| 판정표 JJO-773·564행 | `조건 충족 관측: line 112·119 / 51·57·59 적중. **Done 제안**, 전이는 오너/다음 세션 결정` | **동기화 완료**(구 F12 해소) |
| E4 정의 확장 | `get_issue 41건 대조(7/13/5/16)` + 정책·의존·배차 근거 코드 | 일치, 수치 충돌 없음 |
| g004 O2·O3·O4·O6 | 4개 모두 문장으로 정의(890 브랜치 · 589 아카이브 · 588 ref · 590/935 삭제) | **정의 추가 확인**(판정표는 여전히 O코드 미정의 — F11 잔여) |
| §8-1 109행 · g004 18행 `historicalComparison: unavailable, reason: absent — 이 호출이 반환한 값 그대로` | 동일 scope·cwd로 재실행 → `"historicalComparison": "unavailable"`, `"historicalComparisonReason": "scope_mismatch"` | **재현 실패**(absent 아님) |

### 14-5. Generation 3 판정

| 축 | 결과 |
|---|---|
| E2E(델타 명령 재현) | **pass** — 14-0~14-3 전부 실행·관측 |
| 레드팀 | **fail** — 잔여 blocker 3건 (R1′ 121→120 · R13 13→14 · R3′ absent 재현 실패) |
| 원 blocker R1·R2 | R2 **완전 해소** / R1 **핵심 해소**(행 수만 off-by-one) |

**R1′** §8-1 116행 `파일 기준 121행` → 실측 120행(g003도 120). 문자 하나 수정.
**R13** g004 9행 `현재 데이터 13행(헤더 포함 14행)` → 실측 데이터 14행(헤더 포함 15행). 숫자 하나 수정.
**R3′** §8-1 109행·g004 18행 `reason: absent — 이 호출이 반환한 값 그대로` → 동일 scope 재실행 결과는 `scope_mismatch`. 호출 당시 cwd를 병기하거나 값을 `scope_mismatch`로 고쳐야 재현 가능한 진술이 된다.

세션 종료: 불가 — R1′·R13·R3′(문자·숫자 3건)와 F11(판정표 O코드 미정의)·F14(g002 "실행 예정" 스테일)가 남아 있다.

---

## 15. Generation 4 재검증 (델타, 2026-10-28 03:17~03:21 KST) — **PASS**

수정 표면(실측 mtime): 핸드오프 03:17:29 · `g004` 03:17:29 · `g002` 03:17:36. `g001`·`g003` 무변경(03:12).

동결 변경 집합 불변: `sha256:39d95a9b…` · `pathCount 0` · HEAD = origin/main = `dbea329` · `git status --porcelain` 0줄.

### 15-1. R1′ → **해소**

```
$ wc -l jjo-open-snapshot.tsv → 120 · python3 RECORDS 120 · COVERED 21/41
```

§8-1 116행: `파일 기준 **120행**·배정 41건 중 21건만 포함` ✓, `페이지 자체도 41건 중 34건만 덮었다` ✓. g003의 `120행·41건 중 21건` ✓ — 세 곳이 실측과 일치한다. 파일·핸드오프 전체에서 `121` 잔존 **0건**.

### 15-2. R13 → **해소**

`g004` 9행: 행 수 고정값을 제거하고 "표 행 수는 검증 중에도 늘어나는 값이라 수치를 고정하지 않는다(편집 당시 10행 → 이후 검증·최신성 행 추가). 행 수 대신 각 행의 명령·관찰 내용이 실제 출력과 맞는지를 기준으로 본다"로 대체 ✓. 문서 전체 스캔에서 `13행`·`14행` 고정 표기 **0건** — 반증할 수치가 남지 않았고, 각 행 내용의 정확성은 §14까지 행 단위로 확인된 상태다.

### 15-3. R3′ → **해소**

§8-1 109행: `historicalComparison: unavailable`(사유 표기는 호출 스코프에 따라 달라질 수 있음) · `g004` 18행: "사유 필드 표기는 호출 스코프에 따라 달라질 수 있어 특정 문자열을 정본으로 주장하지 않는다" ✓. `reason: absent`·`absent` 잔존 **0건**. 남은 주장(`historicalComparison: unavailable`)은 동일 scope 재실행에서 그대로 재현된다.

### 15-4. F14 → **해소**

`g002` 39행: "G004에서 실행 — `status: needs_review`(5파일 `directory_entrypoint_only`). 결과는 `g004-evidence.md` E8 절" ✓ — 실제 `g004` E8·제 실측과 일치. `실행 예정` 잔존 **0건**.

### 15-5. 회귀 확인(수정이 기존 주장을 깨지 않았는지)

```
$ handoff-check <현재 핸드오프> → exit 0        (§8-1 편집 후에도 계약 3블록·skill_discovery 표기 유지)
$ Linear 마커 재계수 → 29 (티켓 27; 773·564만 result+verification 각 1)
$ get_issue 41건 → TALLY 7/13/5/16 · MISMATCH [] · TRANSITIONS [] · UPDATED_AFTER_18:05:30Z []
$ /tmp/s1-handoff-missing-approval.md → H2 14개 · '배포 승인 범위' 없음(g002 서술과 일치)
```

### 15-6. Generation 4 판정

| 축 | 결과 |
|---|---|
| E2E(델타 명령 재현) | **pass** |
| 레드팀(사실 모순·재현 불가 주장) | **pass** — 남은 것 0건 |
| blocker | **없음** |

ratchet에 따라 새 스타일 지적은 올리지 않았다. 남은 것은 기록이 아니라 **세션 자체의 대기 항목**(오너 결정 O2·O3·O4·O6, 재배정 25건·차단 16건의 후속 레인 배정)이며, 기록은 이를 "세션 종료: 불가 — 오너 결정 대기"로 이미 정확히 적고 있다.

세션 종료: 가능 — QA 세션의 검증·공격·기록 몫이 끝났다. S1 기록의 완료 판정도 **가능**(대기 항목은 오너 결정·후속 레인으로 명시됨).
