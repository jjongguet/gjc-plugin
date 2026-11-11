# A live GJC 0.20.0 session recreates its deleted working directory

A GJC session keeps its workflow state under its working directory, at `<cwd>/.gjc/_session-<id>`.
Every writer of that state creates the missing ancestors of its target path, so when the working
directory is removed while the session is still running — exactly what `lane-release --self` does to
a recalled lane worktree — the next state write re-creates `<cwd>`, `<cwd>/.gjc` and
`<cwd>/.gjc/_session-<id>/…`. The removed directory comes back, owned by nobody, and the recall that
removed it looks like it failed.

That is the residue pattern recorded in JJO-922/JJO-1985: recalled lane directories left behind with
no git worktree, only `.gjc/_session-*`. The recall is not the defect. The defect is that a session
whose cwd is gone keeps writing to it.

All of this is GJC core behaviour (`Yeachan-Heo/gajae-code`), not something a plugin bundle controls,
so this document records the reproduction, the cause and the requested change instead of a patch.
The commands and output below were produced on this host on 2026-11-12.

## Environment

```sh
gjc --version        # gjc/0.20.0
ls -l ~/.local/bin/gjc   # Bun-compiled Mach-O arm64, mtime 2026-11-10 00:49
uname -sm            # Darwin arm64
```

Upstream source read at tag `v0.20.0` (`b4127889c4a8`); file:line references below are that tag.

## Reproduction

The scenario needs three things at once: a real lane-like directory (not `/tmp`), a session whose
cwd is that directory, and a deletion while the session is alive. The script below starts the
session in the background, waits until the state tree exists and a long `bash` call is running,
removes the directory, then polls for its return.

```sh
REPRO="$HOME/jjo1985-repro-clean"; LANE="$REPRO/lane"; LOG="$REPRO/session.log"
rm -rf "$REPRO"; mkdir -p "$LANE"; cd "$LANE"
git init -q .
git config user.email repro@example.invalid; git config user.name repro
: > README.md; git add README.md; git commit -qm init

# Clean session environment: a child gjc launched from inside another GJC session
# inherits GJC_SESSION_ID and would reuse the parent's id. Unset the session/lifecycle
# variables so the child gets its own session id, as a real lane session would.
CLEAN="env -u GJC_SESSION_ID -u GJC_SESSION_CWD -u GJC_STATE_ROOT \
  -u GJC_LIFECYCLE_REQUEST_ID -u GJC_SDK_LIFECYCLE_REQUEST -u GJC_ISOLATED_SHELL_RUNTIME"

( cd "$LANE" && exec $CLEAN gjc -p --no-mcp 'Use the bash tool exactly three times and nothing
  else. Call 1: run `pwd`. Call 2: run `sleep 40`. Call 3: run `pwd`. Then print the stdout of
  each call, labelled 1/2/3.' ) >"$LOG" 2>&1 &

until compgen -G "$LANE/.gjc/_session-*/runtime/runtime-state.json" >/dev/null; do sleep 1; done
until ps -ax -o command= | grep -q '[s]leep 40'; do sleep 1; done
lsof +D "$LANE" | awk 'NR==1 || /gjc|sleep/'

cd "$REPRO" && rm -rf "$LANE"          # the live session's cwd is now gone
for i in $(seq 1 120); do [ -e "$LANE" ] && { echo "recreated after ${i}s"; break; }; sleep 1; done
find "$LANE" | sort; wait "$!"
```

Observed (first run, child launched with the ambient GJC environment). Absolute home paths below are
shown as `$HOME`; nothing else in the transcripts was edited.

```text
VERSION gjc/0.20.0
START 20:23:31Z
gjc_pid 9685
STATE_CREATED 20:23:36Z
--- files before deletion ---
.gjc/_session-9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f/runtime/runtime-state.json
.gjc/_session-9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f/runtime/runtime-state.json.lock
.gjc/_session-9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f/runtime/runtime-state.json.lock.transition.owner
SLEEP_STARTED 20:23:36Z
COMMAND PID NAME
gjc 9685 $HOME/jjo1985-repro/lane
DELETED 20:23:36Z exists=no
RECREATED 20:23:38Z after_3s
.
./.gjc
./.gjc/_session-9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f
./.gjc/_session-9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f/locks
./.gjc/_session-9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f/runtime
./.gjc/_session-9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f/runtime/runtime-state.json.lock
./.gjc/_session-9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f/runtime/runtime-state.json.lock.transition.owner
./.gjc/_session-9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f/token-logs
./.gjc/_session-9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f/token-logs/token-log.jsonl
REAPPEARED yes
GJC_EXIT 0
```

Second run, with the session environment unset so the child gets its own session id — the realistic
lane case:

