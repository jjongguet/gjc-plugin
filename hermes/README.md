# hermes

Weekly self-evolution loop for Hermes. The loop turns read-only evidence — the
personal wiki and the existing RRSI Dream-RSI surface — into one bounded,
append-only digest per host per week, and (on the Mac) lands that digest in a
private repository.

This area is deliberately **not** a plugin runtime: it adds no GJC hook, no
generated `hooks/`/`tools/` surface and no TypeScript runtime on `gw-kmg`.

Scope note: this implements the narrowed JJO-140/141/142 weekly loop as a Mac
launchd job, a Hermes skill definition and an artifact/ledger contract. It does
not create a remote digest repository, does not install a TypeScript runtime on
gw-kmg, and does not register jobs.

## Purpose

- Mac: a launchd user agent runs every Monday 00:00 local time and writes
  `YYYY-MM-DD-mac.md` + a ledger row into a private digest repository.
- gw-kmg: a Hermes skill runs the same Python writer with `--host gw-kmg`,
  writes `YYYY-MM-DD-gw-kmg.md` locally, and delivers a bounded message to the
  existing home Discord channel through the weekly cron's `--deliver discord`.
- Both hosts share one digest contract, one exactly-once ledger rule and one
  status vocabulary (`ran|unchanged|no_input|error|blocked|skipped`).

## Layout

```text
hermes/
├── README.md
├── docs/
│   ├── digest-contract.md      # path/name, frontmatter, ledger, privacy rules
│   └── runbook.md              # Mac install/verify/uninstall, gw-kmg skill install
├── mac/
│   ├── work.jjongguet.hermes-evolution.plist.template
│   └── install.sh              # render/apply plist; never calls launchctl
├── scripts/
│   └── weekly_evolution.py     # stdlib-only digest + ledger writer
├── skills/
│   └── self-evolution/SKILL.md # Hermes weekly procedure on gw-kmg
└── tests/
    └── test_weekly_evolution.py
```

## Quickstart

```sh
# Compile and run the stdlib test suite from the repository root.
python3 -m py_compile hermes/scripts/weekly_evolution.py
python3 -m unittest discover -s hermes/tests -v

# Render a complete digest without writing anything.
python3 hermes/scripts/weekly_evolution.py \
  --host mac --dry-run --now 2026-10-19T00:00:00+09:00

# Preview the launchd plist (the private repository path is still a placeholder).
hermes/mac/install.sh --print
```

A real Mac run after a private repository exists:

```sh
python3 hermes/scripts/weekly_evolution.py \
  --host mac --digest-repo "$HOME/digests/hermes-evolution"
```

`--digest-repo` refuses to run when the target is not a git checkout or when its
`origin` URL contains `gjc-plugin` (this public repository). The writer stages
only `digests/<date>-<host>.md` and `digests/ledger.jsonl`, commits
`chore(hermes): weekly digest <date> <host>`, and pushes. It never uses
`git add -A`.

## Status vocabulary

| Value | Meaning |
| --- | --- |
| `ran` | The RRSI receipt was produced and is usable. |
| `unchanged` | The receipt hash equals the previous digest for this host. |
| `no_input` | The journal exists but contains no records; not a zero-result claim. |
| `error` | The receipt was unreadable/invalid or journal-dream failed. |
| `blocked` | A required precondition is missing (JJO-129 Python RRSI surface on gw-kmg, or no inputs at all). |
| `skipped` | The RRSI surface (bun/journal-dream) is unavailable; a missing wiki yields a `partial`/`blocked` digest instead. |

The digest status is `ok` only when at least one wiki citation and a usable RRSI
receipt both exist, `blocked` when both are missing (or RRSI is explicitly
blocked), and `partial` otherwise.

`--json` prints one `hermes-evolution.run.v1` object with the same status fields
plus `recorded` (`recorded|already-recorded|recovered|conflict|dry-run`) and,
when the private repository is used, `committed`/`pushed`.

## Safety boundaries

- The wiki content is read-only: non-dry runs refresh with `git fetch --prune`
  (remote-tracking refs only) unless `--no-fetch` is given, then read
  `origin/main` (falling back to `HEAD`) for `rev-parse`/`log`. The writer never
  pulls, checks out, resets or writes pages, indexes, logs or caches. Use
  `--no-fetch` for an offline or strictly non-mutating run. No approve/publish
  path exists here.
- The digest contains date/host/status fields, bounded RRSI summary fields,
  page paths and commit SHAs. It never contains page bodies, raw conversation
  text, message IDs, tokens, cookies, DMs or `#secret` content.
- Digests are committed only to the private digest repository. They are never
  committed to `gjc-plugin` or any public repository. The gw-kmg copy stays
  local under `/home/gjc/.hermes-evolution` and is never pushed.
- The writer does not register timers, change system permissions, send Discord
  messages or mutate remote hosts. launchd/Hermes cron registration is a human
  step.
- Python 3 standard library only; no new dependency, no TypeScript runtime.

## Implemented vs deferred

Implemented in this area:

- deterministic digest writer with a precomputed-receipt mode for tests;
- read-only wiki citations (paths + commit SHAs, max 5);
- exactly-once ledger with flock, atomic digest writes, append+fsync ledger;
- private-repository guard, staged-only commit and push;
- Mac launchd plist + idempotent render/apply installer (no launchctl calls);
- Hermes skill definition and the full contract/runbook;
- stdlib tests for dry-run, exactly-once, conflict, partial/blocked, guards,
  bounds and privacy.

Deferred (human or ticket-owned):

- creating the private digest repository;
- installing the skill on gw-kmg (manual ssh stdin copy + sha256 parity);
- registering the launchd agent and the Hermes weekly cron (`--deliver discord`);
- the JJO-129 Python RRSI surface on gw-kmg (until it exists, the skill records
  `rrsi_status: blocked` and never fabricates a receipt);
- any automatic cross-host sync of gw-kmg digests into the private repository.
