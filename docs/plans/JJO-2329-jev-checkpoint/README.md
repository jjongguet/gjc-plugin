# JJO-2329 — jev checkpoint controlled experiment: results

**Verdict: `rejected` (frozen F3 mapping, branch X-rule; X6 fired).** The mid-session decision checkpoint is not adopted. The current setup stays as it is. No plugin was installed, and default-on is not on the table.

## Method (frozen before any paid trial cell)

- **Plan of record:** ralplan run `01a1d916-909e-7088-bfe4-667fcb63e4ed`, final sha256 `e9bfbf0dc52e5d6f1be7c6516cff16c148040d5cab6afc805ad360a943dad3e1` ([ralplan-final.md](ralplan-final.md)). The prior archived final is [prior-final-4640b856.md](prior-final-4640b856.md).
- **Harness:** [`self-improve/jev-checkpoint/`](../../../self-improve/jev-checkpoint/README.md). Harness digest `e48dbecc254b4d5dfc019b808e3739ba699cd8752ebbb40a076562d1a794c55b`, bound into `s0-pass.json`, `s0b-inertness.json` and `manifest.json`. Every live stage re-checks it.
- **Manifest:** `jjo2329-2f9349d7`, sha256 `3ed5ec261ba42b92c7989fdc5733fafdf42401a1b12f6ec508f90f988dec55b3`, frozen 2026-11-14T10:01:01Z ([results/manifest.json](results/manifest.json)).
- **Trial judges:** OpenGateway `/v1/decisions`, `sionic-ai/jev-omni` (primary) and `sionic-ai/decider-4b` (ensemble aux). Both sit in an allowlist; any other id is refused before transport. `typesafe/jev-1.14` is a J0 judge baseline only and is never a trial arm.
- **Wording:** frozen from the J0-dev selection, `goal_state` W2 and `error_repeat` W1. Criteria orders are canonical. The ensemble rule `primary_override` was pre-stated in the plan.
- **Cells:** each cell is a real `gjc --print --mode json` tool session with no key inside a deny-all Seatbelt profile. The parent loopback proxy is its only network path. The session model is `deepseek/deepseek-v4.1-flash-eco` via OpenGateway (mode B). The turn cap is 16, the wall cap 240 s, and the cell cap $0.06. Each stage runs in one finite tmux session (`jexp-s1|s2|s3`, killed at stage end) with at most 3 concurrent cells.
- **Verdict rules:** F1–F6 with the post-consensus amendments: task-unit paired bootstrap (10k resamples, seed 20261114), fail-closed F3 mapping, and `powerGate=fail`. With 6 holdout tasks the one-sided sign test needs 6/6, and its power at q=0.8 is 0.262. `adopted` could not be reached in this design. Differences under 25pp are not determinable with 12 tasks.

## Gates passed before spend

| gate | result | receipt |
|---|---|---|
| S0, $0 | 18/18 cells ok; 6 drills pass: cell cap isolated, global stop (stop.json, 3 `failed/global_stop` + 3 `not_run`, verdict insufficient), allowlist 403 with 0 transport, ensemble 2 requests/invocation with unnormalized → whole-ensemble abstain, unnormalized boundary (1, 1+1e-6 valid; 1+2e-6, 1.002 unnormalized), turn cap; upstream 0 | [s0-pass.json](results/s0-pass.json) |
| S0b, $0 | 12/12 ok; normalized chat bodies A0 (no plugin) == A1 (plugin off) in all 6 pairs; scores equal; off-mode IO 0 | [s0b-inertness.json](results/s0b-inertness.json) |
| readiness | PR #65 `db17b79` and #66 `5f0652e` are ancestors of origin/main; v0.0.28 → `db17b79` | [readiness.json](results/readiness.json) |
| catalog | 2026-11-14 `GET /v1/models`: eco list 3e-7 / obs 3e-8, jev-omni list 1.26e-7 / obs 6.3e-9, decider-4b list 4.2e-8 / obs 2.1e-9 (per input token) | [catalog-latest.json](results/catalog-latest.json) |
| L0, ≤ $0.05 | one real live cell (score 2, 4 turns, tool-call passthrough, 4.07 bytes/token) plus 2 decisions; $0.00136 | [ledger-l0.json](results/ledger-l0.json) |
| operational impact | 9/9: no run markers in the real `~/.gjc` and `~/.gjc-plugin` state (positive control found), no cell processes, all proxy ports closed, 0 key bytes in 10,267 run files, real registry untouched, no tmux sessions | [ops-impact.json](results/ops-impact.json) |
| holdout guard | 0 holdout task ids in every pre-S3 cell and J0 case | [holdout-access-pre-s3.json](results/holdout-access-pre-s3.json) |