```text
VERSION gjc/0.20.0
MODE clean
START 20:24:38Z
gjc_pid 12053
STATE_CREATED 20:24:41Z
SLEEP_STARTED 20:24:41Z
COMMAND PID NAME
gjc 12053 $HOME/jjo1985-repro-clean/lane
DELETED 20:24:41Z exists=no
RECREATED 20:24:42Z after_2s
.session-01a1cc48-b574-7771-a8d8-aafa1eb97948/{locks,runtime,token-logs}
REAPPEARED yes
GJC_EXIT 0
--- final tree ---
.
./.gjc
./.gjc/_session-01a1cc48-b574-7771-a8d8-aafa1eb97948
./.gjc/_session-01a1cc48-b574-7771-a8d8-aafa1eb97948/locks
./.gjc/_session-01a1cc48-b574-7771-a8d8-aafa1eb97948/runtime
./.gjc/_session-01a1cc48-b574-7771-a8d8-aafa1eb97948/runtime/runtime-state.json
./.gjc/_session-01a1cc48-b574-7771-a8d8-aafa1eb97948/runtime/runtime-state.json.lock
./.gjc/_session-01a1cc48-b574-7771-a8d8-aafa1eb97948/runtime/runtime-state.json.lock.transition.owner
./.gjc/_session-01a1cc48-b574-7771-a8d8-aafa1eb97948/token-logs
./.gjc/_session-01a1cc48-b574-7771-a8d8-aafa1eb97948/token-logs/token-log.jsonl
--- session log ---
1/ `$HOME/jjo1985-repro-clean/lane`
2/ (no output — `sleep 40` exited 0)
3/ `$HOME/jjo1985-repro-clean/lane`
```

Both runs behaved identically. The third `bash` call (`pwd`) succeeded with the same path it printed
before the deletion, which is only possible because the directory existed again by then: a spawn
whose cwd is gone fails with `ENOENT`. The session never noticed that its cwd had been removed.
A third run with the same clean environment reproduced it again (deleted 20:26:56Z, back 20:26:57Z);
its verbatim output is `artifacts/jjo-1985/run-clean3.log`, and the three-run table is
`artifacts/jjo-1985/run.md`.

### What comes back, and what does not

| Path | Re-created | Evidence |
| --- | --- | --- |
| `<cwd>` itself | yes, mode `0700` | `ls -ld …/lane` → `drwx------` |
| `<cwd>/.gjc` | yes, mode `0700` | `drwx------` |
| `<cwd>/.gjc/_session-<id>/{locks,runtime,token-logs}` | yes | tree above |
| `<cwd>/.gjc/_session-<id>/runtime/runtime-state.json` | yes, at session end | final tree |
| `<cwd>/.gjc/state/sdk/<id>.json` (+ `.lifecycle*.json`) | **no** | absent from both final trees |

The `0700` mode on the returned directories is the writers' own mode (`fs.mkdir(…, { mode: 0o700 })`);
a directory restored by an operator or by a checkout would not carry it. That, plus the absence of
`state/sdk/`, is what makes the historical residue recognisable: a recalled lane with no git worktree
holding only `.gjc/_session-*` — the launch-time sidecar under `state/sdk/` is not re-written, but the
per-session runtime tree is.

The re-created `runtime/runtime-state.json` still records the removed path in its `cwd` member
(keys include `cwd`, `session_id`, `workdir`, `state`, `updated_at`), i.e. the session keeps
addressing a directory that no longer exists.

## Cause

The state root is derived from the session cwd, and every writer creates missing ancestors, including
ancestors above `.gjc`:

1. **Path anchored at the cwd.** `packages/coding-agent/src/gjc-runtime/session-layout.ts:72-75`
   (`sessionRoot(cwd, id)` → `path.join(gjcRoot(cwd), "_session-" + encodeSessionSegment(id))`,
   with `gjcRoot(cwd) = path.join(cwd, ".gjc")` at `:66-69`) and `:135-137`
   (`sessionRuntimeStatePath` → `…/runtime/runtime-state.json`). The layout is pure and has no
   existence check by design; the defect is in the writers' willingness to create it.
2. **Atomic state writes.** `packages/coding-agent/src/gjc-runtime/session-state-sidecar.ts:1834`
   calls `writeCoordinatorAtomic(stateFile, …)`, which is
   `packages/coding-agent/src/coordinator-mcp/durability.ts:156`
   → `ensureCoordinatorDirectory(path.dirname(file))` at `:26-52`. That helper walks up from the
   target collecting every `ENOENT` ancestor and `mkdir`s each one — `<cwd>`, `<cwd>/.gjc`,
   `<cwd>/.gjc/_session-<id>`, `…/runtime` — so a missing cwd is silently treated as a directory to
   create. The same helper backs the append path at `:110`.
