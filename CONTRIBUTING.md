# Contributing

Thanks for contributing to `gjc-plugin`. This repository ships plugins for [gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`); each plugin directory is independently installable and its `gajae-plugin.json` is the version source of truth.

## How to contribute

- **Bugs and feature requests:** open an [issue](https://github.com/jjongguet/gjc-plugin/issues/new/choose) using one of the forms.
- **Security problems:** report privately as described in [SECURITY.md](SECURITY.md); never in a public issue.
- **Pull requests:** not accepted from outside the maintainers. Pull-request creation is limited to collaborators, and a workflow closes any pull request whose author is not the owner, a member or a collaborator, with a pointer to issues. The workflow never checks out or runs pull-request code.

Maintainers land changes on `main` with conventional commit subjects in English. Repository rules for agents and contributors are in [docs/agent-rules.md](docs/agent-rules.md).

## Development setup

- [Bun](https://bun.sh) 1.4.x for builds and tests, Node.js ≥ 22 for the `node:test` runner, and a local `gjc` installation for runtime and smoke checks.

```sh
git clone https://github.com/jjongguet/gjc-plugin
cd gjc-plugin
bun run build && bun run test
bun run demo && bun run docs:check && bun run evidence:check && bun run policy:check
```

Without a local `gjc`, use `SELF_IMPROVE_SKIP_SMOKE=1 bun run test`; the four host smoke guards are then reported as skipped.

## Build and test chain

- `bun run build` builds every plugin (keyless). Generated surfaces under each plugin's `tools/` and `hooks/` are committed and must stay in sync; `bun run build:check` (or `bun <plugin>/scripts/build.mjs --check`) fails on drift without writing.
- `bun run test` runs the root chain: fixture tests for the repository check scripts (`scripts/tests/`), shared tests, per-plugin suites (`bun <plugin>/scripts/verify.ts`), the self-improve integration guards and the workspace checks.
- Suites are hermetic: disposable repositories/homes, synthetic or disabled transport, isolated fake CLIs. Live credentials, real personal data and production services are never required and never used in tests.
- Maintainers additionally run the workspace-standard validator, which lives outside this repository (`node ../shared/workspace-standard/validator/cli.mjs validate --root .`, profile `plugin-ts`). It is not required for external use.

## Smoke tests

```sh
node verification-receipts/scripts/smoke-host.mjs --metrics
node verification-receipts/scripts/smoke-host.mjs --installed
node verification-receipts/scripts/smoke-host.mjs --installed --advisor
node jev-advisor/scripts/smoke-results.mjs
UI_REGRESSION_ACCOUNT=<explicit-routing> node verification-receipts/scripts/smoke-host.mjs --installed --ui
```

Host smoke copies installed bundles into a private isolated GJC root and uses only a loopback provider; it does not mutate user configuration. Jev result smoke imports installed hooks in a fresh isolated process and exercises bounded synthetic task/launch/terminal events — it proves hook/storage consumption, not a real child delegation or task quality. Browser smoke requires an actually connected Aside profile and inspected owned loopback handlers. Report source tests, installed dispatch, browser observations and real-provider judgment separately; never blend them into a single claim.

## CI

`.github/workflows/ci.yml` runs on every push to `main`: `build:check`, `evidence:check`, `docs:check`, `policy:check`, `bun run build`, the full test chain and `bun run demo`. It has no `pull_request` trigger. Two
check classes cannot run on hosted runners and are excluded by boundary, not by failure: the four smoke
guards are skipped via `SELF_IMPROVE_SKIP_SMOKE=1`, and the real-gjc trial case self-skips with a
recorded reason (no `gjc` binary). The workspace-standard validator guard is planned only where its
local tree sits beside the repository (`self-improve/lib/guards.mjs`); the test wrapper prints the
planned guard ids, guard statuses and skip counts, so green runs disclose what was planned out and
what was skipped instead of hiding it. The workflow also creates an empty, never-committed `AGENTS.md`
placeholder for the local-only existence contract.

## Adding a plugin

- Declare every installed surface (tools, hooks, skills) in `gajae-plugin.json`; keep generated surfaces keyless and reproducible from `lib/` + `src/` sources.
- Add the distribution-index entry in `gjc-plugin.json` and the table row in `README.md`.
- Reuse the shared private-result primitives (`shared/`) when persistence is required. Transient wrappers such as `aside-memory` intentionally do not journal private payloads; never serialize arbitrary tool output as evidence.
- Tools whose parameters are empty should carry an explicit `schema` in the manifest when static extraction fails.

Typical plugin layout:

```
<plugin>/
  gajae-plugin.json   surfaces, version (source of truth for releases)
  lib/                core logic
  src/                adapters
  tools/              generated tool surfaces (committed)
  scripts/            build.mjs + verify.ts
  README.md           user-facing contract, install and verification
```

## Install order and replacement

- `gjc plugin install <path> --user` refuses a plugin that is already installed. Replace one with `gjc plugin uninstall <name> --user` followed by `gjc plugin install <path> --user`; inspect the recorded source (`~/.gjc/agent/gjc-plugins/registry.json`) first.
- When upgrading several plugins, install **`jev-advisor` first** and **`verification-receipts` second**, then the rest, and run `gjc plugin doctor` afterwards. An older `jev-advisor` reading journal records written by a newer `verification-receipts` fails closed with `store_corrupt`.
- Rebuilding source alone does not update a running session. Tools and hooks load at **session start**; verify upgraded surfaces in a fresh `gjc` process.

## Workspace standard

- `standard.json` — profile `plugin-ts`, root `.`.
- `gjc-plugin.json` — distribution index only; per-plugin manifests are bumped only at an explicitly requested release.
- `dashboard/` — maintainer-only local meta view; not a plugin and not deployed. See [dashboard/README.md](dashboard/README.md).
- `steps.json` — the maintainer's manual release checklist (record, verify, human review); nothing runs it on a timer.
