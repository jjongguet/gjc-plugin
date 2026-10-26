# Harness² M1 + RRSI 실측 — run receipt (2026-10-27)

- 호스트: 맥미니 Apple M6 12코어 / darwin arm64 / node 26.12.0 / bun 1.4.3
- 브랜치: `feat/harness2-rrsi-loop-mini-m6` (base `origin/main` 55a56f1)
- 측정 sourceHead: `0aeecc3` (canonical run `m1-0aeecc3-20261026T172939Z`)
- manifest: `m1-guard-ablation-1` (digest `27f37479846a8f7b…`), `self-improve/m1/manifest.json`
- 비용: 0 USD (모델 호출·네트워크·자격증명 없음, 로컬 명령만)

## 진입점과 실행한 명령

```
node self-improve/m1/run-m1.mjs --head HEAD --out artifacts/harness2-rrsi-20261027
node self-improve/m1/run-m1.mjs --head HEAD --out artifacts/harness2-rrsi-20261027/replay-0aeecc3
bun rrsi/scripts/rrsi-cli.mjs status
bun rrsi/scripts/rrsi-cli.mjs import --ledger self-improve/ledger.jsonl --limit 200
bun rrsi/scripts/rrsi-cli.mjs capture --goal "harness2-m1:m1-0aeecc3" --attempts-file artifacts/harness2-rrsi-20261027/rrsi-attempts.json
bun rrsi/scripts/rrsi-cli.mjs status
bun rrsi/scripts/rrsi-cli.mjs dream --full --seed 1
```

## 1. M1 측정 결과 (2 과제 × 2 설정 = 4 cell + 대조 2 cell)

| task | arm | wallMs | toolCalls | artifactBytes | score | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| generated-surface-drift | B0 drift-only | 11 | 1 | 41 | 5 | passed (defect_located) |
| generated-surface-drift | B1 drift+acceptance | 2862 | 2 | 3658 | 5 | passed (defect_located) |
| manifest-tool-path | B0 drift-only | 8 | 1 | 70 | 0 | failed (defect_missed) |
| manifest-tool-path | B1 drift+acceptance | 2794 | 2 | 3753 | 5 | passed (defect_located) |
| clean-control | B0 drift-only | 8 | 1 | 70 | 5 | passed (control_clean) |
| clean-control | B1 drift+acceptance | 2781 | 2 | 3233 | 5 | passed (control_clean) |

totals: planned 4 / passed 3 / failed 1 / error 0 / skipped 0.
관찰: drift 게이트는 생성 surface 드리프트만 잡고 manifest 계약 결함은 0점(미탐). 전체 수용 스위트는 둘 다 잡고 대조군에서 오탐 없음. 비용은 8~11 ms → 2.78~2.86 s.

**재현성**: 같은 sourceHead에서 2회 실행(`m1-result.json`, `replay-0aeecc3/m1-result.json`)의 4 cell 점수·reason·`outputDigest` 전부 동일. wallMs는 호스트 노이즈로 수 ms 흔들린다(예: drift B1 2836→2862 ms). digest는 격리 임시 경로를 `<cell>`로 정규화한 값이라 안정적이고, cell `excerpt`에도 임시 경로가 남지 않는다.

## 2. RRSI 저장소 (실행 전 → 후)

| 시점 | episodes | attempts | adoptions | storage |
| --- | --- | --- | --- | --- |
| before | 0 | 0 | 0 | missing |
| after import (`self-improve/ledger.jsonl` 28행) | 1 | 28 | 4 | ok |
| after capture (M1 4 cell, episode `ep-128da6afd3ad`) | 2 | 32 | 7 | ok |

import의 jev-advisor journal projection은 `records: 0` — 맥미니에 journal이 없어 합성 데이터를 넣지 않고 0으로 남겼다.
이 세션에서 처음 만든 store는 최종 산출물 기준으로 재구성했다(store.json 삭제 후 import+capture 재실행, journal 세그먼트는 보존).

## 3. dream 정책 순위 (`--full`, seed 1)

- receiptHash `f80f8b821d0d998b…`; 도구 호출과 `--full` 재실행 hash 동일(결정론)
- gate: ok(total 32, passGateN 20, trainN 14, validationN 6, validationAdoptions 3)
- verdict: `unmet` — thresholds `attemptsOk:false`, `costOk:false`, `antiFlukeOk:true`
- 순위(validation): `pi-1-25` failure_greedy / batch 1 / first_adoption / stall off — value 0.985, attemptsToFirstAdoption 3, costMs 322496
- `pi-1-27` batch 2 — 0.98 · `pi-1-29` batch 3 — 0.975 · `pi-1-31` exhaustive stop — 6 attempts / 328160 ms
- baseline 분기 B0·B1 모두 0.985 — 이 코퍼스에서는 arm 분기가 정책 결론을 가르지 못했다
- off-policy replay이며 significance 주장 없음(핀 고정 caveat 유지)

## 4. 경계·실패 관찰

| 입력 | 실행 | 관찰 |
| --- | --- | --- |
| 측정 대상 0건 manifest | `run-m1.mjs --manifest <no-targets>` | exit 1, `invalid_manifest: tasks must hold at least two planted-defect tasks`, 출력 디렉터리 생성 없음 |
| 손상 manifest (`{not json`) | `run-m1.mjs --manifest <corrupt>` | exit 1, JSON parse 오류, cell 계획 없음 |
| 손상 store (`{not json`) | 격리 HOME에서 `rrsi-cli status` | exit 0, `storageStatus: invalid`, `storageReason: corrupt`, counts 0, store 파일 sha256 불변(수리하지 않음) |
| plant anchor 불일치 | 단위 테스트 | `plant_anchor_missing` / `plant_target_missing` / `plant_no_change` throw |
| CLI 오용 | `explode` / `capture`(goal 없음) / `node` 실행 | exit 2 + usage, 부분 상태 변경 없음 |

## 5. 검증 실행

| 명령 | 결과 |
| --- | --- |
| `node --test self-improve/tests/unit/m1-guard-ablation.test.mjs` | 9/9 pass |
| `bun rrsi/scripts/verify.ts` | 32 cases, 0 failures |
| `npm run test:self-improve` | unit 174 ALL PASS, integration 53 ALL PASS, guards 전부 pass |
| `npm test` (11 steps) | 11/11 ok, 0 failed |
| `npm run evidence:check / docs:check / paths:check / policy:check` | 전부 ok |

## 6. 미검증·한계

- 유료 Harness² M1 pilot(JJO-270 원안)은 여전히 미실행: 모델 호출·예산·격리 런타임이 필요하다.
- 이 측정은 가드 커버리지 비교이며 에이전트 행동·효율 주장이 아니다. `gjc.quality_trial.v2` receipt가 아니다.
- jev-advisor journal이 없는 호스트라 journal 기반 import는 0건으로 측정됐다.
- M2/M3(JJO-271·272)는 미착수: M1 데이터가 모델-인-루프 시도가 아니라 가드 비교라 Propose–Probe–Compose 경험 학습에 쓸 실행 근거가 아직 없다.