3. **Lock files.** `packages/coding-agent/src/gjc-runtime/session-state-lock.ts:3043` calls
   `ensureSessionStateParent(path.dirname(stateFile))`; that function (`:317-345`) reimplements the
   same ancestor walk with `fs.mkdir(created, { mode: 0o700 })` + `chmod`. It runs before the state
   write, which is why the `*.lock` files reappear before `runtime-state.json` does.
4. **Token log.** `packages/coding-agent/src/task/token-log.ts:111` does
   `fs.mkdir(dir, { recursive: true, mode: 0o700 })` on
   `path.join(sessionRoot(cwd, managerId), "token-logs")` (`:88`), so a model turn after the deletion
   re-creates the tree on its own.

The runtime already knows the condition. On resume it guards the same case:
`packages/coding-agent/src/main.ts:2494-2505` restores a resumed session's cwd only when
`fs.stat(sessionCwd)` reports a directory, and swallows `ENOENT` with the comment
`// Session cwd no longer exists (e.g. worktree removed); keep current dir.` The state writers do not
apply that rule, so the runtime that refuses to *use* a removed cwd happily *re-creates* it.

## What this costs downstream

`lane-release --self` removes a lane worktree while its session is still alive; the session then
writes the path back within seconds. The lane recall reports success and the directory returns, so
`~/jjongguet/lanes` accumulates non-worktree directories (37 measured on 2026-11-09) that only
`lane-release --residue` can move to the archive. Every one of them is a `0700` `.gjc/_session-*`
tree with no git metadata.

## Upstream report draft

Title: `Live session re-creates its deleted cwd (.gjc/_session-*) on the next state write`

Body:

> **What happens.** A running session keeps writing `<cwd>/.gjc/_session-<id>/…`. When the cwd is
> removed while the session is alive (a recalled lane worktree, a removed scratch dir), the next
> state write re-creates `<cwd>`, `<cwd>/.gjc` and the per-session tree. The session continues and
> its next `bash` call succeeds in the restored directory. Reproduced on `gjc/0.20.0`, Darwin arm64
> (`v0.20.0` = `b4127889c4a8`).
>
> **Why it is wrong.** The cwd is gone by the user's (or a manager's) decision. Re-creating it
> defeats the removal, leaves a `0700` residue that looks like a failed cleanup, and makes the state
> file claim a `cwd` that no longer exists. `main.ts:2494-2505` already treats "worktree removed" as
> a valid condition at resume; the writers should agree.
>
> **Where.** `session-layout.ts:72-75,135-137` (cwd-anchored root),
> `coordinator-mcp/durability.ts:26-52` (`ensureCoordinatorDirectory` mkdirs every missing
> ancestor, called from `session-state-sidecar.ts:1834` and `:110`),
> `session-state-lock.ts:317-345` via `:3043`, `task/token-log.ts:111` (`mkdir -p`).
>
> **Requested change.**
> 1. Before creating the session root, require the session cwd to still exist (`fs.stat(cwd)` or a
>    bounded create that starts no higher than `<cwd>/.gjc`); on `ENOENT` do not create anything.
> 2. Surface that as one typed, deduplicated diagnostic (e.g. `session_root_missing`) so callers can
>    see that the session outlived its working directory, instead of failing silently.
> 3. Keep the write a no-op for the rest of the process lifetime once the cwd is missing; the
>    postmortem/finalizer writes must not resurrect it either.
>
> **Reproduction.** `gjc -p` is started in a scratch git repo and asked for three `bash` calls
> (`pwd`, `sleep 40`, `pwd`); the directory is `rm -rf`-ed while the `sleep` runs. Two seconds later
> the directory is back with `.gjc/_session-<id>/{locks,runtime,token-logs}` and the third call
> prints the restored path. Full recipe and output are in
> `jjongguet/gjc-plugin:docs/gjc-0.20-session-cwd-resurrection.md`.

Filing the upstream issue or a PR is a separate approval (JJO-1985) — nothing here has been sent to
`Yeachan-Heo/gajae-code`.

## Limits of this document

- Only `gjc/0.20.0` was exercised, on Darwin arm64. Other versions were not run.
- The re-created *set* is stable across the two runs; which writer fires first was not attributed
  per-writer. Items 2–4 above all create the same ancestors, so attribution would need per-writer
  tracing (`fs_usage`/`dtruss`) that this record does not include.
- The deletion was `rm -rf`, not `lane-release --self`; both remove the directory while a session
  lives, and `lane-release` additionally holds a `git worktree lock` that does not survive its own
  removal. The mechanism under test — a state write after the cwd is gone — is identical.
- No upstream patch is included. The fix belongs to GJC core.
