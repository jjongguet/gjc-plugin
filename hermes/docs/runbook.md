# Runbook — weekly Hermes self-evolution loop

Operational procedure for the Mac launchd writer and the gw-kmg Hermes skill.
All commands below are **manual**. This repository's implementation lane did not
run launchd, ssh-mutate gw-kmg, register a Hermes cron or create a repository.

## 1. What runs where

| Host | Trigger | Writer | Output |
| --- | --- | --- | --- |
| Mac | launchd user agent, Monday 00:00 local time | `hermes/scripts/weekly_evolution.py --host mac --digest-repo <private>` | `YYYY-MM-DD-mac.md` + ledger row in the private repository, committed and pushed |
| gw-kmg | manually registered Hermes weekly cron with `--deliver discord` | the installed copy of the same script with `--host gw-kmg --no-fetch --no-push` | `YYYY-MM-DD-gw-kmg.md` + ledger row under `/home/gjc/.hermes-evolution/digests`, plus a home-channel message |

The Mac job owns the private digest repository. gw-kmg never pushes.

The Mac writer refreshes the wiki with `git fetch --prune` (remote-tracking refs
only). The gw-kmg Hermes writer uses `--no-fetch` because the personal-wiki
reader contract forbids mutating the wiki's Git state; it reads `rev-parse` and
`git log` only.

## 2. Human steps still required

1. Create the private digest repository (for example
   `jjongguet/hermes-evolution-digests`) and clone it on the Mac.
2. Install the skill and the Python writer on gw-kmg with the ssh stdin copy in
   section 4, then verify sha256 parity.
3. Register the launchd user agent with `launchctl bootstrap` in section 3.
4. Register the Hermes weekly cron with `--deliver discord` in section 5.
5. Confirm whether the JJO-129 Python RRSI surface is available. A blocked
   digest is a valid weekly outcome; do not fabricate RRSI metrics.

## 3. Mac — install, verify, uninstall

### 3.1 Prerequisites

- `/usr/bin/python3` (3.9 or newer; the script uses only the standard library).
- `git` on `PATH`.
- `bun` on `PATH` for `rrsi/scripts/journal-dream.mjs` (the plist adds
  `/Users/kyeongminkim/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` so
  Homebrew bun and the `gh` credential helper are found under launchd).
- `gh` on `PATH`: the HTTPS git credential helper for the private-wiki fetch and
  the digest push invokes `gh`; without it launchd records a fetch skip and the
  digest push fails.
- A private digest repository checkout, with a committed `digests/.gitignore`
  containing `.lock` and `*.tmp.*`.
- The canonical checkout at `/Users/kyeongminkim/jjongguet/gjc-plugin` (or pass a
  different `--repo` to `install.sh`).
- The log directory `/Users/kyeongminkim/jjongguet/discord/logs` must exist;
  `install.sh --apply` refuses to install if it is missing.

### 3.2 Create the private repository (once)

The repository must be private. Example:

```sh
mkdir -p "$HOME/digests/hermes-evolution/digests"
cd "$HOME/digests/hermes-evolution"
git init
git remote add origin <private-git-url>
printf '.lock\n*.tmp.*\n' > digests/.gitignore
printf '# Hermes evolution digests\n\nPrivate, host-owned weekly digests.\n' > README.md
git add README.md digests/.gitignore
git commit -m "chore: initialize private Hermes digests"
git push -u origin HEAD
# The writer commits with this checkout's git identity; configure user.name and
# user.email here if the repository does not inherit them.
```

Verify the guard yourself before the first scheduled run:

```sh
git -C "$HOME/digests/hermes-evolution" remote get-url origin
# must not contain gjc-plugin
```

### 3.3 Dry run (writes nothing)

```sh
cd /Users/kyeongminkim/jjongguet/gjc-plugin
python3 hermes/scripts/weekly_evolution.py \
  --host mac --dry-run --now 2026-10-19T00:00:00+09:00
```

The output must contain the frontmatter, `## Summary`, `## RRSI`,
`## Wiki evidence`, `## Next actions`, and must not create
`~/.hermes-evolution`. The dry run does not fetch the wiki and does not touch the
private repository.

### 3.4 Render and apply the plist

`install.sh` never calls `launchctl`. `--print` is the default and writes
nothing; `--apply` writes the plist atomically and prints the registration
commands.

```sh
hermes/mac/install.sh --print --digest-repo "$HOME/digests/hermes-evolution"
hermes/mac/install.sh --apply --digest-repo "$HOME/digests/hermes-evolution"
```

