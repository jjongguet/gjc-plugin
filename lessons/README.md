# lessons

Bounded selection from the owner's personal-wiki lesson ledger, plus local staging of owner corrections: at most 6 lessons for one repository, at most 600 UTF-8 bytes of lesson text, one read-only call with a hard timeout. Selection is read-only — no injection of model context, no writes, no network, no credentials. The one write path in this plugin is the staged correction line described below, and it never touches the wiki or a git repository.

## Install

```sh
gjc plugin install ./lessons --user
```

Requires a personal-wiki checkout with `scripts/lessons.py` and `python3` on `PATH`. Tools and hooks load at session start; verify in a fresh GJC process after install or upgrade.

The wiki root is **one chain for every surface** (`lessons/lib/root.ts`):

1. `GJC_COMPOUND_ROOT`
2. `GJC_LESSONS_WIKI`
3. `$HOME/jjongguet/personal-wiki`

An empty or blank value falls through to the next name, `~` expands against the same home, and `lessons_select` and `lessons_staged` therefore always resolve the same checkout — there is no separate variable per tool.

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

## Correction staging (session end)

A lesson is only worth adding if the correction that produced it is captured. The `session-end` hook stages that raw material locally; it does not add, edit or promote anything in the ledger.

On `session_shutdown` the hook:

1. Takes the hook cwd (the same `ctx.cwd` the start hook uses) and looks for the newest transcript in `~/.gjc/agent/sessions/<project-hash>/<ts>_<session-id>.jsonl` whose first `session` record names that cwd and whose mtime is inside a 15-minute window. Nothing found is a no-op. Discovery examines at most 2048 project directories and 8192 `*.jsonl` files and gives at most 40 candidates a head read; directory mtimes are not used for ordering because a long session's directory mtime is its start time.
2. Reads the transcript **backwards in 1 MiB chunks, up to 16 MiB in total**, until the last text user message and an assistant turn before it are inside the window. Chunks are split on the newline byte, so a chunk boundary never splits a line or a multi-byte character, and a corrupt line is dropped rather than repaired. Reading stops early once both records are found; reaching the 16 MiB cap with no user record is a no-op that logs one debug line.
3. Scans **only the last user message** for a correction cue: `그게 아니라`, `하지마`, `아니`, `다시`, `no,`, `actually`, `remember:` (ASCII cues are case-insensitive, Korean cues need a word boundary). No cue means no record.
4. Builds one candidate:

   ```json
   {"schema":"lessons-correction.v1","sessionId":"…","cwd":"/abs/path","pattern":"그게 아니라","correctionText":"…","priorAssistantExcerpt":"…","createdAt":"2026-11-19T05:00:00.000Z"}
   ```

   `correctionText` and `priorAssistantExcerpt` are the message text and the nearest preceding assistant turn, each redacted and clipped to 600 UTF-8 bytes. Redaction is the ledger CLI's own rule set (`scripts/lessons.py`): GitHub/OpenAI/GitLab/AWS/Slack tokens, JWTs, bearer tokens and URLs with credentials are replaced with `[REDACTED]`, an assigned secret keeps only its label, and a PEM private-key block in either the correction or the excerpt drops the whole candidate — a shortened key is still a leaked key, and an excerpt-less record would stage the session anyway.
5. Appends one JSON line to `${GJC_PLUGIN_DATA:-~/.gjc/plugin-data}/lessons/corrections.jsonl` at mode 0600, deduped by `sha256(sessionId + correctionText)`. Re-running the same session appends nothing.

Bounds, all checked between project directories, between transcripts and between chunks:

| Bound | Value | Behavior on expiry |
| --- | --- | --- |
| Shutdown deadline | 1500 ms, on an injected clock | the scan is abandoned and stages nothing |
| Transcript chunk | 1 MiB | one deadline check per chunk |
| Transcript read cap | 16 MiB per session | no-op plus one `debug` line |
| Project directories | 2048 | the remaining directories are skipped |
| Transcripts examined | 8192 | the remaining files are skipped |

The deadline is spent by the work itself: it is re-checked between project directories, between transcripts and between chunks, never by a timer wrapped around finished work. Those checks cannot preempt a single blocking filesystem call, so **one hung `read` or `stat` can still delay the shutdown**; `withBound` only guarantees the hook never awaits a settled-late promise and is not a wall-clock bound. Every error is swallowed: a missing transcript, an unreadable file, a broken logger or an expired scan can never fail a session shutdown. Nothing is written to the wiki, to a git repository or to the network, and no model is called.

