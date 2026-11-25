# gjc-plugin — Agent Entry Guide

Repository entry point for agents working on `gjc-plugin`, a collection of independently installable evidence plugins for `gajae-code` (`gjc`).

Canonical repository rules live in [docs/agent-rules.md](docs/agent-rules.md) (the single source of truth scored by `self-improve/domains/rules-text`); this file routes agents to the right contracts without duplicating them.

## Start Here

- [docs/agent-rules.md](docs/agent-rules.md) — repository rules, layout, safety boundaries, code review criteria, records, and commit rules.
- [README.md](README.md) — plugin catalog, what each plugin proves vs does not prove, and quick start.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, build/test chain, smoke tests, and PR validation lane.
- [SECURITY.md](SECURITY.md) — security scope and private vulnerability reporting.
- [gjc-plugin.json](gjc-plugin.json) — distribution index of the 11 installable plugins (each plugin's `gajae-plugin.json` is its version source of truth).
- [package.json](package.json) — canonical build, check, and test script definitions.
- [standard.json](standard.json) & [steps.json](steps.json) — workspace standard declaration (`plugin-ts`, `1.1.0`) and maintainer checklist.

## Source Checkout vs Installed Plugins

- Editing files in this checkout does **not** update an active `gjc` session or user-scoped installation (`~/.gjc/agent/gjc-plugins/registry.json`).
- Each plugin's generated surfaces under `<plugin>/tools/` and `<plugin>/hooks/` are committed build outputs. Regenerate with `bun run build` and verify sync with `bun run build:check`; never hand-edit generated files.
- Never bump plugin manifest versions (`gajae-plugin.json`) or root `package.json` unless an explicit release is requested.

## Development and Verification Contract

Run verification from an isolated worktree before opening or updating a pull request:

```sh
bun run build:check
bun run evidence:check && bun run paths:check && bun run docs:check && bun run policy:check
npm test
bun run demo
```

- `npm test` (and `bun run test`) invokes `scripts/run-checks.mjs`, running every `test:*` step declared in [package.json](package.json), including `test:self-improve` (which archives committed `HEAD` into a scratch copy and runs the full guard set, including the external `workspace-standard` validator when present beside the repository).
- Without a local `gjc` binary, set `SELF_IMPROVE_SKIP_SMOKE=1`; skips must stay explicit and never be hidden.
- Tests and demos must remain hermetic: disposable temporary `HOME`, synthetic or disabled transport, zero writes to real `~/.gjc/` or `~/.gjc-plugin/`, and zero live provider calls.

## Single `main` Trunk and Pull Request Flow

- **`main` is the single integration branch.** Develop in an isolated worktree and topic branch, then open a pull request targeting `main`.
- **No automatic PR execution.** There is no `pull_request` trigger in `.github/workflows/`; `scripts/check-pr-policy.mjs` enforces this invariant. Pull requests are validated on demand via owner-dispatched `.github/workflows/pr-validate.yml` pinned to the reviewed 40-hex head SHA:
  `gh workflow run pr-validate.yml --ref main -f pr_number=<n> -f head_sha=<sha>`
- **Workspace standard invariants (`plugin-ts` `1.1.0`):** no hardcoded secret-shaped literals (OD9b), no periodic timers or `setInterval` polling (f11), no server runtime dependencies (`express`/`next`/`fastify`), and no absolute home paths in tracked files (`bun run paths:check`).
- Stage only the exact files you changed (never `git add -A`) and keep commit subjects conventional.
