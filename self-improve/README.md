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
| `lib/` | node-only `.mjs` engine modules (`types`, `domain`, `ledger`, `budget`, `gates`, `engine`, `guards`, `isolate`, `runner`, `propose`, `loop`, `replay`, `dream`, `policy`) |
| `domains/gjc-plugin/` | first domain: probes and held-out fixtures (run via `bun`, stdout JSON, incl. per-case `failures` labels) |
| `scripts/run.mjs` | CLI (`report`, `cycle`, `loop`, `recover`, `prune`, `runner`, `history`) |
| `scripts/verify-unit.mjs` | runs the unit suite; prints `ALL PASS (N cases)`; zero cases fails |
| `scripts/verify-integration.mjs` | runs the integration suite the same way; part of the `test:self-improve` chain and therefore every cycle's `test` guard |
| `tests/unit/` | `node:test` unit suite (node builtins only) |
| `tests/integration/` | `node:test` integration suite (temp git fixtures; calls the real `gjc`/`bun`/`git` toolchain) |
| `rrsi.json` | gate defaults loaded by the engine (minDelta, cost, stall, retention) and the policy defaults (seed, candidate cap, betas) |
| `DREAM.md` | replay/dreaming protocol spec: digest-epoch rule, reveal protocol, thresholds, pinned caveat, residual-surface note |
| `replay-protocol.json` | pre-registered P2 numbers/epoch/reveal/threshold statements (committed before the dream run) |
| `policies/` | committed policy artifacts (`<id>.json`) plus the `current.json` pointer |
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
ban, forced exploration) and the k>=3 local-stub stochastic runner. The bounded
automatic loop (`loop`) drives that engine without hand-written proposals via the
`stub`/`cmd` proposer seam, with per-cycle loop state, `failureClass` labels and
the HEAD-moved re-propose rule. The real-cycle report lands with the final
milestones.

## Commands

```sh
node self-improve/scripts/run.mjs report --json
node self-improve/scripts/run.mjs history --json
node self-improve/scripts/verify-unit.mjs
node self-improve/scripts/verify-integration.mjs
node self-improve/scripts/run.mjs cycle --proposal /tmp/proposal.json --repo . --dry-run --json
node self-improve/scripts/run.mjs cycle --proposal /tmp/proposal.json --repo .
node self-improve/scripts/run.mjs loop --max-cycles 2 --proposer stub --json
node self-improve/scripts/run.mjs loop --max-cycles 1 --proposer cmd --proposer-cmd 'node tools/proposer.mjs {request} {response}' --live-approved --json
node self-improve/scripts/run.mjs replay --corpus ledger --json
node self-improve/scripts/run.mjs replay --policy <id> --json
node self-improve/scripts/run.mjs dream --seed 1 --out receipt.json --json
node self-improve/scripts/run.mjs policy --list --json
node self-improve/scripts/run.mjs policy --deploy <id> [--dry-run] --json
node self-improve/scripts/run.mjs recover --repo .
node self-improve/scripts/run.mjs runner --baseline . --candidate . --k 3 --json
bun run test:self-improve
```

Run the CLI from the repository root: the engine's patch parsing follows git's
restriction that `git apply` ignores paths outside the current directory when it
is invoked from a repository subdirectory.

## Automatic loop (`loop`)

```sh
node self-improve/scripts/run.mjs loop --repo . [--proposer stub|cmd] [--proposer-cmd '<template>'] \
  [--live-approved] [--max-cycles N] [--max-wall-ms T] [--max-proposer-calls C] [--batch-size W] \
  [--stop-on-adopt] [--loop-id <id>] [--run-root <path>] [--ledger <path>] [--dry-run] [--json]
```

Each iteration: recover sweep (`recoverPendingCycle`) → admissible-action
selection (stalled objectives blocked, least-attempted first, unexplored probes
reported) → proposer request → proposer invocation → validation pipeline →
serialized `runCycle` calls → loop-state persistence. `--dry-run` propagates to
the engine (full evaluation, no ledger rows and no commits).

- **Request**: objective, failing probe cases as short `<metric>#<index>` labels,
editable surfaces, rung caps (`maxFiles`/`maxHunks`), base commit, prior attempts,
and constraints (editable-only, no network, no timers, no secrets, patch must
`git apply` at HEAD).
- **Proposer seam**: `stub` is a keyless scripted test double; `cmd` runs a
template via `sh -c` inside a fresh `git archive` scratch copy with
`self-improve/domains/**` excluded (held-out fixtures never reach the proposer),
with `sanitizeGuardEnv` filtered through an explicit allowlist. Request files
and loop logs record env key names only, never values. `cmd` is live mode:
without `--live-approved` the invocation is recorded `skipped`.
  - Live template: `--proposer-cmd 'node self-improve/scripts/propose-with-gjc.mjs {request} {response}'`
    drives the installed `gjc` CLI (`--print`, non-interactive, no tools) with a
    strict "reply with one JSON object" prompt and writes the first complete JSON
    object it finds to the response path. Model/binary/timeout overrides are
    template-prefix env assignments (`GJC_PROPOSER_MODEL=…`, `GJC_PROPOSER_BIN=…`,
    `GJC_PROPOSER_TIMEOUT_MS=…`); the helper never logs environment values. Live
    runs still require `--live-approved` and the frozen caps in
    `rrsi-protocol.json`.