`--apply` is idempotent: an identical plist reports `unchanged`. It refuses a
missing path, a non-git directory, or an `origin` containing `gjc-plugin`.

The committed template keeps `__PRIVATE_DIGEST_REPO__` as the explicit placeholder
until the private repository exists. The rendered plist is written to
`~/Library/LaunchAgents/work.jjongguet.hermes-evolution.plist`.

### 3.5 Register (human, exact commands)

```sh
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/work.jjongguet.hermes-evolution.plist"
launchctl print gui/$(id -u)/work.jjongguet.hermes-evolution
```

`RunAtLoad` is false; registration alone does not run the job.

### 3.6 First run and weekly verification

Run once manually:

```sh
launchctl kickstart -k gui/$(id -u)/work.jjongguet.hermes-evolution
```

Then verify all of the following:

```sh
# stdout/stderr (launchd creates these files on first run)
tail -n 50 /Users/kyeongminkim/jjongguet/discord/logs/hermes-evolution.out.log
tail -n 50 /Users/kyeongminkim/jjongguet/discord/logs/hermes-evolution.err.log

# digest + ledger
ls -l "$HOME/digests/hermes-evolution/digests"
tail -n 2 "$HOME/digests/hermes-evolution/digests/ledger.jsonl"
head -n 20 "$HOME/digests/hermes-evolution/digests/$(TZ=Asia/Seoul date +%F)-mac.md"

# private repository commit and push
git -C "$HOME/digests/hermes-evolution" log -1 --format='%s'
git -C "$HOME/digests/hermes-evolution" status --porcelain
git -C "$HOME/digests/hermes-evolution" log '@{u}..HEAD' --oneline
```

Expected subject: `chore(hermes): weekly digest <date> mac`. The last command
must print nothing (the local commit is pushed). `status --porcelain` should
also print nothing: `.lock` and `*.tmp.*` are ignored by the committed
`digests/.gitignore`.

Weekly verification after each Monday: repeat the log, ledger and git checks.
The ledger must gain exactly one line per Monday; a second line for the same
date is a defect.

### 3.7 Uninstall

```sh
launchctl bootout gui/$(id -u)/work.jjongguet.hermes-evolution
rm "$HOME/Library/LaunchAgents/work.jjongguet.hermes-evolution.plist"
```

Do not delete digests or the private repository. `bootout` only unregisters the
job.

## 4. gw-kmg — install the skill (manual, ssh stdin copy)

The skill directory layout on gw-kmg is flat, matching
`/home/gjc/.hermes/skills/daily-memory-digest/`. Run from the Mac repository
root. These commands mutate gw-kmg and are deliberately not executed by this
lane.

```sh
ssh gw-kmg 'mkdir -p ~/.hermes/skills/self-evolution/scripts'

ssh gw-kmg 'cat > ~/.hermes/skills/self-evolution/SKILL.md' \
  < hermes/skills/self-evolution/SKILL.md

ssh gw-kmg 'cat > ~/.hermes/skills/self-evolution/scripts/weekly_evolution.py' \
  < hermes/scripts/weekly_evolution.py

# sha256 parity: compare both sides literally
shasum -a 256 hermes/skills/self-evolution/SKILL.md \
  hermes/scripts/weekly_evolution.py

ssh gw-kmg 'sha256sum ~/.hermes/skills/self-evolution/SKILL.md \
  ~/.hermes/skills/self-evolution/scripts/weekly_evolution.py'

# compile check on the target
ssh gw-kmg 'python3 -m py_compile ~/.hermes/skills/self-evolution/scripts/weekly_evolution.py'
```

The four sha256 values must match pairwise. If they do not, redo the stdin copy;
never edit the target in place.

### 4.1 First gw-kmg dry run

```sh
ssh gw-kmg 'python3 ~/.hermes/skills/self-evolution/scripts/weekly_evolution.py \
  --host gw-kmg --no-push --dry-run --now 2026-10-19T00:00:00+09:00'
```

The command performs the refresh (`git fetch --prune`, remote-tracking refs
only) and reads `origin/main`; it does not pull or write pages. For a strictly
non-mutating first check, add `--no-fetch` to the dry run only.

