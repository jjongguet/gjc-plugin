# Harness² M1 — guard ablation and bounded native pilot

`run-m1.mjs` measures **the same planted defect against two guard sets** and emits
a numeric matrix. This is a reproducible, keyless guard measurement, separate
from the native model pilot described below.

`run-preflight.mjs` produces **no empirical model result**: it plans
the pilot cells and budget, resolves oracles and prompts, probes the sandbox and
attaches the loading receipt, then reports every blocker. It is dry-run by
default and answers `--live` with one of five stable codes: `live_not_approved`
(skip, exit 0) plus four refusals (`live_approval_invalid`,
`live_cap_exceeds_declared`, `live_approval_without_live`,
`live_executor_absent`, exit 2). This planning CLI does not dispatch requests.
The separately gated execution entry point is `run-pilot.mjs`.

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

`outputDigest` is the sha256 of a step's captured output with the cell's random
temporary root replaced by `<cell>`, so the digest identifies the captured
behaviour rather than the temp path and is stable across runs at the same source
head.

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
bun rrsi/scripts/rrsi-cli.mjs dream --full
```

`--full` prints the per-policy numbers behind the ranking ids (same store, same
seed; refuses to print when the receipt hash differs from the journaled call).

## What this does not prove

Arm differences here are **guard coverage**, not agent behaviour. Every step is a
local keyless command: no model call, no network, no credentials, no spend. The
result is not a `gjc.quality_trial.v2` receipt — `self-improve/lib/behavior-eval.mjs`
validates admitted paid trials, and a $0 deterministic guard run is not one — and
no accuracy, routing or efficiency claim follows from it. Even the bounded
real-provider pilot below reports **efficacy NOT ASSESSED**.

## One-case native pilot

`pilot-subset.json` pins the declared development task
`decision-probability-boundary-dev10`, its public input, independent oracle,
historical provenance, candidate rule and implementation source. A changed pin
is rejected; it is not silently regenerated at execution time. The existing
manifest retains the other class/split metadata. Holdout payloads are not pilot
inputs.

| Arm | Attempts per cell | Candidate rule | Feedback and selection |
| --- | --- | --- | --- |
| B0 | 1 | absent | scoped tool-free native baseline |
| B1 | 3 | absent | independent same-input attempts |
| B2 | 3 | native `RULES.md` | immediately preceding public output and schema errors only |

All arms select the **lowest-index schema-valid** response; none valid means a
failed cell. The hidden oracle is consulted after selection, never during
refinement. Three repeats give **9 cells / 21 attempt slots**. Each attempt
starts with fresh owned native state: `--no-session` alone is not a guarantee
that runtime metadata cannot carry over.

The native child uses the installed GJC binary under the exact tested Seatbelt
profile and environment. Read grants cover runtime libraries and owned input
state, not the writable macOS Data-volume aliases of private files. The sole
network grant is the owned IPv4 TCP proxy port. The parent alone holds upstream
credentials. Full request, rule content, loader segment and bundle digests have
separate meanings.

### Keyless checks

```sh
node self-improve/m1/probe-native.mjs --out /tmp/native-probe.json
node self-improve/m1/run-pilot.mjs --out /tmp/native-pilot-dry
node self-improve/m1/run-preflight.mjs --dry-run \
  --manifest self-improve/tests/fixtures/pilot/manifest.json \
  --subset self-improve/m1/pilot-subset.json \
  --budget self-improve/m1/budget.example.json --json
```

Use new output paths; existing evidence is not overwritten. These commands
use a scripted loopback endpoint, not a paid model. Dry trial candidates remain
excluded by the unchanged canonical quality validator (`missing_cost`); their
scripted answers are not efficacy evidence. The generic budget example is for
planning only, not paid authorization.

### Real-provider entry

```sh
node self-improve/m1/run-pilot.mjs --live --approve-live 1 \
  --out /tmp/native-pilot-live \
  --budget /private/path/task-budget.json \
  --pricing /private/path/current-pricing.json \
  --native-proof /private/path/native-probe.json \
  --shared-delivery /private/path/mini-delivery.json
```

`OPENROUTER_API_KEY` must already be available to the parent; it is never passed
to the native child. The four evidence documents are not interchangeable:

- **Budget:** `capUsd:1`, `taskCapUsd:5`, `maxCalls:21`; reconciled
  `priorSpentUsd`, `priorReservedUsd`, `priorUnresolvedUsd`, `cleanupUsd`,
  `accountingStatus` and `accountingEvidenceDigest`. Prior pilot calls, spend,
  reservations and unresolved charges must be known (`priorPilotCalls`,
  `priorPilotSpentUsd`, `priorPilotReservedUsd`, `priorPilotUnresolvedUsd`).
  This fresh-run executor rejects an already-started pilot rather than reset
  its caps. Unknown amounts must not be entered as zero.
- **Pricing:** observation time, exact model/provider and endpoint source,
  conservative `inputPrice` and `outputPrice` in USD/token. An observation older
  than 24 hours is refused. Native UI cost estimates are not accounting.
- **Native proof:** a successful current-source `probe-native.mjs` result,
  including real rule inclusion/exclusion and positive/negative kernel probes.
- **MINI delivery:** verified first shared delivery, main SHA/tag, installed
  surface digest and a genuinely new real-user session's projection digest and
  coverage. A topic push or isolated test HOME is not this evidence.

The complete admission contract is implemented in
[`pilot-protocol.mjs`](pilot-protocol.mjs). Operator declarations still require
the underlying receipts; constructing a JSON object is not verification.

Ceilings are 3,000 composed input tokens, 300 output tokens, 90 seconds per
cell, 40 minutes per pilot, US$1 per pilot and US$5 for the whole task. B1/B2
share the same total three-request cell budget. There is no truncation, retry,
cap reset or automatic policy promotion. Reservations are durably written
before forwarding. Deadlines, child disconnect and shutdown abort and join
upstream handlers; uncertain charges stay reserved rather than become zero.

Outputs are `frozen.json`, `events.jsonl`, **all 21** rows in `attempts.jsonl`,
**all 9** candidates in `receipts.jsonl`, and `report.json`. Errors, skipped
slots, exclusions and duplicate counts remain visible. The report applies the
existing quality validator/cohort unchanged. Real-provider execution tests
feasibility only; it does not establish a benefit over B0/B1.