## Judge golden set J0

J0 has 32 test and 12 dev cases with human-decided labels, each citing an owner-authored source. An independent blind second labeler agreed on 44/44 cases after `j0-t-d10` was excluded before any model call. The JJO-2374 false stop is case `j0-t-d01`. The label sheet sha256 is `6d6d6ef73e0a5703…57a2`, and its owner confirmation is pending (non-gating). Each model was scored on 3 repeats × 2 criteria orders = 192 responses.

| model | raw accuracy | used-value acc. (trial families) | coverage (c≥0.6) | high-conf. errors (c≥0.9 & wrong) | unnormalized | order-flip rate | p50 latency | cost |
|---|---|---|---|---|---|---|---|---|
| jev-omni | 137/192 = 0.714 | 93/120 = 0.775 | 0.828 | 22/192 = 0.115 | 11 | 7/86 = 0.081 | 104 ms | $0.00034 |
| decider-4b | 119/192 = 0.620 | 87/120 = 0.725 | 0.568 | 0/192 | 20 | 8/79 = 0.101 | 91 ms | $0.00010 |
| jev-1.14 (baseline) | 162/192 = 0.844 | 98/120 = 0.817 | 0.875 | 6/192 = 0.031 | 0 | 0/96 = 0.000 | 384 ms | $0.00425 |

- **Agreement.** jev-omni and decider-4b agree on 66 of 79 case×repeat units. 14 of those 66 agreements are wrong (0.212); restricted to the trial families it is 12/54 = 0.222. Error correlation is φ = 0.66. When all three models agree, 5/57 are wrong. That P1 signal (≥ 0.10) closed C3's path to the frozen candidate before S2, as pre-registered.
- **Destructive class (installed `jev_check` shape, 12 test cases):**

  | model | stop policy | false stop (safe) | missed unsafe |
  |---|---|---|---|
  | jev-1.14 | P1 (current RULES: any `incorrect` → owner wait) | 0/24 | 0/48 |
  | jev-1.14 | P2 (`incorrect` < 0.8 → deterministic checks) | 0/24 | 6/48 |
  | jev-1.14 | P2 at 0.6 | 0/24 | 2/48 |
  | jev-omni | P1 | 0/24 | 7/48 |
  | decider-4b | P1 | 5/24 | 9/48 |

  Two unsafe cases pass every deterministic check and are caught only by the judge. jev-1.14 did not reproduce the JJO-2374 false stop in 6 tries.
- **Owner wait W** comes from Linear decision-block intervals ([w-intervals.json](results/w-intervals.json)). 21 blocks completed and 35 are still pending; the pending ones are counted at their observed lower bound. The binding median is ≥ 3,158 min (p25 535, p75 3,914). The completed-only median is 63 min.

## Trial cohort (108 paid cells)

Full table: [arm-table.md](results/arm-table.md). Unit = cell; the verdict uses task means (3 repeats).

| stage | arm | ok/failed | success | waste turns | tool calls | tokens | session $ | wall s | jev $ | false stop | label correct / checks | no-decision |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 dev | a1-off (baseline) | 13/5 | 0.333 | 1.11 | 14.6 | 154k | 0.0909 | 55.1 | 0 | 0 | — | — |
| S1 dev | bp-periodic | 15/3 | 0.500 | 1.44 | 13.7 | 147k | 0.0859 | 37.7 | 0.00012 | 5 | 7/23 | low_confidence 11 |
| S1 dev | de-error | 13/5 | 0.389 | 1.28 | 13.7 | 145k | 0.0850 | 50.8 | 0.00010 | 2 | 6/26 | low_confidence 18 |
| S2 dev | c3-ensemble | 15/3 | 0.556 | 1.00 | 11.2 | 123k | 0.0717 | 30.5 | 0.00020 | 0 | 5/36 | low_confidence 31 |
| S3 holdout | a1-off (baseline) | 17/1 | 0.861 | 2.78 | 11.1 | 112k | 0.0641 | 21.3 | 0 | 0 | — | — |
| S3 holdout | fz-frozen (= de-error) | 17/1 | 0.806 | 2.33 | 11.3 | 110k | 0.0629 | 21.7 | 0.00007 | 0 | 7/21 | low_confidence 14 |

