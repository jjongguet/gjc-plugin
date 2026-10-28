# Changelog

Each plugin carries its own version in `gajae-plugin.json`; a repository release tags the set of plugin versions listed under it. Versions follow the `0.0.x` series.

## [0.0.16] - 2026-10-29

Plugins: jev-advisor 0.0.12 · verification-receipts 0.0.8 · ui-regression 0.0.9 · wiki 0.0.7 · rea 0.0.7 · backplan 0.0.10 · rrsi 0.0.6 · aside-memory 0.0.2

### Added

- **verification-receipts, ui-regression**: `invalid_case_id` no-decision reason for a well-formed case-note id outside the invocation's eligible set; the result names the constant allowed ids and never echoes the rejected id or note (JJO-1056).
- **ui-regression**: specific `scenario_*` execution reasons (for example `scenario_url_sensitive`, `scenario_url_host`, `scenario_action`) with fixed recovery guidance in place of the generic not-run reason.

### Changed

- **verification-receipts, ui-regression**: the public `assessment` schema (all four tools) and the `ui_regression_run` `scenario` schema are plain strings. Eligible ids, actions and limits are stated in field descriptions and decided in-plugin, because GJC validates declared constraints before the plugin runs and its error can echo the call arguments. Top-level parameter constraints are unchanged.
- **jev-advisor, verification-receipts, ui-regression, wiki, rea, backplan, rrsi**: the shared private-result reader accepts `invalid_case_id` and the `scenario_*` reasons; bundles regenerated.
- `smoke-host.mjs` requires a non-member case id to reach the plugin and asserts that neither the id nor a synthetic note canary appears in the result or journal; `--ui-rejections` adds an unsupported-action canary probe.

### Upgrade notes

- Reinstall in order: `jev-advisor` first, `verification-receipts` second, then `ui-regression`, `wiki`, `rea`, `backplan`, `rrsi`. A pre-0.0.16 reader fails closed (`store_corrupt`) on journal records carrying the new reasons. Start a new `gjc` session afterwards.

## [0.0.15] - 2026-10-28

Plugins: jev-advisor 0.0.11 · verification-receipts 0.0.7 · ui-regression 0.0.8 · wiki 0.0.6 · rea 0.0.6 · backplan 0.0.9 · rrsi 0.0.5 · aside-memory 0.0.2

### Added

- **rrsi**: `cohort` action — reads one bounded `gjc.quality_trial.v2` receipt file and returns the counts-only `rrsi.quality_cohort.v2` cohort (`total`, `admissible[]`, `excluded[{reason,count}]`, `duplicate`); no rate, delta or verdict.
- **self-improve** (repository tooling, not an installed plugin): Harness² M1 cost-zero guard-ablation runner, loading-receipt producer, preflight and the bounded native B0/B1/B2 pilot executor with recording proxy and live admission contract (JJO-270, JJO-944, JJO-945).
- `supervisor/` — a repository-native workspace session supervisor (JJO-913): ten-minute collection over local lane sessions and the mini host, deterministic stall judgment (`progressing`/`thrashing`/`stalled`/`starting`/`unknown`), one `jev-omni` decision only for the dirty-tree ambiguity, a Discord summary, and a single-target `tmux send-keys` steer with marker verification. No kill path and no daemon install; the loop runs only in an operator-started tmux session.

### Changed

- **rrsi**: periodic import projects the newest journal window, and `lastSuccessAt` renews only when the projection covers every segment of the retained window (torn tails stay stale).
- **jev-advisor, verification-receipts, ui-regression, wiki, rea, backplan**: the shared private-result reader accepts the new `cohort` operation; bundles regenerated.

### Upgrade notes

- Reinstall in order: `jev-advisor` first, `verification-receipts` second, then `ui-regression`, `wiki`, `rea`, `backplan`, `rrsi`. A pre-0.0.15 reader fails closed (`store_corrupt`) on journal records carrying the `cohort` operation. Start a new `gjc` session afterwards. — a repository-native workspace session supervisor (JJO-913): ten-minute collection over local lane sessions and the mini host, deterministic stall judgment (`progressing`/`thrashing`/`stalled`/`starting`/`unknown`), one `jev-omni` decision only for the dirty-tree ambiguity, a Discord summary, and a single-target `tmux send-keys` steer with marker verification. No kill path and no daemon install; the loop runs only in an operator-started tmux session.

## [0.0.14] - 2026-10-26

Plugins: jev-advisor 0.0.10 · verification-receipts 0.0.6 · ui-regression 0.0.7 · wiki 0.0.5 · rea 0.0.5 · backplan 0.0.8 · rrsi 0.0.4 · aside-memory 0.0.2

