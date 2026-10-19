# Changelog

Each plugin carries its own version in `gajae-plugin.json`; a repository release tags the set of plugin versions listed under it. Versions follow the `0.0.x` series.

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

[0.0.7]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/jjongguet/gjc-plugin/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/jjongguet/gjc-plugin/releases/tag/v0.0.1
