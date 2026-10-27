# Harness² and self-improve

## Offline machinery (not a live result)

`lib/behavior-eval.mjs` implements the protocol this proposal describes without
calling a model: it validates a frozen pilot manifest (balanced classes,
independent oracles outside any trial mount), plans arms B0, B1 and B2 under one
shared resource ceiling, admits spending before a call and fails closed on an
unknown price or usage, checks trial validity (loading receipt, isolation deny
probes, independent oracle, admitted budget, holdout untouched, measured cost),
computes the paired benefit verdict, and bounds lesson reuse to three lessons
and 2 KiB while withholding contradicted, stale or inapplicable lessons. The
integration suite `tests/integration/behavior-eval.test.mjs` covers each rule.
No live trial has run; every efficacy statement in this document remains a
proposal, and a live run needs an enforceable isolation runtime plus a separate
owner-approved budget.

`lib/loading-receipt.mjs` is the loading-evidence producer. It composes the
loader state (`gjc plugin list --json`, whitelisted and redacted) with
`computeHarnessDigest` over explicit targets, excludes credential-like files
from the digest rows (presence is recorded without a digest), and embeds a
canonical payload whose sha256 is the receipt digest. `validateTrialReceipt`
requires `loadingReceipt.loaded === true` and re-derives the payload digest
(`loading_not_proven`, `loading_payload_missing`,
`loading_payload_mismatch`). It proves loader-resolved surfaces and payload
integrity — not that a model used them, and not provenance: a self-consistent
forgery still passes. Task outcomes remain the independent oracle's job.

## Decision and evidence boundary

Selectively adapt Harness²'s execution-evidence approach inside the existing
self-improve loop; do not replace the engine or install upstream as a runtime
dependency. Establish real GJC behavior evaluation first, then investigate
proposal composition and experience reuse. Keeping the current implementation
unchanged remains a valid outcome if those experiments do not show benefit.

This is a source-based integration proposal, not an implemented feature or a
measured performance improvement. Neither upstream benchmarks nor live GJC
trials were run for this analysis. No upstream success rate, speedup, or cost
saving is an estimate for this repository.

The comparison is pinned to:

