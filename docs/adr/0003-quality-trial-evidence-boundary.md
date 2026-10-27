# ADR 0003: Quality-trial evidence boundary

Status: accepted and implemented in `self-improve/lib/quality-trial.mjs`,
`self-improve/lib/behavior-eval.mjs`, `self-improve/lib/distill.mjs` and
`rrsi/lib/rrsi.ts`. This record defines admissibility only; it contains no
measured result.

## Context

- The `rrsi` journal projection records that an advice answer was returned and
  labels it `adopt`. That is availability telemetry, and the source comment in
  `rrsi/lib/rrsi.ts` says so: efficacy ranking may only use a separate,
  versioned cohort.
- The Harness² comparison machinery in `self-improve/lib/behavior-eval.mjs`
  validated pilot receipts, but each consumer could have grown its own trial
  shape, and oracle independence was expressible as a bare
  `oracle.independent === true` instead of a named verifier with evidence.
- The distillation path could emit a candidate whose contrast support was not
  reproducible from the store it claimed to come from.
- Two failure modes had to be closed together: a receipt that is admissible
  without an independent outcome, and a cohort that hands a consumer a single
  boolean "efficacy allowed" flag.

## Decision

1. **One canonical validator: `gjc.quality_trial.v2`.**
   `self-improve/lib/quality-trial.mjs` owns `QUALITY_TRIAL_SCHEMA`,
   `QUALITY_COHORT_SCHEMA` (`rrsi.quality_cohort.v2`), the split (`training`,
   `development`, `holdout`) and arm (`B0`, `B1`, `B2`) enums, the outcome enum
   (`passed`, `failed`), `QUALITY_EXCLUSIONS`, `QUALITY_LIMITS`
   (`maxTrials: 4000`, `maxIdChars: 64`, `maxVersionChars: 32`,
   `maxTextChars: 120`, `maxRationaleChars: 200`), `executionKeyFor`,
   `validateQualityTrial` and `projectQualityTrialCohort`.
   `rrsi/lib/rrsi.ts` imports `projectQualityTrialCohort`,
   `QUALITY_COHORT_SCHEMA` and `QUALITY_TRIAL_SCHEMA` from
   `../../self-improve/lib/quality-trial.mjs` and only re-exports them
   (`RRSI_QUALITY_SCHEMA`, `RRSI_QUALITY_COHORT_SCHEMA`,
   `projectQualityCohort`). `self-improve/lib/behavior-eval.mjs` imports
   `isDigestHex` and `QUALITY_ARMS` from the same file (`ARMS = QUALITY_ARMS`).
   There is no second validator to drift.
2. **A trial receipt is executor-owned with independent oracle evidence.**
   The receipt must carry `producer` (id, kind), `executor` (id, receiptId,
   receiptDigest), `harness` (sourceDigest, harnessDigest, manifestDigest,
   version), `oracle` (kind, verifierId, evidenceDigest,
   independentFromProducer), `createdAt` and `sourceHead`, all digest-shaped
   where a digest is expected. `oracle.independentFromProducer` must be `true`
   **and** the named verifier must differ from both producer and executor
   **and** an evidence digest must be present; a bare boolean is
   `non_independent_oracle`. `producer.id === executor.id` is
   `non_independent_producer`. `executionKey` must re-derive from
   `(taskId, taskVersion, arm, repeat, harnessDigest, oracle evidenceDigest,
   goalRevision)`, so a hand-written key is `legacy_schema` rather than a new
   cell.