### Added

- `scripts/tests/ultragoal-succession.test.mjs` reproduces the ultragoal succession lifecycle of the installed `gjc` (JJO-513): `succession offer` → `adopt` → the successor completes every handed-off goal → the source run must finish cleanly. The stable scenario steps always assert; the close assertion skips with a recorded reason while the installed `gjc` still refuses `complete-goals` through the outgoing fence (verified on 0.18.12 and 0.19.0), and fails when that refusal message changes.

### Fixed

- **ui-regression**: `ui_regression_run` pins its Aside REPL invocation to the local session host (`--host local`). The scenario origin is strictly loopback, so the browser must run on the machine that serves the fixture; a cloud session host can never reach it and every run ended `failed: origin_drift` (JJO-745). A real-browser clean pass (visible/text assertions passing, owned tab closed) is now reachable; the runner still opens only its own tab in the shared local Aside Browser and never attaches to existing tabs.

### Upgrade notes

- Reinstall `ui-regression` and start a new `gjc` session: tool behavior is read at session start.

## [0.0.13] - 2026-10-26

Plugins: jev-advisor 0.0.10 · verification-receipts 0.0.6 · ui-regression 0.0.6 · wiki 0.0.5 · rea 0.0.5 · backplan 0.0.8 · rrsi 0.0.4 · aside-memory 0.0.2

### Fixed

- **jev-advisor**: `JEV_ADVISOR_PROVIDER=typesafe-jev` no longer sends the OpenRouter key to `api.typesafe.ai`. Each provider reads only its own variable (`OPENROUTER_API_KEY` for `jev`/`openrouter`, `TYPESAFE_API_KEY` for `typesafe-jev`), `JEV_ADVISOR_API_KEY` stays the explicit override, and a missing key reports `unconfigured` instead of a 401 from the wrong service.
- **jev-advisor**: the shared decision-provider record named `OPEN_GATEWAY_API_KEY` and `OPENAI_API_KEY` for the OpenGateway candidates; it now names `OPENGATEWAY_API_KEY` alone.

### Upgrade notes

- Reinstall `jev-advisor` (`gjc plugin upgrade jev-advisor --user`) and start a new `gjc` session: hooks are read at session start.

## [0.0.12] - 2026-10-25

Plugins: jev-advisor 0.0.9 · verification-receipts 0.0.6 · ui-regression 0.0.6 · wiki 0.0.5 · rea 0.0.5 · backplan 0.0.8 · rrsi 0.0.4 · aside-memory 0.0.2

### Added

- **verification-receipts**: `verification_loop` takes an optional `repository` (same roots and rejection reasons as `verification_run`), so a session started in a non-Git workspace root can evaluate a named repository. Such a session records no delegation gates, so that call reports `blocked` with an `ungated_session_cwd` warning instead of `clean`.
- **ui-regression**: `ui_regression_run` and `ui_regression_status` take the same optional `repository`; run records a receipt against a repository inside a non-Git session directory and status reads it with the same argument.

### Fixed

- **verification-receipts**: a failing `execSync` or promisified `exec` whose shell reports a command the runner `PATH` cannot resolve is recorded as `missing_binary` (warning `missing_binary:<name>`); a command present on `PATH` that exits non-zero stays `native_failure`.

### Upgrade notes

- Reinstall `verification-receipts` and `ui-regression`, then start a new `gjc` session: tool parameters are read at session start.

## [0.0.11] - 2026-10-24

Plugins: jev-advisor 0.0.9 · verification-receipts 0.0.5 · ui-regression 0.0.5 · wiki 0.0.5 · rea 0.0.5 · backplan 0.0.8 · rrsi 0.0.4 · aside-memory 0.0.2

### Added

- **verification-receipts**: `verification_run` and `verification_status` take an optional `repository`, a work-tree root that is the session repository or lies inside the session directory, so a session started in a non-Git workspace root can record and read receipts.
- **verification-receipts**: a failing test that could not start a program missing from the runner `PATH` is recorded as a `missing_binary:<name>` receipt warning, and the execution reason is `missing_binary` when every failure has that cause.
- `docs/ultragoal-gate-evidence.md` documents the evidence the ultragoal quality gate accepts; `scripts/tests/ultragoal-gate.test.mjs` checks it against the installed `gjc` and skips without one.

### Changed

- **verification-receipts**: tests receive the host `PATH` (absolute entries only), so suites that start `bun` or `git` run as they do in a shell; `HOME`, credentials and every other variable stay withheld.
- **verification-receipts**: rejected input names its cause (`not_a_repository`, `missing_test_file`, `invalid_test_path`, …) instead of `invalid_or_unavailable_input`.

