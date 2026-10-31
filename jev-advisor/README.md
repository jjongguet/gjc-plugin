# jev-advisor

[GJC](https://github.com/Yeachan-Heo/gajae-code) plugin for task-level
`fast` / `balanced` / `strong` delegation advice, one-shot `jev_check` artifact
checks and local execution metadata.
Advice is not model selection, process completion is not accepted code quality,
and confidence is not a probability of task success.

## Behavior

- **Before `task`:** ask separately for each eligible child. Normalize at most
  32 entries; dispatch at most four sequential requests within an eight-second
  batch budget. Later or invalid entries receive explicit no-decision reasons.
  Each prompt contains that child's role, description, assignment and shared
  context, without requested tiers, invocation IDs or previous results.
- **After `task`:** observe a launch receipt, not a completed delegation.
- **After `subagent`:** observe structured `completed`, `failed` or `cancelled`
  snapshots. Running, paused, queued, missing and unknown states are not terminal.
  Result hooks never call a provider, re-tier, or rewrite a tool result.
- **`jev_advise`:** explicitly request advice for one assignment/role, or use
  `report="calibration"` for an offline descriptive report. Manual advice does
  not create a delegation-correlation record; both paths append sanitized
  operational outcomes under `~/.gjc-plugin/jev-advisor/journal/v1/`.
- **`jev_check`:** explicitly request one bounded check of one artifact against
  one check question. The composed prompt (question plus artifact) is admitted
  under the same 4,000/1,900-character bound as tier prompts and is rejected
  whole, never sliced. A verdict must be `correct`, `incorrect` or `unsure`
  with a finite `[0,1]` confidence and optional three-label probabilities
  summing to one within `0.001`; anything else is an explicit no-decision.
  The outcome is journaled as a sanitized `check` operation — correlation
  state is untouched. A verdict is an advisory decision-model opinion, not
  verification evidence, correctness proof or acceptance of quality.
- **`plugin_metrics`:** explicitly request one offline descriptive aggregate of
  all three plugins' retained journals and Jev's retained v2 correlation state.
  Accepts exactly `{}`; strictly read-only — creates nothing, appends nothing,
  acquires no lock, performs no repair, loads no credentials and uses no
  network, and appends no journal record of its own. Missing sources are not
  zero and unmeasured values are null; descriptive monitoring only, never
  proof of routing accuracy, task quality or causal benefit. See the
  [`plugin_metrics` sections](#plugin_metrics-tool) below.

**UI surface.** A batch with a non-empty summary draws one keyed widget (`jev-advisor`) above the editor with its per-task advisories. The widget is batch-scoped and event-driven: it clears when the launch receipt shows the call ended (sync/error/abort/block) or when the batch's observed children reach terminal closure (async batches), is replaced when a newer batch supersedes it, and is disposed by session transitions (`/new`, `/drop`, fork/session switch, restart — `/clear` keeps the session id and the widget). For async batches, each child observed `completed`, `failed`, or `cancelled` removes its row immediately and redraws the widget with the remaining rows; removing the last row clears the widget and drops the lifecycle entry even before whole-batch closure. Jobs bind to rows only through structured launch progress (`index`/`id`) and subagent snapshot `id`/`label` values; an unknown job, unmappable observation, duplicate task label, or contradictory binding retains its row (retention is the safe default). Lifecycle state is in-process only: not persisted, no task text beyond the bounded rendered rows, and a process restart simply degrades to replace-on-next-batch. Residuals are advisory-only: never-observed or unmappable children keep their rows until the next batch or session transition, and a foreign terminal counted for never-listed children can satisfy the closure count early.

`JEV_ADVISOR_MODE=shadow` is the source default for tier advice; `hint` adds one bounded single-line notification (multi-line payloads are never emitted because a printed chat entry cannot be removed), and `enforce` keeps the same single-line warning shape.
`enforce` can block a whole task call only when an individual complete task has
an explicit requested tier weaker than its own recommendation and its confidence
meets the configured gate. Unknown, invalid, oversized or unavailable advice
cannot justify blocking. Neither mode rewrites input or chooses an actual model.
No routing settings are enabled by this plugin.

One pre-hook invocation reserves the cooldown before dispatch, including failed
requests. Cached complete advice is still evaluated for enforcement; a genuinely
rate-limited task has no new recommendation and fails open. Manual requests are
independent of this hook cooldown. Storage/provider errors fail open and are
reported as unavailable/no-decision, not successful observations.

## Hermes cron gate (scheduled-output boundary)

The repository also ships `integrations/hermes/jev-gate/`, a Python 3 stdlib
Hermes plugin that uses `transform_llm_output` to catch empty/abort/truncated
cron output before delivery. It applies the deterministic + strict check
contract to allowlisted jobs; a hold replaces the original with a metadata-only
notice (the job-channel alert), requests one detached `hermes cron run`
replacement, and stops at 3 generations / 15 minutes. Gate receipts live under
`~/.hermes/plugins/jev-gate-data/<profile>/` and are separate from
`plugin_metrics.checkAdvice`. The key is read only from
`~/.gjc/agent/jev-advisor/.env`; `~/.hermes/.env` is never read. Rollback is
`mode=off` or `hermes plugins disable jev-gate` plus a gateway reload. The gate
verdict is advisory, never verification evidence.

## Complete inputs and provider responses

Complete encoded prompts are bounded to **4,000 characters** for hosted Jev,
TypeSafe Jev and chat, and **1,900** for Ollaya's local constraint. These are plugin
admission budgets, not claims about maximum hosted model context. Inputs above
the applicable bound are rejected without a request; shared context is never
silently sliced away. Full semantic input is fingerprinted independently of
invocation IDs, requested tier and task order; fingerprints never join executions.

Confidence must be a finite number in `[0,1]`; missing, coerced or out-of-range
values are rejected. A supplied probability distribution must contain exactly the
three tiers, finite probabilities in `[0,1]`, and sum to one within `0.001`.
Validated distributions are retained unchanged; missing ones are not invented.
Chat requires final content, not a reasoning-only fallback. Provider errors,
invalid/partial responses, response overflow, timeout and cancellation yield
explicit no-decision. There are no retries or automatic provider fallbacks.

Systemone choice confidence and chat self-reported confidence have different
semantics. Neither is independent correctness evidence. Validate any enforcement
policy independently; a confidence threshold alone does not establish safety.

## Providers

| Provider | Endpoint | Default model | Key variable |
| --- | --- | --- | --- |
| `jev` | OpenRouter `/api/alpha/decisions` | `typesafe/jev-1.14` | `OPENROUTER_API_KEY` |
| `openrouter` | OpenRouter `/api/v1/chat/completions` | `openai/gpt-5-mini` | `OPENROUTER_API_KEY` |
| `typesafe-jev` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| `ollaya` | `http://127.0.0.1:11435/v1/systemone` | `laya` | none |

Jev uses `state` plus typed `questions`, not chat completions. Provider/model
selection remains explicit. Egress permits only HTTPS `openrouter.ai` and
`api.typesafe.ai`, or loopback HTTP; redirects are rejected. OpenRouter alone
receives attribution headers (`HTTP-Referer` and `X-Title`).

## Image evidence (`jev_check`)

Jev 1.14 reads images as well as text. `jev_check` takes an optional `images`
array of PNG/JPEG paths (absolute, or relative to the session directory) and
sends them as `state` image parts:
`["<artifact>", {"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}]`.
Admission is deterministic and happens before any provider call: at most 4
images, each 256–1,568 px per side and 78,400–2,458,624 px total, at most 16 MiB
decoded, PNG/JPEG signature sniffed (never the extension), animated PNG
rejected. A rejected set is never partially sent and yields
`no_decision`/`unsupported_input` or `input_too_large`. Image bytes and paths
never enter the journal, the store, a log or the tool result. Only the `jev`
provider has a verified inline image contract; other providers reject images.
An image-grounded request runs in TypeSafe's long-context mode (slower, less
accurate) and costs roughly 1,080 input tokens for one 512 px image.

## Configuration

Configuration lives outside the replaceable installation tree in
`~/.gjc/agent/jev-advisor/.env`. Process environment overrides same-named file
values. `JEV_ADVISOR_API_KEY` is an explicit override for any provider; without
it each provider reads only its own variable (`OPENROUTER_API_KEY` for `jev` and
`openrouter`, `TYPESAFE_API_KEY` for `typesafe-jev`). A provider never falls back
to another provider's credential, so a missing key surfaces as `unconfigured`
rather than as a 401 from the wrong service.
No key and no keyless provider means zero hook network calls or correlation-state writes.
`JEV_ADVISOR_PROVIDER=off` disables provider advice and correlation writes; local
outcome journaling still records disabled/unconfigured operations. An explicit offline report still works.

```sh
mkdir -p ~/.gjc/agent/jev-advisor
printf 'OPENROUTER_API_KEY=sk-or-v1-...\n' >> ~/.gjc/agent/jev-advisor/.env
chmod 600 ~/.gjc/agent/jev-advisor/.env
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEV_ADVISOR_PROVIDER` | `jev` | `jev`, `openrouter`, `typesafe-jev`, `ollaya`, `off` |
| `JEV_ADVISOR_MODEL` | per provider | Advisor model, not delegated execution model |
| `JEV_ADVISOR_MODE` | `shadow` | `shadow`, `hint`, `enforce` (tier advice only) |
| `JEV_ADVISOR_MIN_CONFIDENCE` | `0.6` | Per-task enforcement confidence gate |
| `JEV_ADVISOR_TIMEOUT_MS` | `8000` | Per-request timeout, also bounded by remaining hook budget |
| `JEV_ADVISOR_MIN_INTERVAL_MS` | `15000` | Pre-hook batch cooldown; zero disables cooldown |
| `JEV_ADVISOR_ENDPOINT` | per provider | Override subject to egress restrictions |
| `JEV_ADVISOR_MEMORY` | `on` | `off` disables hook correlation-state access/writes, not sanitized outcome journaling |
| `JEV_ADVISOR_MEMORY_MAX_KEYS` | `200` | Retained semantic groups, hard ceiling 200 |
| `JEV_ADVISOR_MEMORY_MAX_EVENTS` | `10` | Task records per group, hard ceiling 10 |
| `JEV_ALIGNMENT_MODE` | `shadow` | `off`, `shadow`, `deterministic` for the goal-alignment hook; unrelated to `JEV_ADVISOR_MODE` |

`JEV_ADVISOR_MEMORY_HEAD_CHARS` is no longer used: v2 stores no assignment heads.
Existing configuration and legacy memory are not changed or migrated.
`JEV_ADVISOR_STATE` is retired: a nonempty value is ignored with
`state_override_ignored`, never recorded or followed. Production result paths
always resolve beneath `~/.gjc-plugin/`; the credential path is unchanged.

## Private versioned evidence

The correlation store is `~/.gjc-plugin/jev-advisor/state.v2.json`. Old `.gjc`
state is never read, rewritten, moved or silently converted. Existing legacy
data remains untouched and is not counted as new-root evidence.

- Task records use exact `(sessionId, toolCallId, taskIndex)` identity. Terminal
  records use `(sessionId, jobId)`; a resumed job is a different execution.
- Only a valid **original singleton** task launch with an explicit job ID and no
  scheduling failures can join to a terminal observation. A batch with one valid
  child after filtering is still a batch. Multi-child mappings are not inferred
  from text, caller IDs, array positions or fingerprints.
- Repeated inspect/list/await observations enrich one retained job, including
  terminal-before-launch delivery. Missing correlation stays unjoined. Missing
  session/job identity cannot be counted as a distinct retained execution.
- Requested tier, advisor recommendation, requested model, observed effective
  model and terminal status remain separate. Actual tier is host-supplied only;
  when the host does not expose it, it remains unknown. Task quality remains
  unknown. Contradictory observations are flagged, not overwritten into a
  success story. Conflicted measurements are excluded from their aggregates.
- The report separates `batchMapped` (batch-level coverage; currently 0 because
  the plugin does not infer per-child mappings) from `exactJoin` (singleton exact
  task/job joins), reports `actualTier` known/unknown/byTier with conflicted jobs
  excluded, and includes a bounded `byEffectiveModel` status/duration table
  (observational, not causal).
- The store contains bounded metadata, fingerprints and validated advice, not
  assignment/context/result prose, rationale, provider payloads or credentials.
  Retention and eviction limit deduplication to the retained window.

Updates acquire a private exclusive lock, load the latest state, synchronously
mutate it and atomically rename a unique `0600` temporary file. No network await
holds a transaction or a stale state snapshot. Lock waiting is bounded to 100 ms;
foreign or abandoned locks are never stolen. Corrupt, unsupported, oversized or
unsafe stores remain unavailable rather than being reset. Recovery requires an
explicit operator decision; do not delete memory just to silence an error.

The job table is bounded by the effective task budget (at most 2,000 jobs), and
the serialized store by 2 MiB. Zero retention keeps no records. New plugin-owned
directories use `0700`; unrelated existing parents are not chmodded. Memory off,
store failure, missing identity and eviction limit persistent replay suppression.

The independent outcome journal records manual advice/calibration and bounded
hook/result outcomes, including no-decision and known storage failures. Only
allowlisted status/reason, digest, tier/score/probability and persistence metadata
is retained; assignment/context/result prose, provider rationale and keys are
excluded. Files are single-link owned `0600`, directories owned `0700`;
symlink ancestors and unsafe existing permissions are refused, not repaired.
Each record is at most 4 KiB, each segment 1 MiB, with eight retained segments.
Rotation retires only marker-bound validated closed segments, never legacy data
or immutable verification receipts. `journalStorage` reports confirmed append,
rotation and retained-segment counts independently of advice. Disk, busy or
corrupt-store failure is visible and cannot guarantee durable recording.

## Offline report

```text
jev_advise report="calibration"
```

The existing parameter is retained, but output is **descriptive retained-window
coverage**, not an accuracy or savings benchmark. It separates advice/no-decision,
launch visibility, blocked calls, exact joins, unjoined terminals, conflicts,
process statuses and observed/unknown effective model coverage. It reports
requested-vs-recommended agreement only for individual records with both values.
Agreement is not correctness or evidence that a recommended model actually ran.
The report is network-free and does not modify correlation state, but appends
one sanitized calibration-lookup journal outcome.

Duration means use only positive, nonconflicted observed durations: a 12-second
job plus an unknown-duration job has a 12-second mean over one measured job.
All-missing means unknown, not zero. Unobserved terminals and missing-identity
observations are outside report coverage. No automatic NEXT recommendation,
prior-outcome prompt injection, accepted-quality or cost-saving claim is made.

## `plugin_metrics` tool
The plugin also ships the explicitly invoked `plugin_metrics` tool. It is
strictly read-only: it accepts exactly `{}` (any other parameter set is rejected
without touching any store) and aggregates only what is already on disk:

- the retained `~/.gjc-plugin/<plugin>/journal/v1/` outcome journals of
  `jev-advisor`, `verification-receipts` and `ui-regression`, and
- Jev's retained v2 correlation state (`state.v2.json`).

The tool creates nothing, appends nothing, acquires no lock, performs no repair
and never calls a provider. It also never loads credentials and never touches
the network: it reads the three journals and the v2 state directly from
`~/.gjc-plugin/`, returning a single bounded JSON envelope.

## What `plugin_metrics` reports

The envelope is a **descriptive retained-window summary**, not a guarantee, and
not a coverage measurement. Its content is bounded to what each plugin actually
wrote to disk:

- **Retained record counts and operation frequencies** per source journal —
  how many records of each operation kind are present in the retained segments.
- **Separate run and status invocation buckets** for the verification and UI
  plugins, with the same shape (execution/assessment/freshness/storage counts,
  field-present denominators, recorded durations). Status records never
  contribute to run-duration aggregates: a status copy inherits the original
  receipt's duration but is excluded from run-side duration statistics.
- **Execution, assessment, freshness and receipt-storage distributions** with
  field-present denominators: a rate is only computed over records that
  actually carry the relevant field.
- **Verification native test counts** (pass/fail/skip/TODO etc.) and **UI
  recorded assertion entries** (assertion kind, outcome, count). These are
  *recorded observations*, overlapping dimensions across records — not
  coverage, not correctness, and not a substitute for reading the underlying
  receipts.
- **Jev manual advice, task advice and check outcomes**: manual-advice
  invocations, present statuses, tiers, confidence bases and no-decision
  reasons; task-advice batch and entry counts with the same breakdowns; and
  check invocations broken down by status, verdict, confidence basis and
  no-decision reason. These are separate buckets and are never merged.
- **Evidence-observation sightings** per operation (task launch, subagent
  terminal, advice, calibration) — how many retained records report each
  observation kind.
- **Canonical correlation via `calibrationSummary`**: unique session+job
  terminal jobs, agreement between requested and recommended tier, and
  duration statistics. Agreement is a descriptive match rate, not
  correctness and not proof a recommended tier was honored at the model
  layer.

## Measured intervals

The report uses only exactly defined intervals:

- Verification and UI run receipt duration spans the run entry through
  post-execution/after-fingerprint only. It excludes receipt storage, the
  Jev adequacy call, and the journal write.
- Status records copy the original receipt's duration verbatim and never
  contribute to run duration aggregates.
- Jev `task_advice` duration spans hook entry through pre-journal finish only.
  It is not per-provider latency and never claims to be.
- Correlation state durations are positive, non-conflicted stored values only.
- No cross-instrument totals are produced: durations from one journal are
  never summed with durations from another.

## Missing sources, nulls and denominators

The tool is deliberately conservative about absence:

- A missing journal or store is reported as `missing`, never as zero.
- Unmeasured values are `null`, never invented.
- A duration with `measured = 0` yields `null` sum and average; a rate over a
  zero denominator is `null`; native counts and assertion aggregates with no
  count-bearing samples are `null`. Genuine zeros remain numeric.
- Correlation state reports independent snapshot windows; the journal and the
  correlation store are independent snapshots and are never reconciled.

## Scope limits

Coverage is bounded by what each plugin actually retained:

- **All retained observed rows only.** Rotation, eviction and the bounded
  store mean there are no lifetime totals.
- **Failed writes are invisible.** A record that was never successfully
  journaled cannot be counted, so the report can't produce a recording
  reliability rate.
- **No time or repository filters.** The report reads the whole retained
  window in the current process home; you cannot narrow it to a time range or
  a specific repository through the tool parameters.
- **Historical producer version and smoke-vs-real workload are
  unidentifiable.** A record written by an older plugin version, a smoke test,
  or real usage looks identical and cannot be distinguished after the fact.

## Non-causal statement

The tool is **descriptive monitoring only**. It never claims quality,
accuracy, routing correctness, cost or token usage, overhead, provider or
assessment latency, or causal ROI. It does not imply that a recommended tier
actually ran, and it does not measure cost, accuracy or causal benefit.
Causal evaluation of delegation policy requires a separate controlled
comparison, not this report.

## Architecture and verification
```text
lib/decision.ts             Config, task inputs, providers, v2 transactions/report
lib/alignment.ts            Goal-alignment authority, ordered rules, recovery transitions, journal caps
src/hook.adapter.ts         Per-task pre-call advice and optional enforcement
src/alignment.adapter.ts    Write-class gate, mode resolution, degraded retry counters
src/alignment-observe.adapter.ts    Result binding, criterion observation, completion
src/alignment-shutdown.adapter.ts   Idempotent flush of unresolved recoveries
src/result.adapter.ts       Provider-free task/subagent receipt observer
src/tool.adapter.ts         Explicit advice and offline report
src/check.adapter.ts        Explicit one-shot artifact check
src/metrics.adapter.ts      Thin read-only plugin_metrics tool adapter
scripts/build.mjs           Keyless embedding of shared results, core and adapters
hooks/jev-advisor.ts         Generated pre-call surface
hooks/jev-advisor-alignment.ts         Generated alignment before-tool surface
hooks/jev-advisor-alignment-observe.ts Generated alignment result surface
hooks/jev-advisor-alignment-shutdown.ts Generated alignment session-shutdown surface
hooks/jev-advisor-result.ts  Generated result surface, two manifest targets
tools/jev-advise.ts          Generated explicit-tool surface
tools/jev-check.ts           Generated explicit check surface
tools/plugin-metrics.ts      Generated read-only metrics surface
```

Installed surfaces are self-contained because the installer copies only
manifest-declared files. Edit core/adapters, never generated outputs by hand.
The surfaces share disk transactions, not an in-memory evidence cache.

```sh
bun scripts/build.mjs
bun scripts/verify.ts
```

The verifier starts an isolated child with fresh HOME/environment/cwd before
product imports. It uses synthetic credentials, temporary state and scripted
in-memory fetch only: no real provider, local-model server or user memory.
It exercises actual generated adapters, strict parsing, mixed/oversized tasks,
throttle/enforce boundaries, terminal identity/replays/conflicts, concurrent
writes, legacy preservation, unavailable stores and report denominators. It
compares all four generated files byte-for-byte against the unchanged builder
run in a temporary fixture, including a deliberately stale candidate.

These checks establish local package behavior, not installed-host dispatch,
real-provider conformance or actual task efficacy. The manifest declares legacy
before-task and after-task/after-subagent hooks. Public host source exposes scoped
session identity and structured terminal snapshots; unavailable runtime fields
remain unknown. The plugin does not scrape private histories or install itself.

## Consumers

- The **rrsi** plugin's due-gated `session_start` refresh replays this journal
  (read-only) through the bundled Dream-RSI core into its private store and run
  receipts under `~/.gjc-plugin/rrsi/`; the journal is never modified.
- `plugin_metrics` aggregates this plugin's retained journal and the v2
  correlation state strictly read-only. During a live append window a read can
  transiently report `store_corrupt`; the store is fail-closed and never
  repaired automatically.

## Goal alignment (write-class authority boundary)

`lib/alignment.ts` plus `src/alignment{,-observe,-shutdown}.adapter.ts` add a
deterministic, keyless surface over the session's own user entries: it makes no
provider call, reads no credential or configuration file, and is independent of
tier advice. The full boundary, including the rejected alternatives, is
[ADR 0002](../docs/adr/0002-goal-alignment-authority-boundary.md).

- **Modes** (`JEV_ALIGNMENT_MODE`, resolved per tool call). `shadow` is the
default and the fallback for an unset or unrecognised value: it evaluates and
journals but never blocks, so a would-be block is still recorded. `deterministic`
may block the three drift rules; it is explicit opt-in for dogfood and
end-to-end checks, not a default. `off` is a kill switch: no evaluation, no
journal, no block. `JEV_ADVISOR_MODE` (`shadow` / `hint` / `enforce`) belongs to
tier advice and is never read by this path — the two switches are unrelated.
- **Semantic enforcement is not implemented.** There is no model-based
alignment mode and no semantic setting; the layer is deterministic only.
- **Rule ids** (`evaluateAction`, first match wins):

| Rule id | Verdict | Coverage | Blocks |
| --- | --- | --- | --- |
| `drift_write_vs_readonly` | drift | evaluated | yes |
| `drift_write_forbidden_target` | drift | evaluated | yes |
| `drift_write_after_stop` | drift | evaluated | yes |
| `aligned_write_within_requested_scope` | aligned | evaluated | no (stage-2 admissible) |
| `uncertain_authority_ambiguous` | uncertain | coverage_gap | no |
| `read_allow` | allow | evaluated | no |
| `bash_observe` | allow | coverage_gap | no |
| `unknown_authority` | uncertain | coverage_gap | no |

- **Authority.** Only host session user entries are authority. Assistant turns,
tool output, todo lists and subagent output are data, never authority; a branch
with no user entry yields no authority, which is uncertain and never a block.
Recognised constraints are read-only, stop and a do-not-touch target; only an
explicit release clears them. Hedged release wording is recorded but not
applied, and a plain "continue" never clears read-only.
- **Targets and criteria.** Targets are only explicit machine-shaped tokens
(backticked paths, slash paths, filenames with a known extension); free prose
never becomes one. A completion criterion is declared in the user entry as
`criterion=exit_zero`, `criterion=artifact_exists:<path>` or
`criterion=criterion_file:<path>`.
- **Recovery.** correction → admission → observation → completion, all journaled
as typed transitions. `recovered` requires the declared criterion's
`false|unknown → true` transition; a missing criterion, a baseline that was
already true, or a tool-call id that does not match ends as
`recovery_unverified` instead. The result observer never rewrites a tool result
and never blocks.
- **Coverage limits.** Reads and bash are never evaluated: a bash call is
observe-only and reports `coverage_gap`, so a mutation performed inside bash is
not classified, blocked or journaled. An answer-only turn produces no
evaluation at all, an action that is already running is not re-evaluated, an
unknown tool name is not evaluated, only a single-target write can reach the
recovery chain, and work inside a subagent is covered only insofar as its tool
calls reach this surface with a readable session branch. An ambiguous write is
allowed and reported as `coverage_gap` rather than guessed at, and a truncated
authority window (older user entries left unscanned) is `coverage_gap` too
— never labelled `evaluated`, never aligned and never blocked.
- **Journal.** `~/.gjc-plugin/jev-advisor/alignment/v1/<sessionDigest>/events.jsonl`
with one rotated predecessor `events.1.jsonl`; `<sessionDigest>` is the first 16
hex characters of the session-id digest, or `default` when the session id is
unreadable. Directories `0700`, files `0600`. Caps: 200 records, 2048 bytes per
record, 256 KiB total, two segments, seven-day retention (plus 60 s future-skew
tolerance). Records carry digests, ids and typed statuses only — never raw user
text — and an over-cap record is dropped rather than truncated. The journal is
best effort: a storage failure can neither create nor suppress a block, and
retry counters fall back to bounded in-process state. Every read and append
goes through one shared store (`lib/alignment-journal.ts`) bounded by
`JEV_ALIGNMENT_STORE_TIMEOUT_MS` (default 100 ms), so a hung filesystem
degrades to degraded storage instead of delaying a tool call. The
session-shutdown surface flushes one record per still-unresolved recovery,
idempotently.

### Rebuild, install and rollback order

```sh
bun scripts/build.mjs          # regenerate all surfaces, including the three alignment hooks
bun scripts/build.mjs --check  # non-mutating drift gate
bun scripts/verify.ts          # isolated acceptance suite, including the alignment cases
```

Install and activation are separate operator actions. Reinstall in this order:

```sh
gjc plugin uninstall jev-advisor --user    # an installed plugin is refused, so replace it
gjc plugin install "$(pwd)" --user         # 1. jev-advisor first
gjc plugin uninstall verification-receipts --user && gjc plugin install <verification-receipts-path> --user  # 2. second
# 3. then the remaining plugins
```

`jev-advisor` goes first and `verification-receipts` second because an older
`jev-advisor` reading journal records written by a newer
`verification-receipts` fails closed with `store_corrupt`; the repository
[install order](../CONTRIBUTING.md#install-order-and-replacement) owns that rule.
Hooks and tools load at session start, so a rebuild or reinstall only takes
effect in a **new** `gjc` process — restart the session before judging the
surface.

Rollback is local and immediate: `JEV_ALIGNMENT_MODE=off` disables evaluation,
journaling and blocking without uninstalling, and `gjc plugin uninstall
jev-advisor --user` removes the surfaces. Existing alignment journal files are
left in place until an operator removes them.

## Install

See the [repository README](../README.md#quick-start). Installation and activation are
separate operator actions, not part of building or offline verification:

```sh
# 1. Plugin surface (jev_advise, jev_check, plugin_metrics)
gjc plugin install "$(pwd)" --user     # from jev-advisor/, fresh install
gjc plugin upgrade jev-advisor --user
gjc plugin list && gjc plugin doctor

# 2. Loose skill payload (bundles cannot register top-level skills)
mkdir -p ~/.gjc/agent/skills/jev-advisor
cp jev-advisor/subskills/jev-advisor/SKILL.md ~/.gjc/agent/skills/jev-advisor/SKILL.md
```

Health labels alone do not prove terminal observation coverage or model routing.
