# JJO-1985 — live session re-creates its deleted cwd, run receipts

Host: macOS 27.0.0, Darwin arm64 (`mini`). Binary `gjc/0.20.0` (Bun-compiled, `~/.local/bin/gjc`,
mtime 2026-11-10). Runs on 2026-11-12, timestamps UTC.

| run | session id | deleted | re-created | re-created after | result |
| --- | --- | --- | --- | --- | --- |
| 1 (ambient session env) | `9a1f11ab-ff67-4555-8b0d-c3e5895b1f9f` | 20:23:36Z | 20:23:38Z | 3 s | reproduced |
| 2 (clean session env) | `01a1cc48-b574-7771-a8d8-aafa1eb97948` | 20:24:41Z | 20:24:42Z | 2 s | reproduced |
| 3 (clean session env) | `01a1cc4a-bedf-76a0-a091-45c1ef52c5be` | 20:26:56Z | 20:26:57Z | 2 s | reproduced |

Run 1 is the control for a trap: a `gjc` started from inside another GJC session inherits
`GJC_SESSION_ID` and reuses the parent's session id. Runs 2 and 3 unset the session/lifecycle
variables, so the child gets its own id — the realistic lane case. All three behaved the same.

`run-clean3.log` is the verbatim stdout of run 3 with `$HOME` substituted for the absolute home path;
the file tree, timings and `lsof` lines are otherwise untouched. The orchestration script that
produced all three runs is quoted in
[`docs/gjc-0.20-session-cwd-resurrection.md`](../../docs/gjc-0.20-session-cwd-resurrection.md).

Re-created set (identical in all runs): `<cwd>`, `<cwd>/.gjc` and
`<cwd>/.gjc/_session-<id>/{locks,runtime,token-logs}` with mode `0700`. Not re-created:
`<cwd>/.gjc/state/sdk/*.json`.

Cause and the requested upstream change are in the document above; no GJC source was modified
(JJO-1985 non-scope).
