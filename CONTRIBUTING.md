# Contributing

Thanks for contributing to `gjc-plugin`. This repository ships plugins for [gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`); each plugin directory is independently installable and its `gajae-plugin.json` is the version source of truth.

## How to contribute

- **Bugs and feature requests:** open an [issue](https://github.com/jjongguet/gjc-plugin/issues/new/choose) using one of the forms.
- **Security problems:** report privately as described in [SECURITY.md](SECURITY.md); never in a public issue.
- **Pull requests:** accepted, with owner-controlled execution.

## Pull requests

1. Open the pull request against `main`. Nothing runs automatically: there is no `pull_request` trigger anywhere in this repository.
2. The owner reviews the diff and dispatches **Validate pull request (owner dispatch)** from `main` with the pull request number and the reviewed 40-hex head SHA:
   `gh workflow run pr-validate.yml --ref main -f pr_number=<n> -f head_sha=<sha>`
3. A trusted preflight checks the dispatch actor, repository, `main` ref and that the SHA is still the pull request head.
4. The candidate job checks out that SHA on a GitHub-hosted runner with no secrets, no write token, no cached dependencies and no self-hosted runner, then runs the build, checks, tests and demo.
5. A trusted verifier re-reads the head SHA, runs this repository's policy checker over the pull request's workflow files as data, and posts a `owner-pr-validation` status bound to the reviewed SHA.
6. Pushing new commits changes the head SHA; the owner re-dispatches for the new one. The receipt of an older SHA never carries over.

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
- `bun run test` runs every `test:*` script in `package.json` — fixture tests for the repository check scripts (`scripts/tests/`), shared tests, per-plugin suites (`bun <plugin>/scripts/verify.ts`), the self-improve integration guards and the workspace checks — through `scripts/run-checks.mjs`. The steps share nothing but this checkout, so the runner keeps up to 4 of them in flight (`GJC_TEST_CONCURRENCY=<n>` overrides the fan-out, `1` restores a serial run), reprints each step's output as one block, and exits 1 when any step fails.
- `scripts/tests/ultragoal-gate.test.mjs` checks the installed `gjc` against the ultragoal gate evidence contract in [docs/ultragoal-gate-evidence.md](docs/ultragoal-gate-evidence.md); it fails when a `gjc` release changes that contract and skips when no `gjc` is on `PATH`.
- Suites are hermetic: disposable repositories/homes, synthetic or disabled transport, isolated fake CLIs. Live credentials, real personal data and production services are never required and never used in tests.
- Maintainers additionally run the workspace-standard validator, which lives outside this repository (`node ../shared/workspace-standard/validator/cli.mjs validate --root .`, profile `plugin-ts`). It is not required for external use.

## Smoke tests

```sh
node scripts/onboarding-smoke.mjs
node verification-receipts/scripts/smoke-host.mjs --metrics
node verification-receipts/scripts/smoke-host.mjs --installed
node verification-receipts/scripts/smoke-host.mjs --installed --advisor
node jev-advisor/scripts/smoke-results.mjs
UI_REGRESSION_ACCOUNT=<explicit-routing> node verification-receipts/scripts/smoke-host.mjs --installed --ui
```

The onboarding smoke installs `backplan` from the checkout into a throwaway GJC root, calls `backplan_check` with the bundled examples from a fresh `gjc --print` process through a scripted loopback endpoint, uninstalls it and confirms the real plugin registry is unchanged; it proves the README quick start path, not model behaviour. Host smoke copies installed bundles into a private isolated GJC root and uses only a loopback provider; it does not mutate user configuration. Jev result smoke imports installed hooks in a fresh isolated process and exercises bounded synthetic task/launch/terminal events — it proves hook/storage consumption, not a real child delegation or task quality. Browser smoke requires an actually connected Aside profile and inspected owned loopback handlers. Report source tests, installed dispatch, browser observations and real-provider judgment separately; never blend them into a single claim.

## CI

`.github/workflows/ci.yml` runs on every push to `main` (the only automatic trigger in this repository): `build:check`, `evidence:check`, `docs:check`, `policy:check`, `bun run build`, the full test chain and `bun run demo`. It has no `pull_request` trigger, and neither does any other workflow. Two
check classes cannot run on hosted runners and are excluded by boundary, not by failure: the four smoke
guards are skipped via `SELF_IMPROVE_SKIP_SMOKE=1`, and the real-gjc trial case and the ultragoal
gate contract fixture self-skip with a recorded reason (no `gjc` binary). The workspace-standard validator guard is planned only where its
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