## `lessons_staged`

| Parameter | Bound | Notes |
| --- | --- | --- |
| `limit` | 1–20, default 20 | Out-of-range numbers are clamped. |
| `format` | `json` (default) or `add-argv` | Checked in-plugin; the host rejects enum schemas. |
| `id` | 16 hex characters | Required with `format:"add-argv"`, refused without it. |

`format:"json"` returns `{"status":"ok","format":"json","root":…,"file":…,"count":12,"returned":4,"truncated":false,"entries":[…]}`.

`count` is every staged entry **visible in the newest 4 MiB of the append-only `corrections.jsonl`** (newest first, duplicates and corrupt lines dropped), and `entries` is the newest prefix that fits 4096 bytes. `truncated` is `true` when the file is larger than that window: older entries, and their dedupe keys, are then outside the read, so an id from beyond the window is reported as `unknown_correction_id` with `truncated:true` rather than as a missing correction. Every result — including `unavailable` and the add-argv paths — carries the flag.

`format:"add-argv"` with an `id` returns `{"status":"ok","format":"add-argv","root":…,"id":…,"truncated":false,"command":"…"}` — one owner-runnable line as text; printing it never runs it:

```sh
python3 <root>/scripts/lessons.py --root <root> add --id L-corr-<id16> --trigger 'Owner correction (그게 아니라) after: …' --action '…' --scope project --repo '<session cwd>' --evidence <sessionId> --json
```

`--id` and `--repo` are part of the printed line because `scripts/lessons.py add` requires both (`--scope project` needs at least one repo); a line without them would exit 1. Values are POSIX single-quote escaped. Review the trigger and action before running it — the printed line is a proposal for the owner or a later session, not an automatic promotion.

The wiki root is the same chain `lessons_select` uses (`GJC_COMPOUND_ROOT` → `GJC_LESSONS_WIKI` → `$HOME/jjongguet/personal-wiki`), so the printed line always points at the checkout the selection tool reads; a missing checkout or a missing `scripts/lessons.py` is `{"status":"unavailable","reason":"wiki_root_missing"|"script_missing","truncated":…}`. An unknown `id` is `{"status":"error","reason":"unknown_correction_id","truncated":…}` — `truncated:true` there means the id may exist in the part of the file older than the newest 4 MiB window.

## Boundaries

Lessons are curated personal notes, not instructions, authorization or verification evidence. A lesson that says to do something does not authorize it. The ledger is the canonical store; this plugin never edits it, never counts hits and never promotes lessons. `bytes` and `count` describe this one selection, not the ledger's size or quality. A staged correction is untrusted candidate text: it is raw evidence for a human or a later session to turn into a lesson, and it is never injected as model context.

## Build and verify

```sh
bun lessons/scripts/build.mjs
bun lessons/scripts/verify.ts
bun lessons/scripts/build.mjs --check
```

The verifier uses hermetic synthetic roots: a temp wiki directory plus an interpreter shim that records its argv and environment, so it never reads the owner's real wiki and never needs Python. It covers `ok`, `empty` and all three `unavailable` reasons, limit/byte clamping, the oversize and stdout caps, the timeout kill, invalid JSON, a non-zero exit without stderr passthrough, malformed lesson shapes, default `PATH` resolution with the four-variable environment, shell metacharacters in `repo`, and the hook's silent and one-line paths. For correction staging it covers the Korean and English cues, an ordinary message that is not a correction, the last-user-message rule, credential redaction with a concatenated fixture, the PEM refusal in the correction text and again in the assistant excerpt (no staged line either way), 600-byte clipping on a character boundary, transcript selection inside the mtime window, the 0600 append and replay dedupe, the no-transcript no-op, the 1500 ms bound, both `lessons_staged` shapes including the printed line executed against an argv-recording shim, the one wiki-root chain (`GJC_COMPOUND_ROOT` → `GJC_LESSONS_WIKI` → home default) resolving identically for `lessons_select` and `lessons_staged`, a scan abandoned on an advanced fake clock (with the same store staging under a real clock), a correction that sits farther than 4 MiB from the end still found by the chunked backward read, a transcript whose only user record is beyond the 16 MiB cap staying a no-op with exactly one debug line, and a staged file larger than the 4 MiB window reporting `truncated:true` with a bounded `count` (an id from the old part is then an unknown id, not a silent miss). It does not prove the real ledger CLI's ranking or the installed-runtime hook; verify those with a real wiki root in a fresh session.