3. **The cohort is counts-only.** `projectQualityTrialCohort` returns
   `{ schema, total, admissible[], excluded[{ reason, count }], duplicate }`.
   Every inspected record lands in exactly one bucket: admissible, one
   exclusion reason, or `duplicate`. Admissible rows carry counts, ids and
   digests only (`qtAttemptFor`: provenance, objective, taskVersion, split,
   arm, repeat, executionKey, decision, wallMs, usd, costMeasured,
   sourceDigest, harnessDigest) — no rate, delta or verdict. There is no
   `efficacyClaimsAllowed` field; `rrsi/tests/quality-cohort.test.ts` asserts
   its absence ("the cohort is counts only: there is no efficacy permission
   field") and `self-improve/tests/unit/quality-trial.test.mjs` asserts the
   same accounting in the canonical module.
4. **Duplicate, conflict, cost and denominator handling is an explicit
   exclusion taxonomy.** One record is admitted at most once:

   | Exclusion | Predicate in `validateQualityTrial` |
   | --- | --- |
   | `legacy_schema` | Not a v2 payload: wrong `schema`, a malformed or missing required field, or an `executionKey` that does not re-derive |
   | `conflicting_duplicate` | Same `executionKey` as an admitted trial with a different canonical payload |
   | `non_independent_producer` | `producer.id === executor.id` |
   | `non_independent_oracle` | `independentFromProducer !== true`, unnamed verifier, verifier equal to producer or executor, or a missing kind/evidence digest |
   | `unknown_outcome` | `outcome` is not `passed` or `failed` |
   | `negative_cost` | Any measured cost component is negative |
   | `missing_cost` | `cost.measured !== true`, a non-finite component, or an all-zero measurement without `zeroCostRationale` |
   | `denominator_mismatch` | `planned < 1`, `planned !== passed + failed + error + skipped`, or an outcome that disagrees with its counters |

   Byte-identical repeats collapse into `duplicate` and count once. A re-run is
   a distinct trial only because `repeat` is part of the execution key.
5. **`pairedBenefit` requires the full planned denominator.**
   `plannedPairs` declares how many pairs the design expects (default: the
   number supplied). Fewer pairs → `insufficient` / `incomplete_pairs`; more →
   `unexpected_pairs`; fewer than two → `too_few_pairs`; duplicate pair ids →
   `duplicate_pairs`; a non-finite `qualityDelta` → `invalid_pairs`;
   `baselineCost === 0` → `baseline_zero`; a missing, non-finite or negative
   `costRatio` → `invalid_cost_ratio`. A missing ratio is never defaulted to 1,
   a zero baseline is undefined rather than perfect, and an incomplete set
   never reaches a verdict by dropping the bad row. Only after those checks
   does the composite rule apply: no regression, no lower coverage on
   decidable tasks, `qualityDelta >= 0`, and `costRatio < 1` by default.
6. **Spending admission fails closed.** `admitCall` refuses a non-finite or
   negative cap, price, reservation or usage and projects
   `spent + unresolved + max(reservation, price) + cleanup`, so a
   refund-shaped negative component cannot reduce the projected spend of a
   live call.
7. **Distillation requires re-derivable support.**
   `rederiveSupport(candidate, attempts)` resolves every referenced attempt id
   to an attempt of the same objective on the declared side
   (`adopt`/`reject`), requires that side's declared `count` to equal the
   number of such attempts in the store, and requires
   `contrast.support.adopts/rejects` to match the side counts.
   `validateCandidate` additionally requires a non-empty, duplicate-free
   `attemptIds` list per side and re-derives support whenever `attempts` is
   supplied (`candidate_support_not_rederivable`). A candidate expiry must be a
   ledger sequence: a future `after`, or one before `evidence.ledgerSeq`, is
   `candidate_expiry_invalid`. `distillTrajectories` skips a candidate it
   cannot re-derive (`support_not_rederivable`) and records the reason; an
   all-skipped run returns an empty `candidates` list, and
   `self-improve/tests/unit/distill-integrity.test.mjs` fixes that as "zero
   candidates is a normal terminal result, not an error".
8. **Offline predicates and hashes are contract evidence only.**
   `validateQualityTrial`, `validateTrialReceipt`, `pairedBenefit`,
   `admitCall`, `rederiveSupport` and `validateCandidate` are structural
   predicates over receipts, manifests and attempt rows. Digests pin identity;
   they measure nothing. None of them calls a model, starts a process or reads
   a live outcome, and no admissible-cohort count is a quality result.

## Drivers

- One contract with several consumers: a trial written for the Harness² pilot
  must be the same object `rrsi` validates, or the two will disagree about what
  counts as evidence.
- Exclusions must be visible counts rather than silent drops, which is the
  denominator rule ADR 0001 already states.
- Independence must be a relationship with evidence attached, not a
  self-asserted boolean.
- A lesson must be reproducible from the retained attempts, or it is a claim.

## Alternatives considered

- **Keep per-consumer validators (`rrsi` and `behavior-eval` separately).**
  Rejected: the same receipt could be admissible in one consumer and excluded
  in the other, with no way to say which contract was authoritative.
- **Keep `oracle.independent: true` as sufficient.** Rejected: any producer can
  self-assert it. A named verifier plus its evidence digest is checkable, and
  the relationship check also catches a producer verifying its own execution.
- **Let `rrsi` compute rates or averages from the cohort.** Rejected: a rate
  over a handful of retained receipts is not a measurement of quality, and a
  single permission flag would invite exactly that reading. Counts-only output
  makes "no efficacy claim" a property of the data shape.
- **Default a missing cost ratio or accept a short pair set.** Rejected: a
  defaulted ratio is invented data, and a short set is `insufficient`, not a
  smaller sample of a benefit claim.
- **Emit the best available candidate when support cannot be re-derived.**
  Rejected: an unverifiable lesson is the failure mode this boundary exists to
  prevent.
- **Treat a zero-candidate run as an error.** Rejected: with re-derivation
  gates, "no reproducible contrast" is a legitimate result, and making it an
  error invites pressure to loosen the gate.

## Why chosen

- The canonical module imports only `node:crypto`, so it is inlined unchanged
  into the `rrsi` surfaces (`rrsi/scripts/build.mjs` lists
  `self-improve/lib/quality-trial.mjs` in `inlineModules` for both generated
  files) and tested with `node:test` without a provider.
- The exclusion set is a closed enum, so a consumer can print counts per reason
  and a change in the funnel is visible.
- Re-derivation uses the store the candidate claims to come from, so a lesson
  and its evidence cannot diverge.

## Consequences

- A receipt with an unmeasured component is inadmissible, never zero. A
  producer that does not record `usd`, `wallMs`, `inputTokens` and
  `outputTokens` cannot contribute an admissible trial, and an all-zero
  measurement additionally needs `zeroCostRationale`.
- Holdout correctness is a predicate over a declared flag
  (`holdout.usedEarly === true` fails validity); the code cannot detect a false
  declaration.
- `rrsi` exposes the cohort as a library export (`projectQualityCohort`) used
  by its tests. The `rrsi` tool's four actions (`capture`, `import`, `dream`,
  `status`) do not return it.
