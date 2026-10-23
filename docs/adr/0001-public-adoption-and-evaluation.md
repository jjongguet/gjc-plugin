# ADR 0001: Public adoption and evidence-based evaluation

Status: accepted. Items marked *planned* are decided but not yet in this repository; this record is updated as each one lands.

## Context

- The repository is public, but its front page, contribution policy and evaluation claims were written for one maintainer. Pull requests from outside the maintainers are closed automatically.
- Two plugins call a decisions endpoint (`jev-advisor` advice and checks, `verification-receipts` adequacy notes) with separate request, response and confidence handling. Adequacy calls the model even when the evidence is already known to be insufficient.
- The `rrsi` journal projection counts a returned advice decision as `adopt`. That is operational telemetry, not task quality, yet replay can rank it as reward.
- `self-improve/` has guarded proposal, distillation and replay machinery, but no evaluator that compares the behaviour of an actually loaded GJC harness against an unchanged baseline. [HARNESS2.md](../../self-improve/HARNESS2.md) is a proposal.

## Decision

1. **Public onboarding.** The README is the front page: each plugin is listed with what it proves and does not prove, and the keyless first-success path is executable as [`scripts/onboarding-smoke.mjs`](../../scripts/onboarding-smoke.mjs).
2. **Owner-controlled external pull requests.** Outside pull requests are accepted. Their code runs only when the owner dispatches a trusted workflow on `main` for a reviewed head SHA, in a disposable GitHub-hosted job without secrets, write tokens, persistent caches or self-hosted runners; a separate trusted job verifies identity and result. Pushes to `main` keep running CI automatically. *(planned)*
3. **One typed decision contract at the real consumers.** Provider envelopes and confidence meanings are recorded per provider and never guessed; unknown model mappings are unavailable rather than aliased; ineligible adequacy input returns before any network call; existing defaults and configured thresholds keep their behaviour. *(planned)*
4. **Operational versus quality reward.** RRSI keeps its operational projection labelled as operational. Only immutable trial receipts with an independent outcome and complete cost enter a versioned quality cohort used for efficacy ranking. *(planned)*
5. **Offline-first Harness² machinery.** A versioned task manifest with independent oracles and development/holdout splits; comparison arms B0, B1 and B2 (below); a pre-call budget predicate that fails closed; validity checks kept separate from benefit analysis; per-trial isolation. Live trials need a separately approved budget and are recorded as not run until then. *(planned)*
6. **Byte-verified releases.** Final bytes are built and verified once, then installed and released unchanged, with a tested rollback to the preserved previous bytes. *(planned)*

## Evaluation rules

These rules bind any future claim that a plugin or harness change improves outcomes.

- **Pilot design.** 12 artifact-check, 12 eligible-adequacy and 12 small repository tasks; 6 development and 6 holdout tasks per class; 3 stochastic repeats per arm, with the paired task as the unit of analysis.
- **Arms.** B0 runs the unchanged harness once. B1 repeats the unchanged harness under the same total resource ceiling as B2 and selects the first result that passes public build and schema checks. B2 runs the refined or composed harness with every proposal, selection, judge and retry cost counted. Actual spend is reported separately from the shared ceiling.
- **Separation of factors.** Decision-model comparisons fix the harness and input; harness comparisons fix the model. A run that changes both is not reported as a harness gain.
- **Holdout.** Holdout tasks run once, after candidate, model, prompt, tools, configuration and thresholds are frozen, and never feed proposal, selection or memory.
- **Denominators.** Failures, timeouts and unknown costs stay in the denominator or in a declared exclusion set; a missing cost is never zero; zero accepted tasks makes cost per accepted task undefined.
- **Benefit.** Promotion requires predeclared paired criteria: no critical regression, no lower coverage on decidable cases, and a paired quality delta whose lower bound is at least zero with a cost-ratio upper bound below one, or a separately preregistered matched-ceiling test. Small pilots usually end as "insufficient evidence"; that blocks promotion, not the implementation.

## Alternatives considered

- **Issues only.** Rejected: it does not accept outside contributions.
- **Automatic CI on external pull requests.** Rejected: untrusted code would run without an owner decision.
- **Owner-local disposable validation instead of hosted dispatch.** A viable fallback for low volume, without a hosted record.
- **Porting the upstream Harness² framework wholesale.** Rejected: it would replace the existing guards and ledger, and upstream benchmark numbers do not transfer to this repository.

## Consequences

- The owner dispatches validation for each external pull request.
- Engineering checks (builds, tests, smoke runs) are reported separately from efficacy evidence.
- Demand from people other than the maintainer is an unvalidated hypothesis; no metric in this repository claims adoption.

## References

- Harness²: <https://arxiv.org/abs/2610.14224>; upstream snapshot <https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335>.
- Dream-RSI: <https://arxiv.org/abs/2609.14858>.
- Decision models in the OpenGateway catalog (`sionic-ai/jev-omni`, `sionic-ai/decider-4b`): <https://apis.opengateway.ai/v1/models>.
