# Battery

Base: `e74140c`. Executed 2026-10-21T20:53:52.407Z. Every row is produced by
`tools/run-battery.mjs`, which records the real exit status and keeps the
captured output under [`battery-logs/`](battery-logs/). A non-zero exit fails
this renderer; a command that did not run has no row.

| command | exit | duration ms | log sha256 |
| --- | --- | --- | --- |
| `bun run build:check` | 0 | 154 | `f90659051297ce9ec528cef523600972418da584ec121803187f3dfb4be85deb` |
| `bun run evidence:check` | 0 | 73 | `9513ee9729c4ffb3b8ad229a3cc0cb3bb9f6a821b9cd13992201f3dbc9da354d` |
| `bun run docs:check` | 0 | 53 | `e12cba5828f91e7fd4076ec82716f4fc80e88f1b0a6c9a9f012066bb9043a8bc` |
| `bun run policy:check` | 0 | 33 | `7d9d6fdca0aa856d6f4fd25670980d243981c99519d9e7b0fb56213900734421` |
| `bun run paths:check` | 0 | 80 | `1c388bd1cbb80c4c15972507a502f1c4f75eae120c6d788e9bd198e74278465a` |
| `node scripts/check-audit-claims.mjs --base e74140c --reenumerate` | 0 | 536 | `8b9a3bc974edc5c9bda58b51de68d42c7dc30e86e3385ac4a050ddf9f711baa3` |
| `bun run test` | 0 | 157287 | `fda9a145524e7673041bae5c192ec8c207ae111adb0dedeae6e55a275737b81a` |
| `bun rrsi/scripts/verify.ts` | 0 | 4593 | `70bca2f29c68b5d8d2a4faa5c6449263bf5a8c6934891824f82d6a764a272035` |
| `bun test rrsi/tests/real-journal.test.ts` | 0 | 205 | `888f77d54bc2eb734f143578f52a2dfa82ceec6455399980abd8ca4113fb791e` |
| `node --test rrsi/tests/periodic.test.mjs` | 0 | 4785 | `dbc280626c1ca8238cbe64c2a4252474a7890b0fc92589ca9f72d4d46e319089` |
| `bun run demo` | 0 | 249 | `d358b113074d0357acad98fa5b01ccfde469f1abe654bf0355ea8fba38132dcb` |
| `node self-improve/evidence/audit-20261022/tools/verify-reproductions.mjs` | 0 | 185 | `f17a08a7ac73fc05e9fa351a9c3f112c4445667343e8d4fabeb56058db7443de` |

Commands: 12. Failed: 0. Logs: `battery-logs/` (committed).