### Upgrade notes

- The shared results journal accepts four new execution reasons. Reinstall `jev-advisor` first, then `verification-receipts`, then the rest, and start a new `gjc` session.

## [0.0.10] - 2026-10-23

Plugins: jev-advisor 0.0.8 · verification-receipts 0.0.4 · ui-regression 0.0.4 · wiki 0.0.4 · rea 0.0.4 · backplan 0.0.7 · rrsi 0.0.3 · aside-memory 0.0.2 (unchanged)

### Fixed

- `policy:check` inspects single-line `run:` steps that carry `${{ … }}` and flow-style triggers such as `on: [push, pull_request]`.

## [0.0.9] - 2026-10-23

Plugins: jev-advisor 0.0.8 · verification-receipts 0.0.4 · ui-regression 0.0.4 · wiki 0.0.4 · rea 0.0.4 · backplan 0.0.7 · rrsi 0.0.3 · aside-memory 0.0.2

### Added

- Pull requests are accepted through the owner-dispatched `pr-validate.yml` lane: their code never runs automatically, a GitHub-hosted candidate runs without secrets, a write token or a cache, and a trusted verifier posts `owner-pr-validation` on the reviewed SHA.
- `scripts/onboarding-smoke.mjs` runs the README quick start end to end in a throwaway GJC root.
- `shared/lib/decision-contract.ts` records every decision provider; adequacy questions the supplied evidence cannot answer return before any provider call.
- self-improve: offline Harness² evaluation machinery in `self-improve/lib/behavior-eval.mjs`; no live trial has run.

### Changed

- README rewritten as the public front page with a keyless quick start, a plugin selector and a claim-to-evidence table.
- **rrsi** separates its operational journal projection from a versioned quality cohort that only admits independent outcomes with a measured cost.

### Fixed

- **shared**: the append lock no longer reports `unsafe_path` when another appender releases it mid-probe.

## [0.0.8] - 2026-10-20

Plugins: jev-advisor 0.0.7 · verification-receipts 0.0.3 · ui-regression 0.0.3 · wiki 0.0.3 · rea 0.0.3 · backplan 0.0.6 · rrsi 0.0.2 · aside-memory 0.0.1

Fixes from the boundary review of the 0.0.7 change set.

### Fixed

- **backplan**: a missing `project.mode` or automation-candidate `disposition` is reported once, not twice.
- **rea**: rejected `rea_readiness` input is journaled (`not_run` / `invalid_or_unavailable_input`) like every other handled invocation.
- `docs:check` now checks reference-style links and rejects links that escape the repository or have malformed percent-encoding; it ignores scheme and protocol-relative links, fences inside block quotes and indented code.
- `evidence:check` also catches lowercase Windows and `file://` home paths.

### Added

- `scripts/tests/checks.test.mjs`, first in `bun run test`: pass and fail fixtures for `docs:check`, `evidence:check` and `policy:check`, and a drift probe for every plugin's `build --check`.

## [0.0.7] - 2026-10-20

Plugins: jev-advisor 0.0.7 · verification-receipts 0.0.3 · ui-regression 0.0.3 · wiki 0.0.3 · rea 0.0.2 · backplan 0.0.5 · rrsi 0.0.2 · aside-memory 0.0.1 (first release)

### Added

- **aside-memory** plugin: `aside_memory`, an explicit account-bound, read-only search over Aside memory that returns bounded quotations with relative citations and screened states.
- **jev-advisor**: `jev_check`, a one-shot strict `correct` / `incorrect` / `unsure` check of one artifact against one question; a Hermes cron pre-delivery gate under `integrations/hermes/jev-gate/`; host-only actual-tier and effective-model coverage in metrics.
- **rrsi**: a due-gated `session_start` periodic refresh (no timer process) that projects the jev-advisor journal into the store, with bounded backoff, locks and receipts.
- `bun run demo`: a keyless demo of backplan, rrsi and rea through their generated tools under a temporary `HOME`.
- `bun run build:check`, `docs:check`, `evidence:check` and `policy:check`, all run in CI.
- `SECURITY.md` with private vulnerability reporting, issue forms and an English repository rules document (`docs/agent-rules.md`).
- self-improve: the rules-text domain, the 22-attempt P2b replay measurement and the five-cycle P3 redeploy campaign (verdicts and limits in `self-improve/evidence/`).

### Changed