On gw-kmg there is no bun and no gjc-plugin checkout, so the default RRSI path
is `skipped` (partial/blocked digest). That is expected. The Hermes skill checks
the JJO-129 Python RRSI surface and passes its receipt with `--rrsi-json`. When
the surface is absent, the skill writes a blocked marker
(`{"schema":"hermes-evolution.rrsi-blocked.v1","status":"blocked","reason":"python_rrsi_surface_missing"}`)
and the digest reports `rrsi_status: "blocked"`; it never fabricates metrics.

## 5. Hermes weekly cron (manual registration)

Register once, after the skill and writer are installed and verified:

```sh
hermes cron create "0 0 * * 1" \
  "Run the self-evolution skill for gw-kmg and deliver the digest." \
  --name hermes-evolution --deliver discord --continuity
```

- `0 0 * * 1` is Monday 00:00 in the Hermes process timezone; confirm the
  runtime timezone is `Asia/Seoul` before relying on it.
- `--deliver discord` targets the configured Hermes home channel
  (`1557381856909988001`, `#가재웨이` as recorded in `discord/docs/operations.md`).
  Do not substitute a DM, `#secret`, or an unrelated channel.
- `--continuity` is optional; keep it only if the existing Hermes cron
  convention uses it.
- The skill itself never changes cron jobs or permissions.

Verify manually:

```sh
hermes cron list
hermes cron run <job-id>
```

Then confirm the home channel received one bounded message and that
`/home/gjc/.hermes-evolution/digests/<date>-gw-kmg.md` and `ledger.jsonl` exist.

## 6. Failure and recovery

| Situation | Observed behavior | Recovery |
| --- | --- | --- |
| Wiki checkout missing/unreadable | `wiki_head: null`, `citations: []`, body `근거 없음`; digest `partial` or `blocked`; exit 0 | Restore the checkout; rerun the next week. Do not edit the wiki from this loop. |
| Wiki `fetch` fails (offline/remote) | fetch recorded as skipped; the reader still uses the last fetched `origin/main` (or `HEAD`); exit 0 | Check network/credentials; rerun manually if needed. |
| bun or `journal-dream.mjs` missing | `rrsi_status: "skipped"`; not fatal | Enable the RRSI surface (JJO-129 on gw-kmg; bun on Mac). Never synthesize a receipt. |
| Journal empty (`no_journal`/`no_records`) | `rrsi_status: "no_input"` | Record real attempts; rerun next week. |
| Receipt invalid/unreadable | `rrsi_status: "error"` with a fixed reason code | Replace the receipt with a valid one; inspect the source. |
| JJO-129 Python RRSI surface absent on gw-kmg | blocked marker passed via `--rrsi-json`; digest `blocked` | Do not fabricate metrics; resolve JJO-129 or report blocked. |
| Same `(date, host)` already recorded with a different sha | exit 2, `conflict`, no overwrite | Inspect the ledger and digest. Do not delete or rewrite the row. Use a fresh date for a new digest. |
| Digest written, ledger append crashed | rerun with the same `--now` reports `recovered` and appends the missing row | Confirm one ledger line and the same digest bytes. |
| Digest written, commit/push failed | exit 2, `landing: git_push_failed`; digest remains | Fix the remote, then commit and push the existing digest + ledger manually. Do not regenerate with a new timestamp (that becomes a conflict). |
| launchd job never fires | `launchctl print` shows the job; check the logs | Re-run `install.sh --apply`, then `bootout`/`bootstrap`; verify `StartCalendarInterval`. |
| Home-channel delivery fails | digest file and ledger remain; delivery is pending | Check the Hermes cron output/job state; rerun `hermes cron run <job-id>` manually. Do not switch to a DM or another channel. |
| Digest exceeds 8 KiB | writer shrinks the verdict and, as a last resort, trims the tail; required headings remain | Inspect the receipt size; do not raise the bound. |

## 7. Verification checklist

- [ ] `python3 -m py_compile hermes/scripts/weekly_evolution.py` passes.
- [ ] `python3 -m unittest discover -s hermes/tests -v` passes.
- [ ] `python3 ... --host mac --dry-run --now 2026-10-19T00:00:00+09:00` prints all four body sections.
- [ ] `~/.hermes-evolution` is absent after the dry run.
- [ ] `hermes/mac/install.sh --print` renders a valid plist; `--apply` is idempotent.
- [ ] gw-kmg skill and writer sha256 values match the Mac source.
- [ ] The private repo contains only `digests/<date>-mac.md` and `digests/ledger.jsonl` in the weekly commit.
- [ ] No digest exists in `gjc-plugin` or any public repository.