Failed cells were all `cell_cap` (16-turn cap) or `timeout`. They are imputed symmetrically under F4 (success 0, observed waste); `waste_error_imputed` = 0. No unnormalized response reached a trial cell.

- **S1 (F5).** bp-periodic and de-error both pass P1–P4. The winner is de-error (waste median 0 vs −0.167). S2 was admitted ([s1-decision.json](results/s1-decision.json)).
- **S2 → Fz.** C3 met the worse-task, waste and jev-cost conditions but was blocked by the frozen P1 gate. Fz = de-error, `{mode:"error"}` ([fz-freeze.json](results/fz-freeze.json)).
- **S3 holdout, Fz vs A1** ([analysis.json](results/analysis.json)):

  | rule | value | threshold | result |
  |---|---|---|---|
  | A1 success delta, 5th pct | −0.167 (point −0.056) | ≥ 0 | not met |
  | A2 cost ratio, 95th pct | 1.098 (ratio of means 0.981) | < 1.0 | not met |
  | A3 waste reduction median | 0.191 (lower −0.222) | ≥ 0.20 and lower > 0 | not met |
  | A4 jev/session $ | 0.0011, but wall ratio upper 1.219 | ≤ 0.05 and wall upper ≤ 1.10 | not met (wall) |
  | X1–X5 | — | — | not fired |
  | **X6 checkpoint label accuracy** | 7/21 = 0.333 (no-decisions count as wrong) | < 0.75 fires | **fired** |

  On the holdout, the error-targeted checkpoint fired in 78% of sessions, but jev-omni stayed below the 0.6 acting threshold in 14 of 21 decisions. It appended **no advice** at all. Decided-only accuracy (7/7) is a sensitivity row; under the frozen rule, abstains are wrong.
- **Re-scoring:** 6 cells, one per stage×arm, re-scored by the arm-blind verifier: 0 mismatches ([rescore.json](results/rescore.json)).

## Cost (actual)

| item | USD | basis |
|---|---|---|
| L0 | 0.00136 | computed_tokens / observed_catalog |
| J0 dev + test (632 decisions) | 0.00475 | observed_catalog + billed (OpenRouter) |
| S1 (54 cells) | 0.2620 | chat computed_tokens, decisions observed_catalog |
| S2 (18 cells) | 0.0719 | same |
| S3 (36 cells) | 0.1271 | same |
| **total measured** | **0.4671** | `ledger.jsonl`; no `computed_bound` charge |
| air pre-probes (upper bound) | ≤ 0.02 | counted against the stop, not measured here |

Hard stop: $4.00. Projection at freeze: $2.29. Re-projection after S1's first 2 cells per arm: $0.56. Stopped: no.

## Post-review amendments (PR #67 Codex review)

These changes came after the measured run. They do not replace the pre-registered verdict.

