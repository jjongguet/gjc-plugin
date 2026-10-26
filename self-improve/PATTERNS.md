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

## Replay / dreaming (P2/P3)

- **Epochs**: replay an attempt only at its recorded code state. The boundary is
  the editable-surface digest; the observable event is an adoption. Ledger-only
  `chore` commits and concurrent-lane commits are not boundaries, so `baseCommit`
  is provenance, never the epoch key. Adoption order is preserved; rejects inside
  an epoch are freely reorderable; attempts recorded before a replayed slice are
  ex-ante prior knowledge.
- **Selection features**: objective/gap id, attempt index within the branch,
  hypothesis-novelty flag, files/hunks, prior *revealed* outcomes of the same
  branch, prior guard-failure classes, budget rung. Verdicts, deltas and the
  order/adoption flags of unplayed attempts stay sealed until selection.
- **Policy space**: order rule (fixed, round_robin, success_greedy,
  failure_greedy, novelty_first) × batch size 1–3 × stall switch × stop rule;
  40 deterministic candidates (≤48). π\* is chosen on the train split only; the
  validation split exists to evaluate the frozen thresholds.
- **Determinism**: same ledger + seed ⇒ byte-identical receipt (`receiptHash`).
  No timestamps, randomness or network in the replay/dream path.
- **Wording**: report a met threshold as "met the pre-registered P2 thresholds";
  below the pass gate the verdict is the measured insufficient-evidence string;
  never claim bare "proven". The pinned no-significance/CI caveat sentence lives
  in `DREAM.md` and `replay-protocol.json` and is reused verbatim in the evidence
  map.

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

## M1 measured guard coverage (2026-10-27, cost 0)

Measured by `self-improve/m1/run-m1.mjs` over sourceHead `dbb8864`
(artifact `artifacts/harness2-rrsi-20261027/`): two planted-defect tasks × two
guard sets, one isolated `git archive` snapshot per cell.

| task | B0 drift-only | B1 drift+acceptance |
| --- | --- | --- |
| generated-surface drift | 5 (12 ms, 1 call) | 5 (2.81 s, 2 calls) |
| manifest tool path broken | **0 — missed** (8 ms) | 5 (2.79 s) |
| clean control | 5 (8 ms) | 5 (2.79 s) |

Resulting rule: `bun rrsi/scripts/build.mjs --check` is a drift-only guard. It
never saw the `gajae-plugin.json` contract defect, and the acceptance suite that
did costs ~2.8 s — so there is no cost argument for substituting the drift gate on
a manifest or contract change. Run `bun rrsi/scripts/verify.ts` whenever the
touched files include `gajae-plugin.json`, a tool schema or a generated surface;
the drift gate alone is enough only for source-only edits the builder regenerates.

Scope: guard coverage, not agent behaviour. No model call, no spend, no
significance claim; the paid M1 pilot is still unrun.

## Honesty

Missing is not zero; unmeasured is `null`; unrun is `skipped`. No completion
claim without a receipt. Flaky repository tests are never silently retried: a
guard failure rejects the cycle — fix the flaky test in the repository instead.
Ledger rows are <= 2 KiB; raw logs stay in
`~/.gjc-plugin/self-improve/runs/<cycleId>/` (0700, never committed).
