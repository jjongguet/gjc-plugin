# rrsi

GJC exploration-trace store and Dream-RSI replay surface. The plugin captures
exploration episodes, projects real journals into attempt records and replays
them through the same deterministic replay/dreaming core the repository's
`self-improve` loop uses — as an instrument, not as a model upgrade.

**Scope (functional acceptance only).** rrsi captures exploration episodes,
projects journals into attempt records and replays them through the bundled
Dream-RSI core. The performance proof (P1–P3) applies to the `self-improve` loop
and its frozen corpus, not to this plugin; no accuracy, savings, routing or
causal claim is made. Dream receipts are off-policy replays over whatever the
store contains and are reported with the same pinned caveat as the loop.

## Tool surface

One explicitly invoked tool — `rrsi` — with four actions. **No hook
registrations**; the plugin never runs on its own.

| Action | Parameter | What it does |
| --- | --- | --- |
| `capture` | `goal`, `attempts` (JSON array string) | Stores one bounded episode: goal plus attempts with features/outcome (`objective`, `hypothesisNovelty`, `decision`, `wallMs`, `guardFailures`, `budgetRung`, `files`, `hunks`). |
| `import` | `ledgerPath?`, `limit?` | Read-only projection of the jev-advisor journal (`~/.gjc-plugin/jev-advisor/journal/v1/*.jsonl`) and, when a path is given, of a `self-improve/ledger.jsonl`. Sources are never modified; malformed lines are skipped, never repaired. |
| `dream` | `seed?` | Runs the bundled deterministic replay/dreaming core over the store: 40 candidate policies ranked on the train slice, thresholds evaluated on the validation slice, plus the pinned no-significance caveat. |
| `status` | — | Store counts (episodes/attempts/adoptions), storage state and the journal location. |

Every handled invocation appends exactly one sanitized `rrsi` outcome to the
shared plugin journal (`~/.gjc-plugin/rrsi/journal/v1/`, retained-window
counts only — no goals, attempt payloads or credentials). Keyless and offline:
no network path, no credentials, no model calls, no timers.

## Storage

`~/.gjc-plugin/rrsi/store.json` — private `0700` directory, `0600` single-link
file, written atomically (temp + rename). Bounded: 128 episodes, 40 attempts per
episode, 512 KiB store, 4 MiB source reads, 40-char identifiers, 280-char text
fields. Absent, corrupt, symlinked or oversized stores are **reported** as
`missing` / `invalid` and never reset or repaired; the store is never committed
to the repository.

## Projection schema

| Source | → Store attempt |
| --- | --- |
| jev-advisor journal record | branch `objective` = `<operation>:<tier or advice status>`; `hypothesisNovelty` = first record of that branch in read order; `decision` = `adopt` when the record carries a decision, else `reject`; `wallMs` = `durationMs`; `provenance` = the journal record id |
| `self-improve/ledger.jsonl` cycle row | `objective` = `probe.*`; `decision` from the recorded verdict; `wallMs` = recorded cost; `guardFailures` = non-passing guard ids; `provenance` = the cycle id |

The plan's journal-projection fields (`source`, `goal`, `features`, `outcome`)
are flattened onto the replay core's attempt shape so the same simulator runs
over both sources; the mapping above is the exact contract.

## Bundling decision (M5)

`scripts/build.mjs` inlines the shared journaling core
(`../shared/lib/results.ts`) and the Dream-RSI core
(`../self-improve/lib/{types,ledger,replay,dream,policy}.mjs`) into the single
generated surface `tools/rrsi.ts`, like the sibling plugins inline their cores.
Local imports are stripped (every local binding is declared earlier in the same
bundle), identical builtin import statements are de-duplicated, and the
self-improve modules are plain Node ESM so they transpile unchanged. The plan's
recorded fallback (vendoring the modules as separate files) was **not needed**:
the generated file is self-contained and needs no runtime file resolution
outside the plugin.

## Build and verify

```sh
bun rrsi/scripts/build.mjs     # regenerate tools/rrsi.ts (keyless)
bun rrsi/scripts/verify.ts     # hermetic acceptance suite (isolated HOME)
bun test rrsi/tests/real-journal.test.ts   # capture -> import -> dream over >=10 real journal attempts
```

The verifier uses a temporary isolated `HOME`; the real `~/.gjc-plugin/rrsi`
store is never touched. The real-journal test reads the jev-advisor journal
read-only (990 records measured on 2026-10-13) and copies a bounded slice into
the isolated home, so the round trip runs over real attempts with a hermetic
store. If the real journal is unavailable the verifier records the measured
count (null/0) instead of substituting synthetic data.
