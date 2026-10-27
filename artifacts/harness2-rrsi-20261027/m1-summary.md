# Harness² M1 — m1-0aeecc3-20261026T172939Z

- sourceHead: `0aeecc32d3203a1df7dbb451bee1285264db1857` (feat/harness2-rrsi-loop-mini-m6)
- manifest: `m1-guard-ablation-1` digest `27f37479846a8f7b`
- matrix: 2 tasks × 2 arms = 4 cells; totals {"planned":4,"passed":3,"failed":1,"error":0,"skipped":0}
- host: darwin/arm64 12 cores, node 26.12.0, bun 1.4.3

Cost-0 deterministic guard ablation. Each arm is a guard set run against the same planted defect in an isolated snapshot. Every step is a local keyless repository command: no model call, no network, no credentials, no paid execution. The result measures these guard sets only; it is not a gjc.quality_trial.v2 receipt and makes no agent-efficacy claim.

| task | arm | wallMs | toolCalls | artifactBytes | score | outcome | reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| generated-surface-drift | B0 (drift-only) | 11 | 1 | 41 | 5 | passed | defect_located |
| generated-surface-drift | B1 (drift+acceptance) | 2862 | 2 | 3658 | 5 | passed | defect_located |
| manifest-tool-path | B0 (drift-only) | 8 | 1 | 70 | 0 | failed | defect_missed |
| manifest-tool-path | B1 (drift+acceptance) | 2794 | 2 | 3753 | 5 | passed | defect_located |
| clean-control | B0 (drift-only) | 8 | 1 | 70 | 5 | passed | control_clean |
| clean-control | B1 (drift+acceptance) | 2781 | 2 | 3233 | 5 | passed | control_clean |

Rubric: {"0":"defect missed, control false positive, or timeout/runner error","3":"defect caught but not located: a guard exited non-zero without the locate marker","5":"defect located: a guard exited non-zero and its output contains the task's locate marker; a clean control stayed green"}

Exclusions: A cell that times out, crashes or cannot be given its planted defect is reported as outcome=error with score 0 and stays in the denominator. It is never dropped or retried.