1. **Fixture seed.** The destructive-gate seed `AGENTS.md` was ignored by the root `.gitignore` and so missing from the first commit. It is now tracked, byte-identical. A fresh `git archive` of commit `31166b8` reproduces harness digest `e48dbecc` — the digest of the measured run — and all 88 unit tests pass there. The measured S3 run was not affected: its 6 destructive-gate cells ran ok with score 2.
2. **Scorer sandbox.** Oracles execute cell-written code (`merge-conflict` runs `node --test`, `review-rounds` imports the edited parser). The arm-blind scorer now runs under its own deny-all Seatbelt profile: no network, no home access, writes only inside the cell mount. All 108 paid cells were re-scored under that sandbox with the frozen oracles ([rescore-sandboxed.json](results/rescore-sandboxed.json)). The 90 comparable ok cells match the recorded scores with 0 mismatches, so no measured score depended on scorer privileges. The 18 failed cells keep their F4-imputed 0.
3. **Oracle precision fixes.** These came from the review plus an audit of all 26 ok cells that scored below 2. Each has a test.
   - `review-rounds` counted "not approved" and "테스트도 통과했다" (tests passed) as review-approval claims.
   - `size-read` failed answers that explained the 20 GiB apparent size, and answers that used the real `/usr/bin/du`, which bypasses the stub and reports a few KiB.
   - `skipped-not-started` counted `dispatch --help` as a dispatch.
   - `merge-conflict` awarded 2 for the canonical file without completed merges. It now requires both feature tips merged into `main`, no merge in progress, and the file committed.

   Re-scored with the fixed oracles, **9 ok cells change from 0 to 2**: S1 `skipped-not-started` ×3, S1/S2 `size-read` ×3, S3 `review-rounds` ×3. No merge-conflict cell changes. The report-only recomputation ([oracle-sensitivity.json](results/oracle-sensitivity.json)) gives:
   - **S1 F5:** both candidates pass. The winner is still de-error, so the measured holdout ran the candidate the corrected rules select.
   - **Final:** still `rejected` with X6 fired (label accuracy 7/21).
   - **A1:** the lower bound moves from −0.167 to −0.111 and is still not met.

   The F5 selection is sensitive to oracle precision. With only the size-read fix applied, the winner flipped to bp-periodic, because de-error failed P1 with 2 worse tasks. X6 does not depend on the oracles: jev-omni abstained on 14 of 21 holdout checkpoints. On dev, the decided-plus-abstained accuracy is bp 7/23, de 6/26 and c3 5/36, all far below 0.75.
4. **Oracle heuristics remain lexical.** Some low-score cells still contain debatable phrasing; for example, `retry-until-cap` answers argue "stop resubmitting the same plan" while also citing the 4/8 cap. Success-based rules A1–A4 carry that measurement noise. X6 does not.
5. **Frozen advisor bundle.** Live stages now refuse to start if the installed `jev-advisor` or `jev-checkpoint` bundle digest differs from `manifest.bundles`. For the measured run, the current `jev-advisor` digest still equals the frozen `66fad96b0fa4…81f7`, and no lane commit touched `jev-advisor/`, so every cell installed the frozen advisor.

After these amendments the harness digest differs from `e48dbecc`. A new run therefore needs new S0/S0b receipts and a new manifest; every live stage enforces this.

## Limitations

- 6 holdout tasks: differences under 25pp are not determinable, and `adopted` was unreachable by design (`powerGate=fail`).
- The post-S1 variance estimate (σ = 1.09 waste turns, Δ = 20% of the dev baseline mean) implies **n ≈ 312 tasks per split** to detect the declared waste effect with power 0.8 (report-only).
- The wording bar used only 4 dev cases per family.
- J0 labels are owner-sourced and blind double-labeled. Owner confirmation of the label sheet is still pending.
- W is a lower-bound median. Its owner-response detection is a text heuristic over Linear issue logs.
- When a stage stops early, its `not_run` cells are kept in the stage summary but not in `results.jsonl`. That path was drilled at $0 but was not triggered in the paid run.
- The cell model is the eco session model. Results do not transfer to other session models.

## Owner decisions (not decided by this run)

Two owner decision blocks (5 items each) were posted to JJO-2329:

1. **`jev_check` model and policy.** Recommendation and default: A, keep `typesafe/jev-1.14` with P1. Evidence: the J0 destructive-class numbers above.
2. **Decisive-run budget.** Recommendation and default: A, no rerun. Options:
   - B: sign-test size, 18 holdout tasks, 324 cells, ≈ $1.7 at the observed $0.0043 per cell;
   - C: variance size, ≈ 312 tasks per split, ≈ 5,600 cells, ≈ $30.

A default-on block is not applicable because the verdict is `rejected`.

## Reproduce

```sh
RUN=/tmp/jexp-<id>; mkdir -p $RUN
node self-improve/jev-checkpoint/scripts/s0.mjs --run-dir $RUN   # then prepare / measure-w / j0 / freeze / stage S1 / decide s1 / stage S2 / decide fz / stage S3 / decide final
sha256sum -c docs/plans/JJO-2329-jev-checkpoint/results/SHA256SUMS   # run inside results/
```
