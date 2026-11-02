# nightly-review — post-merge review with independent lenses and a deterministic gate

Reviews the pull requests merged in the last day with several independent reviewer
calls, then keeps only the findings whose quoted code actually exists in the merged
diff. Models propose; a deterministic gate decides.

The reason the gate exists: a finding a model cannot quote is a guess, and a guess
that becomes a ticket costs more attention than it saves. Nothing here writes to
Linear. Surviving findings land in a run directory as a report plus a receipt, and a
separate, explicitly approved step turns them into issues.

## Pipeline

| Stage | What it does | Model calls |
| --- | --- | --- |
| collect | `gh pr list --state merged --search "merged:>=DATE"`, `gh pr diff`, and the repository's own `AGENTS.md` at the reviewed commit (`input/<repo>/pr-<n>.json`) | none |
| lenses | one headless GJC process per (PR × lens), no tools, no MCP, no rules, scratch cwd | one per cell |
| gate | quote/path/line verification, near-duplicate collapse, per-run cap | none |
| report | `report.md` plus `receipt.json` in the run directory | none |

Each lens call runs in its own process with its own temporary working directory, so
no reviewer sees another reviewer's conclusion and no project context is injected —
the diff and the repository's rules are the only evidence. Concurrency is capped so
the provider is not rate-limited into empty results that would look like "nothing
found".

## Repository rules

Every repository in this workspace carries its review conventions in `AGENTS.md`, and
the repository's own Codex reviewer reads them. This tool does the same: `collect`
fetches `AGENTS.md` at the reviewed commit — the root file first, then the
`AGENTS.md` nearest each changed file — and every lens prompt receives them under
`REPOSITORY RULES` with two constraints: a change that violates a written rule is a
finding, and a rule that is not written does not exist, so a reviewer may not invent
repository conventions. The shared budget is 12000 bytes across all rule documents;
each document records whether it was truncated, and `--no-rules` can be added per run
to compare with and without.

## Entry points

```sh
nightly-review/bin/nightly-review.mjs once --repos infra,yyaz-web --since 2026-11-02
nightly-review/bin/nightly-review.mjs once --repos infra --lenses contract,failure --json
nightly-review/bin/nightly-review.mjs recheck --run <run-dir>     # re-gate, no model calls
nightly-review/bin/nightly-review.mjs loop --repos infra --interval 86400
```

Flags: `--repos` (required for `once`), `--since` (default yesterday), `--lenses`,
`--out` (default `~/.gjc-plugin/nightly-review`), `--max-diff-bytes` (default
40000), `--concurrency` (default 4), `--soft-bytes` (default 100663296),
`--max-findings` (default 15), `--no-rules`, `--json`.

Exit codes: `0` ok, `2` invalid arguments.

`loop` runs only inside the terminal you started. There is no launchd or cron
installation in this repository: a timer is a separate decision with its own budget
ceiling, and this tool does not make it.

## Lenses

| id | model family | looks for |
| --- | --- | --- |
| `contract` | deepseek | renamed or removed symbols still referenced, signature drift, OpenAPI or schema mismatch, migration columns vs readers |
| `failure` | deepseek | unhandled errors, empty/null/zero/single-element cases, bounds, partial writes, unbounded retries, error paths that report success |
| `security` | glm | untrusted input reaching a shell/query/path/template, missing authorization or RLS on a new path, secrets in logs, permissive defaults |
| `testgap` | deepseek | behavior changes with no test, assertions that assert nothing, mocks that replace the thing under test, skipped assertions |
| `regression` | glm | untouched files that depend on what changed, generated or vendored files out of sync, docs and manifests describing the old shape |

Two model families are mixed on purpose. Reviewers of the same model share blind
spots, which is exactly what an ensemble is supposed to break. A lens changes what
is asked, not just the sampling — a second identical prompt only buys correlated
noise.

## Gate

A finding survives only when all of these hold:

1. `file` appears in the diff as an added file (`+++ b/...`, `/dev/null` excluded).
2. `quote` appears in that file's added lines after whitespace normalization.
3. `quote` is specific enough: at least 12 characters after normalization and at
   least 6 alphanumeric characters, so `return` and `}` cannot pass.
4. `line` is corrected to the added line that actually contains `quote`. A wrong
   citation is not grounds to discard a real quote, but a wrong line in a ticket
   sends the reader to the wrong place, so the corrected line and
   `lineCorrected: true` are what the report and receipt carry.
5. No earlier finding shares the same `file` and `kind` with a containing or
   equal quote — nearer duplicates collapse across lenses.

Then findings are sorted by confidence and capped at `--max-findings`. Every drop is
counted by reason in the receipt, so the ratio of produced to surviving findings is
visible per run and per lens.

## Receipt

`receipt.json` in the run directory:

- `prs[]` — repo, number, title, url, mergedAt, additions, deletions, `truncated`,
  `rules[]` (path, bytes, truncated)
- `calls[]` — repo, pr, lens, model, `ok`, `error`, `latencyMs`, `streamBytes`,
  `streamTrimmed`, `findings`, `usage`, `cost`
- `usage` — summed `inputTokens`, `outputTokens`, `cachedInputTokens`
- `gate` — `submitted`, `kept`, `dropped`, `byReason`
- `dropped[]` — reason, file, lens, quote prefix (first 200)
- `findings[]` — survivors as quoted above
- `linear` — `filed: 0` and the note that filing is a separate approved step
- `recheckedAt` — set by `recheck`, which re-gates stored raw results offline

## Operational notes

`gjc -p --mode json` is a snapshot stream, not a delta stream: every token update
re-sends the accumulated message, so one 18 KB prompt produced a 176 MB stream in
the first real run. Buffering that with `execFile` fails on `maxBuffer`, so
`lib/runner.mjs` reads the child's stdout incrementally and parses only the
`message_end` and `agent_end` lines it needs. Past `--soft-bytes` with the answer
already captured, the child is killed and the receipt records
`streamTrimmed: true` with no usage for that call, because the usage event had not
arrived yet.

Because the stream grows with the square of the answer length, the diff cap matters
more than the prompt budget: `--max-diff-bytes` defaults to 40000, and a PR above it
is reviewed on its first 40000 bytes with `truncated: true` in the receipt. A call
that still exceeds `--max-bytes` is retried once in `--mode text`, which prints the
answer only; that attempt keeps the findings and records `retriedForSize: true` with
no usage. A large diff therefore costs coverage, never a silent empty review.

A call whose assistant message is not a JSON object with a `findings` array is
recorded as failed with its stderr tail, never as "no findings". A run that fails
every call reports failed calls, not a clean sheet.

## What this does not do

- No Linear writes, no issue creation, no status changes.
- No repository mutation and no repair attempt: findings are evidence for a later
  decision, not an action.
- No timer, no launchd/cron installation, no background service.
- No claim that a review with these lenses finds every defect, or that a kept
  finding is correct. The gate proves the code was quoted from the merged diff; it
  does not prove the reviewer's reasoning about it.

## Tests

```sh
node --test nightly-review/tests/*.test.mjs
```

The suite covers diff indexing, every gate rejection reason, duplicate collapse, the
cap, the stream filter (including a line split across chunks and an oversized
partial line), and the refusal to read prose as an empty result.
