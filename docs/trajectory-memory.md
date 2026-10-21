# Trajectory memory: from attempts to gated rules

Status: proposal. Not implemented. Tracking ticket: JJO-394.

The repository already stores exploration attempts (`rrsi`) and already gates
changes (`self-improve`). What it does not have is the layer that turns a
success/failure contrast into a reusable rule. This note fixes that contract
before any code exists.

## Layers

| Layer | Owner | State |
| --- | --- | --- |
| 0. Capture trajectories | `rrsi` store (`capture`, `import`; attempt shape) | implemented |
| 1. Distill contrastive rules | this note | **missing** |
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

Output shape is a `self-improve` proposal: `hypothesis` (why the contrast
implies the edit), `objective`, `commitMessage`, `patchFile`. Admission runs
through the existing `cycle --dry-run` and the existing guard set. There is no
second evaluator and no second store schema.

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

- Unit: candidate generation over a fixed attempt fixture is deterministic and
  byte-identical across runs.
- Integration: candidate -> `cycle --dry-run` -> adopt or reject; rejections
  remain visible in `history --json` with their streak.
- Acceptance: adoption only when the existing probe improves on the held-out
  slice. Otherwise the cycle is recorded as rejected; a rejection is a valid
  outcome, not a failure to fix by loosening a guard.
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

## Open decisions

- first objective to run the loop against;
- distillation method: contrast prompt versus deterministic heuristic over
  `guardFailures` classes;
- where candidates live before they become proposals.
