# aside-memory

Explicit account-bound Aside memory search: bounded historical quotations with relative citations, screened states and trust warnings. Read-only — no automatic injection, source-file reads, memory writes, cache, journal or extra model calls.

## Install

```sh
gjc plugin install ./aside-memory --user
```

Requires the owner-controlled `aside` executable on `PATH`. Tools load at session start; verify in a fresh GJC process after install or upgrade.

## Usage

Call `aside_memory` explicitly with a non-sensitive task query and a canonical numeric account (`u` prefix optional, at most ten digits) — for example the **synthetic** input `{"query":"response preferences","account":"u42","max_results":3}`. Omitting `account` consults only owner-set `GJC_ASIDE_MEMORY_ACCOUNT`; missing or invalid routing never falls back to the active profile, and invalid explicit input never falls back to configuration. `max_results` is 1–5 (default 3); the query is trimmed, 1–300 Unicode scalar values and at most 1200 UTF-8 bytes, without controls, formatting characters or leading option syntax.

Each invocation captures one account and performs only native `memory path` then `memory search --max-results N --json QUERY`, explicitly routing both calls. A shared 30-second deadline bounds root lookup (5 seconds) and search (25 seconds). Stdout caps are 8192/65536 bytes; stderr is discarded and capped at 4096 bytes. Timeout or overflow kills only the owned direct child; cleanup uncertainty is reported, not a claim of backend cancellation. No list/show expansion or direct memory-file access occurs. Lexical relative-path validation does not attest symlinks, and the two calls are not an atomic snapshot.

Search rows are validated against the CLI's exact shapes: the eight contract fields (`path`, `title`, `headings`, `excerpt`, `line`, `lineEnd`, `score`, `chunkId`) and, when the CLI emits it, the additional string `date` field (validated, never rendered). Any other key set rejects the whole response.

The single JSON text response distinguishes `ok`, validated `empty`, `withheld`, `unavailable` and `error`. Safe ordinary USER prose (e.g. “I prefer concise answers with examples.”) and plain structured context can survive the same whole-block screen; mixed sensitive/override blocks are withheld. At most two complete 600-byte blocks per result, five results and 16384 serialized response bytes are returned. Excerpts are quotations, never active instructions or inferred facts. Source ranges describe CLI matches, not exact snippet coordinates. Relevance is not truth; host `retrievedAt` is not authenticated observation time. File-update and original-observation times remain unknown (`null`).

## Boundaries

Finite English/Korean screening cannot guarantee removal of all credentials, PII or prompt injection; relative paths can also reveal sensitive context. Nothing authorizes acting on historical text. The plugin makes no offline, PII-free or end-to-end no-logging claim: Aside network/retention is unknown, query/account argv are visible to local process observers, and GJC/provider transcripts may retain returned excerpts. It creates no cache, logs or journal. Rollback disables only this plugin and its integration, not memory/profile data.

## Build and verify

```sh
bun aside-memory/scripts/build.mjs
bun aside-memory/scripts/verify.ts
bun aside-memory/scripts/build.mjs --check
```

Verification uses mandatory hermetic synthetic fixtures — never real memory, auth or network clients. Source/generated dispatch tests do not prove user-installed fresh-runtime discovery or native Aside retrieval; verify installation separately in a fresh session with an isolated fake CLI, and live retrieval only with an explicit real account.