- README rewritten for external readers: problem statement, architecture, per-plugin requirements, demo output and verification commands.
- External pull requests are no longer accepted: creation is limited to collaborators and a hosted, no-checkout workflow closes any other pull request.
- **backplan**: a missing required key is reported once instead of once per field beneath it; issue registration defaults to standing per-topic projects.
- **jev-advisor**, **wiki**, **rea**, **backplan**: builders gained a non-mutating `--check` drift mode.
- **jev-gate**: placeholder job and channel ids in the example config, and the default `home_channel` is empty.
- CI runs on the maintainer's self-hosted runner with Node 24 pinned.

### Fixed

- **rrsi**: an unknown action is now a tool error (`isError: true`); the plugin suite fails when it executes zero cases.
- **rea**: `rea_readiness` rejects any input other than exactly `{}`.
- **jev-advisor**: the documented 0.001 probability-sum bound is enforced in the decision parsers; completed task rows leave the batch widget immediately.
- **aside-memory**: the CLI's optional date field in search rows is accepted.
- **verification-receipts**: truncated receipt scans report bounded-evaluation state; the pre-budget timeout proof is deterministic.
- **shared**: a replaced lock generation is treated as contention while waiting to append.

### Removed

- `hermes/`, the maintainer's personal weekly self-evolution operations (now maintained privately). `rrsi/scripts/journal-dream.mjs`, which it called, is unchanged.
- The internal `docs/portfolio/AGENTS.md` (replaced by `docs/agent-rules.md`) and the raw P3 loop logs (replaced by `self-improve/evidence/p3/summary.json`).

### Upgrade notes

- Reinstall in this order: `jev-advisor`, then `verification-receipts`, then the rest (`gjc plugin uninstall <name> --user` followed by `gjc plugin install <path> --user`), and start a new `gjc` session.
- jev-gate: an existing `config.json` keeps its own `home_channel`; a fresh install must set `home_channel` and per-job `channels` before alerts are delivered.
- The self-improve rules-text domain now targets `docs/agent-rules.md`.
- `dashboard/` is a maintainer-only local view and is not part of the plugin distribution.

## [0.0.6] - 2026-10-13

Plugins: jev-advisor 0.0.6 · verification-receipts 0.0.2 · ui-regression 0.0.2 · wiki 0.0.2 · rea 0.0.1 · backplan 0.0.4 · rrsi 0.0.1

- **rrsi** plugin: exploration-trace store with `capture` / `import` / `dream` / `status` over the bundled Dream-RSI core.
- **backplan** plugin: `backplan_check` validates backward-derived work plans and renders Linear-ready payloads with a stable digest.
- **rea** plugin: `rea_readiness` and a workflow skill for the pinned REA CLI.
- **verification-receipts**: post-delegation gate hooks on `task`, `subagent` and `job` results and the `verification_loop` tool that rechecks every open delegation gate.
- self-improve RRSI v2: bounded automatic loop with a live proposer seam, replay simulator, deterministic dreaming, pre-registered thresholds and a deployed policy; first adoption landed without a hand-written proposal.
- **jev-advisor**: probability sums exactly on the documented tolerance are accepted and responses are capped at 64 KiB.

## [0.0.5] - 2026-10-12

Plugins: jev-advisor 0.0.5 · verification-receipts 0.0.2 · ui-regression 0.0.2 · wiki 0.0.2

- **wiki** plugin: `wiki_query` (read-only canonical pages) and `wiki_propose` (pending proposals with an exact digest; never approves or publishes).
- **jev-advisor**: `plugin_metrics`, a bounded offline aggregate over the retained plugin journals.
- self-improve: the repository-native improvement loop with gates, adoption, rollback, recovery, scratch isolation and guards.

## [0.0.4] - 2026-10-10

Plugins: jev-advisor 0.0.4 · verification-receipts 0.0.2 · ui-regression 0.0.2

- Private results under `~/.gjc-plugin/` with enforced ownership, modes, locks, capacity and rotation.
- **verification-receipts**: explicit selected tests, including ignored files, are bound to immutable receipts so changed inputs make historical evidence stale.
- **ui-regression**: empty substring expectations are rejected.

## [0.0.3] - 2026-09-28

- **jev-advisor**: learns from delegation outcomes through local evidence memory; self-describing install and management guide.

## [0.0.2] - 2026-09-28

- **jev-advisor**: outcome re-tier advisor after each delegation (observe-only) and visible advice in the TUI.

## [0.0.1] - 2026-09-27

- Initial public snapshot: **jev-advisor** decision-model advisories for subagent task delegation.

[0.0.12]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.11...v0.0.12
[0.0.11]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/jjongguet/gjc-plugin/releases/tag/v0.0.1
