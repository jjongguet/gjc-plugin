# rrsi

GJC exploration-trace store and Dream-RSI replay surface. The plugin captures
exploration episodes, projects real journals into attempt records and replays
them through the same deterministic replay/dreaming core the repository's
`self-improve` loop uses — as an instrument, not as a model upgrade. A single
due-gated `session_start` hook keeps the store refreshed; there is no timer
process and no wall-clock scheduler.

**Scope (functional acceptance only).** rrsi captures exploration episodes,
projects journals into attempt records and replays them through the bundled
Dream-RSI core. The performance proof (P1–P3) applies to the `self-improve` loop
and its frozen corpus, not to this plugin; no accuracy, savings, routing or
causal claim is made. Dream receipts are off-policy replays over whatever the
store contains and are reported with the same pinned caveat as the loop.

## Tool surface

One explicitly invoked tool — `rrsi` — with four actions, plus one
`session_start` hook (`hooks/rrsi-periodic.ts`) that performs the due-gated
periodic refresh described below.

| Action | Parameter | What it does |
| --- | --- | --- |
| `capture` | `goal`, `attempts` (JSON array string) | Stores one bounded episode: goal plus attempts with features/outcome (`objective`, `hypothesisNovelty`, `decision`, `wallMs`, `guardFailures`, `budgetRung`, `files`, `hunks`). Serialized by the shared store lock. |
| `import` | `ledgerPath?`, `limit?` | Read-only projection of the jev-advisor journal (`~/.gjc-plugin/jev-advisor/journal/v1/*.jsonl`) and, when a path is given, of a `self-improve/ledger.jsonl`. One slot per source class: the derived episode set is replaced as a whole (`ep-jev-<digest12>-<n>` / `ep-ledger-<digest12>-<n>`); byte-identical content skips the write. The response carries `storeWrite` (`added` / `replaced` / `unchanged`), `projectionDigest` and `projection` (`records` / `projected` / `omitted` / `ratio` / `limited`), and `wrote: { persisted:false, reason:"store_busy" }` when the store lock is contended. Sources are never modified; malformed lines are skipped, never repaired. |
| `dream` | `seed?` | Runs the bundled deterministic replay/dreaming core over the store: 40 candidate policies ranked on the train slice, thresholds evaluated on the validation slice, plus the pinned no-significance caveat. |
| _other_ | — | Rejected as a tool error (`isError: true`) with `error: "unknown action: <value>"`; the store is read, never written. |
| `status` | — | Store counts (episodes/attempts/adoptions, where `adoptions` counts attempts whose `decision` is `adopt`, including projected advice records), storage state, the journal location, and a bounded periodic summary (`lastAttemptAt`, `lastSuccessAt`, `lastStatus`, `lastReason`, `nextRetryAt`, `lastProjection`, `due`, `receiptCount`, `intervalMs`). Read-only. |

Every handled invocation appends exactly one sanitized `rrsi` outcome to the
shared plugin journal (`~/.gjc-plugin/rrsi/journal/v1/`, retained-window
counts only — no goals, attempt payloads or credentials). Keyless and offline:
no network path, no credentials, no model calls, no timer process.

## Periodic refresh (`session_start`)

The hook is the plugin's only automatic invocation: a due-gated staleness check
executed on GJC's own session lifecycle — never a wall-clock scheduler. Idle
periods without sessions do not refresh, and `launchd`/`cron`-style scheduling
is out of scope and unprovided.

- **Trigger and interval.** Every fresh GJC session (interactive, print/SDK,
  task) runs one bounded attempt. The default interval is 24 h;
  `RRSI_PERIODIC_INTERVAL_MS` (milliseconds, ≥ 60 000) overrides it; values
  below the floor fall back to the 24 h default and values above 30 days are
  clamped.
  `RRSI_PERIODIC=off` disables the refresh without consuming the interval.
