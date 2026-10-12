# self-improve patterns

Rules the proposal and review sides follow. Evidence over vibes: every claim
points at a command, a receipt, or a ledger row.

## Proposals

- One hypothesis per cycle. Record it as `hypothesisHash` (sha256 of the
  hypothesis text) plus a named `objective` (the probe metric being moved).
- Resubmission ban: the same `(objective, hypothesisHash)` must not be
  resubmitted until the probe files change; the engine rejects it as
  `history_duplicate_hypothesis` before spending evaluations.
- Stalled objectives are redirected: K=3 consecutive rejections on the same
  objective force the next proposal onto an unexplored probe
  (`forced_exploration`).
- Budget: the rung tightens with accepted cycles in the campaign (0 accepted ->
  3 files/12 hunks, 1 -> 2/8, 2+ -> 1/4). Resets require an auditable reason:
  rotating the campaign id, or the explicit `--reset-budget` flag (accepted
  count treated as 0).

## Commit pattern (max 3 commits per accepted cycle)

1. `chore(self-improve): cycle <cycleId> <decision>` — ledger only.
2. `feat|fix(<plugin>): ...` — the accepted code change (regenerated surfaces included).
3. `chore(self-improve): record adoption <cycleId>` — ledger only.

Rejected cycles commit only the cycle record. Push, `--install` and releases
are separate, explicitly gated steps.

## Protected paths (hard reject)

Tests, verifiers (`scripts/verify.ts`), `package.json` scripts, held-out
fixtures, `self-improve/` itself, anything under `.gjc/`, secret files. Editing
generated surfaces by hand, or adding network/timer behaviour, fails the critic.

## Threat model (held-out)

The proposer is a cooperative same-actor component; fixture secrecy is
best-effort, not enforced. Effective defenses are the critic's hardcoding scan,
the protected path set, and manual review of the cycle record. This limitation
is recorded here on purpose.

## Labels

`subskills/jev-advisor/SKILL.md` is scored as a `text_fixture` (text input),
never as a runtime-loaded skill surface: the plugin manifest does not register
`subskills`, the installed bundle does not contain it, and skill loaders scan
only project `.gjc/skills/` and user `~/.gjc/agent/skills/`.

## Headroom (M2)

Probes start saturated (every metric at 1.0, `delta = 0 < floor`), so the loop
cannot adopt anything until the corpus contains cases the current
implementation genuinely misses. Procedure:

- **Source each case from a documented statement**, never from implementation
  behavior: `provenance = {source, statement, cluster, note}` names the plugin
  spec line (README / SKILL.md / decision.ts) the expectation comes from. Cases
  the current code already satisfies create no headroom and are not added for
  that purpose.
- **Clusters**: cases that fail for the same reason form one cluster, repaired
  by one change. Independent clusters are pre-registered in
  `rrsi-protocol.json` so the live proposer keeps a fallback; each cluster's
  `cases / denominator` must cross `floor` on its own.
- **Held-out parallels** mirror each cluster with different values (same
  behavior class) and carry `parallelOf`, keeping the non-regression gate
  meaningful. Numeric-boundary clusters use decimal-exact expectations (the
  documented tolerance is decimal, not binary). Where a cluster has an upper
  bound (the 64 KiB response cap), the probe suite also carries the at-cap
  accept case so an over-strict repair cannot adopt.
- **Derivation** (frozen in `rrsi-protocol.json` before the first live cycle):
  `delta = repaired/denominator`, `required = ceil(floor x denominator)`; the
  denominator is the `decision_accuracy` probe case count and `floor` comes from
  `rrsi.json`.
- **Disclosure**: the probe corpus was expanded this session and P1 deltas are
  measured on that expanded corpus (README carries the mandated boundary text).
  The M2 gap hunt ran as throwaway batteries recorded under
  `artifacts/dream-rsi-01a130dd-20261013/m2-gap-hunt/` — zero-violation
  batteries are evidence too. The 64 KiB cap cases make the fixture files large
  on purpose: the byte size is the contract under test.

## Partial regularization (limits)

What is deliberately not regularized yet:

- Hypothesis resubmission is keyed to `(objective, hypothesisHash)` without a
  probe-file content hash: changing only fixtures does not unlock a rejected
  hypothesis — update the hypothesis text when the corpus changes materially.
- Stall redirection blocks a stalled objective and marks the redirect cycle
  (`forcedExploration`), but choosing the next objective remains proposer work;
  the engine reports the unexplored objectives.
- Stochastic calibration is one baseline spread per side (median comparison);
  no bootstrap or multi-campaign calibration exists.
- Held-out coverage remains best-effort per the threat model above.

## Honesty

Missing is not zero; unmeasured is `null`; unrun is `skipped`. No completion
claim without a receipt. Flaky repository tests are never silently retried: a
guard failure rejects the cycle — fix the flaky test in the repository instead.
Ledger rows are <= 2 KiB; raw logs stay in
`~/.gjc-plugin/self-improve/runs/<cycleId>/` (0700, never committed).
