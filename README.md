# gjc-plugin

Plugins for [gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`). Each subdirectory with a `gajae-plugin.json` is independently installable. Generated runtime surfaces embed their sources and do not require installed sibling packages.

| Plugin | Purpose |
| --- | --- |
| [`jev-advisor`](jev-advisor/) | Task-scoped `fast` / `balanced` / `strong` advice, bounded delegation correlation and an offline descriptive report. Shadow by default; advice is not model routing or quality proof. |
| [`verification-receipts`](verification-receipts/) | Explicit JavaScript `node:test` execution, native counts, immutable private receipts, source freshness, deterministic post-delegation verification gates and the `verification_loop` recheck tool. |
| [`ui-regression`](ui-regression/) | One bounded, non-sensitive loopback Aside scenario with literal DOM assertions and historical metadata receipts. No screenshot baselines. |
| [`wiki`](wiki/) | Read-only personal-wiki lookup and pending-proposal submission (capture + propose). Never approves or publishes; human approval of the exact digest stays outside the plugin. |
| [`rea`](rea/) | Offline readiness report (`rea_readiness`) and the pinned GJC workflow skill payload for [REA](https://github.com/morluto/rea) (rea-agents 6.4.0). The integration runs the pinned CLI (`npx -y rea-agents@6.4.0 <command>`); an optional `gjc mcp add` registration exists for stateful MCP sessions — GJC 0.18.5 refuses plugin-bundle stdio MCP servers off Linux, so no manifest `mcps` surface is declared. |
| [`backplan`](backplan/) | Planning gate that fires when execution-bound work arrives: `backplan_check` validates a structured plan (end state, success criteria, issue breakdown, Linear project mapping, policy decisions, automation candidates) and renders Linear-ready payloads plus a stable digest. Deterministic, keyless and offline; registration stays with the agent's Linear MCP / `linear-trace.py` path. |
| [`rrsi`](rrsi/) | GJC exploration-trace store and Dream-RSI replay surface (`rrsi` tool: capture/import/dream/status). Instrument only: the plugin carries functional acceptance; the performance proof (P1–P3) applies to the `self-improve` loop and its frozen corpus. Keyless and offline; private store under `~/.gjc-plugin/rrsi/`. See [`rrsi/README.md`](rrsi/README.md). |
| [`aside-memory`](aside-memory/) | Explicit account-bound Aside memory search (`aside_memory`), returning bounded historical quotations and relative citations. No automatic injection, source-file reads, writes, journal or extra model calls. |
| `plugin_metrics` (in `jev-advisor`) | Read-only offline aggregate of all three plugins' retained journals and Jev's retained v2 correlation state. See [Plugin metrics](#plugin-metrics). |

## Install and configure

Use a local plugin directory or a published source containing that plugin with GJC's plugin installer. From this checkout:

```sh
gjc plugin install ./jev-advisor --user
gjc plugin install ./verification-receipts --user
gjc plugin install ./ui-regression --user
gjc plugin install ./wiki --user
gjc plugin install ./rea --user
gjc plugin install ./backplan --user
gjc plugin install ./rrsi --user
gjc plugin install ./aside-memory --user
gjc plugin list && gjc plugin doctor
```

An existing installation requires the supported replacement/upgrade operation; inspect `gjc plugin install --help` and the recorded source before replacing it. Rebuilding source alone does not update a running GJC session. Verify upgraded surfaces in a fresh GJC process.

Credentials remain outside the replaceable installation tree in `~/.gjc/agent/jev-advisor/.env`, or process environment. `JEV_ADVISOR_API_KEY` takes priority over `OPENROUTER_API_KEY`; process values override same-named file values. Never put credentials in source or result records. See [Jev configuration](jev-advisor/README.md#configuration).

### Aside memory

Use the existing owner-controlled `aside` executable on PATH. Call `aside_memory`
explicitly with a non-sensitive task query and a canonical numeric account
(`u` prefix optional, at most ten digits), for example the **synthetic** input
`{"query":"response preferences","account":"u42","max_results":3}`.
Omitting `account` consults only owner-set `GJC_ASIDE_MEMORY_ACCOUNT`; missing or
invalid routing never falls back to the active profile. Invalid explicit input
never falls back to configuration. `max_results` is 1–5; the query is trimmed,
1–300 Unicode scalar values and at most 1200 UTF-8 bytes, without controls,
formatting characters or leading option syntax.

Each invocation captures one account and performs only native `memory path`
then `memory search --max-results N --json QUERY`, explicitly routing both calls.
A shared 30-second deadline bounds root lookup (5 seconds) and search (25 seconds).
Stdout caps are 8192/65536 bytes; stderr is discarded and capped at 4096 bytes.
Timeout or overflow kills only the owned direct child; cleanup uncertainty is
reported, not a claim of backend cancellation. No list/show expansion or direct
memory-file access occurs. Lexical relative-path validation does not attest
symlinks, and the two calls are not an atomic snapshot.

The single JSON text response distinguishes `ok`, validated `empty`, `withheld`,
`unavailable` and `error`. Safe ordinary USER prose (e.g. “I prefer concise answers
with examples.”) and plain structured context can survive the same whole-block
screen; mixed sensitive/override blocks are withheld. At most two complete
600-byte blocks per result, five results and 16384 serialized response bytes are
returned. Excerpts are quotations, never active instructions or inferred facts.
Source ranges describe CLI matches, not exact snippet coordinates. Relevance is
not truth; host `retrievedAt` is not authenticated observation time. File-update
and original-observation times remain unknown (`null`).

Finite English/Korean screening cannot guarantee removal of all credentials,
PII or prompt injection; relative paths can also reveal sensitive context.
Nothing authorizes acting on historical text. The plugin makes no offline,
PII-free or end-to-end no-logging claim: Aside network/retention is unknown,
query/account argv are visible to local process observers, and GJC/provider
transcripts may retain returned excerpts. It creates no cache, logs or journal.
Rollback disables only this plugin and its integration, not memory/profile data.

Verification uses mandatory hermetic synthetic fixtures, never real memory,
auth or network clients: `bun aside-memory/scripts/build.mjs`,
`bun aside-memory/scripts/verify.ts`, and
`bun aside-memory/scripts/build.mjs --check`. Source/generated dispatch tests
do not prove user-installed fresh-runtime discovery or native Aside retrieval;
verify installation separately in a fresh session with an isolated fake CLI.

## Private results

All plugin-owned result/state writes use **`~/.gjc-plugin/`**, not `~/.gjc/`. GJC still owns installed code under `~/.gjc/agent/gjc-plugins/`, and the credential file above is unchanged.

| Path beneath `~/.gjc-plugin/` | Contents |
| --- | --- |
| `jev-advisor/state.v2.json` | Bounded metadata-only task/launch/terminal correlation |
| `verification-receipts/receipts/v1/<repository-digest>/<receipt-id>.json` | Shared immutable verification/UI storage envelopes: public receipt and private selected-input binding |
| `verification-receipts/loop/v1/<repository-digest>/<session-digest>.json` | Per-session delegation-gate state (baselines, pending async launches, gates and resolutions). Writer-owned: a session only ever writes its own file and read-merges at most 16 other session files |
| `<plugin>/journal/v1/` | Sanitized handled-outcome records, including run/status/manual/advice/observation failures and assessment/storage results |
| `ui-regression/locks/` | Private owned browser-run coordination lock |

Directories are owned `0700`; files are owned single-link regular `0600`. Symlinks, unsafe owners/modes, hard links and corrupt/unknown inventory fail closed without permission repair, lock stealing or legacy fallback. `JEV_ADVISOR_STATE` no longer controls the result path; a supplied value is ignored and reported as `state_override_ignored`. It is never recorded.

Existing `.gjc` results remain untouched: no automatic migration, deletion or lookup. Old receipt IDs are unavailable in the new store. Uninstalling/upgrading code does not erase results. Archive or remove history only through an explicit user-owned operation after checking ownership and stopping writers.

### What is recorded

Every handled invocation attempts exactly one journal record after its known assessment/storage results. Jev batch advice records up to32 normalized task indices, tiers, confidence semantics and no-decision reasons in one bounded record; per-task `basis` retains the normalized advice's `confidenceKind` without rounding scores. Result observers record terminal-status and storage-transaction counts in one record. Full validated probabilities remain in manual advice records and eligible correlation state. Disabled/unconfigured providers still produce local operational records; calibration remains network-free and correlation-read-only, but now journals the lookup.

Records contain only allowlisted enums/reason codes, timestamps/durations, digests/UUID references, native counts, assertion kinds/outcomes, validated tier/score/probability fields and storage metadata. They contain **no** assignment/context/rationale prose, raw logs/source/stacks, credentials, account routing, snapshots, URLs, selectors or fill/expected values. Selected test locators exist only in the private bound storage envelope and are omitted from returned receipts, journals and provider requests.

Responses separate observed execution, adequacy assessment, receipt/evidence storage and `journalStorage`. A failed write never changes an actual test result. `persisted:false` means recording is not confirmed; disk failure cannot guarantee a durable error record. Status never reruns tests or opens a browser.

### Retention and capacity

Immutable receipt admission is bounded to **200 receipts / 2 MiB per repository / 32 KiB per complete envelope**. `count`, `bytes` and `nearCapacity` are returned when measurable; warning starts at 180 receipts or 90% bytes. `store_full` preserves history and does not advertise a rejected receipt as durable. The independent outcome journal can continue recording while receipts are full.

Each plugin journal has **4 KiB records, 1 MiB segments and eight retained segments**, with a 100 ms lock-wait bound. Marker-bound rotation retires only validated owned closed segments. `rotated` and `retainedSegments` describe the retention boundary; indefinite history is not promised. Unknown files or interrupted/corrupt publication are not adopted or repaired automatically.

## Verification tools

`verification_run` accepts explicit repository-relative `.js` / `.mjs` / `.cjs` files (1–32), not globs, arbitrary commands or alternate runners. Inspect test effects first: test code is not sandboxed. Native pass/fail/skip/TODO/cancellation counts are execution evidence, not assertion counts or coverage proof. Empty and skipped-only files cannot establish successful testing.

Freshness covers normal Git-visible source **and the safely validated explicit selected test inputs, including ignored files**. A private receipt/repository/spec-bound input manifest lets status hash those same bytes. Missing, unsafe, sensitive/cache-excluded or unhashable inputs make freshness unavailable; they are never silently omitted. Dependency caches and excluded credentials are not covered.

`ui_regression_run` requires explicit ephemeral account routing, one exact loopback origin, a first `goto`, and at least one assertion. It supports unique visible current CSS targets, non-sensitive text fields and explicit `button[type="button"]`. Inspect handlers: loopback and post-action origin checks do not sandbox redirects, popups or network effects. One scenario uses one Aside REPL invocation and closes only its owned tab. Timeouts, cancellation, malformed/partial observations or unconfirmed cleanup cannot pass.

Text matching preserves case and internal whitespace, normalizing only line endings and surrounding whitespace. **Normalized-empty substring expectations are rejected**; exact-empty assertions and empty fills remain meaningful supported cases. UI status explicitly reports `currentUiState:"not_reobserved"` and `browserBuildBinding:"unverified"`; historical success is not current/deployed UI evidence.

Both verification/UI tools automatically attempt warning-only Jev adequacy via the fixed OpenRouter decision endpoint when configured. Only validated supplied semantic summaries/notes and bounded host facts leave. Omitted context, stale/missing/nonpassing evidence, unscored/low-confidence results and transport failure do not establish sufficient verification. No automatic repairs are added. The delegation verification gate below is a requirement appended to a completed result, never a hard block, and `verification_loop` only rechecks its own private gate ledger.

## Delegation verification loop

After a delegated `task` batch completes visibly (sync completion, a race-completed async envelope, or a terminal `job`/`subagent` observation), the plugin appends a bounded `[delegation-verification-gate]` block to that tool result: machine facts (changed files, commits, tree state, binding evidence, newest receipt), a required `verification_loop` recheck and a judgment-only sweep checklist. Backgrounded launches that are still `running` record a pending marker instead and are gated when their terminal observation arrives; the same job id never produces two gates across `job` and `subagent` polling. Failures, aborts and errors are never gated.

`verification_loop` (no parameters, ≤15s budget, no network) recomputes the ledger for the current repository: open gates from this and earlier sessions, covering-receipt evaluation (`verification-receipts` receipts only, recomputed freshness, passed status, changed test files included in the run's selected inputs), and honest gap kinds. `status:"clean"` is a mechanical recheck, not proof of correctness or coverage; unreadable state reports `blocked` instead of silently clean. `silentPending` is an upper-bound proxy for launches without an observed terminal (it may include still-running or cancelled jobs), not a count of missed gates; `scanTruncated` marks bounded cross-session scans.

The gate hook is fail-open and bounded: the before-hook baseline capture shares a single 3s wall-clock budget and never blocks or throws; the after-hook appends text within its isolated execution and leaves the original result untouched on any failure. If the private state write is dropped (lock timeout or budget), the requirement text is still appended and the drop is journaled (`stateWrite:"drop"`). Gates and loop runs journal `gate_emitted` and `loop_run` counts under `~/.gjc-plugin/verification-receipts/journal/v1/`.

Hooks load at session start: after installing or upgrading this plugin, only a **new** GJC session has the gate and `verification_loop` available.

## Plugin metrics

`plugin_metrics` (shipped with [`jev-advisor`](jev-advisor/)) is an explicitly invoked, strictly read-only reporting tool that aggregates all three plugins' retained operational records into one bounded JSON envelope. It accepts exactly `{}` — no user paths, filters or config.

It reads the retained `~/.gjc-plugin/` journals of `jev-advisor`, `verification-receipts` and `ui-regression`, plus Jev's retained v2 correlation state. It never writes, locks or repairs anything, never loads credentials, never touches the network, and appends no journal record of its own.

What it reports: per-source retained-record counts and operation frequencies; separate run vs. status invocation buckets; execution, assessment, freshness, receipt-storage distributions with field-present denominators; native test counts (recorded observations — overlapping dimensions, not coverage); recorded UI assertion entries; Jev manual advice vs. task-advice batch/entry counts; evidence-observation sightings; and canonical correlation via `calibrationSummary` (unique session+job terminal jobs, agreement as requested/recommended tier match — not correctness).

Measured intervals are exact and bounded: a verification/UI run receipt's duration spans the run entry through post-execution/after-fingerprint only — it excludes receipt storage, adequacy call and journal write. A status record copies the old receipt's duration and never contributes to run duration aggregates. Jev `task_advice` duration spans hook entry through pre-journal finish, not per-provider latency. State durations include only positive, non-conflicted stored values. No cross-instrument totals exist.

Missing sources are not zero. Unmeasured values are `null`. Duration sums and averages with no measured samples, zero-denominator rates, and native counts/assertions with no contributing samples are `null`. A recorded zero-duration sample remains numeric zero. All data is from retained observed rows only: rotation and eviction mean no lifetime totals, failed writes are invisible, and no recording-reliability rate exists. There are no time or repository filters. Historical producer version and smoke-vs-real workload are unidentifiable.

This tool is descriptive monitoring only. It never claims quality, accuracy, routing-correctness, cost/token, overhead, provider/assessment latency or causal ROI. Causal evaluation requires a separate controlled comparison.

## Self-improvement loop (`self-improve/`)

[`self-improve/`](self-improve/) is a repo-native harness self-improvement loop over this repository's own plugin surfaces (regularized recursive self-improvement, inspired by the RRSI design). It edits only declared `editable` sources, scores candidates with the repository's deterministic checkers plus declared probes, and records every decision in a committed append-only ledger. Regularizations beyond the documented set are explicitly out of scope (partial regularization). Candidates run in `git archive` scratch copies with an allowlisted environment; the live `~/.gjc/agent` is never modified. The loop is keyless and never reads credentials. See [`self-improve/README.md`](self-improve/README.md) and [`self-improve/PATTERNS.md`](self-improve/PATTERNS.md).

## Develop and verify

```sh
bun run build
bun run test
node verification-receipts/scripts/smoke-host.mjs --metrics
node verification-receipts/scripts/smoke-host.mjs --installed
node verification-receipts/scripts/smoke-host.mjs --installed --advisor
node jev-advisor/scripts/smoke-results.mjs
UI_REGRESSION_ACCOUNT=<explicit-routing> node verification-receipts/scripts/smoke-host.mjs --installed --ui
```

Builds are keyless. Verification/UI builders support `--check`; Jev's suite compares all generated surfaces to its canonical builder. Offline tests use disposable repositories/homes and synthetic or disabled transport. Host smoke copies installed bundles into a private isolated GJC root and uses only a loopback provider; it does not mutate user configuration. Jev result smoke imports installed hooks in a fresh isolated process and exercises bounded synthetic task/launch/terminal events: it proves hook/storage consumption, not a real child delegation or task quality. Browser smoke requires an actually connected Aside profile and inspected owned loopback handlers. Report source tests, installed dispatch, browser observations and real-provider judgment separately.

## Add a plugin

Declare every installed surface in its manifest, keep generated surfaces keyless, add the distribution-index entry and table row, and reuse the shared private result primitives when persistence is required. Transient wrappers such as aside-memory intentionally do not journal private payloads. Do not serialize arbitrary tool output as evidence.

## Workspace standard

The repo uses `standard.json`, profile `plugin-ts`, root `.`. `gjc-plugin.json` is a distribution index; each plugin manifest remains its version source of truth and is bumped only at an explicitly requested release.

- **Dashboard** (`dashboard/`): local meta only until Supabase connection; no push-envelope.
- **Validator**: local-only `npm run validate` inside `dashboard/`; not part of `vercel-build` because hosting lacks the canonical workspace-standard checkout.
- **Manual workflow** (`steps.json`): record, verify, human review. No timer execution.

## Related

- [gajae-code](https://github.com/Yeachan-Heo/gajae-code)
