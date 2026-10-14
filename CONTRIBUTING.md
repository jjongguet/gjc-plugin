# Contributing

Thanks for contributing to `gjc-plugin`. This repository ships plugins for [gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`); each plugin directory is independently installable and its `gajae-plugin.json` is the version source of truth.

Changes land on `main` directly with conventional commit subjects in English (this repository does not use pull requests).

## Development setup

- [Bun](https://bun.sh) for builds and tests; a local `gjc` installation for runtime checks.
- The workspace-standard validator expects a sibling checkout: `shared/workspace-standard` next to this repository.

```sh
git clone https://github.com/jjongguet/gjc-plugin ~/jjongguet/gjc-plugin
cd ~/jjongguet/gjc-plugin
bun run build && bun run test
```

## Build and test chain

- `bun run build` builds every plugin (keyless). Generated surfaces under each plugin's `tools/` are committed and must stay in sync; builders support `bun <plugin>/scripts/build.mjs --check` for drift detection.
- `bun run test` runs the root chain: shared tests, per-plugin suites (`bun <plugin>/scripts/verify.ts`), the self-improve integration guards and the workspace checks.
- Suites are hermetic: disposable repositories/homes, synthetic or disabled transport, isolated fake CLIs. Live credentials, real personal data and production services are never required and never used in tests.
- `node ../shared/workspace-standard/validator/cli.mjs validate --root .` must stay green (profile `plugin-ts`).

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

`.github/workflows/ci.yml` runs `bun run build` plus the full test chain on every push to `main`. Two
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

- Replacement/upgrade uses the supported operation (`gjc plugin install --help`); inspect the recorded source path before replacing an installation.
- When upgrading several plugins that share the private `~/.gjc-plugin/` stores, upgrade in dependency order and run `gjc plugin doctor` afterwards.
- Rebuilding source alone does not update a running session. Tools and hooks load at **session start**; verify upgraded surfaces in a fresh `gjc` process.

## Workspace standard

- `standard.json` — profile `plugin-ts`, root `.`.
- `gjc-plugin.json` — distribution index only; per-plugin manifests are bumped only at an explicitly requested release.
- `dashboard/` — local meta view only; no Supabase push-envelope until a connection exists. The validator runs locally (`npm run validate` inside `dashboard/`) and is intentionally not part of `vercel-build`.
- `steps.json` — manual workflow (record, verify, human review); no timer execution.