- **Validation**: schema, budget pre-check, protected-path pre-check,
hypothesis-novelty pre-check, verbatim held-out value scan over the patch's
added lines only (probe-corpus vocabulary is not treated as held-out; matches
are reported as short hashes).
- **Bounds**: max cycles, max wall-clock, max proposer calls, batch size <= W
(proposal preparation only — engine cycles stay serialized by the cycle lock).
No timers; guard failures are never retried; a crashed cycle is swept by
`recover` on the next start.
- **HEAD-moved rule**: a proposal authored against an old HEAD is discarded
un-evaluated and re-proposed; repeated movement stops the campaign.
- **State**: only under `<run-root>/loop-<loopId>/` (`~/.gjc-plugin/self-improve`
by default) — `loop-state.json` (incl. per-cycle `failureClass`:
`known_flake_suspect` vs `other`), append-only `loop-log.jsonl`, request files,
proposer scratch copies. Nothing is written into the repository outside the
engine's own ledger commits.
- **Pre-registration**: `rrsi-protocol.json` freezes the headroom derivation
(denominator, per-case delta, required repaired cases), the spec-sourced gap
clusters, the M2/M4 caps with auto-stop, the dual-floor decision rule, the P2
validation minimum, the corpus sha256 and the no-post-hoc-edits sentence.
Headroom cases live in `domains/gjc-plugin/probes/fixtures.json` with a
`provenance` object naming the documented statement; held-out parallels carry
`parallelOf`. See `PATTERNS.md` for the procedure.

## Honest evidence boundary (mandated disclosure)

**Establishes:** the Dream-RSI core (trace→replay→dreaming→redeploy) is implemented, real, and functional on this repository's recorded search space; the loop landed a real, guard-green, heldout-clean, committed improvement without a hand-written proposal (**P1 DEGRADED — 1 adoption, the plan's minimum count; target 2 not reached because the single adopted patch consumed the remaining headroom**); the protocol was frozen and content-hashed before the evidence runs (commits re-created into review order afterward — integrity-pre/post receipts prove no post-hoc changes) and the dream is deterministic and byte-reproducible; **measured checkpoint — P2:** the corpus froze below the pass gate (13 attempts < 20; pass-1 floor of 12 met), so the frozen verdict is `insufficient evidence at pass-gate size — thresholds not evaluated` and the advisory numbers (π* 6 attempts / 408s vs baselines 12 / 874s; validation-slice advisory smaller) are NOT a met-threshold claim; **measured checkpoint — P3:** the redeployed policy (`pi-1-25`) steered six live completed cycles — one earlier (`cyc-20261018182238-50bb`) and five in the final campaign (`cyc-20261018185941-9f39`, `cyc-20261018190244-9942`, `cyc-20261018190540-fab5`, `cyc-20261018190917-97bb`, `cyc-20261018191208-3956`) — with zero guard failures across all seven guards, so the five-cycle redeploy floor is met. All five final-campaign cycles were rejected (`floor_not_met`; two also `critic_secret` and one also `cost_rule`; the `critic_secret` blocks are verdict reasons, not guard failures), held-out coverage stayed 1.0 with zero regressions, and the redeployed state operates within the safety gates. The final campaign's receipts are `self-improve/evidence/p3/`; the earlier provider outages are recorded in the P3 evidence. **Does not establish:** statistical significance (n is tens; one realized corpus; post-hoc counterfactual reuse of recorded outcomes and costs); generalization to other repos/domains; superiority over human choices (baseline is fixed exploration); live-provider equivalence to stub behavior; indefinite improvement. **Session-authored corpus disclosure [F03]:** the probe corpus was expanded *this session* with spec-sourced cases (each carrying a `provenance` field) and session-authored held-out parallels; the P1 adoption deltas are measured on that expanded corpus under the documented best-effort held-out threat model — not on an externally curated benchmark. This full text ships verbatim in `self-improve/README.md` and the v0.0.6 release notes (whose scope is this session's change set only) [F08].

**Post-v0.0.6 update (JJO-213):** a second real adoption cycle (`cyc-20261018172021-6f5f`) replayed the live proposer's probability-bound patch and was adopted: delta 0.0588 >= 0.01, held-out coverage 0.9667 → 1.0 with no regressions, all seven guards pass, code commit `079da02` (six files, including the regenerated surfaces) and the adoption-recorded ledger row. The first adoption (`95f1600`) ran `--install`; the second was installed manually after the cycle and verified in the user-scope install, so the P1 dual-floor's ">=2 adoption cycles" is met. The second adoption is a manual replay, not a second live-proposer launch, and the P2 corpus remains frozen at 13 attempts below the 20 pass gate; the P2/P3 measured checkpoints above are unchanged. The v0.0.6 text remains the release-time disclosure.


## Replay and dreaming (P2/P3)

Recorded cycles are replayed off-policy (no agent, no evaluator rerun) as
epoch-partitioned worlds: the epoch boundary is the editable-surface digest, with
adoptions as the observable boundary event and `baseCommit` as provenance only.
Baselines B0 (recorded order) and B1 (round-robin) and the dreamed policy π\*
(selected on the train split from ≤48 deterministic candidates) are scored on
the same recorded set; outcomes are revealed only after selection and selection
sees ex-ante features only. Thresholds, the digest-epoch rule and the reveal
protocol are frozen in `replay-protocol.json`; the full spec is `DREAM.md`.

*"All P2 comparisons are off-policy replays over ONE realized corpus of fewer
than ~24 recorded attempts; no statistical significance is claimed; effect
sizes are reported with n and are not confidence-interval estimates of future
performance; the cost proxy is load-dependent recorded wallMs, not a fresh
measurement."*

Below the pass gate the verdict is `insufficient evidence at pass-gate size —
thresholds not evaluated` (measured, never downgraded), and a met threshold is
reported as "met the pre-registered P2 thresholds", never as bare "proven".

## Runbook

1. Write a proposal JSON next to its patch; `patchFile` resolves relative to the
   proposal file (`cycle`), or run the `loop` above and let the proposer author
   it against the current HEAD.
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
