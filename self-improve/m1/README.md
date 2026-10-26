# Harness² M1 — cost-0 guard ablation

`run-m1.mjs` measures **the same planted defect against two guard sets** and emits
a numeric matrix. It exists because the paid Harness² pilot (JJO-270) is blocked
on budget and an isolation runtime; this runner produces a real, reproducible
measurement today without spending anything, and it is the only M1 surface that
is allowed to produce numbers.

## What a cell is

One task × one arm. Each cell gets

- a fresh `git archive <sourceHead>` snapshot of `rrsi/`, `shared/`,
  `self-improve/` and `package.json` — the working tree never leaks in;
- one planted defect (or nothing, for the clean control);
- its own `HOME`, `TMPDIR`, `XDG_*` inside a temporary root, with
  `RRSI_PERIODIC=off`, so the real store and journal are untouched.

## Frozen arms and tasks

| arm | plan | what it is |
| --- | --- | --- |
| `B0` | `bun rrsi/scripts/build.mjs --check` | drift-only guard |
| `B1` | `B0` + `bun rrsi/scripts/verify.ts` | drift + full acceptance suite |

| task | planted defect | oracle |
| --- | --- | --- |
| `generated-surface-drift` | append a comment to the generated `rrsi/tools/rrsi.ts` | non-zero exit + `generated_out_of_sync` in output |
| `manifest-tool-path` | point `rrsi/gajae-plugin.json` `tools[0].path` at a missing file | non-zero exit + `tools/rrsi.ts` referenced in output |
| `clean-control` | none | every step exits 0 |

## Metrics

`wallMs` (whole plan), `toolCalls` (guard commands executed — one command is one
tool call for a tool-less planner), `retries` (frozen at 0, the plan is
deterministic and runs once), `artifactBytes` (captured stdout+stderr), and a
rubric `score`:

- **5** defect located / control stayed clean
- **3** defect caught without the locate marker
- **0** defect missed, control false positive, or timeout / spawn error

A timeout, spawn failure or unplantable defect is `outcome: error`, score 0, kept
in the denominator. Nothing is retried, dropped or substituted.

## Run

```sh
node self-improve/m1/run-m1.mjs --head HEAD --out artifacts/harness2-rrsi-20261027
node --test self-improve/tests/unit/m1-guard-ablation.test.mjs
```

Outputs: `m1-result.json` (`harness2.m1.result.v1`), `m1-summary.md` (same table
as stdout) and `rrsi-attempts.json`. Feed the attempts to the store with

```sh
bun rrsi/scripts/rrsi-cli.mjs capture --goal "harness2-m1:<runId>" \
  --attempts-file artifacts/harness2-rrsi-20261027/rrsi-attempts.json
bun rrsi/scripts/rrsi-cli.mjs import --ledger self-improve/ledger.jsonl
bun rrsi/scripts/rrsi-cli.mjs dream
```

## What this does not prove

Arm differences here are **guard coverage**, not agent behaviour. Every step is a
local keyless command: no model call, no network, no credentials, no spend. The
result is not a `gjc.quality_trial.v2` receipt — `self-improve/lib/behavior-eval.mjs`
validates admitted paid trials, and a $0 deterministic guard run is not one — and
no accuracy, routing or efficiency claim follows from it. The paid M1 pilot still
has to run before any sentence about harness efficacy is allowed.
