# self-improve

Repo-native harness self-improvement loop over this repository's own plugin
surfaces (regularized recursive self-improvement, inspired by the RRSI design).

The loop edits only declared `editable` source paths, scores candidates with the
repository's deterministic checkers (build / test / verify / validator / smoke)
plus declared probes, and records every decision in an append-only ledger
(`ledger.jsonl`) that is committed as the proof stream.

## Layout

| Path | Role |
| --- | --- |
| `lib/` | node-only `.mjs` engine modules (`types`, `domain`, `ledger`, `budget`, `gates`, `engine`, `guards`, `isolate`, plus `runner` as it lands) |
| `domains/gjc-plugin/` | first domain: probes and held-out fixtures (run via `bun`, stdout JSON) |
| `scripts/run.mjs` | CLI (`report`, `cycle`) |
| `scripts/verify-unit.mjs` | runs the unit suite; prints `ALL PASS (N cases)`; zero cases fails |
| `tests/unit/` | `node:test` unit suite (node builtins only) |
| `rrsi.json` | gate defaults loaded by the engine (minDelta, cost, stall, retention) |
| `PATTERNS.md` | proposer/review rules (commit pattern, resubmission ban, threat model, labels) |

## Gates

Leakage critic, noise-adjusted floor, cost rule, held-out non-regression,
annealed edit budget, pruner, and proposal-side history/stall regularization.
Partial regularization: anything beyond this set is explicitly out of scope.

## Safety invariants

- Candidates run in `git archive` scratch copies with an allowlisted environment; the live `~/.gjc/agent` is never modified. Installation is an explicit `--install` flag on an accepted cycle.
- Keyless: the loop never reads credentials; logs and ledger rows contain no secrets.
- Commits: at most three main commits per accepted cycle — ledger-only `chore(self-improve): cycle <cycleId> <decision>`, the code commit, and ledger-only `chore(self-improve): record adoption <cycleId>`. Push, install and release stay separate steps.
- `subskills/jev-advisor/SKILL.md` is scored only as a `text_fixture` (plain text input); it is not a runtime-loaded surface.

## Status

The deterministic cycle engine is in place (gates, guard pipeline, scratch-copy
isolation, replay-gated adoption, ledger commits, crash recovery), together with
the deterministic probe/held-out suites, history conditioning (duplicate-hypothesis
ban, forced exploration) and the k>=3 local-stub stochastic runner. The real-cycle
report lands with the final milestones.

## Commands

```sh
node self-improve/scripts/run.mjs report --json
node self-improve/scripts/run.mjs history --json
node self-improve/scripts/verify-unit.mjs
node self-improve/scripts/run.mjs cycle --proposal /tmp/proposal.json --repo . --dry-run --json
node self-improve/scripts/run.mjs cycle --proposal /tmp/proposal.json --repo .
node self-improve/scripts/run.mjs recover --repo .
node self-improve/scripts/run.mjs runner --baseline . --candidate . --k 3 --json
bun run test:self-improve
```

## Runbook

1. Write a proposal JSON next to its patch; `patchFile` resolves relative to the
   proposal file.
2. Dry-run first: evaluates baseline and candidate scratch copies with the full
   guard set and probes, writes nothing and commits nothing.
3. Run the real cycle: one ledger row plus a ledger-only
   `chore(self-improve): cycle <id> <decision>` commit. Adoptions add the code
   commit (including regenerated surfaces) and the adoption row (see
   `PATTERNS.md`). Accepted cycles can optionally install with `--install`
   (user-scoped `gjc plugin upgrade` + `gjc plugin doctor`, recorded on the
   adoption row) and reset the annealed rung with `--reset-budget`.
4. `history --json` exposes recent rejects, per-objective reject streaks and
   stalled objectives; `recover --repo .` rolls back a cycle that crashed
   mid-apply.

Proposal shape:

```json
{
  "source": "manual",
  "hypothesis": "why this edit should move the objective",
  "objective": "probe.decision_accuracy",
  "commitMessage": "fix(jev-advisor): ...",
  "patchFile": "relative-or-absolute.patch"
}
```

The stochastic runner is keyless by default (`local_stub`: k>=3 pinned
`gjc --print` trials against an in-process loopback scripted provider). Live
provider calls require `--live-approved` and an approved budget; without it the
run is recorded as `skipped`.
