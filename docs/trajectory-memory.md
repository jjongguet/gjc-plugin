# Trajectory memory: from attempts to gated rules

Status: layer 1 implemented (`self-improve/lib/distill.mjs`). Tracking ticket: JJO-394.

The repository already stores exploration attempts (`rrsi`) and already gates
changes (`self-improve`). What it does not have is the layer that turns a
success/failure contrast into a reusable rule. This note fixes that contract
before any code exists.

## Layers

| Layer | Owner | State |
| --- | --- | --- |
| 0. Capture trajectories | `rrsi` store (`capture`, `import`; attempt shape) | implemented |
| 1. Distill contrastive rules | `self-improve/lib/distill.mjs` (`distill` command) | implemented |
| 2. Promote under gates | `self-improve` (guards, probes, ledger) | implemented |

Layer 1 produces candidates only. It never edits source, never writes to the
store, and never bypasses layer 2.

## Contract

Inputs, read-only:

- attempts from the `rrsi` store: `objective`, `decision`, `wallMs`,
  `guardFailures`, `budgetRung`, `files`, `hunks`, plus provenance ids;
- `self-improve/ledger.jsonl` rows (decision, verdict, guards that failed);
- optionally the jev-advisor journal projection already produced by `rrsi
  import`.

A candidate carries:

- `objective`: the existing probe id the rule is scoped to;
- `contrast`: one adopting attempt and one rejecting attempt on the same
  objective, with the single differing feature named;
- `rule`: one imperative sentence, scoped to that objective;
- `evidence`: attempt ids and the projection digest the contrast was drawn
  from;
- `expires`: a supersede condition (source hash or ledger epoch), not a
  wall-clock date alone.

The candidate is the input to a proposal, not a proposal itself. Patch
synthesis stays with the existing proposer seam (`loop --proposer cmd` or a
human), and admission runs through `cycle --dry-run` and the existing guard
set. There is no second evaluator and no second store schema.

## Command

```sh
node self-improve/scripts/run.mjs distill [--store <path>] [--ledger <path>]
  [--objective <id>] [--out <path>] [--json]
```

- Defaults: `~/.gjc-plugin/rrsi/store.json` and `self-improve/ledger.jsonl`.
- The store is read-only; a missing store is a normal first-run state and a
  corrupt or unsafe one exits 3 without repair.
- Objectives are processed in sorted order. Within an objective the first
  adopting and first rejected attempt are the contrast pair. A candidate is
  emitted only when `guardFailures`, `budgetRung`, or `hypothesisNovelty`
  separates them; cost-only and size-only differences are skipped.
- Output contains no clock value, so identical inputs produce byte-identical
  JSON. `expires.after` is the highest cycle `seq` read from the ledger.

## Non-goals

- weight updates, fine-tuning, or model routing changes;
- a consolidated enterprise/ontology store;
- replacing retrieval or removing RAG;
- new gate thresholds, a new frozen corpus, or weakening an existing guard.

## Failure modes the contract must encode

- **Error reproduction.** An abstraction persisted after a single success gets
  reused and re-derives the same mistake. Requiring a success/failure contrast,
  not one sample, is the minimum defence.
- **False applicability.** Similar-looking attempts are not applicable
  attempts. The match key is `objective` plus `guardFailures` class, not text
  similarity.
- **Staleness.** A rule outlives the code that justified it. Expiry is tied to
  the source hash or ledger epoch that produced the contrast.
- **Metric gaming.** The objective must be an existing probe. A new
  self-reported score is not admissible evidence.

## Verification

Offline and keyless.

- Unit (`tests/unit/distill.test.mjs`): candidate generation is deterministic and
  byte-identical across runs; missing adopt/reject, cost-only differences, and
  malformed stores are handled without synthesis or repair.
- CLI: `distill --json` and `distill --out` exit 0 with a parseable payload; a
  corrupt store exits 3. A read-only run over the real `~/.gjc-plugin/rrsi`
  store produced one candidate and 44 skips without writing either input.
- Not yet exercised: a candidate turned into a proposal patch and passed through
  `cycle --dry-run`. Until that runs, the adoption half of this contract is
  unproven; a rejection would be recorded as rejected, not repaired by loosening
  a guard.
- No change to `replay-protocol.json`, the frozen corpus, or the guard set.

## Evidence

- REM, arXiv 2610.27377: phase-structured consolidation of trajectories;
  reported 68.7% vs 55.6% match@1 and 27.6% vs 24.9% end-task at 17% lower cost.
- MemDev-Bench, arXiv 2610.27524: unrelated history increases failures; agents
  reuse memory without reassessing applicability; raw trajectories reduce
  steps relative to memory systems.
- More Memory, Worse Agents, arXiv 2610.27406: persisting abstractions
  reproduces errors; separate experience accumulation from abstraction
  persistence.

Numbers above are the sources' own reports, not measurements in this
repository.

## Decisions taken

- Distillation is a deterministic heuristic over `guardFailures` ->
  `budgetRung` -> `hypothesisNovelty`, not a contrast prompt. No model call is
  involved, which keeps the layer keyless and reproducible.
- All objectives are processed by default; `--objective` narrows to one.
- Candidates are emitted to stdout or `--out`; they are not stored. The
  proposer seam remains the only path that produces a patch.

Remaining open: which objective should be the first to run end to end, and
whether a candidate should become a `loop` request payload rather than an
operator-authored proposal.
