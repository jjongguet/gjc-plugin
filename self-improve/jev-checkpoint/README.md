# jev-checkpoint — JJO-2329 controlled experiment harness

This experiment measures whether a mid-session decision-model checkpoint saves waste turns without lowering task success. It covers a periodic goal-vs-state check, an error-targeted check, and a two-voter ensemble. It is **not** a shipped plugin: the `jev-checkpoint` bundle under `plugin/` is installed only into isolated experiment cells and is off by default. The plan of record is ralplan run `01a1d916-909e-7088-bfe4-667fcb63e4ed`, final sha256 `e9bfbf0d…d3e1`. Results live in `docs/plans/JJO-2329-jev-checkpoint/`.

## Judgment surface (frozen)

| surface | models | route | used by |
|---|---|---|---|
| trial | `sionic-ai/jev-omni` (primary), `sionic-ai/decider-4b` (ensemble aux) | `POST https://apis.opengateway.ai/v1/decisions` | checkpoint arms via the parent proxy |
| J0 | trial models + `typesafe/jev-1.14` (judge baseline only) | OpenGateway + `POST https://openrouter.ai/api/alpha/decisions` | `scripts/j0.mjs` |

- `lib/decision-routes.mjs` holds the allowlists. `resolveDecisionRoute` runs before any request is built. An id outside the surface returns `route_not_allowed` with zero transport and zero ledger rows; `tests/unit/decision.test.mjs` checks this with a fetch spy. The entries are parity-checked against `shared/lib/decision-contract.ts`.
- The plugin also carries the per-mode model constant (`plugin/src/core.ts`). A config that names a model is refused with `model_selection_forbidden`.
- `criteria` is always an object. `lib/questions.mjs` builds every body, and the J0 destructive class uses the installed `jev_check` shape: question name `check`, criteria `correct/incorrect/unsure` in installed order.
- `unnormalized_probabilities` is its own no-decision reason. The primary tolerance is `|Σp−1| > 1e-6`, the same check `decision-ask` and `shared/lib/decision-contract.ts` use. The `1e-3` bound is recorded as a sensitivity flag. Its cost and latency are always accounted, it never stops a stage, and it never invalidates a table. In the ensemble it makes the **whole ensemble abstain**.

## Cells

Each cell is a real `gjc --print --mode json` tool session (`read,bash,edit,write,find,search`) under a deny-all Seatbelt profile whose single allowed network host is the parent loopback proxy. The recipe is in `lib/cell.mjs` and descends from `self-improve/m1/native-pilot.mjs`.

- **Keys:** the child holds no provider key, only a per-cell placeholder token. Only the parent process reads `~/.gjc/agent/policy/secrets/opengateway-key.txt` (and, for J0 only, the OpenRouter key in `~/.gjc/agent/.env`). Values are never printed, logged or written.
- **Upstream:** the proxy (`lib/proxy.mjs`) forwards chat in mode B (`stream:false` + `usage:{include:true}`) and re-emits the answer as SSE.
- **Ledger and hard stop:** every request reserves before transport (`lib/accounting.mjs`). The global hard stop is US$4.00, inclusive. When it triggers, the proxy writes `stop.json` and refuses every route with zero upstream calls. The runner then kills the running cells, records them as `failed/global_stop`, and records the rest as `not_run`. A per-cell cap fails only that cell.
- **Scoring:** a separate arm-blind process (`scripts/score-cell.mjs`) scores each cell against the task's `oracle.mjs`. Oracles execute cell-written code, so the scorer runs under its own deny-all Seatbelt profile (`scorerProfile` in `lib/runner.mjs`): no network, reads limited to the runtime, the harness, the task and the cell, writes only inside the cell mount.

## Stages and commands

All runs use one run dir, for example `/tmp/jexp-<runId>`. Every paid step appends to `run-dir/ledger.jsonl`, so the stop is cumulative.

```sh
node self-improve/jev-checkpoint/scripts/s0.mjs --run-dir $RUN                     # S0 18 cells + 6 drills, S0b 12 cells ($0)
node self-improve/jev-checkpoint/scripts/prepare.mjs --run-dir $RUN --step readiness
node self-improve/jev-checkpoint/scripts/prepare.mjs --run-dir $RUN --step catalog
node self-improve/jev-checkpoint/scripts/prepare.mjs --run-dir $RUN --step l0      # ≤ $0.05, one real live cell + 2 decisions
node self-improve/jev-checkpoint/scripts/measure-w.mjs --out $RUN/w-intervals.json # owner-wait W from Linear (read-only)
node self-improve/jev-checkpoint/scripts/j0.mjs --run-dir $RUN --phase freeze|dev|test
node self-improve/jev-checkpoint/scripts/freeze.mjs --run-dir $RUN                 # manifest.json; refuses if projection > $3.40
node self-improve/jev-checkpoint/scripts/stage.mjs --stage S1 --run-dir $RUN       # 54 cells, ≤ 3 concurrent, re-projection after 2 cells/arm
node self-improve/jev-checkpoint/scripts/decide.mjs --run-dir $RUN --phase s1      # F5 winner → S2 admitted or not
node self-improve/jev-checkpoint/scripts/stage.mjs --stage S2 --run-dir $RUN       # 18 cells (only if admitted)
node self-improve/jev-checkpoint/scripts/decide.mjs --run-dir $RUN --phase fz      # Fz frozen before holdout
node self-improve/jev-checkpoint/scripts/stage.mjs --stage S3 --run-dir $RUN       # 36 holdout cells
node self-improve/jev-checkpoint/scripts/decide.mjs --run-dir $RUN --phase final   # analysis.json, arm-table.md, summary.json
node self-improve/jev-checkpoint/audit/ops-impact.mjs --run-dir $RUN --since <ISO> --out $RUN/ops-impact.json
node self-improve/jev-checkpoint/scripts/report.mjs --run-dir $RUN --out docs/plans/JJO-2329-jev-checkpoint/results
```

Each paid stage runs inside one finite tmux session (`jexp-s1`, `jexp-s2`, `jexp-s3`). The session holds at most three concurrent cells and is killed when its stage ends. There are no timers and no launchd jobs.

## Freeze and digests

`lib/digest.mjs` hashes `lib/`, `plugin/`, `fixtures/` and `scripts/`. `s0-pass.json`, `s0b-inertness.json` and `manifest.json` each record that digest, and every live stage refuses to run if the current tree differs (`harness_changed_since_freeze`). The analyzer and rule-table digests are checked in the same way.

`audit/` and `tests/` sit outside the digest because they never run inside a cell and never change a measurement.

## Verdict

`lib/analyze.mjs` implements the frozen F1–F6 rule table:

- the bootstrap is task-unit, 10k resamples, seed 20261114;
- the F3 mapping is fail-closed;
- `POWER_GATE = 'fail'`.

With holdout n=6, a one-sided sign test needs 6/6 tasks, and its power at q=0.8 is 0.262 (`lib/power.mjs`). So `adopted` cannot be reached in this design, and the verdict is either `rejected` or `insufficient → 현행 유지`. Default-on adoption and any `jev_check` model or policy change belong to owner decision blocks, not to this harness.

## Tests

`bun run test:jev-checkpoint` (`scripts/verify.mjs`) first runs the plugin bundle sync check, then runs every `tests/unit/*.test.mjs` file. A file that reports zero tests fails.
