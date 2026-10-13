# DREAM.md — replay simulator, dreaming and redeploy (P2/P3)

Status: **frozen** (M3b). The corpus is frozen in `replay-protocol.json` (ledger sha256 `72e25ab9092fac9a2f9ac3a9903a9e5aa2c3fffae3038ecd25a9c91a5b2da72e`, 13 attempts / 1 adoption, 2 epochs) and both files are committed before the dream run; the corpus hash fields in `replay-protocol.json` are
filled and both files are committed **before** the dream run (M3b); this file is
the normative description of what the run does.

## Corpus freeze (M3b)

The P2 corpus is `self-improve/ledger.jsonl` at the M2 campaign close: sha256
`72e25ab9092fac9a2f9ac3a9903a9e5aa2c3fffae3038ecd25a9c91a5b2da72e`, 13 cycle rows (12 reject /
1 adopt) and 1 adoption row, partitioned into
2 epochs by adoptions (adoption order preserved). The frozen pass gate asks
for 20 attempts; 13 is below it but meets the pass-1 floor of 12, so
the dream run reports **"insufficient evidence at pass-gate size - thresholds not evaluated"**
as a measured, escalated verdict with the downgrade recorded in
`replay-protocol.json` - no threshold is relaxed or re-derived.

## What runs

```sh
node self-improve/scripts/run.mjs replay --corpus ledger --json                 # B0/B1 over the whole ledger
node self-improve/scripts/run.mjs replay --policy <id> --json                   # one policy artifact
node self-improve/scripts/run.mjs dream --seed 1 --out receipt.json --json      # select pi* on the train split
node self-improve/scripts/run.mjs dream --seed 1 --write-policy <id>            # also write policies/<id>.json
node self-improve/scripts/run.mjs policy --list --json
node self-improve/scripts/run.mjs policy --deploy <id> [--dry-run] --json       # current.json + one policy row
```

Every command is deterministic: the same ledger and seed produce byte-identical
receipts (`receiptHash`). No network, no timers, no model calls.

## Digest-epoch rule

An attempt may be replayed only at the code state at which it was recorded. The
authoritative boundary is the **editable-surface digest**; an **adoption is the
observable boundary event**, because ledger-only `chore(self-improve): cycle …`
commits move HEAD without changing the graded surface. `baseCommit` is retained
as provenance, never used as the epoch key. Consequences:

- adoption order is preserved in every replay (a later epoch's attempts only
  become available after the adoption that opened it has been played);
- reject-only attempts inside an epoch are freely reorderable;
- cross-epoch replay of an attempt is disallowed;
- attempts recorded **before** a replayed slice are ex-ante prior knowledge
  (branch hypothesis novelty, prior revealed outcomes, prior guard-failure
  classes) — exactly what the live loop knows when it authors the next request.

## Reveal protocol / anti-triviality

Selection sees ex-ante features only: objective/gap id, attempt index within the
branch, hypothesis-novelty flag, files, hunks, prior *revealed* outcomes of the
same branch, prior guard-failure classes and the budget rung. Verdicts, deltas,
the ledger order of unplayed attempts and their adoption flags stay sealed until
selection. `tests/unit/replay.test.mjs` pins both the epoch rules and the
feature boundary.

## Policies and selection

- **B0** = recorded order, batch 1, stop at the first adoption (today's fixed
  policy).
- **B1** = fixed round-robin objective order, batch 1.
- **π\*** = the candidate selected on the **train split only** (first 14 recorded
  attempts) from 40 deterministic candidates (5 order rules × batch 1–3 × stall
  switch × stop rule; ≤48 by construction). The validation split (last 6
  attempts, must include ≥1 adoption) is used only to evaluate the frozen
  thresholds — never to choose π\*.

Thresholds (frozen in `replay-protocol.json`): π\* attempts ≤ min(B0, B1) − 1 on
validation; π\* cost ≤ 0.7 × B0 cost on validation; π\* cost ≤ B0 cost on the
full corpus (anti-fluke); same seed ⇒ byte-identical receipt. If the corpus is
below the pass gate (n < 20, validation < 6, or a validation slice without an
adoption) the verdict is **"insufficient evidence at pass-gate size — thresholds
not evaluated"** — measured, never silently downgraded.

## Pinned caveat (reused verbatim in the evidence map)

> All P2 comparisons are off-policy replays over ONE realized corpus of fewer
> than ~24 recorded attempts; no statistical significance is claimed; effect
> sizes are reported with n and are not confidence-interval estimates of future
> performance; the cost proxy is load-dependent recorded wallMs, not a fresh
> measurement.

## Redeploy (P3, M4)

`dream --write-policy <id>` writes `policies/<id>.json`; `policy --deploy <id>`
writes `policies/current.json`, appends exactly one `kind:"policy"` ledger row
(≤2 KiB, `validatePolicyRow`) and commits both files plus the ledger with
`chore(self-improve): policy <id> deploy` (the commit is skipped, with the
command printed, when the ledger does not live inside a git work tree). The
subsequent bounded campaign uses the deployed policy as its selection rule and
produces the calibration report (predicted vs realized selection outcomes,
recorded in every dream receipt).

## Residual-surface note

The propose-time scratch excludes `self-improve/domains/**`, but the held-out
fixtures remain present in the engine's own *evaluation* scratch — pre-existing
and inherent. The anti-hardcoding defense remains the critic's token scan, the
parallel-instance held-out design and the best-effort threat model documented in
`PATTERNS.md`.
