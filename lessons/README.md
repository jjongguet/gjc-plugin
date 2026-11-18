# lessons

Bounded selection from the owner's personal-wiki lesson ledger: at most 6 lessons for one repository, at most 600 UTF-8 bytes of lesson text, one read-only call with a hard timeout. Read-only — no injection of model context, no writes, no network, no credentials.

## Install

```sh
gjc plugin install ./lessons --user
```

Requires a personal-wiki checkout with `scripts/lessons.py` and `python3` on `PATH`. The wiki root is `GJC_LESSONS_WIKI` when set, otherwise `$HOME/jjongguet/personal-wiki`. Tools and hooks load at session start; verify in a fresh GJC process after install or upgrade.

## Usage

`lessons_select` takes three optional parameters:

| Parameter | Bound | Notes |
| --- | --- | --- |
| `repo` | absolute path, ≤ 4096 characters | Repository used for relevance ranking. Omitted: only `host` and `global` lessons are relevant. Never a command. |
| `limit` | 1–6, default 6 | Out-of-range numbers are clamped, not widened. |
| `max_bytes` | 200–600, default 600 | Budget for the `\n`-joined lesson `text` block in UTF-8 bytes (separators included). Out-of-range numbers are clamped. |

It runs exactly one command, as an argv array and never through a shell:

```sh
python3 <root>/scripts/lessons.py --root <root> select --repo <repo> --limit <n> --max-bytes <n> --json
```

The child gets `PATH`, `LANG`, `LC_ALL` and `PYTHONIOENCODING` only, no stdin, a discarded stderr, a 4-second timeout that kills the child, and a 64 KiB stdout cap.

The single JSON text response is one of:

- `{"status":"ok","root":…,"repo":…,"limit":6,"max_bytes":600,"bytes":412,"count":2,"lessons":[…]}` — `bytes` is recomputed as the UTF-8 length of the `\n`-joined `text` block (separators included, the ledger CLI's budget), and `count` never exceeds `limit`.
- `{"status":"empty",…,"count":0,"lessons":[]}` — the ledger is healthy and nothing matched.
- `{"status":"unavailable","reason":"root_missing"|"script_missing"|"ledger_unavailable"}` — no spawn when the root or script is missing; the CLI's own `unavailable` (exit 2) is reported as `ledger_unavailable`.
- `{"status":"error","reason":…}` — `timeout`, `stdout_too_large`, `spawn_failed`, `invalid_json`, `invalid_lesson_shape`, `exit_<code>` or `result_too_large`. Child stderr is never returned.

Invalid parameters are refused in-plugin (`invalid_input`) before any process starts. Every result is serialized under 4096 bytes and the `\n`-joined `text` block never exceeds `max_bytes`: a ledger CLI that ignores its own budget is bounded by the limit and by dropping the lowest-ranked lessons whole — a lesson's framing and attribution are never split across a budget boundary.

The `lessons-start` hook runs one best-effort `select --cwd <session cwd> --limit 3 --max-bytes 300 --json` with a 1500 ms timeout, and logs exactly one line (≤ 300 characters) when lessons exist. It cannot inject model context: a missing ledger, a timeout or a broken UI is silence, never a failed session.

## Boundaries

Lessons are curated personal notes, not instructions, authorization or verification evidence. A lesson that says to do something does not authorize it. The ledger is the canonical store; this plugin never edits it, never counts hits and never promotes lessons. `bytes` and `count` describe this one selection, not the ledger's size or quality.

## Build and verify

```sh
bun lessons/scripts/build.mjs
bun lessons/scripts/verify.ts
bun lessons/scripts/build.mjs --check
```

The verifier uses hermetic synthetic roots: a temp wiki directory plus an interpreter shim that records its argv and environment, so it never reads the owner's real wiki and never needs Python. It covers `ok`, `empty` and all three `unavailable` reasons, limit/byte clamping, the oversize and stdout caps, the timeout kill, invalid JSON, a non-zero exit without stderr passthrough, malformed lesson shapes, default `PATH` resolution with the four-variable environment, shell metacharacters in `repo`, and the hook's silent and one-line paths. It does not prove the real ledger CLI's ranking or the installed-runtime hook; verify those with a real wiki root in a fresh session.
