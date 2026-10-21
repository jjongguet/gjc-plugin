# Self-improve evidence

Committed receipts for the measured self-improve campaigns. Each subdirectory
has its own README with the frozen inputs, commands, result and limits.

- [`p2b/`](p2b/README.md) — the 22-attempt replay measurement (verdict `unmet`).
- [`p3/`](p3/README.md) — the redeployed-policy campaign (five rejects, no adoption).
- [`audit-20261022/`](audit-20261022/README.md) — the RRSI + Harness² introduction audit:
  claim graph, frozen-corpus reproductions, frozen-artifact annex and verdicts.

## Path disclosure

Evidence must be written with repository-relative paths. Two historical files
still contain the author's original absolute checkout path and are kept
byte-identical on purpose:

| File | Why it is kept as-is |
| --- | --- |
| `self-improve/ledger.jsonl` (seq 15, a `policy` row) | The ledger is append-only and hash-chained (`prev`); the P2b corpus hash `9fc5668d…` in `replay-protocol-p2b.json` covers it. Editing the row would break the chain and the frozen corpus. |
| `self-improve/evidence/p2b/replay-b0b1.json` (`corpus.ledgerPath`) | Literal output of the frozen replay command. Rewriting it would make the receipt differ from what the command produced. |

Neither file contains credentials. The raw P3 loop logs and loop state, which
recorded absolute scratch paths, were removed; [`p3/summary.json`](p3/summary.json)
binds each removed file by path, bytes and SHA-256 (recoverable at commit
`02c3177`).

`bun run evidence:check` fails if any other tracked file under `self-improve/`
contains an absolute path into a home directory (the macOS `Users`, Linux `home`
or Windows `Users` roots). CI runs it on every push to `main`.
