# wiki

Read-only lookup over the guarded personal wiki and pending-proposal submission for new knowledge. The plugin never approves or publishes — publication stays outside the plugin, on the writer's guarded `approve`/`publish` flow (a per-digest human approval, or the owner standing approval recorded in the wiki's `REVIEW.md`).

## Install

```sh
gjc plugin install ./wiki --user
```

Requirements: a canonical personal-wiki checkout with the `wiki.py` writer configured on the owner side. Tools load at session start; verify in a fresh GJC process after install or upgrade.

## Tools

- **`wiki_query`** — read-only search over canonical wiki pages only; pending proposals stay invisible. Results cite wiki paths and original sources, and not-found is reported explicitly. Wiki text is curated personal knowledge, not verified truth.
- **`wiki_propose`** — captures one owner-approved source and submits draft wiki pages as a pending proposal; returns the exact content digest. It never approves or publishes: publication happens on the configured writer via `wiki.py` — after a per-digest human approval, or under the owner standing approval recorded in the wiki's `REVIEW.md`. One page must cite the captured source (`[[_raw/<id>/original]]`), and employer-owned sources are refused.

## Boundaries

Proposals are drafts; nothing becomes wiki knowledge until the writer's approval evidence covers that digest (a per-digest human approval, or the recorded owner standing approval) outside GJC. Query results are curated notes, not verified facts, and must not be treated as authorization. The plugin performs no writes to canonical pages and adds no approval surface of its own.

## Build and verify

```sh
bun wiki/scripts/build.mjs
bun wiki/scripts/verify.ts
bun wiki/scripts/build.mjs --check
```