- **Bounded work (one slot per source).** The hook reads the jev-advisor
  journal, projects the newest `limit = 160` records into one content-keyed
  derived episode (`ep-jev-<digest12>-0`; a larger configured limit chunks at
  160 attempts per episode with the same digest rules) and replaces that source
  class as a whole; byte-identical content skips the write entirely. It then
  dreams over the store. Dream cost grows super-linearly with corpus size
  (measured at implementation time: 40 attempts ≈ 59 ms; 160 ≈ 0.8 s; 480 ≈
  18.6 s), so corpora above 160 attempts are completed by a detached worker
  (`RRSI_PERIODIC_WORKER=1 bun hooks/rrsi-periodic.ts`, spawned by the hook,
  re-running under the same locks) instead of inside the session.
- **Coverage labels.** The periodic receipt carries `projection`
  `{records, projected, omitted, ratio, limited}`, `limited_projection` and
  `incomplete_prefix`; omitted records are labeled in the periodic receipt,
  never silently dropped by that path; `import` returns journal coverage as `projection`.
  The same projection is stored as `lastProjection` for
  `rrsi status`.
- **State, receipts, retention.** `~/.gjc-plugin/rrsi/periodic.json`
  (schema `gjc.rrsi.periodic.v1`, 0600 in the 0700 root) records
  `lastAttemptAt`, `lastSuccessAt`, `lastStatus`, `lastReason`, `nextRetryAt`,
  `consecutiveFailures`, `lastReceiptId`, `lastProjectionDigest`, `storeWrite`,
  `derivedChunks`, `incomplete_prefix` and `intervalMs`. Run receipts live in
  `~/.gjc-plugin/rrsi/runs/v1/<receiptId>.json` (schema
  `gjc.rrsi.periodic.run.v1`, ≤ 64 KiB each, ≤ 60 retained, oldest pruned on
  write). Each executed run — including `no_input` and error outcomes —
  appends exactly one sanitized `dream` record to
  `~/.gjc-plugin/rrsi/journal/v1/`; `skipped_due` / `skipped_locked` /
  `skipped_disabled` write nothing.
- **Outcome taxonomy.** `ran` (store written: `added`/`replaced`) ·
  `unchanged` (due run, byte-identical content, no write) · `deferred` (large
  corpus handed to the detached worker) · `no_input` (journal missing/empty;
  state `lastStatus: "empty"`, next attempt at the interval) · `skipped_due`
  (interval or backoff) · `skipped_locked` · `skipped_disabled` · `error`
  (bounded reason; failures set a binding `nextRetryAt = now + backoff` — a
  15 min base, doubling per consecutive failure, capped at the interval — and a
  dream failure is recorded as an `error` receipt/state, never a masked
  success). Success runs re-arm `nextRetryAt` to `lastSuccessAt + interval`,
  and the due gate treats `nextRetryAt` as the schedule (falling back to the
  interval only when it is absent); `clockSkew` and `lockTakeover` are recorded
  in state and receipts when they occur.
- **Deferred handoffs.** When the corpus exceeds the inline dream budget the
  hook writes the import, a handoff state (`lastStatus: "deferred"`) and a
  handoff receipt (`status: "deferred"`), then spawns the detached worker; the
  worker re-runs under the same locks and writes its own receipt, the single
  `dream` journal record and the success stamps. A failed spawn is recorded as
  `worker_spawn_failed` (bounded — no crash) and writes no handoff receipt.
- **Failure isolation.** A broken run never blocks or fails a session: every
  failure is a bounded result recorded in state (plus one journal record);
  corrupt/oversized stores are reported and never reset or repaired; a
  `resource_limit` or `store_unavailable` write keeps the store untouched and
  records an error receipt with `persisted: false`; a lock older than
  2 × 12 s may be taken over once. Stored future timestamps beyond 5 minutes
  are clamped for the due decision (`clockSkew`).
- **Rollback.** Set `RRSI_PERIODIC=off` (immediate, no uninstall), disable the
  hook surface if the loader supports per-surface disable, or
  `gjc plugin uninstall rrsi --user` — state, receipts and the store are
  preserved.

## Storage

`~/.gjc-plugin/rrsi/store.json` — private `0700` directory, `0600` single-link
file, written atomically (temp + rename). Bounded: 128 episodes, 160 attempts per
episode, 512 KiB store, 4 MiB source reads, 64-char identifiers, 40-char labels,
280-char text fields. Absent, corrupt, symlinked or oversized stores are **reported** as
`missing` / `invalid` and never reset or repaired; the store is never committed
to the repository. The periodic state (`periodic.json`), its exclusive locks
(`periodic.lock`, `store.lock`) and run receipts (`runs/v1/`) live under the
same root with the same ownership/mode rules.

