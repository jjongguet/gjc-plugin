# Battery — command, exit code, output digest

Base: `e74140c7b014b60402b6f2c4ef748cfd1b7d3512`. Logs are read from `/tmp`; digests cover the captured stdout+stderr.

| command | exit | output sha256 | log |
| --- | --- | --- | --- |
| `bun run build:check` | 0 | `7c73f0bbb4a0b054b07a88baf73e6e488142849708c99b5e012f99fbab58fa39` | `battery-build:check.log` |
| `bun run evidence:check` | 0 | `95fd57857e4cb58f3c7472980f51f0eb4660e282ea54dee28f86d256e0540529` | `battery-evidence:check.log` |
| `bun run docs:check` | 0 | `a83f54799c635384bd202ee0477289b982b47f950ae11b7b43874af6dd565517` | `battery-docs:check.log` |
| `bun run policy:check` | 0 | `c66a837f6b0f1b7c447d4875eef42ba347c617dff86a6b8c60df166eecb855d9` | `battery-policy:check.log` |
| `bun run test:self-improve` | 0 | `78413b898b9e619ee0e94f22e8c1dc0d5632905cdbbb36d01f0cfad2389ad627` | `battery-test-self-improve.log` |
| `bun rrsi/scripts/verify.ts` | 0 | `b1161f2af89b13209d2001d6c7c27aa9cfd864c77514a7c35e51f75209da1dc5` | `battery-rrsi-verify.log` |
| `bun run demo` | 0 | `93dd57f3cc906137c9e4718dde5b39ef746a771e8998108b9e83d50804812a27` | `battery-demo.log` |
| `node self-improve/evidence/audit-20261022/tools/verify-reproductions.mjs` | 0 | `74e53549af4a6571aab33acf0beb2b51f75ce6cfbf6622c81db87471362183db` | `battery-reproductions.log` |

Exit codes were captured by the shell wrappers that produced each log; a non-zero exit is recorded as a failure, never omitted.