- [Harness² at `1cfe254e`](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335).
- [gjc-plugin at `b9d47c2`](https://github.com/jjongguet/gjc-plugin/tree/b9d47c2a5ea73fa2db270f85d01fe1801d86f186).

These are comparison snapshots, not claims that later delivery commits contain
identical code. Upstream calls its method recursive agent harnessing: model
weights stay fixed while prompts, tools, memory, skills, orchestration, and
other harness components change.

## Relationship: overlapping loop, different evidence

| Concern | Existing self-improve | Harness² | Integration decision |
| --- | --- | --- | --- |
| Proposal | Editable surfaces, failing probe cases, budgets, and prior attempts enter the proposer request | General/invariant and domain-specific harness candidates | Reuse the proposer seam; investigate scoped candidates after behavior evaluation exists |
| Probe | Deterministic repository checks and probes; a local-stub/text-fixture runner | Candidate harnesses execute the same task and produce trajectories/deliverables | Add actual consumer-loading and task-outcome evidence, not another fixture-only score |
| Composition | Individual patch evaluation and adoption pipeline | Multiple candidate executions inform a composed harness, which executes again | Treat a composition as a new candidate requiring its own checks |
| Adoption | Reject paths for guards, improvement floor, cost, held-out regression, and edit budget | Final-output selection excludes reference baseline executions | Preserve baseline eligibility, rejection, and abstention; do not copy finals-only adoption |
| Experience | Attempt history, ledger, replay/dreaming, and existing knowledge tools | Per-domain adopted harness trees and cue/lesson/evidence records | Extend existing provenance and bounded retrieval rather than create a competing memory system |
| Safety | Declared editable sources, scratch copies, protected paths, and explicit live-mode admission | Editable harness validation, but unrestricted executor network by default | Preserve controls and add enforceable execution/network isolation before real-agent trials |

### Primary-source map

- [Local proposer](https://github.com/jjongguet/gjc-plugin/blob/b9d47c2a5ea73fa2db270f85d01fe1801d86f186/self-improve/lib/propose.mjs):
  `buildProposerRequest` carries failing cases, prior attempts, editable surfaces,
  and rung limits. `createProposerScratch` excludes held-out fixtures.
- [Local runner](https://github.com/jjongguet/gjc-plugin/blob/b9d47c2a5ea73fa2db270f85d01fe1801d86f186/self-improve/lib/runner.mjs):
  `buildTrialCommand` disables skills, rules, and tools; evaluation defaults to
  `local_stub`; unapproved live evaluation is skipped. A text fixture is prompt
  input, not evidence that the corresponding runtime surface was loaded.
- [Local gates](https://github.com/jjongguet/gjc-plugin/blob/b9d47c2a5ea73fa2db270f85d01fe1801d86f186/self-improve/lib/gates.mjs):
  `noiseFloor`, `evaluateCostRule`, `evaluateHeldout`, and `decideCycle` provide
  existing decision mechanisms. They are not a complete safety proof for an
  arbitrary new executor. The existing wall-time/byte cost proxy is not a live
  provider spending cap.
- [Upstream recursion](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/recursion.py):
  `run_parallel` probes invariant and domain candidates, then creates independent
  compositions from their evidence; sequential recursion carries refinements
  through successive steps.
- [Upstream selection](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/selection.py):
  `selection_pool` deliberately excludes `base` and returns only `agg1..aggk`
  or `c1..ck`. Output selection therefore does not prove improvement over baseline.
- [Upstream library](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/library.py):
  nonempty `cue`, `lesson`, and `evidence` are required to store an entry, along
  with the full adopted harness. Field presence does not validate a lesson's
  truth or establish causality.
- [Upstream experiments](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/docs/EXPERIMENTS.md):
  defines budgets, ordered within-domain experience, baseline grading,
  reproducibility limits, and network/rubric leakage warnings.

The existing loop is functional for its declared code/probe domain. The gap is
narrower: improving a fixture or deterministic parser does not establish that a
running agent uses a changed skill, rule, or tool better. RRSI policy replay over
recorded attempts likewise does not execute a new harness on fresh tasks.

## Transfer the method, not the defaults

A useful future loop is:

```text
Frozen task + verified baseline/candidate surface identities
  -> scoped general and domain proposals
  -> isolated executions and independently checked outcomes
  -> contrastive evidence and an optional composition
  -> fresh composite execution
  -> existing guards plus baseline comparison and abstention
  -> evidence-linked experience for later eligible tasks
```

This is not a mandate to run recursion on every user task. Start with bounded,
repeatable repository tasks without external side effects. Restrict experiments
to declared editable surfaces; global authority and approval rules are not
optimization targets.

### Cost and selection

Upstream schedules **4 × k task executions and 3 × k improvement stages per
task**, including reference executions, where `k` is recursion budget. At
`k = 1`, that means four task executions and three improvement stages, not
thousands. Selection, reflection, retries, multiple tasks, and domain count add
work; these counts are neither API-call counts nor a complete monetary budget.
`--max-tasks` is per domain, not a global task cap.

A later experiment must compare the unchanged baseline, a compute-matched
baseline repetition strategy, and refinement. Otherwise gains may reflect extra
execution rather than a better harness. Retain the baseline as an eligible
outcome and reject or abstain when evidence is insufficient.

### Isolation and contamination

Upstream documents unrestricted executor network access, disabled Codex
sandboxing, and a release-validation rollout that downloaded a public rubric.
Do not copy these defaults. A Git scratch copy is filesystem separation, not a
security sandbox. A future runner must demonstrate credential exclusion,
execution and network restrictions, allowed tools/endpoints, and no external
mutations. A prompt saying “no network” is not enforcement.

Separate proposal/selection inputs from held-out evaluation. Freeze scoring,
thresholds, exclusions, and stopping rules before revealing held-out outcomes;
record every attempt, failure, skip, and exclusion. A missing or non-finite
measurement must not become an adoption pass.

## Staged adoption and completion criteria

Linear owns priority, assignment, and work status; this document owns the
technical relationship and proposed contracts. The links below are follow-up
work, not claims that these capabilities are installed.

| Stage | Tracking | Contract and observable completion |
| --- | --- | --- |
| Relationship decision | [JJO-269](https://linear.app/jjongguet/issue/JJO-269) | Source-grounded document, README link, remotely verified delivery, and linked follow-up issues |
| M1: real behavior evaluation | [JJO-270](https://linear.app/jjongguet/issue/JJO-270) | Prove intended baseline/candidate surfaces actually load; freeze tasks/scoring; compare outcomes and cost; reject regression, ineffective candidates, wrong loading, invalid measurements, timeout, and exhausted budget |
| M2: evidence-backed composition | [JJO-271](https://linear.app/jjongguet/issue/JJO-271) | After M1, probe components and re-execute each composite; preserve provenance and all existing gates; reject conflicts and composite regression even when components improved separately |
| M3: bounded experience reuse | [JJO-272](https://linear.app/jjongguet/issue/JJO-272) | After M1/M2, attach cue/lesson/evidence and source/version/outcome references; invalidate contradicted lessons; test held-out separation, learning on/off, and misleading-lesson negative controls |

[JJO-213](https://linear.app/jjongguet/issue/JJO-213) is related prior RRSI evidence
work, not a new Harness² implementation or an issue to reopen for this roadmap.

M1 must define a frozen task/model/tool contract and immutable per-trial loading,
outcome, source, and cost receipts. Existing verification receipts may establish
the checks they actually ran, not whole-agent quality. Composition must never
sum component improvements and assume the combination works. Experience
retrieval should load a bounded relevant subset, with explicit invalidation,
rather than copying every past harness into every context.

Before any model-backed experiment, approve one explicit window with numeric
call/token/currency/wall-time caps, task/domain counts, recursion budget,
auxiliary-stage allowance, allowed endpoints and files, and stop conditions.
Specify sample sufficiency and uncertainty rules in advance. No timers,
unattended paid retries, automatic installation, or automatic global-rule
promotion follow from registering these issues.

## Alternatives and remaining unknowns

- **Keep the current runtime:** lowest operational risk and a valid conclusion
  if behavior experiments show no transferable benefit; leaves the evaluation
  gap open.
- **Selective extension (recommended):** reuses current guards and evidence
  storage, but introduces a real evaluation problem before any gain is known.
- **Full upstream port/replacement:** preserves upstream structure, but expands
  scope and still requires local safety, baseline, and evaluation decisions.
  It is not justified by this source comparison alone.

Unknowns include actual task coverage, reliable live isolation on the target
host, suitable surfaces and metrics, sample requirements, and incremental model
cost. Upstream benchmark claims were not reproduced. These unknowns belong in
M1's bounded design and evaluation, not in fabricated performance estimates.

## Verification

For documentation changes, verify pinned source-to-claim mappings, relative
links, the intended two-file diff, published commit contents, and Linear issue
relations. Runtime efficacy requires the future M1–M3 contracts and their actual
observations; documentation review, local-stub tests, and advisory model
judgments do not substitute for that evidence.

## Contract layer status: offline predicates, no result

`lib/behavior-eval.mjs` is an offline contract and predicate layer. It validates
a frozen pilot manifest, plans arms, admits spending before a call, checks trial
receipt validity and computes paired benefit — and it never calls a model,
starts a process or reads a live outcome. Its verdicts say whether a receipt is
admissible and whether a predeclared paired rule is met. They are not a measured
comparison of harnesses.

Admission rules hardened in this revision:

- `admitCall` refuses a non-finite or negative cap, price, reservation or usage
  and projects `spent + unresolved + max(reservation, price) + cleanup`, so a
  refund-shaped negative component cannot lower the projected spend of a call.
- `validateTrialReceipt` requires a named verifier that differs from both
  producer and executor and carries its own evidence digest; a bare
  `oracle.independent === true` is `oracle_not_independent`. It also requires
  the loading receipt, source and harness digests, passing isolation deny
  probes, an admitted budget, an untouched holdout, a complete denominator and
  a measured non-negative cost.
- `pairedBenefit` requires the full declared pair set: fewer pairs →
  `incomplete_pairs`, more → `unexpected_pairs`, fewer than two →
  `too_few_pairs`, duplicate ids → `duplicate_pairs`, `baselineCost === 0` →
  `baseline_zero`, and a missing, non-finite or negative ratio →
  `invalid_cost_ratio`. A missing ratio is never defaulted to 1.
- The arm enum and the digest predicate now come from the canonical
  `gjc.quality_trial.v2` module (`lib/quality-trial.mjs`), so the pilot and the
  `rrsi` cohort cannot disagree about the arm vocabulary or the digest shape.
  See [ADR 0003](../docs/adr/0003-quality-trial-evidence-boundary.md).
- `lib/distill.mjs` requires re-derivable contrast support
  (`rederiveSupport`) and treats an all-skipped run, including zero candidates,
  as a normal empty result.

**No measured comparison result exists.** No trial receipt, arm execution or
paired benefit verdict from a real run is recorded in this repository. Nothing
here establishes that any harness change improves task outcomes, reduces cost,
or is calibrated. The suites (`tests/integration/behavior-eval.test.mjs`,
`tests/unit/quality-trial.test.mjs`,
`tests/unit/behavior-eval-integrity.test.mjs`,
`tests/unit/distill-integrity.test.mjs`) prove the predicates and their failure
paths, not behavior.

**What does exist (2026-10-27).** A cost-0 guard ablation — two planted-defect
tasks × two guard sets, each in an isolated `git archive` snapshot — is recorded
in `artifacts/harness2-rrsi-20261027/` and summarised in
[`PATTERNS.md`](PATTERNS.md). It measures which guard set catches which defect and
at what wall cost. It has no model in the loop, no repeated arms and no holdout,
so it is not a trial receipt and does not change the paragraph above.

**The experiment that must run before any efficacy claim** is M1 (JJO-270) under
the [evaluation rules](../docs/adr/0001-public-adoption-and-evaluation.md):
freeze the task manifest, arm definitions, scoring, thresholds and exclusions;
prove that the baseline and candidate surfaces actually load (loading receipt);
run the paired development and holdout trials for B0/B1/B2 inside one approved
budget window; and keep every failure, timeout and exclusion in the denominator.
Until that run exists, any sentence about this machinery being better, cheaper
or more accurate is a proposal.
