# Battery

Base: `e74140c`. Executed 2026-10-21T23:30:27.169Z. Every row is produced by
`tools/run-battery.mjs`, which records the real exit status and keeps the
captured output under [`battery-logs/`](battery-logs/). A non-zero exit fails
this renderer; a command that did not run has no row.

| command | exit | duration ms | log sha256 |
| --- | --- | --- | --- |
| `bun run build:check` | 0 | 86 | `7e227265439b1e64a14577af6b04912199a8222bff3c7a791e0a32d9d55c8e0d` |
| `bun run evidence:check` | 0 | 53 | `a0b95648b4b75f9a56713aca6917bca0c68742f496ad546c51d6369ba855289c` |
| `bun run docs:check` | 0 | 43 | `7bffcad098420124b9458b469557a47122a7badd1e9864ab90ae8f9699b5af9e` |
| `bun run policy:check` | 0 | 29 | `094afdbdbb12730b2bae118feb1ccfbd04fac1d8d37ef4615e12db0123a060df` |
| `bun run paths:check` | 0 | 73 | `7c7c1af428f8359bb685c3079ea195458bc13e7564d69eb6291112eb963654f4` |
| `node scripts/check-audit-claims.mjs --base e74140c --reenumerate` | 0 | 408 | `f88725c0f361712e4cbd3afae0ebffb37895f85dfaa90ef25bc4da8deccbbca3` |
| `bun run test` | 0 | 142327 | `7e31674ad7169beefe1287651f87d4ae4109124fbb48b82f78fd03a013b9b676` |
| `bun rrsi/scripts/verify.ts` | 0 | 4260 | `6704d5707ac392ac4700d21ce37e17347330673837a9dfb28b394184172d3748` |
| `bun test rrsi/tests/real-journal.test.ts` | 0 | 190 | `3f2dfbcc02da1b92eaa9b5a547a67136de5e3775dec4ee8f5c7b2e6745df86cb` |
| `node --test rrsi/tests/periodic.test.mjs` | 0 | 4328 | `b2b91b74b06b0da96f851455c5401992376c80a6cb9a9587ad7fcabe1613af8b` |
| `bun run demo` | 0 | 218 | `3e0f87f691bb853dfca4963517d2e57ff734ec04ef9f041a9f8c88123c84c77c` |
| `node self-improve/evidence/audit-20261022/tools/verify-reproductions.mjs` | 0 | 172 | `cf41255e889739c36d068e4af966f81040efbccc83e23086b0fcd06f4b19840d` |

Commands: 12. Failed: 0. Logs: `battery-logs/` (committed).
