# Trajectory memory: from attempts to gated rules

Status: layer 1 implemented as `distill.v2` (`self-improve/lib/distill.mjs`,
`self-improve/scripts/run.mjs distill`). The candidate handoff is proven by a
hermetic integration test; the live guard-tier dry run (E5b) has **not** been
executed and is labelled unproven below. Follow-up to JJO-394.

The repository stores exploration attempts (`rrsi`) and gates changes
(`self-improve`). Layer 1 turns a success/failure contrast into a candidate
rule; it is deliberately strict, so most runs emit nothing.

## Layers

| Layer | Owner | State |
| --- | --- | --- |
| 0. Capture trajectories | `rrsi` store (`capture`, `import`) | implemented |
| 1. Distill contrastive rules | `self-improve/lib/distill.mjs` (`distill`) | implemented (v2) |
| 2. Promote under gates | `self-improve` (guards, probes, ledger) | implemented |

Layer 1 produces candidates only. It never edits source, never writes to the
store or ledger, and never bypasses layer 2.

## Contract

Inputs, read-only: attempts from the `rrsi` store, `self-improve/ledger.jsonl`
cycle rows, and the domain adapter's declared objectives. `declaredObjectives`
is required; an empty list means nothing is declared and yields zero candidates.

### Emission

A group is one objective's attempts. Every adopt × reject pair must agree on
one non-null feature (`guardFailures` → `budgetRung` → `hypothesisNovelty`).

Classification order is fixed:

1. any pair with **no** differing feature → `contradicted`;
2. otherwise, more than one distinct feature → `inconsistent_contrast`;
3. otherwise → emitted.

A null pair is checked first because it is strictly stronger evidence against a
rule than a second signature. Cost (`wallMs`) and edit size never justify a
rule. Counters are distinct attempts per side, plus a `pairs` audit block; the
dominant feature is the one with the most pairs, ties broken by the feature
order above.

### Evidence and freshness

Each group's `drawnFrom` is the highest ledger cycle seq represented by that
group's provenance. `evidence.ledgerSeq == expires.after == drawnFrom`, never
the ledger head. Attempts without ledger provenance are unbound: a declared,
gated group containing any unbound attempt is skipped as `unbound_evidence` and
never emitted.

One `--max-lag` authority (default 0) exists on both `distill` and
`loop --candidate-file`. A group whose lag exceeds it is `withheld`
(`store_stale`). The store-level `projection` block is context only; no emission
decision reads it. `expires.after = drawnFrom` means valid for the same epoch at
`--max-lag 0`; a positive `--max-lag N` widens the consume window to N epochs.

### Scope

Only the gated primary objective (`adapter.probes[0].objective`) can become a
candidate. Other declared objectives are `objective_not_gated`; undeclared
groups are a counted aggregate with a bounded sample and never become
candidates. `probe.heldout_coverage` is excluded on purpose: held-out is an
admission veto, not a proposal target.

### Handoff

`loop --candidate-file <path>` accepts a bare `candidate.v2` or a `distill.v2`
payload with exactly one candidate. All checks live in `loop.mjs`:
schema, gated objective, zero contradiction/unexplained, rule length, internal
counter consistency (`pairs.support = support.adopts × support.rejects`, side
counts equal the support counts, attempt ids unique and bounded), recomputed
content id (`candidate_tampered`), freshness (`candidate_stale`), and the store
digest recomputed from `--store` (default the rrsi store) so a forged digest is
`candidate_store_mismatch`. Candidate mode without a store is
`candidate_store_required`. A refused candidate exits 2 before any proposer
call. A valid candidate pins the objective, adds an optional `contrast` field
to the v1 proposer request, rejects a response that moves the objective
(`proposer_objective_mismatch`), and stops the loop with `candidate_consumed`
after one cycle. Requests without a candidate keep their previous shape.

## Command

```sh
node self-improve/scripts/run.mjs distill [--store <path>] [--ledger <path>]
  [--objective <id>] [--domain <id>] [--max-lag <n>] [--out <path>] [--json]
```

- Defaults: `~/.gjc-plugin/rrsi/store.json`, `self-improve/ledger.jsonl`, domain
  `gjc-plugin`.
- Exit codes: 0 normal (including a missing store); 2 unknown domain, objective
  outside the declaration, or invalid `--max-lag`; 3 corrupt or unreadable
  inputs.
- Output carries no clock value, so identical inputs produce byte-identical
  JSON.
- Projection refresh: run the rrsi `import` action with
  `ledgerPath: self-improve/ledger.jsonl` (or wait for the due-gated
  `session_start` refresh), then `distill`, then `loop --candidate-file`.
  `rrsi import` projects an existing ledger; it does not create ledger rows.

## Measured result (frozen inputs, 2026-10-21)

Inputs frozen at `.gjc/distill-demo/inputs/` from the live store and ledger:

| Field | Value |
| --- | --- |
| `store.attempts` / `undeclared` | 212 / 42 groups, 198 attempts |
| `projection` | `maxDrawnFrom 16`, `ledgerHead 31`, `storeLag 15`, `label stale` |
| `candidates` / `withheld` / `skipped` | 0 / 0 / 3 |
| `probe.decision_accuracy` | `contradicted`, `drawnFrom 14`, lag 17, support 1/1, contradiction 1/4, unexplained 1/1 (6 pairs) |
| `probe.extract_coverage` | `objective_not_gated`, `drawnFrom 16`, lag 15 |
| `probe.egress_boundary` | `objective_not_gated`, `drawnFrom 9`, lag 22 |

Zero candidates is the intended outcome: the only group with both decisions is
refuted by four of its six pairs.

## Non-goals

- weight updates, fine-tuning, or model routing changes;
- a consolidated enterprise/ontology store;
- replacing retrieval or removing RAG;
- new gate thresholds, a new frozen corpus, or weakening an existing guard;
- rrsi store schema or new store fields;
- capture-goal → objective classification.

## Verification

- Unit (`tests/unit/distill.test.mjs`, 22 cases): unanimity, contradicted
  counters, inconsistent contrast, unbound evidence, gated scope, undeclared
  aggregate, per-group lag, `parseMaxLag`, deterministic output, CLI exit codes,
  candidate tamper/contradiction/staleness.
- Unit (`tests/unit/propose-contrast.test.mjs`): the contrast field is additive;
  requests without it keep their previous shape.
- Integration (`tests/integration/distill-handoff.test.mjs`): fixture store and
  ledger → candidate → real request → committed composer fixture → validation →
  engine **dry-run** decision, with the contrast present in the request, the
  ledger unchanged, and a mismatched response objective refused. This is E5a
  and it is hermetic (no model, no network).
- **Not executed:** E5b, the live `cmd` proposer plus build/test tier. Until it
  runs, the guard-tier dry run is **unproven**; the E5a test is never described
  as a guard-tier run.
- All suites: `verify-unit.mjs` and `verify-integration.mjs` report ALL PASS.

## Evidence

- REM, arXiv 2610.27377: phase-structured consolidation; reported 68.7% vs
  55.6% match@1 and 27.6% vs 24.9% end-task at 17% lower cost.
- MemDev-Bench, arXiv 2610.27524: unrelated history increases failures; agents
  reuse memory without reassessing applicability.
- More Memory, Worse Agents, arXiv 2610.27406: persisted abstractions reproduce
  errors; keep accumulation and abstraction persistence separate.

Numbers above are the sources' own reports, not measurements here.
