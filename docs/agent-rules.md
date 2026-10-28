# gjc-plugin repository rules

These are the working rules for agents and contributors changing this repository. They are a contract, not background reading: the `rules-text` self-improve domain (`self-improve/domains/rules-text`) scores this file, and an edit must keep that domain green.

## Purpose

- Every plugin subtree names its installed, generated and verification surfaces, so an agent can work without guessing.
- Each rule lives in one canonical place; other documents link to it instead of restating it.
- An unverified change is never adopted.

## Repository layout

- `jev-advisor/` — task-delegation tier advice, artifact checks and the read-only metrics report (advisory, never a gate).
- `verification-receipts/` — explicit test execution, private receipts and the post-delegation verification gate.
- `ui-regression/` — bounded loopback browser scenarios with literal DOM assertions.
- `rrsi/` — exploration-trace store and Dream-RSI replay (explicitly invoked, keyless).
- `self-improve/` — the repository's self-improvement loop. The append-only [ledger](../self-improve/ledger.jsonl) records every decision and [rrsi.json](../self-improve/rrsi.json) configures the loop.
- `wiki/`, `rea/`, `backplan/`, `aside-memory/` and `shared/` — the remaining plugins and the shared private-results module. Each plugin's `gajae-plugin.json` is its manifest of record.
- `supervisor/` — repository-native session supervisor CLI (not a plugin, not deployed).
- `integrations/` — host integration gates (e.g. the Hermes cron gate), manually verified.
- `dashboard/` — maintainer-only local meta view (not a plugin, not deployed).
- `scripts/` — repository check scripts, runners and smoke entry points.
- `docs/` — repository rules, ADRs and documentation.
- `artifacts/` — dated run artifacts; local-only, not committed.

## Build and test

- Full verification: `bun run test`; [package.json](../package.json) defines every script.
- Build: `bun run build`. Generated surfaces (`tools/`, `hooks/`) are build outputs; never edit them by hand.
- A change that was checked with one plugin suite still finishes with the full chain.

## Safety boundaries

- Never commit credentials, `.env` files or local key files; plugins read keys only from their documented locations outside the repository.
- Tests and demos run in disposable homes with synthetic or disabled transport; they must not write to a real `~/.gjc-plugin/` store or call a live provider.
- External pull requests are accepted only through the owner-dispatched `pr-validate.yml` lane: their code never runs automatically, on the self-hosted runner, with secrets, or with a persistent cache.

## Records

- Committed evidence uses repository-relative paths; `bun run evidence:check` enforces this for `self-improve/`.
- The self-improve ledger is append-only. Never rewrite, reorder or delete a ledger row.
- Session logs, dated run notes and test counts do not belong in committed documentation; reproduction steps do.
- `self-improve/evidence/**` is the sanctioned home for dated receipts and measured counts; the exception does not extend to other documentation except a point-in-time snapshot inside a design note that is explicitly labelled non-reproducible and names the command that regenerates it.

## Commit and verification rules

- Stage only changed files; never `git add -A`.
- Use conventional commit messages, scoped to the plugin name where one applies.
- Plugin manifest versions change only at a tagged release.