- `loaded` is a pilot-receipt (`harness2`) property: `validateTrialReceipt`
  requires it and re-derives the embedded loading payload, while
  `validateQualityTrial` keeps digest-pin admission. The divergence is
  deliberate and recorded here; propagating `loaded` into the cohort validator
  is separate work, not a silent reconciliation.
- Duplicate collapse means two byte-identical receipts count once; a genuine
  repeat must differ in `repeat`.
- No measured comparison exists yet. No trial receipts are committed, and every
  efficacy statement in this repository remains a proposal.

## Follow-ups

- The frozen pilot in ADR 0001 and `self-improve/HARNESS2.md` (M1, JJO-270)
  must run before any efficacy claim. This boundary decides admissibility only.
- Returning the cohort from an `rrsi` tool action would be a separate surface
  change with its own output cap and acceptance case.
- `validateTrialReceipt` (pilot receipt) and `validateQualityTrial` (portable
  trial) overlap deliberately. If they diverge, one must be removed rather than
  reconciled silently.

## Implementation

- `self-improve/lib/quality-trial.mjs` — canonical schema, validator, cohort.
- `self-improve/lib/behavior-eval.mjs` — receipt validity, spending admission,
  paired benefit, lesson bounds.
- `self-improve/lib/distill.mjs` and `self-improve/lib/loop.mjs` — support
  re-derivation and store-passed attempts.
- `rrsi/lib/rrsi.ts`, `rrsi/scripts/build.mjs` — delegated cohort and build
  inlining.
- Tests: `self-improve/tests/unit/quality-trial.test.mjs`,
  `self-improve/tests/unit/behavior-eval-integrity.test.mjs`,
  `self-improve/tests/unit/distill-integrity.test.mjs`,
  `rrsi/tests/quality-cohort.test.ts`.

The session-authority side of this work is [ADR 0002](0002-goal-alignment-authority-boundary.md);
the repository's evaluation rules stay in
[ADR 0001](0001-public-adoption-and-evaluation.md).
