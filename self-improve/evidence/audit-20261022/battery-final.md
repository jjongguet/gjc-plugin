# Post-fix battery

All commands ran in the lane worktree after the Phase-B fixes. Exit codes were
captured by the wrapper that produced each log; a missing log means the command
did not run (recorded as `n/a`, never omitted).

| command | exit | output sha256 | log |
| --- | --- | --- | --- |
| `bun run build:check` | 0 | `7c73f0bbb4a0b054b07a88baf73e6e488142849708c99b5e012f99fbab58fa39` | `final-build:check.log` |
| `bun run evidence:check` | 0 | `95fd57857e4cb58f3c7472980f51f0eb4660e282ea54dee28f86d256e0540529` | `final-evidence:check.log` |
| `bun run docs:check` | 0 | `204e677fe32d53bca2005159c4115ffb45169ef75b95eab506f768b76ca0f4ea` | `final-docs:check.log` |
| `bun run policy:check` | 0 | `c66a837f6b0f1b7c447d4875eef42ba347c617dff86a6b8c60df166eecb855d9` | `final-policy:check.log` |
| `bun run paths:check` | 0 | `f4e4edc8ebbfd3a9ea1c94392e171500cf0afc95dc06f4a13ae8ea7543b1f3d3` | `final-paths:check.log` |
| `bun run test` | 0 | `6b362804563dda3f5107d972adb6d60e6d54c99c8fc0425b65d69e89798dbe8b` | `final-test-all.log` |
| `bun test rrsi/tests/real-journal.test.ts` | 0 | `60233b9ddb8d36943e704aeb3615887de53ee7c56fcf3b260d6133cbbf577584` | `final-real-journal.log` |
| `node --test rrsi/tests/periodic.test.mjs` | 0 | `57c9da42a1444a9c2241410619c27550cc24b44d4d95d86ebadace7657ddb9ce` | `final-periodic.log` |
| `bun run demo` | 0 | `93dd57f3cc906137c9e4718dde5b39ef746a771e8998108b9e83d50804812a27` | `final-demo.log` |

Missing logs: 0.
