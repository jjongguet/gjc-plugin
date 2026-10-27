# G002 증거 — 차단 근거·경계 사례·정적 검사 실행 (2026-10-28 KST)

cwd: `<repo>`

## E2 — 차단 근거 실측 (JJO-513 · JJO-664)

| 명령 | 관찰 |
|---|---|
| `verification_run(files=[scripts/tests/ultragoal-succession.test.mjs, self-improve/tests/unit/isolation-runtime.test.mjs])` | exit 0 · tests 7 · pass 6 · skip 1 · fail 0 · receipt `b9c3ee64-7c33-4248-a970-3cf99cd0105a` · 실행시간 6419ms |
| `node --test scripts/tests/ultragoal-succession.test.mjs` | skip 1, 사유 원문: `upstream succession close gap (JJO-513) still present in gjc/0.19.0: complete-goals refused by the outgoing fence` |

→ JJO-513: 차단 확인 완료(gjc 0.19.0에서 outgoing fence가 complete-goals를 거부). skip은 통과로 계산하지 않는다.
→ JJO-664: `isolation-runtime.test.mjs`는 pass 6에 포함. 격리 프로브는 이미 머지됐고 남은 차단은 예산·유료 실행이다.

## E3 — 경계 사례 1건 (§9 관찰 조건 3)

- 픽스처: 핸드오프 원문에서 `## 배포 승인 범위` 블록만 제거한 사본 `/tmp/s1-handoff-missing-approval.md` (원문 불변, `## ` 헤딩 14개 잔존)
- 명령: `~/.gjc-user-policy/bin/handoff-check /tmp/s1-handoff-missing-approval.md`
- 관찰: `handoff-check: '배포 승인 범위' 블록이 없다: /tmp/s1-handoff-missing-approval.md` · **exit 1**
- 대조(정상 경로): 원문 핸드오프에 대한 같은 명령은 **exit 0** (세션 시작 시 실행 기록)

## E4 — 정적 검사 체인 (기준선)

| 스크립트 | exit | 마지막 줄 |
|---|---|---|
| `bun run build:check` | 0 | aside-memory generated surface in sync |
| `bun run evidence:check` | 0 | evidence:check ok: 149 tracked self-improve files, 2 allowlisted hash-bound files |
| `bun run paths:check` | 0 | paths:check ok: 407 tracked files, 2 allowlisted hash-pinned line(s) |
| `bun run docs:check` | 0 | docs:check ok: 89 relative links in 46 tracked Markdown files |
| `bun run policy:check` | 0 | policy:check ok: 2 workflows; owner-dispatched pull-request lane is hosted, secret-free, pinned and verified |

## E2E 진입점 관찰 (§9 조건 1)

| 진입점 | 관찰 |
|---|---|
| `gjc` 세션 시작 | 이 세션이 실행 중 (branch `feat/all-s1-gjc-plugin-20261028`, HEAD `dbea329`) |
| `lane-gjc ls` | exit 0 — 기존 레인 8건 + 루트 세션 4건, `lane-gjc tmux 세션: 0건 (확인됨)` |
| `handoff-check <원문 핸드오프>` | exit 0 |
| `agents_freshness_check` | G004에서 실행 — `status: needs_review`(5파일 `directory_entrypoint_only`). 결과는 `g004-evidence.md` E8 절 |
