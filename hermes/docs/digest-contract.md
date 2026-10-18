# Digest contract (`hermes-evolution.digest.v1`)

Canonical contract for the weekly Hermes self-evolution digest. The writer is
`hermes/scripts/weekly_evolution.py`; the Hermes procedure is
`hermes/skills/self-evolution/SKILL.md`.

## Canonical paths

| Purpose | Mac | gw-kmg |
| --- | --- | --- |
| Wiki checkout (read-only) | `~/jjongguet/personal-wiki` | `/home/gjc/personal-wiki` |
| Default digest root | `~/.hermes-evolution/digests` | `/home/gjc/.hermes-evolution/digests` |
| Private repository mode | `<private-repo>/digests` | not used (no push from gw-kmg) |
| Lock | `<digest-root>/.lock` | `<digest-root>/.lock` |
| Ledger | `<digest-root>/ledger.jsonl` | `<digest-root>/ledger.jsonl` |
| Digest | `<digest-root>/YYYY-MM-DD-<host>.md` | same |

`--digest-root` and `--digest-repo` are mutually exclusive. `--digest-repo`
writes into `<repo>/digests/`; the repository must be a git checkout whose
`origin` URL does not contain `gjc-plugin`.

## Name contract

- Date: `YYYY-MM-DD` in `Asia/Seoul`, taken from `--now` (injectable) or the
  current time.
- Host: exactly `mac` or `gw-kmg`.
- File name: `<date>-<host>.md`, for example `2026-10-19-mac.md`.
- Host ownership: the Mac writer emits only `-mac` files; the gw-kmg Hermes
  writer emits only `-gw-kmg` files. Neither host rewrites the other's file.
- One digest per `(date, host)`. The pair is the exactly-once key.

## Frontmatter

```yaml
---
schema: "hermes-evolution.digest.v1"
date: "2026-10-19"
host: "mac"
generated_at: "2026-10-19T00:00:00+09:00"
status: "ok"
rrsi_status: "ran"
rrsi_receipt_sha256: "fb939a74df827d61c3799ef9bf310b93b9293459148f764c2bcc475d759457f6"
wiki_head: "de93e3e8499a97528f29608ee0d611ddb41422ad"
wiki_ref: "refs/remotes/origin/main"
citations:
  - path: "concepts/example.md"
    commit: "de93e3e8499a97528f29608ee0d611ddb41422ad"
---
```

| Field | Type | Rule |
| --- | --- | --- |
| `schema` | string | Always `hermes-evolution.digest.v1`. |
| `date` | string | KST date of the run. |
| `host` | string | `mac` or `gw-kmg`. |
| `generated_at` | ISO8601 string | KST timestamp with an explicit `+09:00` offset. |
| `status` | enum | `ok`, `partial`, `blocked`. |
| `rrsi_status` | enum | `ran`, `unchanged`, `no_input`, `error`, `blocked`, `skipped`. |
| `rrsi_receipt_sha256` | 64-hex string or `null` | SHA-256 of the exact receipt bytes used. `null` when no receipt exists. |
| `wiki_head` | 40-hex string or `null` | Commit used for citations. After a refresh, the writer prefers `refs/remotes/origin/main` (or `master`) and falls back to `HEAD`. |
| `wiki_ref` | ref name or `null` | Ref resolved for `wiki_head` (`refs/remotes/origin/main`, `refs/remotes/origin/master`, or `HEAD`). |
| `citations` | list | Up to 5 items: `path` (repo-relative canonical page path) + `commit` (40-hex). Empty list when no citation exists. |

`citations` is a citation index, not a summary. Page bodies are never read by
the writer. When there is no evidence the body says `근거 없음`, and the
frontmatter keeps `citations: []`.

## Wiki refresh

A non-dry run refreshes the wiki with `git fetch --prune` (remote-tracking refs
only) unless `--no-fetch` is given. It then reads `refs/remotes/origin/main`
(falling back to `master`, then `HEAD`) for `wiki_head` and citations. It never
runs `pull`, `checkout`, `reset` or any page/index/log write, so a fetched week
is summarized without touching the working tree. `--no-fetch` is for offline or
strictly non-mutating runs.

The digest `status` is `ok` only when at least one citation and a usable RRSI
receipt exist; `blocked` when both inputs are missing or `rrsi_status` is
`blocked`; `partial` otherwise.