## Projection schema

| Source | → Store attempt |
| --- | --- |
| jev-advisor journal record | advice entries = the record's `taskAdvice[]` batch when it carries entries, else the older single `advice`/`assessment` field; representative entry = the first real decision, else the first entry. Branch `objective` = `<operation>:<tier or advice status>` of that entry; `hypothesisNovelty` = first record of that branch in read order; `decision` = `adopt` when the representative entry is a decision, else `reject`; `wallMs` = `durationMs`; `provenance` = the journal record id |
| `self-improve/ledger.jsonl` cycle row | `objective` = `probe.*`; `decision` from the recorded verdict; `wallMs` = recorded cost; `guardFailures` = non-passing guard ids; `provenance` = the cycle id |

The plan's journal-projection fields (`source`, `goal`, `features`, `outcome`)
are flattened onto the replay core's attempt shape so the same simulator runs
over both sources; the mapping above is the exact contract. Derived episodes
carry a content-keyed identity (`projectionDigest` over the bounded attempt
array and the applied limit; ids `ep-jev-<digest12>-<n>` /
`ep-ledger-<digest12>-<n>`, `createdAt: derived:<digest12>`): identical content
yields a byte-identical set, and the whole source class is replaced — previous
derived chunks and any legacy clock-seeded `jev-journal` episode from earlier
manual imports are superseded together. User `capture` episodes are never
selected by the filter.

## Bundling decision (M5)

`scripts/build.mjs` emits two self-contained surfaces, exactly like the sibling
plugins: `tools/rrsi.ts` (the tool) and `hooks/rrsi-periodic.ts` (the
`session_start` hook, which doubles as the detached worker CLI). Both inline the
shared journaling core (`../shared/lib/results.ts`) and the Dream-RSI core
(`../self-improve/lib/{types,ledger,replay,dream,policy}.mjs`); local imports
are stripped, identical builtin import statements are de-duplicated, and the
self-improve modules are plain Node ESM so they transpile unchanged. The
installer copies only manifest-declared files, so the generated hook must not
resolve anything outside itself — it doesn't. `--check` provides a non-mutating
drift gate.

## Build and verify

```sh
bun rrsi/scripts/build.mjs            # regenerate tools/rrsi.ts + hooks/rrsi-periodic.ts (keyless)
bun rrsi/scripts/build.mjs --check    # non-mutating drift gate (generated_out_of_sync:<path> on drift)
bun rrsi/scripts/verify.ts            # hermetic acceptance suite (isolated HOME; includes the periodic cases)
bun test rrsi/tests/real-journal.test.ts          # capture -> import -> dream and one periodic cycle over real journal attempts
node --test rrsi/tests/periodic.test.mjs          # receipt-bearing node:test harness (delegates to bun)
```

The verifier uses a temporary isolated `HOME`; the real `~/.gjc-plugin/rrsi`
store is never touched. The real-journal test reads the jev-advisor journal
read-only and copies a bounded slice into the isolated home, so the round trip
and the periodic cycle run over real attempts with a hermetic store. If the
real journal is unavailable the verifier records the measured count (null/0)
instead of substituting synthetic data. `.ts`/bun suites are local gates;
`rrsi/tests/periodic.test.mjs` is the node-native file eligible for
`verification_run`.

## Quality trial contract (`gjc.quality_trial.v2`)

The journal projection above records that an advice answer was returned, which
is availability telemetry. Quality evidence is a separate contract:
`self-improve/lib/quality-trial.mjs` is the single canonical implementation,
`rrsi/lib/rrsi.ts` imports `projectQualityTrialCohort`, `QUALITY_TRIAL_SCHEMA`
and `QUALITY_COHORT_SCHEMA` from it and only re-exports them, and
`scripts/build.mjs` lists that file in `inlineModules` so both generated
surfaces inline it and stay self-contained. The boundary and its rejected
alternatives are [ADR 0003](../docs/adr/0003-quality-trial-evidence-boundary.md).

