# gjc-plugin

Plugins for [gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`). Every subdirectory with a `gajae-plugin.json` is independently installable; generated runtime surfaces embed their sources and need no installed sibling packages.

![license: MIT](https://img.shields.io/badge/license-MIT-blue)

## Quick start

```sh
git clone https://github.com/jjongguet/gjc-plugin ~/jjongguet/gjc-plugin
cd ~/jjongguet/gjc-plugin
bun run build && bun run test

gjc plugin install ./aside-memory --user   # install any plugin the same way
gjc plugin list && gjc plugin doctor
```

An existing installation requires the supported replacement/upgrade operation (`gjc plugin install --help`; inspect the recorded source before replacing). Rebuilding source alone does not update a running session — verify upgraded surfaces in a fresh GJC process.

Credentials stay outside the replaceable installation tree in `~/.gjc/agent/jev-advisor/.env`, or the process environment. `JEV_ADVISOR_API_KEY` takes priority over `OPENROUTER_API_KEY`; process values override same-named file values. Never put credentials in source or result records.

## Plugins

| Plugin | Purpose | Docs |
| --- | --- | --- |
| [`jev-advisor`](jev-advisor/) | Task-scoped `fast` / `balanced` / `strong` advice, one-shot `jev_check` artifact checks and the read-only `plugin_metrics` report. Shadow by default; advice is not model routing or quality proof. | [README](jev-advisor/README.md) |
| [`verification-receipts`](verification-receipts/) | Explicit `node:test` execution, immutable private receipts, source freshness and the post-delegation verification gate (`verification_loop`). | [README](verification-receipts/README.md) |
| [`ui-regression`](ui-regression/) | One bounded, non-sensitive loopback Aside scenario with literal DOM assertions and historical metadata receipts. No screenshot baselines. | [README](ui-regression/README.md) |
| [`wiki`](wiki/) | Read-only lookup over the guarded personal wiki and pending-proposal submission. Never approves or publishes. | [README](wiki/README.md) |
| [`rea`](rea/) | Offline `rea_readiness` report and the pinned workflow-skill payload for [REA](https://github.com/morluto/rea) (rea-agents 6.4.0); optional `gjc mcp add` registration for stateful sessions. | [README](rea/README.md) |
| [`backplan`](backplan/) | `backplan_check` planning gate: validates a structured plan against the fixed contract and renders Linear-ready payloads plus a stable digest. Deterministic, keyless and offline. | [README](backplan/README.md) |
| [`rrsi`](rrsi/) | Exploration-trace store and Dream-RSI replay surface (capture/import/dream/status), private store under `~/.gjc-plugin/rrsi/`. Instrument only: performance proof belongs to `self-improve/`. | [README](rrsi/README.md) |
| [`aside-memory`](aside-memory/) | Explicit account-bound Aside memory search (`aside_memory`) returning bounded historical quotations with relative citations. Read-only: no injection, writes, cache or extra model calls. | [README](aside-memory/README.md) |

Measured attributes (tiers, counts, durations, journals) are descriptive observations, not quality, routing or causal proof.

## Usage

Each plugin exposes one or two tools, plus session-start hooks for `verification-receipts`. Full contracts, limits and boundaries live in each plugin README.

- **`jev_advise`** — task-scoped tier advice (shadow by default). **`jev_check`** — one bounded artifact check returning a strict `correct` / `incorrect` / `unsure` verdict; advisory only, never verification evidence. **`plugin_metrics`** — strictly read-only aggregate of retained journals; accepts exactly `{}`. Details: [`jev-advisor/README.md`](jev-advisor/README.md).
- **`verification_run` / `verification_status`** — run explicit repository-relative `.js` / `.mjs` / `.cjs` test files (1–32; no globs or arbitrary commands) and read their private receipts with recomputed source freshness. **`verification_loop`** — bounded (≤15s, offline) recheck of the post-delegation verification ledger; `clean` is a mechanical recheck, not proof of correctness. Details: [`verification-receipts/README.md`](verification-receipts/README.md).
- **`ui_regression_run` / `ui_regression_status`** — one bounded loopback scenario (explicit ephemeral account, exact loopback origin, first `goto`, at least one assertion) and historical status. Historical success is not current/deployed UI evidence. Details: [`ui-regression/README.md`](ui-regression/README.md).
- **`wiki_query` / `wiki_propose`** — read-only search over canonical wiki pages; capture an owner-approved source and submit draft pages as a pending proposal with an exact digest. Publication stays a human step outside the plugin. Details: [`wiki/README.md`](wiki/README.md).
- **`rea_readiness`** — offline readiness report for the pinned REA integration (Node/npx or Bun/bunx availability, optional MCP registration state, loose-skill payload). Details: [`rea/README.md`](rea/README.md).
- **`backplan_check`** — validates one backward-derived work plan (end state, success criteria, per-issue scope, Linear mapping, policy decisions, automation candidates) and renders Linear-ready payloads. Registration stays with the agent's Linear path. Details: [`backplan/README.md`](backplan/README.md).
- **`rrsi`** — capture / import / dream / status over the private exploration store. Keyless and offline. Details: [`rrsi/README.md`](rrsi/README.md).
- **`aside_memory`** — explicit account-bound Aside memory search (`{query, account?, max_results?}`) returning bounded quotations with relative citations, screened states (`ok` / `empty` / `withheld` / `unavailable` / `error`) and trust warnings. Details: [`aside-memory/README.md`](aside-memory/README.md).

Both verification tools automatically attempt warning-only Jev adequacy via the fixed OpenRouter decision endpoint when configured; missing or weak context never establishes sufficient verification. No automatic repairs are added.

## Verification

```sh
bun run build          # keyless builds for every plugin
bun run test           # root chain: per-plugin suites + self-improve + shared
bun <plugin>/scripts/verify.ts          # focused suite for one plugin
bun <plugin>/scripts/build.mjs --check  # generated-surface drift check
node ../shared/workspace-standard/validator/cli.mjs validate --root .
```

Offline tests use disposable repositories/homes and synthetic or disabled transport; live credential use is never required. Host/browser smoke commands and their evidence limits: [CONTRIBUTING.md](CONTRIBUTING.md#smoke-tests).

## Private results

All plugin-owned result/state writes use **`~/.gjc-plugin/`** (owned `0700` directories, owned single-link `0600` files; unsafe owners/modes, symlinks, hard links and corrupt inventory fail closed). GJC still owns installed code under `~/.gjc/agent/gjc-plugins/`. Full inventory, journal record contents and retention bounds: [`docs/private-results.md`](docs/private-results.md).

## Self-improvement loop

[`self-improve/`](self-improve/) is a repo-native harness self-improvement loop over this repository's own plugin surfaces (regularized recursive self-improvement, inspired by the RRSI design): declared `editable` sources only, deterministic checkers, every decision in a committed append-only ledger, candidates in `git archive` scratch copies. Keyless; the live `~/.gjc/agent` is never modified. See [`self-improve/README.md`](self-improve/README.md).

## Contributing

Development setup, the full test and smoke matrix, add-a-plugin conventions, install ordering and the workspace standard: [CONTRIBUTING.md](CONTRIBUTING.md).

## Related

- [gajae-code](https://github.com/Yeachan-Heo/gajae-code)

## License

[MIT](LICENSE)
