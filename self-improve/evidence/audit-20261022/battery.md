# Battery

Base: `e74140c`. Executed 2026-10-21T23:49:05.988Z. Every row is produced by
`tools/run-battery.mjs`, which records the real exit status and keeps the
captured output under [`battery-logs/`](battery-logs/). A non-zero exit fails
this renderer; a command that did not run has no row.

| command | exit | duration ms | log sha256 |
| --- | --- | --- | --- |
| `bun run build:check` | 0 | 93 | `7e227265439b1e64a14577af6b04912199a8222bff3c7a791e0a32d9d55c8e0d` |
| `bun run evidence:check` | 0 | 51 | `7470ff18b22e3e3282a8d3f88b954e02fbca5f4498cfa6adc97e06d9f30bbbd1` |
| `bun run docs:check` | 0 | 45 | `ac38554fd318d9e808c552c6645b3e1be00d8c40f053fa16f1013de37f161bcb` |
| `bun run policy:check` | 0 | 31 | `094afdbdbb12730b2bae118feb1ccfbd04fac1d8d37ef4615e12db0123a060df` |
| `bun run paths:check` | 0 | 71 | `2e21987b13bf0db5d93af2b9c1bd10ef0261c2e2fca5e0752c323e23c77f1437` |
| `node scripts/check-audit-claims.mjs --base e74140c --reenumerate` | 0 | 492 | `f88725c0f361712e4cbd3afae0ebffb37895f85dfaa90ef25bc4da8deccbbca3` |
| `bun run test` | 0 | 184884 | `7d2bedff60c9cc2a6d1354b258bd4244adaffba096c17014c84824452018d6ca` |
| `bun rrsi/scripts/verify.ts` | 0 | 7024 | `6704d5707ac392ac4700d21ce37e17347330673837a9dfb28b394184172d3748` |
| `bun test rrsi/tests/real-journal.test.ts` | 0 | 305 | `7606b2793f69d463d1b1d8d87e1588da1bc7a051f15513a73d4278fb42b4c6ab` |
| `node --test rrsi/tests/periodic.test.mjs` | 0 | 11579 | `2f0a390bf4b0f9677569ea3f508daaa7e8e7eaaa348b4ad3d695152e43cb32e7` |
| `bun run demo` | 0 | 890 | `3e0f87f691bb853dfca4963517d2e57ff734ec04ef9f041a9f8c88123c84c77c` |
| `node self-improve/evidence/audit-20261022/tools/verify-reproductions.mjs` | 0 | 556 | `cf41255e889739c36d068e4af966f81040efbccc83e23086b0fcd06f4b19840d` |

Commands: 12. Failed: 0. Logs: `battery-logs/` (committed).
