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
supervisor/bin/session-guard JJO-895 gjc-plugin     # refuse a second session on one ticket (exit 2)
```

`supervisor loop` runs until stopped (`Ctrl-C`/`SIGTERM` finishes the current run
first). There is no launchd/cron install: the loop lives only inside the tmux
session the operator started.

Flags: `--out DIR` (state directory, default `~/.gjc-plugin/supervisor`),
`--no-discord`, `--no-mini`, `--json`, `--count N`, `--force-report`.

## Duplicate session guard (JJO-895)

`lane-gjc run` refuses a duplicate session *name* only, so two sessions on the
same ticket in the same repository could start and edit the same files (six
sessions on one mini checkout were observed on 2026-10-27). `session-guard`
answers that question before a start:

```sh
supervisor/bin/session-guard <ticket> <repo> [--no-mini] [--json]
node supervisor/bin/session-guard JJO-895 /path/to/lane-worktree
```

- Liveness is the tmux listing only (`collect.mjs`); a handoff file or a branch
alone never proves a session exists. A lane worktree whose pane directory was
deleted, or a mini checkout whose tmux session is gone, is a leftover and does
not block.
- The ticket is matched against strings the session itself carries: session
name, tmux session name, branch and worktree path (`JJO-895`, `jjo895` and
`S42-JJO-895.md` all match). The repository comes from the session's origin
remote, so the same ticket in another repository passes.
- Exit codes: `0` clear, `2` live duplicate (the reason lists the session name,
start time and age), `3` the tmux listing failed so absence is unproven, `1`
usage. Sessions whose origin remote cannot be read are printed as `레포 미확인`
rather than treated as a match.
- Read-only: it starts, steers and kills nothing. Ending the duplicate session
and restarting remains the operator's call.

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
`~/.gjc/agent/policy/bin/decision-ask` (`jev-omni`, confidence ≥ 0.6). A missing CLI,
abstain, provider error, unknown label or low confidence falls back to the
deterministic default and records `source: deterministic_fallback` plus the error in
the snapshot and `events.jsonl`. No other state spends a model call.

`describer` is not used: the decisions catalog has no such model (2026-10-22), so the
summary text is rendered deterministically from the snapshot. Numbers are computed
by code, never written by a model.

## Interventions

- **Discord summary** — one message per run to `DISCORD_REPORT_WEBHOOK_URL`, sent only
  when the report changed. The URL must be an `https://discord.com/api/webhooks/...` URL;
  mentions are disabled and the body is capped at the Discord limit. No webhook means
  `skipped`, not a failed run.
- **Change-only reporting** — a sha256 fingerprint of the reportable facts (state counts, stalled/thrashing sessions, collection errors, the monitored session set, steer outcomes) is compared with the last delivered report; timestamps, ages, dirty counts and the run id are excluded, so a quiet workspace stays quiet. The fingerprint is kept in `last-report.json` (mode 0600) in the state directory, and it advances only on a delivered POST, so a failed send is retried and a missing or damaged state file reports instead of dropping the message. `discord: skipped: unchanged` prints the reason (also in `events.jsonl`), and `--force-report` sends an unchanged summary; a missing webhook stays `webhook_missing`.
- **Steer** — `tmux send-keys` into exactly one `lane-<name>` session, only when that
  session judged `stalled` or `thrashing`. The message carries a `sv-<id>` marker and
  the run verifies the marker on screen before recording `verified: true`.
- **Repeat stalls** — a still-stalled session keeps the same line in the next report but
  does not post a new message on its own (change-only reporting); replacing or killing a
  session stays a human decision. This tool has no kill path.

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
every failure kind, dry-run versus real steer, webhook validation, change-only reporting
(suppression, forced send, damaged state file, webhook missing), and two loop
iterations against an injected clock.

## Non-goals

- no session kill, no replacement automation, no multi-target steer;
- no launchd/cron/daemon install — the loop runs in a tmux session the operator starts;
- no writes to another session's worktree or branch;
- `rrsi/`, `self-improve/` and `jev-advisor/` are read-only neighbors.
