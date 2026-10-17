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

**UI surface.** A batch with a non-empty summary draws one keyed widget (`jev-advisor`) above the editor with its per-task advisories. The widget is batch-scoped and event-driven: it clears when the launch receipt shows the call ended (sync/error/abort/block) or when the batch's observed children reach terminal closure (async batches), is replaced when a newer batch supersedes it, and is disposed by session transitions (`/new`, `/drop`, fork/session switch, restart — `/clear` keeps the session id and the widget). Lifecycle state is in-process only: not persisted, no task text, and a process restart simply degrades to replace-on-next-batch. Residuals are advisory-only: never-observed children keep the widget until the next batch or session transition, and a foreign terminal counted for never-listed children can clear early.

`shadow` is the source default; `hint` adds one bounded single-line notification (multi-line payloads are never emitted because a printed chat entry cannot be removed), and `enforce` keeps the same single-line warning shape.
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

| Provider | Endpoint | Default model | Key |
| --- | --- | --- | --- |
| `jev` | OpenRouter `/api/alpha/decisions` | `typesafe/jev-1.13` | OpenRouter |
| `openrouter` | OpenRouter `/api/v1/chat/completions` | `openai/gpt-5-mini` | OpenRouter |
| `typesafe-jev` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | TypeSafe |
| `ollaya` | `http://127.0.0.1:11435/v1/systemone` | `laya` | none |

Jev uses `state` plus typed `questions`, not chat completions. Provider/model
selection remains explicit. Egress permits only HTTPS `openrouter.ai` and
`api.typesafe.ai`, or loopback HTTP; redirects are rejected. OpenRouter alone
receives attribution headers (`HTTP-Referer` and `X-Title`).

## Configuration

Configuration lives outside the replaceable installation tree in
`~/.gjc/agent/jev-advisor/.env`. Process environment overrides same-named file
values; the merged `JEV_ADVISOR_API_KEY` takes priority over `OPENROUTER_API_KEY`.
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
| `JEV_ADVISOR_MODE` | `shadow` | `shadow`, `hint`, `enforce` |
| `JEV_ADVISOR_MIN_CONFIDENCE` | `0.6` | Per-task enforcement confidence gate |
| `JEV_ADVISOR_TIMEOUT_MS` | `8000` | Per-request timeout, also bounded by remaining hook budget |
| `JEV_ADVISOR_MIN_INTERVAL_MS` | `15000` | Pre-hook batch cooldown; zero disables cooldown |
| `JEV_ADVISOR_ENDPOINT` | per provider | Override subject to egress restrictions |
| `JEV_ADVISOR_MEMORY` | `on` | `off` disables hook correlation-state access/writes, not sanitized outcome journaling |
| `JEV_ADVISOR_MEMORY_MAX_KEYS` | `200` | Retained semantic groups, hard ceiling 200 |
| `JEV_ADVISOR_MEMORY_MAX_EVENTS` | `10` | Task records per group, hard ceiling 10 |

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
src/hook.adapter.ts         Per-task pre-call advice and optional enforcement
src/result.adapter.ts       Provider-free task/subagent receipt observer
src/tool.adapter.ts         Explicit advice and offline report
src/check.adapter.ts        Explicit one-shot artifact check
src/metrics.adapter.ts      Thin read-only plugin_metrics tool adapter
scripts/build.mjs           Keyless embedding of shared results, core and adapters
hooks/jev-advisor.ts         Generated pre-call surface
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

## Install

See the [repository README](../README.md#quick-start). Installation and activation are
separate operator actions, not part of building or offline verification:

```sh
gjc plugin install "$(pwd)" --user     # from jev-advisor/, fresh install
gjc plugin upgrade jev-advisor --user
gjc plugin list && gjc plugin doctor
```

Health labels alone do not prove terminal observation coverage or model routing.