**Trial record.** `gjc.quality_trial.v2` requires `trialId`, `taskId`,
`taskVersion`, `split` (`training` / `development` / `holdout`), `arm` (`B0` /
`B1` / `B2`), `repeat`, `goalRevision`, `producer` (id, kind), `executor` (id,
`receiptId`, `receiptDigest`), `harness` (`sourceDigest`, `harnessDigest`,
`manifestDigest`, `version`), `oracle` (kind, `verifierId`, `evidenceDigest`,
`independentFromProducer`), `outcome` (`passed` / `failed`), `denominator`
(`planned`, `passed`, `failed`, `error`, `skipped`), a measured `cost`
(`wallMs`, `inputTokens`, `outputTokens`, `usd`, `zeroCostRationale` when all
four are zero), `createdAt`, `sourceHead` and an `executionKey` that re-derives
from `(taskId, taskVersion, arm, repeat, harnessDigest, oracle evidenceDigest,
goalRevision)`. Independence is a relationship: the named verifier must differ
from both producer and executor and must carry its own evidence digest, so a
bare `independentFromProducer: true` is never enough.

**Exclusion codes.** Every inspected record lands in exactly one bucket, so
the funnel is visible as counts:

| Code | Meaning |
| --- | --- |
| `legacy_schema` | Not a v2 payload: wrong schema, malformed/missing required field, or an `executionKey` that does not re-derive |
| `conflicting_duplicate` | Same execution cell as an admitted trial with a different payload |
| `non_independent_producer` | `producer.id === executor.id` |
| `non_independent_oracle` | Bare independence flag, unnamed verifier, verifier equal to producer/executor, or missing kind/evidence digest |
| `unknown_outcome` | Outcome is not `passed` or `failed` |
| `negative_cost` | Any measured cost component is negative |
| `missing_cost` | Cost unmeasured, a non-finite component, or an all-zero measurement without `zeroCostRationale` |
| `denominator_mismatch` | `planned < 1`, `planned !== passed + failed + error + skipped`, or an outcome that disagrees with its counters |

**Counts-only cohort.** `projectQualityCohort(records, { limit })` returns
`{ schema: "rrsi.quality_cohort.v2", total, admissible[], excluded[{ reason,
count }], duplicate }`. Admissible rows carry counts, ids and digests only
(provenance, objective, taskVersion, split, arm, repeat, executionKey,
decision, wallMs, usd, costMeasured, sourceDigest, harnessDigest) — no rate,
delta or verdict — and there is no `efficacyClaimsAllowed` field, asserted by
`tests/quality-cohort.test.ts`. Byte-identical repeats collapse into
`duplicate` and count once; a genuine re-run is a separate cell only through
`repeat`. The cohort is a library export exercised by the tests: the `rrsi`
tool's four actions (`capture`, `import`, `dream`, `status`) do not return it.

**`taskAdvice[]` projection.** One journal record is one attempt. The advice
entries a record carries are its compact `taskAdvice[]` batch (one entry per
delegated task) when that batch holds any entry; otherwise the older single
`advice`/`assessment` object is used, and no entry is invented when neither
exists. The representative entry is the first real decision, else the first
entry; the branch objective is `<operation>:<tier|status>` of that entry,
`decision` is `adopt` only when it is a decision, and the rest count as
`reject`. `projectJournalRecords` also returns `scanned` (records inspected)
and `truncated` (a prefix cut).

**`incomplete_prefix` freshness rule.** `truncated: true` means the attempt
bound was reached while newer records were still unread, so the projection and
its digest cover only the head of the journal. The periodic run records
`incomplete_prefix: true` on its receipt, state and `finish` result, does
**not** renew `lastSuccessAt`, and — when the run is not already a dream
failure — schedules the next attempt at one backoff step
(`backoffMs(1, intervalMs)`) instead of the full interval. A prefix projection
therefore never counts as freshness evidence.

**What this does not prove.** Counts and digests are contract evidence, not
efficacy evidence: no trial receipts are committed, no comparison has been run,
and no accuracy, calibration or improvement claim follows from this surface.
The frozen Harness² pilot in
[`self-improve/HARNESS2.md`](../self-improve/HARNESS2.md) must run before any
efficacy claim.
