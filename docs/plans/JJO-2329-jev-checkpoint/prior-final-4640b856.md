# RALPLAN-DR — JJO-2329 jev checkpoint 통제 실험 (revision / stage_n 4)

근거: 이슈 JJO-2329, 부모 설계 886c4edb…, stage-01-intent f8517c1b…, stage-02-revision fe9a1cdd…, stage-02-architect fed38ff4…(F1–F10), stage-02-critic 2364545f…(CR2329-01..10), stage-03-revision 8b2891b5…, stage-03-architect c36a16bf…(CLEAR/APPROVE, N1–N3), stage-03-critic 167fb456…(ITERATE, CR2329-11·06잔여·12·13), 리더 결정 K1–K7. 레인 1149bb4 clean.

이 개정은 판정 규칙을 이슈 문장 **그대로**로 동결하고(비관용·fail-closed), 두 종류의 한도(셀 상한 vs 전역 hard stop)를 분리해 전파 국면까지 명세한다. 나머지 구조(부모 프록시·전 셀 Seatbelt·$0 S0/S0b·108셀·동결 규칙표)는 유지한다.

## Summary

S0($0 18셀) → S0b($0 12셀: A0/A1 불활성) → **L0(≤$0.01 계정 프로브)** → G1(PR #65) → S1(dev6×3팔, 54셀) → 조건부 S2(18셀) → S3(holdout6×2팔, 36셀). 유료 **108셀**.

이번 개정의 핵심 4개:
1. **K1**: 채택 조건을 이슈 문장 그대로 동결한다. 포화·기저 waste 0·오류 셀 어느 것도 조건을 대체·면제하지 않는다. 모든 비채택은 `rejected` 또는 `insufficient → 현행 유지`로 **전수 메핑**된다.
2. **K2**: 셀 상한 초과와 전역 $4.00 도달을 **다른 사건**으로 분리한다. 셀은 그 셀만 error, 전역은 프록시 STOPPED + 실행 중 자식 제거 + 전 세션 종료 + 부분 보고서. 둘 다 S0에서 선형 가격/상한 주입으로 $0 드릴한다.
3. **K3/K4/K6**: S0b 비교는 선언된 정규화 집합 위에서 3반복으로 수행하고, 비용 예상은 L0 1회로 bytes→tokens 비율만 교정한 뒤 **S1 첫 2셀/팔 재투영 체크포인트**로 보정한다. wall 예상은 L0 턴 지연 × turn cap으로 한다.
4. **K5/K7**: 플러그인 번들 경로를 readRoots에 넣고 smoke에서 `plugin list --json`을 단정하며, config.json 경로를 digest target과 일치시키고 models.yml은 셀-불변 템플릿 뷰로 digest한다. 키 스캔은 프로세스 내부에서만, 보유 삭제는 이 세션이 한다.

## Intent Diff (추가분만)

| # | 이전 | 지금 | 이유 |
|---|---|---|---|
| 1 | 포화/기저0/오류 waste 대체 규칙 | 전부 제거, 이슈 문장 그대로 + 전수 메핑 | CR2329-11 fail-open |
| 2 | G4 단일 문구 | G4a(셀)/G4b(전역) 분리 + 전파 명세 + $0 드릴 2종 | CR2329-06 잔여 |
| 3 | S0b 8셀·무정규화 바이트 동일 | 12셀(3반복)·정규화 집합 선언·결정론 fixture | CR2329-12 |
| 4 | L0 p95 가정 | bytes→tokens 교정 + S1 재투영 체크포인트 | CR2329-13 |
| 5 | config.json이 agentDir 밖 | agentDir 안으로 이동, digest target과 일치 | N2 |
| 6 | models.yml 원본 digest | 셀-불변 템플릿 뷰 digest | CR-05 케이밋 |
| 7 | S0b median이 wall 게이트 | L0 지연 × turn cap + S1 재투영; S0b는 오버헤드 드리프트만 | N3 |
| 8 | 번들 readRoots 누락 | 번들 realpath 추가 + smoke 단정 | N1 |

## Principles (4)

1. **판정은 이슈 문장 그대로, 편차는 비채택 방향으로만.** 어떤 규칙도 not_applicable로 면제되지 않는다. 대체 기준은 오너 결정 블록으로만.
2. **분모 보존**: 오류 셀은 성공 0·waste 관측값(없으면 turn cap)·비용 원장값으로 모든 분모에 남는다.
3. **식별 가능성**: 모든 주장은 `(stage, split, taskId, repeat, condition)`로 재구성되고, cohort arm 라벨은 판정에 쓰지 않는다.
4. **자식 최소 표면**: 키 0, 네트워크=loopback 1포트, 프록시가 유일 상류 경로.

## Decision Drivers (top 3)

1. **fail-closed 판정** (K1): 불확실성은 채택이 아니라 현행 유지로 귀결되어야 한다.
2. **두 한도의 분리** (K2): 셀 실패가 단계를 죽이지 않고, 전역 상한이 조용히 일부만 지불하며 끝나지 않는다.
3. **투영의 실측 보정** (K4/K6): 예상을 낙관적으로 고정하면 hard stop이 코호트를 절단한다 → S1 초반 재투영.

## Viable Options

### A. 판정 규칙 (K1)
- **A1. 포화→R2 면제·기저0→비용 대체** — **기각**: Fz 2/3도 채택될 수 있음(CR2329-11).
- **A2. 이슈 문장 그대로 + 전수 메핑** — **채택**.

### B. 전역 중단 전파 (K2)
- **B1. 프록시 거절만** — **기각**: 실행 중 자식·세션이 남는다.
- **B2. 프록시 STOPPED + runner 감지·자식 제거·세션 종료·부분 보고** — **채택**, S0 드릴로 증명.

### C. S0b 비교 (K3)
- **C1. 무정규화 바이트 동일** — **기각**: 경로·시간·커밋 SHA가 달라 항상 실패.
- **C2. 선언된 정규화(경로·셀 id·포트·세션 id·시각·커밋 SHA → 고정 토큰) + 3반복 정확 일치** — **채택**.

### D. 비용 예상 (K4)
- **D1. L0 1회로 p95 가정** — **기각**: 통계량 아님.
- **D2. L0로 bytes→tokens 비율 교정 + S0 요청 크기로 턴 성장 모델 + S1 재투영** — **채택**.

## ADR-ready decision list

- **D1** 실행 컨테이너 `self-improve/jev-checkpoint/{,plugin/}`, root index 미등록, build check는 `test:jev-checkpoint` 내부.
- **D2** checkpoint는 `tool_result`·`session_shutdown`만 등록(block 구조적 불가), append는 content 배열 추가(gate-result.adapter.ts:140-144).
- **D3** 기본 off. 킬 스위치 `JEV_CHECKPOINT=off`; 처리 선언은 `<agentDir>/jev-checkpoint/config.json`(mode·k·trigger·cap·models·lexical=false).
- **D4** 상한: periodic K=8·≤6/세션, error ≤2/세션, ensemble 승자 트리거+회당 3요청(≤3요청/invocation, 8s, 6s/req, retry 0).
- **D5** 합의 5분기(abstain/3-0/2-1/1-1-1/invalid).
- **D6** 계정: 부모 프록시, 요청 예약→전송→settle, 셀 상한과 전역 4.00을 분리, 미확정=`computed_bound`(0 금지).
- **D7** receipt: `validateQualityTrial` 단일 validator; `condition`/`stage`/`errorClass`는 raw 추가 필드; 오류 셀=`failed:1, error:0`.
- **D8** 채택 최대 형태 default-off advisory; 기본 on은 오너 결정 블록.
- **D9** 라우트/가격 상수 4종 고정(eco chat, jev-1.14, jev-omni, decider-4b), 표 밖 모델은 상류 전 거절.
- **D10** 전 셀 deny-all Seatbelt + 단일 loopback, 부트스트랩 순서·readRoots 고정(번들·gjc·mount 포함).
- **D11** 대조 동결: `agentConfigSha`, `jjo2328MergeSha|null`, `alignmentMode=deterministic`, `jevAdvisorMode=shadow`, `jevAdvisorProvider` unset.
- **D12** 판정은 동결 규칙표 + `analyzerDigest`/`ruleTableDigest`; 불일치 시 실행 거절. 채택/기각/불충분은 **전수 메핑**.
- **D13** PR #65 통합은 `git merge origin/main`(rebase·force push 금지).
- **D14** 불활성 증거는 S0b($0)의 정규화된 결정론 검사이며 유료 셀로 대체하지 않는다.
- **D15** 전역 hard stop은 프록시 STOPPED 상태 + runner 전파(자식 제거·세션 종료·부분 보고)로 구현한다.

## F. 규칙표 (K1: 이슈 문장 그대로, 동결)

### F1. 채택 규칙(전부 충족해야 채택) — holdout, Fz vs A1
| ID | 조건 (이슈 문장) | 추정량 |
|---|---|---|
| A1 | 비열등: 성공 delta 하한 ≥ 0 | paired(과제×반복) delta의 bootstrap 10k, seed 20261114, percentile **하한 ≥ 0**. 기저(100%)여도 **그대로 계산**한다(성공 delta 0 → 하한 0 → 통과하려면 Fz도 100%) |
| A2 | 비용비 < 1 | paired sessionUsd 비율의 bootstrap **상한 < 1.0** |
| A3 | 낭비턴 중앙 −20% 이상 | 과제별 (A1−Fz)/A1 wasteTurns의 중앙 ≥ 20% AND bootstrap 하한 > 0. **기저 waste 총합 0 → 규칙 미충족**(대체 없음) |
| A4 | jev 오버헤드 ≤ 5% | jevUsd/sessionUsd ≤ 0.05 AND 추가 wall paired 비율 상한 ≤ 1.10 |
| A5 | 기각 규칙 무발화 | 아래 X1–X6 전부 미발화 |

### F2. 기각 규칙(설계 §2.5 동결)
| ID | 조건 |
|---|---|
| X1 | holdout에서 A1 3/3 → Fz 0/3인 과제 ≥ 1 |
| X2 | dev+holdout 합산 성공률 −8.3pp 이상(≥1과제 상당) 하락 |
| X3 | 비용비 상한 ≥ 1.1 |
| X4 | ignoredAdvice ≥ 70% 또는 triggerRate < 10% |
| X5 | 하네스 총돌 신호 ≥ 2 (설계 4.3 6종) |
| X6 | falseStop ≥ 10% 또는 checkpoint 라벨 정확도 < 0.75 |

### F3. 판정 메핑(전수, fail-closed)
1. X1–X6 중 하나라도 발화 → **`rejected`**.
2. A1–A5 전부 충족 → **`adopted (default-off advisory)`**.
3. 그 외 → **`insufficient → 현행 유지`**(현상 유지가 정답).
4. 조기 종료(전역 hard stop·게이트 실패·S0 실패) → **`insufficient`** + 부분 표(채택·기각 표기 금지).
5. S1 승자 없음 → **`insufficient`**(기각 아님; 후보 미진행을 기록).
6. 포화(기저 100%)는 **“우월성 판정 불가”**를 병기할 뿐 A1을 끄지 않는다.
7. 기저 waste 0은 A3 미충족 → 3번으로. 비용 대체 기준을 쓰려면 오너 결정 블록(5항목)으로 보낸다.

### F4. 오류 셀 보간(모든 분모 유지, K1)
- success = 0. wasteTurns = 존재하는 transcript에서 관측한 값(절단 구간 포함), transcript가 없거나 잘렸으면 **turn cap**. cost = 원장 정산값(미정산이면 예약 상한).
- 이 규칙은 **모든 팔에 대칭** 적용하고, 민감도 줄(`waste_error_imputed` 건수)을 `arm-table.md`에 병기한다.

### F5. S1 통과·승자 (동결)
- 통과 = P1(더 나쁜 과제 ≤1) ∧ P2(triggerRate≥0.30, ignoredAdvice<0.70) ∧ P3(costRatio<1.0 또는 waste 중앙 −10%) ∧ P4(3/3→0/3 과제 0).
- 승자 = 통과자 중 waste 감소 큰 쪽; 차<5pp → costRatio 작은 쪽; 차<0.02 → trigger 작은 쪽; 동률 → De(설계 H2).
- C3가 Fz가 되는 조건 = C3 dev 더 나쁜 과제 ≤1 ∧ C3 waste 중앙 ≤ 승자 ∧ C3 jevUsd/흡수 wasteTurn < 승자. 아니면 승자 유지.

### F6. `analyze.mjs` 캐논
- 단위 = 과제(3반복 평균), paired = (과제, 반복). 비용은 **평균의 비**(상한)을 1차로, 평균 비율을 보조로(둘 다 기록, A2는 1차).
- `pairedBenefit`(behavior-eval.mjs:182)를 재사용하고, 부족한 bootstrap을 자체 구현할 때 이유를 README에 쓴다. `analyzerDigest`·`ruleTableDigest`를 manifest에 동결, 불일치 시 실행 거절.
- 단원 테스트: A1 포화(100% vs 100%), 기저 waste 0 → insufficient, X1–X6 각 1건, 조기 종료, `rejected`/`adopted`/`insufficient` 3분기 전부.

## A. 선행 게이트 (PR #65)

### A1. 지금
하네스·프록시·plugin·fixtures·tests·**S0/S0b**(K2 드릴 포함), S0/S0b 통과 후 **L0**.

### A2. 머지 후
`git fetch origin && git merge origin/main` → **새 manifest id**(sourceHead 변경)로 재동결 → S1.

### A3. 감지 명령 (단계 경계 1회)
```sh
git fetch -q origin main
git merge-base --is-ancestor "$(git rev-parse origin/feat/mini-jjo2327-jev-reliability)" origin/main
jq -r '.version' jev-advisor/gajae-plugin.json
gjc plugin list --json | jq -r '.[]|select(.name=="jev-advisor")|[.version,.manifestHash]|@tsv'
```

### A4. 미머지 시 결정 블록 (완결)
1. 막힌 것: S1–S3(측정 유효성 전제 미충족). 2. 근거: 위 명령 출력·설치 버전 관측값. 3. 완료한 것: 하네스+프록시+unit tests+S0/S0b(+L0) + **draft PR**. 4. **gate label `gate:external`**, 해제 조건 = “PR #65 merge commit이 `origin/main`의 조상”, 재개 주체 = **이 레인(`completion-gate drive`)**. 5. 재개점: `stage.mjs --stage S1` 한 줄.
**PR 처리**: 이 PR은 하네스+S0/L0 결과만 담은 **draft로 열어둔 채 머지하지 않는다**(C1/C2 증거가 생기기 전). 블로커 보고는 branch-flow대로.

## B. checkpoint 메커니즘

### B1. 파일·등록
`plugin/{gajae-plugin.json, hooks/jev-checkpoint.ts, lib/checkpoint-core.ts, src/checkpoint.adapter.ts, scripts/build.mjs}`. hooks: `tool_result/*/after`, `session_shutdown`. `tool_call` 미등록 → block 구조적 불가. build은 jev-advisor/scripts/build.mjs:19-63 방식.

### B2. config 경로(K5/N2)
파일 위치 = `<agentDir>/jev-checkpoint/config.json`(agentDir = arm HOME의 `.gjc/agent`), 기본 경로를 플러그인이 같은 상대 경로로 읽는다. env `JEV_CHECKPOINT_CONFIG`로 오버라이드 가능. digest target `jev-checkpoint/config.json`이 agentDir 기준으로 **해석됨**(isolate.mjs:107-146). `JEV_CHECKPOINT=off` 킬 스위치.

### B3. 트리거·출력·goal
periodic(toolCalls%8 + digest 변경, ≤6), error(isError/동일 args 2회/동일 실패 digest 2회, ≤2), 출력은 개입 신호만 300자 1블록. goal 1줄은 `getBranch()` → `collectAuthority({windowSize:12})`, `goalSource: branch|fixture|absent`을 저널에 기록(전 팔 동일).

### B4. 결정 호출
`JEV_CHECKPOINT_ENDPOINT=http://127.0.0.1:<port>/c/<cellId>/decisions`. state ≤2 KB, 응답 검증 실패는 `invalid_response`(표 무효).

### B5. 저널·상태
`<armHome>/.gjc-plugin/jev-checkpoint/{state,journal/v1}`. 행은 라벨·confidence·latency·status·goalSource·appendDigest만(원문 없음). off 모드는 파일 0.

## C. 프록시·계정 (K2/K5)

### C1. 라우트·가격(고정)
| 요청 | 상류 | 키 | 가격(입력) |
|---|---|---|---|
| `/v1/chat/completions` eco | apis.opengateway.ai | 호스트 로컬 키 파일 | $0.03/1M in, $0.12/1M out |
| `/decisions` jev-1.14 | openrouter.ai | OPENROUTER_API_KEY | $0.042/1M |
| `/decisions` jev-omni | apis.opengateway.ai | 호스트 로컬 키 파일 | $0.038/1M |
| `/decisions` decider-4b | apis.opengateway.ai | 호스트 로컬 키 파일 | $0.021/1M |

출력 토큰 decision 과금 0(decision-models.md:53). `GET /v1/models`는 eco 1개. 표 밖 모델은 상류 전 거절.

### C2. body 충실도
바이트 그대로 전달. 허용 변이는 `stream:true`에서 `stream_options.include_usage`가 없을 때 그 키 추가 1개. 캐노니컬 JSON 동등성 테스트(model/messages/tools/max_tokens/temperature/top_p). L0가 usage 부재를 보이면 모드 B(`stream:false` + SSE 합성)로 전환하며 diff는 `stream`/`stream_options` 2키로 제한, `upstreamMode`를 manifest에 동결.

### C3. 귀속
`baseUrl = http://127.0.0.1:<port>/c/<cellId>/v1`, checkpoint endpoint도 동일 prefix. 프록시가 경로의 `<cellId>`로 모든 행을 귀속. 동시 3세션에서 한 셀 상한이 다른 셀을 막지 않는 테스트.

### C4. 두 한도 (K2) — 상호배타적 의미
**(a) 셀 상한**: `cellCaps{inputTokens, outputTokens, turns, wallMs}`+`cellUsdCap`. 초과 시 프록시는 **그 셀 경로의 추가 요청만** 거절(429형, 상류 0), runner는 **그 자식 프로세스 그룹만** 5초 내 제거, 그 셀 = `failed` + `errorClass=cell_cap`, **다른 셀·단계는 계속**.
**(b) 전역 hard stop**: `spent+reserved+next+cleanup ≥ 4.00` → 프록시가 원자적으로 STOPPED로 전환하고 `stop.json`(사유·원장 스냅샷·시각)을 쓰고 **모든 요청을 상류 0으로 거절**. runner는 1초 간격 제한 폴링(≤5초)으로 `stop.json`을 감지해 (i) 새 셀 스케줄 중지(전 세션), (ii) 실행 중 자식 프로세스 그룹 전부 SIGTERM→SIGKILL, (iii) 부분 arm-table·analysis(`insufficient`) 작성, (iv) `jexp-*` 세션 전부 종료. 남은 계획 셀은 선언 pair 모수에 `not_run`으로 남겨 `incomplete_pairs` → `insufficient`.

### C5. L0(≤$0.01, K4)
S0/S0b 통과 후 1회, `ledger-l0.json`(동일 $4.00에 합산). 요청 3건: tool 포함 chat 1(stream true), jev-1.14 decision 1, jev-omni decision 1. 기록: 턴 prompt/completion 토큰, usage 프레임 유무, tool_calls 통과, 지연, basis, **bytes→tokens 비율**. 게이트: chat basis가 `computed_bound` 아님, 실패 시 모드 B 재프로브 1회(합계 ≤$0.02), 재실패 STOP.

### C6. 예상·재투영(K4/K6)
- 토큰 예상: L0 bytes→tokens 비율로 S0의 scripted 요청 크기 분포를 토큰화하고, 턴당 성장은 S0 관측 + **선언 마진 1.25**. `turnCap`은 16.
- wall 예상 = L0 턴 지연 × `turnCap` + S0b 오버해드 중앙. >240초이면 머지 전에 turnCap 축소(새 manifest id).
- 초기 예상 = Σ U_cell + jev + L0; **≤3.40**이어야 시작.
- **S1 재투영 체크포인트(K4)**: S1에서 팔별 **첫 2셀 완료** 시점에 관측 셀당 평균으로 남은 셀 예상을 재계산. >3.40이면 **추가 셀 시작 전 중단**(축소 레더는 새 manifest id에서만 적용; 진행 중 처리 변경 금지) → `insufficient` + 부분 표.

## D. Receipts·식별

### D1. 팔·condition (변경 없음, 표 생략; a0-release/a1-off/bp-periodic/de-error/c3-ensemble/fz-frozen)
공통 env(정확 목록): `JEV_ALIGNMENT_MODE=deterministic`, `JEV_ALIGNMENT_LATENCY_BUDGET_MS=250`, `JEV_ALIGNMENT_SEND_AUTHORITY_TEXT` 미설정, `JEV_ADVISOR_MODE=shadow`, `JEV_ADVISOR_PROVIDER` 미설정, `RRSI_PERIODIC=off`, `SELF_IMPROVE_SKIP_SMOKE=1`, `NO_COLOR=1`, `CI=1`, `GJC_MODEL_PRESET_REGISTRY_DISABLED=1`.

### D2. provider
1차(검증된 형식): arm `models.yml`에 맞춤 provider `jexp-proxy` — baseUrl `http://127.0.0.1:<port>/c/<cellId>/v1`, api `openai-completions`, auth 방식 `apiKey`(값 = 셀 id placeholder), models 항목 = on-wire id `deepseek/deepseek-v4.1-flash-eco`, 모델 상한 8000, context 1e6, 단가 in 0.03/out 0.12. 호출: `--model jexp-proxy/deepseek/deepseek-v4.1-flash-eco --api-key <cellId>`. 문구는 “provider 자격증명 없음 + 셀 범위 placeholder”.

### D3. receipt 형 (변경 없음) + `stage`/`condition`/`errorClass`.

### D4. harnessDigest (K5/CR-05)
- targets(모두 agentDir 기준, timestamp 없음): `gjc-plugins/registry.json`, `gjc-plugins/jev-advisor`, `gjc-plugins/verification-receipts`, `gjc-plugins/jev-checkpoint`, `jev-checkpoint/config.json`, `models.yml`, `config.yml`, `RULES.md`, `SYSTEM.md`.
- `models.yml`은 **셀-불변 템플릿 뷰**를 digest한다: baseUrl의 포트를 `<PORT>`, 셀 id를 `<CELL>`로 치환한 바이트. `config.json`은 실제 경로(B2)에서 digest.
- 테스트: (a) config 1바이트 변경→digest 변경, (b) 6팔 6 digest, (c) 같은 팔의 두 셀 digest 동일, (d) S1 A1 ≡ S2 재사용 A1, (e) 시간 비의존.

### D5. 단계별 receipts·조합
`receipts/{s0b-inertness,s1,s2,s3,all}.jsonl`. 조합 검사: `conflicting_duplicate=0`, S1 18/18/18. winner 재사용은 의도된 duplicate.

## E. 하네스 레이아웃 / 파일

```
self-improve/jev-checkpoint/
  README.md manifest.json configs/{off,periodic,error,ensemble,frozen}.json
  lib/{proxy,accounting,cell,oracle,analyze,receipts,runner,metrics}.mjs
  fixtures/tasks/<id>/{prompt.md,seed/**,stubs/bin/*,spec.json}
  scripts/{stage,analyze,verify,test-guard,s0-guard}.mjs
  tests/unit/{checkpoint-core,proxy,accounting,receipts,oracle,metrics,analyze,manifest,isolation,s0-guard}.test.mjs
  plugin/**
```
기존 파일: `package.json`의 `test:jev-checkpoint` 1줄(test:self-improve 다음), 내부에서 `test-guard` → `node --test` → `build --check` 순서로 호출(CI는 package script만 실행). `CHANGELOG.md` 미변경. root `build:check` 미변경.
결과: `docs/plans/JJO-2329-jev-checkpoint/{README.md,manifest.json,ralplan-final.md,receipts/,summary.json,analysis.json,arm-table.md,SHA256SUMS}`.

## F(단계)·G(지표)·H(격리)

### 단계·셀
| 단계 | tmux | 셀 | 구성 |
|---|---|---|---|
| S0 | 3 | 18 | 2 dev × 3팔 × 3반복(scripted) + 드릴 |
| S0b | 2 | 12 | 2 dev × {A0,A1} × **3반복** |
| L0 | 1 | 0 | 3요청 |
| S1 | 3 | 54 | dev6 × {A1,Bp,De} × 3 |
| S2 | 1 | 18 | dev6 × C3 × 3 |
| S3 | 2 | 36 | holdout6 × {A1,Fz} × 3 |

### S0 드릴 2종 (K2)
1. **셀 상한 드릴**: 한 셀의 `cellUsdCap`을 작게 주입 → 그 셀만 `failed/cell_cap`, 다른 셀 정상 완료.
2. **전역 상한 드릴**: S0 manifest에 선형 가격(`syntheticPriceUsd`)을 주입해 몇 요청만에 4.00에 도달하게 한다. 관측 필수: 상류 호출 0, `stop.json` 생성, 모든 실행 자식 종료, `jexp-*` 세션 0, 남은 셀 `not_run`로 분모 유지, 부분 arm-table·analysis(`insufficient`) 생성.

### S0b 정규화 집합 (K3/CR2329-12)
- 정규화 토큰: 셀 루트 경로→`<ROOT>`, 셀 id→`<CELL>`, 포트→`<PORT>`, 세션 id→`<SESSION>`, 날짜/시각 줄→`<TIME>`, fixture 커밋 SHA→`<SHA>`, 작업트리 목록의 mtime→`<MTIME>`.
- fixture는 `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`/이름·이메일 고정으로 결정론 생성한다(SHA 고정됨).
- 비교: 턴마다 정규화 전/후 body SHA를 모두 기록하고, `정규화 후 SHA(A0) == 정규화 후 SHA(A1)`을 3반복 전부에서 요구. scripted 기대 점수는 표면 불문 정확히 동일해야 한다.
- off 모드 IO 0: state/journal 파일 0, 프록시 행 0, append 0.

### 지표(G)·격리(H)
- `--mode=json` JSONL(≤8 MiB, 절단→error). 지표 술어는 stage 3 그대로 + **falseProceed는 `spec.json.driftPredicates`**(과제별 결정론 검출: 상한 발명 숫자·범위 밖 쓰기·미확인 단단)로 판정, 조언이 proceed/retry_same인데 t+1..t+2에 발화하면 falseProceed.
- arm-table 열 = 이슈 8지표 + `waste_error_imputed`·`triggerRate`·`ignoredAdvice`.
- oracle은 arm-blind(입력=transcript/audit/repo/taskId/spec만), 별도 프로세스·`probeIsolation` 아래.
- H1 부트스트랩: `readRoots = runtimeReadRoots() + realpath(gjcBin) + realpath(mount) + realpath(<lane>/self-improve/jev-checkpoint/plugin) + realpath(<lane>/jev-advisor)`(K5/N1). 샌드박스 안에서 `gjc plugin install <bundle> --user` + natives 워밍업 후 `plugin list --json`에서 `jev-checkpoint`와 `jev-advisor`의 manifestHash를 **단정**한다. 이 실패는 부트스트랩 결함($0 수정)이며 G9와 구분한다.
- H2 운영 영향: 마커(nonce·셀 session id·stageRoot) 기반 0건 단언 + 양성 대조, `pgrep -f stageRoot`=0, `lsof` 포트 폐쇄, **키 스캔은 프로세스 내부 Buffer.indexOf**(argv·파이프에 키 금지) + 센티널 검출.
- H3 보유: `/tmp/jexp-<runId>`는 결과 커밋·SHA256·비밀 스캔 후 **이 세션이 삭제**하고 삭제 시각·경로 목록을 영수증에 남긴다(타이머 없음).

## I. 결과 기록·전달 (K7)

- 결과 README 고정 섹션(방법·manifest sha·ruleTable/analyzer digest·팔·라우트·지표·판정과 수치·한계·비용/`computed_bound` 건수·재현 3줄).
- 어휘 가드: `verdict != adopted`면 README/summary/PR 본문에 `개선|improve|better` 금지(verify.mjs exit 1).
- Linear 기록: ralplan run id + final plan sha256 / 첫 유료 단계 전 manifest sha256 / 결과(판정·수치·미실행·비용·PR merge SHA·남은 일) / ultragoal run id.
- **전달 순서**: 커밋 → PR(본문 게이트 결과) → 최종 head SHA의 Codex 호스팅 리뷰 확인 → `pr-review jjongguet/gjc-plugin <n> --codex-fallback --post` → 「리뷰 처분」 → 머지 → post-merge CI → Linear → worktree clean. **lane-finish/lane-verify/sidecar는 이 세션에서 하지 않는다**(C0=executor). C1/C2 증거가 없으면 PR은 draft로 유지·머지 금지.

## Acceptance criteria

- AC1 단원 전수 exit 0(test:jev-checkpoint가 test-guard 선실행, 0-case면 실패).
- AC2 `bun run test` step에 `test:jev-checkpoint` 포함·exit 0.
- AC3 `build:check`·`paths:check`·`evidence:check`·`docs:check`·`policy:check` exit 0.
- AC4 S0 18/18 ok + **드릴 2종**: 셀 상한(해당 셀만 failed/cell_cap), 전역 상한(상류 0·stop.json·전 자식·세션 종료·부분 보고·선언 pair 보존).
- AC5 S0 $0: `upstreamCalls=0`, 자식 키 이름 0, deny-all 음성 probe.
- AC6 운영 영향 9종(마커·양성 대조·pgrep·포트·키 스캔·보유 삭제 포함) 통과.
- AC7 S0b 3반복 전부에서 정규화 body SHA A0==A1 + off IO 0 + 표면 불문 scripted 점수 동일.
- AC8 S1 54셀·arm 18/18/18·`conflicting_duplicate=0`·재투영 체크포인트 통과(또는 중단 기록).
- AC9 `analysis.json`이 A1–A5·X1–X6·메핑 7분기·보간·조기 종료를 전부 평가하고 `rejected|adopted|insufficient` 중 하나를 낸다. seed 20261114 재현, digest 일치.
- AC10 receipts `validateQualityTrial` 통과, cohort counts-only 인용만, `waste_error_imputed` 건수 병기.
- AC11 L0 ≤$0.01·basis 비-`computed_bound`, 초기 예상 ≤3.40, 누적 ≤4.00, 미확정 0 처리 없음.
- AC12 지표 8종 재도출 + arm-blind 재채점 6셀 불일치 0(또는 한계 기록).
- AC13 SHA256SUMS 일치(결과·workflow 사본).
- AC14 merge SHA + post-merge CI URL + clean worktree + `/tmp` 삭제 기록; C0=executor 대기.
- AC15 어휘 가드 통과, 미실행·차단은 결정 블록 5항목(`gate:external` 라벨 포함).

## Escalation / Risk gate

- **G0**(기계적) s0-pass.json(manifestDigest·harnessDigest·proxyMode·드릴 2종) 없으면 유료 거절.
- **G1** PR #65 미충족 → 결정 블록·draft PR.
- **G2** S0b 불활성 실패 → 유료 금지·수정 후 새 manifest id.
- **G3a** L0 `computed_bound` → 모드 B 1회 재프로브, 재실패 STOP. **G3b** 초기/재투영 예상 >3.40 → 시작/추가 셀 중단.
- **G4a** 셀 상한 → 그 셀만 error(단계 계속). **G4b** 전역 4.00 → STOPPED·전파·부분 보고(단계 종료).
- **G5** 포화 → A1 유지, “우월성 판정 불가” 병기(중단 아님).
- **G6** 동시 편집(`jev-advisor/`·`shared/`) → 중단. **G7** 동일 실패 2회 → 오너 결정 블록.
- **G8** 라우트/키 섬임·표 밖 모델 → 거절+단계 중단.
- **G9** Seatbelt tool-세션 미호스팅(부트스트랩 결함이 아닌 경우) → **유료 STOP + 오너 결정 블록**.
- **G10** 결과 리뷰 불일치 >0 → 새 manifest id 또는 한계 기록.

## Risks

| 리스크 | 완화 |
|---|---|
| 판정 fail-open | K1 원문 동결 + 3분기 전수 테스트 |
| 전역 상한이 일부 만 지불 | K2 STOPPED+전파+$0 드릴 |
| S0b 비교 불가 | 정규화 집합+결정론 fixture+3반복 |
| 예상 과소 → 절단 | L0 교정+S1 재투영(2셀/팔) |
| 셀 조기 거절 | L0 파생 caps·turn cap, error를 분모 유지 |
| Seatbelt/번들 실패 | readRoots에 번들·pod 포함 + smoke 단정, 실패는 $0 수정 |
| provider baseUrl 미작동 | S0 smoke가 형식 판정, `auth:none`은 프로브만 |
| 시스템 라우트 부재 | 전 팔 fail-closed 한계 기록 |
| PR #65 지연 | 결정 블록·draft PR·`gate:external` |
| 시간 초과 | 240s/셀, 120분/단계, 240분 전체, S1 우선 |

## Cost & time

- 단가: eco in $0.03/1M, out $0.12/1M; jev-1.14 $0.042/1M; jev-omni $0.038/1M; decider-4b $0.021/1M; decision 출력 0.
- 계획값 U₀=0.0144/셀 → 108셀 1.5552 + jev 0.0681 + L0 ≤0.01 = 1.6333; ×1.25 = **2.04**; hard stop 4.00; 절대 5.00.
- L0 교정값이 0.030/셀 이상이면 레더(새 manifest id) 필요, 0.037/셀 이상이면 시작 불가. S1 재투영이 최종 방어선이다.
- 시간: S0 10분 + S0b 10분 + L0 2분 + S1 27분 + S2 27분 + S3 27분 + 준비·분석 40분 ≈ **약 143분**(상한 240, 단계 120).

## Sequencing

- **P0(지금, $0–$0.01)**: lib·프록시·fixtures·oracle·metrics·analyzer·tests → plugin build → S0(드릴 포함) → S0b → L0 → G0/G2/G3a.
- **P1(G1 후)**: `git merge origin/main` → 새 manifest id → S1(3세션, 2셀/팔 재투영) → 규칙표 → S2(조건부) → Fz 동결 → S3.
- **P2**: analysis·arm-table·summary·SHA256SUMS·결과 리뷰 6셀 → 판정 → `/tmp` 삭제.
- **P3**: PR 본문 → 호스팅 리뷰·pr-review·처분 → 머지 → post-merge CI → Linear → clean worktree(C0=executor).

## Resolution map (pass 2 추가분 포함)

| finding | 섬션 | 해결 |
|---|---|---|
| F1–F10 | (pass 1) | stage 3에서 해결, 유지 |
| CR2329-01..05, 07..10 | (pass 1) | stage 3에서 해결, 유지 |
| CR2329-06 잔여 | C4, G4a/G4b, S0 드릴, AC4 | 셀 상한 ↔ 전역 상한 분리, 전파 4단계, 드릴 2종 |
| CR2329-11 | F1–F4, F6, AC9 | 이슈 문장 원문, 포화·기저0·오류 면제 제거, 3분기 전수 메핑, 테스트 |
| CR2329-12 | S0b 정규화, AC7 | 정규화 토큰 7종, 결정론 fixture, 3반복, 표면 불문 점수 동일 |
| CR2329-13 | C5/C6, G3b, AC11 | bytes→tokens 교정 + S0 성장 모델 + S1 재투영(2셀/팔) |
| N1 | H1, AC4/AC7 | 번들·pod realpath readRoots + smoke `plugin list --json` 단정 |
| N2 | B2, D4 | config를 agentDir 안으로 이동, digest target 해석 일치 |
| N3 | C6, F2 | wall 예상 = L0 지연×turnCap; S0b는 오버해드 드리프트만 |
| CR-05 케이밋 | D4 | models.yml 셀-불변 템플릿 뷰 + 4개 불변성 테스트 |
| K7 키 스캔 | H2 | 프로세스 내부 Buffer.indexOf, argv 금지 |
| K7 보유 | H3, AC14 | 이 세션이 결과 커밋·SHA 후 `/tmp` 삭제·기록 |
| K7 test-guard | E, AC1 | `test:jev-checkpoint`가 guard 선실행 |
| K7 falseProceed | G, AC12 | `spec.json.driftPredicates` 결정론 검출 |
| K7 A4 | A4 | `gate:external`·해제 조건·재개 주체·draft PR 유지 |
| K7 env 편집 | D1 | 정확 키 목록으로 정리(`SELF_IMPROVE_SKIP_MODE` 오기 제거) |

## Evidence index

- `self-improve/lib/quality-trial.mjs`: ARMS(:38), executionKeyFor(:80), validateQualityTrial(:100; denominator:157-173; cost:176-189), cohort(:238).
- `self-improve/lib/behavior-eval.mjs`: admitCall(:94), isolationPreflight(:111), pairedBenefit(:182). `self-improve/lib/isolate.mjs`: DEFAULT_DIGEST_TARGETS(:17-23), targets 해석(:107-146). `self-improve/lib/loading-receipt.mjs`: harness_target_missing(:184-186), collectPluginState(:96), buildLoadingReceipt(:139).
- `self-improve/lib/isolation-runtime.mjs`: buildSeatbeltProfile(:48-91), loopback(:160-164), probeIsolation(:328+).
- `self-improve/m1/native-pilot.mjs`: provider(:18-33), readRoots/protected(:62-76), profile 결박(:78-90). `m1/recording-proxy.mjs`: UPSTREAM/MODEL(:5-6), 모델 검사(:28), SSE(:113-118), dry 거절(:123-125), `/v1/models`(:146-149), 원장(:50-110), usage(:192-211).
- `verification-receipts/scripts/smoke-host.mjs`: SSE tool_calls(:441-470). `verification-receipts/src/gate-result.adapter.ts`: 이벤트(:47-56), append(:140-144), sessionId(:18-21).
- `jev-advisor/src/alignment.adapter.ts`: mode(:53-60), write-class(:37), block(:165), getBranch(:234-240). `jev-advisor/lib/decision.ts`: 상한(:113-114), envelope(:180-230), ollaya(:303), endpoint(:384). `shared/lib/decision-contract.ts`(:69,:74-86).
- `shared/lib/results.ts`: HOME(:253-256), append(:434), 저널(:448), 회전(:478-522). `rrsi/scripts/rrsi-cli.mjs`: ACTIONS(:14). `rrsi/lib/rrsi.ts`: readTrialRecords(:470-477). `rrsi/README.md`(:27-29).
- `scripts/run-checks.mjs`(:30-31), `check-paths.mjs`(:5-35), `check-evidence-paths.mjs`(:8), `check-doc-links.mjs`(:17), `self-improve/scripts/verify-unit.mjs`(:19-22,:44-47).
- `.github/workflows/ci.yml`(:1-5,:55-70), `pr-validate.yml`(:1-15).
- `rules/pr-review.md`(:12 10레포,:19 `--codex-fallback --post`), `rules/branch-flow.md`(:86,:96 리뷰 처분), `rules/decision-models.md`(:53 가격,:63 키 경로,:68-70 allowlist).
- `models.yml`: warp-oz `auth:none`(:15-20), opengateway(:26-31), 0_Deepseek_eco(:66-75). `evals/better-option/run.mjs`(:41-73,:114-118). `docs/gjc-0.20-plugin-cli-verification.md`(:44,:96,:137).

## Material open items

1. 설계서 sha256 바이트 재계산 미실행(제한된 bash) — 두 출처 일치까지 확인.
2. L0가 결정: `upstreamMode`, bytes→tokens 비율, 초기 예상. 실패 시 G3a STOP/모드 B.
3. pre-S0 smoke가 결정: custom provider 해석 + Seatbelt tool-세션 호스팅(+번들 설치). 실패 시 각각 $0 수정 또는 G9.
4. S0b `goalSource`: `absent`면 “goal 라인 없음” 한계 기록.
5. PR #65 머지·설치 상태는 실행 시 A3 명령으로 재확인(이 세션은 관측만).


---

# FINAL — pending approval unless admitted by the final receipt's auto_handoff

Consensus: Architect CLEAR/APPROVE (stage-04-architect.md e6482d4a…) and Critic OKAY (stage-04-critic.md b06af07e…) on revision stage_n 4 (d36950d3…). Post-consensus reconciliation: stage-04-post-interview.md (8c71e7b9…), reconciled-clean.

## Intent Reconciliation

Pre-consensus (stage-01-intent, f8517c1b…), leader-resolved from evidence because this executor lane has no owner channel:
- M1 parent-owned loopback forwarding proxy; child receives no provider key; request-level hard stop $4.00. Key sources (values never read into output): host-local `~/.gjc/agent/policy/secrets/opengateway-key.txt` (0600) for OpenGateway routes, `OPENROUTER_API_KEY` from `~/.gjc/agent/.env` for jev-1.14.
- M2 deny-all Seatbelt + single loopback for every cell; failure to host a tool session is a paid-stage STOP with an owner decision block (G9).
- M3 S0 = the same proxy in scripted mode, no upstream client.
- M4 deterministic control = current harness (`JEV_ALIGNMENT_MODE=deterministic`) on an agent-config `origin/main` snapshot frozen in the manifest; JJO-2328 included iff merged by freeze (merge SHA recorded), else stated.
- M5 baseline reuse (A1 dev cells shared by S1/S2).
- M6 ≤3 concurrent `jexp-*` tmux sessions per stage.
- M7 paid stages only after PR #65's merge commit is an ancestor of origin/main and the lane has merged origin/main.
- M8 checks = full local gate + Codex-hosted review / `pr-review --codex-fallback --post` + review disposition + post-merge CI.

Review-loop leader decisions (pass 1–2): L1 drop ollaya/systemone route (jev-advisor provider features fail closed equally in every arm; recorded limitation); L2 paid A′ replaced by $0 deterministic S0b inertness evidence; L3 L0 live calibration probe ≤ $0.01 after S0/S0b, before PR #65 merge allowed (calibration only); L4 `git merge origin/main`, no rebase/force push; L5 no lane-finish/lane-verify/sidecar in this session (C0 = executor); L6 Codex-hosted review flow; L7 unsandboxed fallback = STOP. K1 adoption rules frozen literally, fail-closed, exhaustive mapping; K2 per-cell cap vs global stop separated with two $0 drills; K3 declared normalization + 3 repeats for S0b; K4 S1 re-projection after 2 cells/arm; K5 bundle readRoots, config path/digest alignment, cell-invariant models.yml digest view; K6 wall projection from L0 latency; K7 in-process key scan, /tmp retention deletion by this session, test-guard, falseProceed predicates, completed A4 block.

Post-consensus (stage-04-post-interview, 8c71e7b9…) — these AMEND the plan text above and win on conflict:
1. **Bootstrap unit = task** (3-repeat mean per task, paired by task) for A1–A4; "paired(과제×반복)" in F1/A1 is superseded. Unit test: 6-task holdout interval equals resampling 6 task means.
2. **Per-task waste ratio with zero baseline**: A1=0 ∧ Fz=0 → 0; A1=0 ∧ Fz>0 → −1. Unit tests.
3. **Precedence**: F3 branch 4 (early termination → `insufficient`) precedes branch 1; partial data never yields `rejected` (fired X-rules reported as observations). In-flight cells at global stop → `failed`, `errorClass=global_stop`; unstarted → `not_run`. X6 uses per-task `expectedLabelAt` in `spec.json`.
4. **25pp declaration** in manifest and result README: with 12 tasks (holdout 6) differences < 25pp are not determinable (sign test needs 10/12, holdout 6/6).
5. **PR #65 readiness check** (replaces A3's branch rev-parse): `gh pr view 65 -R jjongguet/gjc-plugin --json state,mergeCommit` then `git merge-base --is-ancestor <mergeCommit> origin/main`; A0 release surface = JJO-2327 release tag tree (`git archive <tag>`), or the merge commit tree if no tag exists (stated in the result doc).

Open confirmations deferred to the owner: none required for execution. Default-on adoption remains an owner decision block by design (non-goal).

## ADR

**Decision.** Build a self-contained experiment under `self-improve/jev-checkpoint/` (harness libs, scripted/live loopback proxy with a durable reservation ledger, an unregistered default-off `jev-checkpoint` plugin hooking only `tool_result`/`session_shutdown`, 12 golden tasks with deterministic arm-blind oracles, analyzer with frozen rule table) and run S0 (18 scripted cells + two hard-stop drills, $0) → S0b (12 cells, deterministic inertness, $0) → L0 (≤ $0.01) → [PR #65 merged + `git merge origin/main` + new manifest id] → S1 (dev6 × {A1,Bp,De} × 3) → conditional S2 (dev6 × C3 × 3) → S3 (holdout6 × {A1,Fz} × 3), 108 paid cells, every cell keyless under deny-all Seatbelt with one loopback port. Verdict ∈ {rejected, adopted (default-off advisory), insufficient → keep current} by the issue's literal criteria; results committed to `docs/plans/JJO-2329-jev-checkpoint/` with SHA256SUMS; PR → Codex/pr-review disposition → merge → post-merge CI.

**Drivers.** (1) Measurement validity depends on unmerged PR #65 → gate paid stages on its merge. (2) $4.00 hard stop must be real and immediate → request-level proxy refusal + propagation, drilled at $0. (3) A live lane is rewriting `jev-advisor/**`, `shared/lib/**` → zero write overlap.

**Alternatives considered.** Checkpoint inside `jev-advisor/` (rejected: certain conflict with PR #65); harness-only prompt injection (rejected: measures a different mechanism); reuse m1 recording proxy as is (rejected: tool-less/300-token normalization would invalidate cells); transcript-only accounting with keys in the child (rejected: no mid-flight stop, key-leak path into transcripts); separate paid deterministic-control arm (rejected: duplicates B0 and costs budget); paid A′ inertness cells (rejected: stochastic, cannot gate S1; replaced by deterministic S0b); adoption-rule substitutions for saturation/zero baseline (rejected: fail-open).

**Why chosen.** It is the smallest design that satisfies every issue requirement with checkable receipts, keeps all paid spend behind a $0-proven harness, never puts a credential in a child, and leaves the default-on question with the owner.

**Consequences.** jev-advisor provider features (jev_check, task advice) fail closed in every arm — a uniform limitation, not a confound. The experiment plugin is not shipped; if adopted, the merge into jev-advisor is a follow-up issue. 12 tasks cannot detect < 25pp; the likely outcome per ADR 0001 is `insufficient`, which is a valid result. Paid stages may wait on PR #65; the PR stays draft until C1/C2 evidence exists.

**Follow-ups.** (a) If adopted: default-off advisory install with receipt and rollback, plus an issue to fold the checkpoint into jev-advisor after PR #65. (b) Owner decision block for any default-on exception to RULES 「판단 단계」. (c) Out-of-scope defect reported, not fixed: `rrsi/scripts/rrsi-cli.mjs` ACTIONS lacks `cohort`.