## Body

The body has exactly these second-level sections in this order:

1. `## Summary` — status, RRSI status, wiki HEAD (or `unavailable`), and the
   statement that inputs are read-only.
2. `## RRSI` — status plus bounded counts, selected policy, verdict (truncated
   to 300 characters) and receipt hashes. Missing/blocked/error states are
   named; no metrics are invented.
3. `## Wiki evidence` — bullets of `` `path` @ `commit` `` or `- 근거 없음`.
4. `## Next actions` — bounded checklist derived from the observed statuses.

The whole file is UTF-8 with one trailing newline and is kept below **8 KiB**.
Required headings are never dropped by the size guard.

## Ledger

`digests/ledger.jsonl` is append-only, one compact JSON object per line:

```json
{"schema":"hermes-evolution.ledger.v1","date":"2026-10-19","host":"mac","path":"2026-10-19-mac.md","sha256":"<64-hex>","generated_at":"2026-10-19T00:00:00+09:00","status":"ok","rrsi_status":"ran","wiki_head":"<40-hex>","wiki_ref":"refs/remotes/origin/main"}
```

- `path` is the digest **file name only**, never an absolute path.
- `sha256` is the SHA-256 of the exact digest bytes.
- Each line is at most **2 KiB**; the writer refuses to append a longer line.
- The ledger is never rewritten, reordered or truncated.

## Exactly-once rules

The key is `(date, host)`.

| Observed state | Action | Exit |
| --- | --- | --- |
| Ledger has the key with the same `sha256` | `already-recorded`; no new ledger line, no file change (a missing digest file is restored from the same bytes) | 0 |
| Ledger has the key with the same `sha256` but the file bytes differ | `conflict`; never overwrite the tampered file | 2 |
| Ledger has the key with a different `sha256` | `conflict`; never overwrite the digest or ledger | 2 |
| Digest file exists with the same bytes but no ledger row (crash window) | append the missing ledger row (`recovered`) | 0 |
| Digest file exists with different bytes and no ledger row | `conflict`; never overwrite | 2 |
| No record | write digest atomically, then append+fsync the ledger row | 0 |

`--dry-run` performs the same reads and reports a pending conflict with exit 2,
but writes nothing and never commits or pushes.

## Locking and atomicity

- Writes take an exclusive `flock` on `<digest-root>/.lock`.
- The digest is written to a `<name>.tmp.<random>` temporary file in the same
  directory, fsynced, chmod `0600`, and moved into place with `os.replace`.
- The ledger append is `write` + `flush` + `os.fsync`.
- The digest root is created with mode `0700`; digest, ledger and lock files use
  `0600`.

`.lock` is intentionally untracked. The private digest repository should commit
a one-line `digests/.gitignore` containing `.lock` and `*.tmp.*` once during
setup; the writer never stages it.

## Allowed and forbidden content

Allowed:

- date, host, timestamps, status vocabulary, SHA-256/commit SHAs;
- up to five repo-relative canonical wiki page paths;
- bounded RRSI counts, selected-policy id, verdict text and receipt hashes;
- fixed reason codes such as `bun_missing`, `receipt_unreadable`.

Forbidden:

- page bodies, raw wiki text, raw conversation/session logs;
- message IDs, channel IDs, Discord jump links, DMs or `#secret` content;
- tokens, cookies, JWTs, API keys, credentials, absolute private paths;
- arbitrary fields copied from a receipt (`token`, `raw_transcript`, `messages`,
  `prompt`, ...); the writer extracts known keys only.

## Private repository rule

Committed digests live **only** in a private repository. They must never be
committed to `gjc-plugin` (public) or any other public repository. The gw-kmg
digest root is a local, non-pushed copy. The writer enforces the private-repo
rule when `--digest-repo` is used: a non-git target or an `origin` URL containing
`gjc-plugin` exits 2 before any directory is created. gw-kmg never pushes; the
Mac job owns the private repository.

The commit is scoped with `git commit --only -- <digest> <ledger>`: unrelated
staged or untracked work in the private checkout is left untouched and never
swept into the weekly commit.

## Retention

Digests and ledger rows are retained indefinitely by default. There is no
automatic deletion, compaction or rewriting. Any pruning is a manual owner
action performed outside the writer; the ledger row for a removed digest is
kept so the exactly-once history remains auditable.
