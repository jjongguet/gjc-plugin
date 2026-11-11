# JJO-1985 — live session re-creates its deleted cwd, run receipts

Host: macOS 27.0.0, Darwin arm64 (`mini`). Binary `gjc/0.20.0` (Bun-compiled, `~/.local/bin/gjc`,
mtime 2026-11-10). Runs on 2026-11-12, timestamps UTC.

| run | in-flight predicate | session id | deleted | re-created | after | result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `ps` grep (weaker) | `9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f` | 20:23:36Z | 20:23:38Z | 3 s | reproduced |
| 2 | `ps` grep (weaker) | `01a1cc48-b574-7771-a8d8-aafa1eb97948` | 20:24:41Z | 20:24:42Z | 2 s | reproduced |
| 3 | `ps` grep (weaker) | `01a1cc4a-bedf-76a0-a091-45c1ef52c5be` | 20:26:56Z | 20:26:57Z | 2 s | reproduced |
| 4 | out-of-lane sentinel | `01a1cc4e-3073-748f-a5c4-4a8c52d945e8` | 20:30:46Z | 20:31:26Z | 36 s | reproduced |

Runs 2–4 unset `GJC_SESSION_ID`, `GJC_SESSION_CWD`, `GJC_STATE_ROOT`, `GJC_LIFECYCLE_REQUEST_ID`,
`GJC_SDK_LIFECYCLE_REQUEST` and `GJC_ISOLATED_SHELL_RUNTIME`, so the child session gets its own id —
the realistic lane case. Run 1 inherits them, which is the control for that trap: a `gjc` started
from inside another GJC session reuses the parent's session id.

Runs 1–3 waited for the long `bash` call with `ps -ax -o command= | grep '[s]leep 40'`. That
predicate is not proof: the `gjc -p` command line itself contains the prompt text `sleep 40`, and
`ps -ax` also sees unrelated processes, so the deletion could have preceded the second call. Run 4
replaces it with a sentinel file outside the lane that the session touches before sleeping; deletion
happened only after it existed. That is the run that proves the deletion happened while the call was
in flight, and it also shows the 40 s gap: nothing is written while the tool runs, and the tree
returns when the call finishes and the session writes its next state.

`run-clean4.log` (sentinel run) and `run-clean3.log` (last weaker-predicate run) are verbatim stdout
with `$HOME` substituted for the absolute home path; file trees, timings and `lsof` lines are
otherwise untouched. The orchestration script is quoted in
[`docs/gjc-0.20-session-cwd-resurrection.md`](../../docs/gjc-0.20-session-cwd-resurrection.md).

Re-created set (identical in all runs): `<cwd>`, `<cwd>/.gjc` and
`<cwd>/.gjc/_session-<id>/{locks,runtime,token-logs}` with mode `0700`. Not re-created:
`<cwd>/.gjc/state/sdk/*.json`.

Cause and the requested upstream change are in the document above; no GJC source was modified
(JJO-1985 non-scope).
