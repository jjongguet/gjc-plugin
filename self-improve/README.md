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
| `lib/` | node-only `.mjs` engine modules (`types`, `domain`, `ledger`, `budget`, plus engine/gates/isolate/runner as they land) |
| `domains/gjc-plugin/` | first domain: probes and held-out fixtures (run via `bun`, stdout JSON) |
| `scripts/run.mjs` | CLI (`report`, `cycle`) |
| `scripts/verify-unit.mjs` | runs the unit suite; prints `ALL PASS (N cases)`; zero cases fails |
| `tests/unit/` | `node:test` unit suite (node builtins only) |
| `rrsi.json` | gate defaults (minDelta, k, stall, cost, budget schedule, retention) |
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

Early scaffold: ledger/budget primitives and the unit suite exist; cycle
execution (engine, gates, isolation) lands with the engine milestone.

## Commands

```sh
node self-improve/scripts/run.mjs report --json
node self-improve/scripts/verify-unit.mjs
bun run test:self-improve
bun run self-improve:cycle -- --domain gjc-plugin --proposal <path>
```
