# supervisor — workspace session supervisor

Ten-minute health checks over the local lane sessions and the mini host: collect
facts, judge progress deterministically, report, and nudge one stalled session.
It exists because a stalled lane was observed for 42 minutes with zero commits
(JJO-771) and the read-only status view had no way to intervene (JJO-913).

## Entry points

```sh
supervisor/bin/supervisor once                      # one snapshot + Discord summary
supervisor/bin/supervisor once --dry-run            # collect, judge, print; no steer, no webhook
supervisor/bin/supervisor loop --interval 600       # repeat in a user-started tmux session
supervisor/bin/supervisor once --steer lane-JJO-913-supervisor   # real nudge, one target
```

`supervisor loop` runs until stopped (`Ctrl-C`/`SIGTERM` finishes the current run
first). There is no launchd/cron install: the loop lives only inside the tmux
session the operator started.

Flags: `--out DIR` (state directory, default `~/.gjc-plugin/supervisor`),
`--no-discord`, `--no-mini`, `--json`, `--count N`.

## What is collected

Per lane session (`lane-<name>` tmux sessions): the worktree comes from the pane's
current directory, so a session whose worktree was deleted is reported instead of
being silently skipped. Also branch, HEAD, origin remote, session age, commits
since session start, commits in the last 10 minutes, dirty file count, last commit,
newest changed-file mtime, pane digest and the GitHub check-runs state for HEAD.

Per mini session: non-integration-branch checkouts under `~/jjongguet` on
`MINI_HOST` (default `macmini`), read in one bounded ssh call. An unreachable host
is an entry in `errors`, never a failed run.

CI reads the public GitHub API (`gh` is not installed on every workspace host).
Results are cached per `repo@sha` for five minutes, and a missing remote, offline
host, rate limit or a repository without checks is recorded as `unavailable` /
`unknown` — never as success.

## Judgment rules (deterministic first)

| Observed | State |
| --- | --- |
| lane worktree missing, or tmux session gone | `stalled` |
| a commit inside the 10 minute window | `progressing` |
| dirty files grew and no commit landed | `thrashing` |
| a commit inside the 30 minute stall window | `progressing` |
| no commit since session start, age ≥ 30 min | `stalled` |
| no commit for the whole stall window | `stalled` |
| age < 30 min and no commits yet | `starting` |
| no age signal (mini checkout without a tmux session) | `unknown` |

One ambiguity is escalated to a decisions model: a dirty tree that stopped growing
past the stall window (`stalled` vs `thrashing`). That goes through
`~/.gjc-user-policy/bin/decision-ask` (`jev-omni`, confidence ≥ 0.6). A missing CLI,
abstain, provider error, unknown label or low confidence falls back to the
deterministic default and records `source: deterministic_fallback` plus the error in
the snapshot and `events.jsonl`. No other state spends a model call.

`describer` is not used: the decisions catalog has no such model (2026-10-22), so the
summary text is rendered deterministically from the snapshot. Numbers are computed
by code, never written by a model.

## Interventions

- **Discord summary** — one message per run to `DISCORD_REPORT_WEBHOOK_URL`. The URL
  must be an `https://discord.com/api/webhooks/...` URL; mentions are disabled and the
  body is capped at the Discord limit. No webhook means `skipped`, not a failed run.
- **Steer** — `tmux send-keys` into exactly one `lane-<name>` session, only when that
  session judged `stalled` or `thrashing`. The message carries a `sv-<id>` marker and
  the run verifies the marker on screen before recording `verified: true`.
- **Repeat stalls** — the summary repeats the stalled line each run; replacing or
  killing a session stays a human decision. This tool has no kill path.

## Snapshot

`snapshot-<timestamp>.json` and `latest.json` in the state directory, plus
`events.jsonl` with one line per snapshot, judgment, steer, Discord result and
collection error. See `lib/report.mjs` for the shape; `schemaVersion` is `1`.

## Tests

```sh
bun run test:supervisor     # node --test supervisor/tests/*.test.mjs
```

The suite pins the judgment rules (including the 30-minute stall, 10-minute progress
and dirty-growth cases), fixture collection for lane and mini, decision fallback for
every failure kind, dry-run versus real steer, webhook validation, and two loop
iterations against an injected clock.

## Non-goals

- no session kill, no replacement automation, no multi-target steer;
- no launchd/cron/daemon install — the loop runs in a tmux session the operator starts;
- no writes to another session's worktree or branch;
- `rrsi/`, `self-improve/` and `jev-advisor/` are read-only neighbors.
