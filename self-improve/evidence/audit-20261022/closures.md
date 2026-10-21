# Fix closures

Each row records the audited observation, the fix, and the post-fix evidence.
The command column is what was actually run in this audit; the full battery is
in [`battery.md`](battery.md) (exit codes recorded by `tools/run-battery.mjs`).

## Fix commits

| Commit | Scope |
| --- | --- |
| `91fd30e` | `fix(rrsi)`: source imports + projection coverage + verify cases + regenerated surfaces |
| `7d2479c` | `docs(rrsi,self-improve)`: audited documentation drift |
| `48547ea` | `test`: `paths:check` + `check-audit-claims` + fixtures + CI step |
| `251dfef` | `docs(self-improve)`: recovered 13-attempt P2 receipt + provenance test |

| Finding | Pre-fix observation | Fix | Post-fix evidence |
| --- | --- | --- | --- |
| F-01 (frozen) | protocol says "all 6 guards pass" | none — annex records 6 hosted / 7 local (validator conditional) | `bun run test:self-improve` printed `plan: build,test,validator,smoke-verification,smoke-loop,smoke-advisor,smoke-metrics` |
| F-02 (frozen) | protocol says the validation slice "includes 3 adoption cycles" | none — annex records `validationAdoptions=1`, `adoptionsAtFreeze=2` | reproduction: `dream-seed1.json` + `replay-protocol-p2b.json` |
| F-03 | policy provenance `6700fb56…`/`e7f987…` absent from evidence | recover the path-free receipt and commit it byte-identically; bind it with a unit test | `node --test self-improve/tests/unit/policy-provenance.test.mjs` (5 pass); reproduction equals the committed bytes (`cff80dfb…`) |
| F-04 (frozen) | hash roles ambiguous | annex hash-semantics register + evidence README sentence | reproductions: raw `72e25ab9…`, canonical `6700fb56…`/`9fc5668d…` |
| F-05 | README said 40-char identifiers | corrected to 64-char identifiers, 40-char labels | `bun test rrsi/tests/readme-contract.test.ts` (asserts `RRSI_LIMITS.maxIdChars` and the README caps) |
| F-06 | `adoptions` semantics unstated | status row now defines attempt-level `decision == "adopt"` incl. advice records | same contract test |
| F-07 | coverage label scoped only to periodic | sentence now names `import` as returning journal coverage; additive field added in T-B10 | contract test + `bun rrsi/scripts/verify.ts` coverage case |
| F-08 | dead `.gjc/distill-demo/inputs/` path | replaced with a non-reproducible snapshot statement | `bun run docs:check` exit 0 |
| F-09 | dated-receipt exception unstated | one sentence in `docs/agent-rules.md` §Records | `bun run test:self-improve` (rules-text domain green) |
| F-10 | snapshot without command | measured-at + `distill --json` command recorded | `bun run docs:check` exit 0 |
| F-14 | interval clamp undocumented | below-floor fallback + 30-day clamp documented | `bun test rrsi/tests/readme-contract.test.ts` asserts `resolveIntervalMs` against the README sentence |
| F-15 (frozen) | two cycle counts unlabelled | annex labels `counters.cycles` vs `finalLoopState.cycles` | `p3/summary.json` recomputation |
| F-17 (frozen) | sub-gate split overlap undisclosed | annex records train 1–13 / validation 8–13 at n=13 | `dream.mjs` slice recomputation |
| F-18 | "advisory" pair was train/full | additive labels, advisory validation pair appended, no number replacement | `bun test rrsi/tests/readme-contract.test.ts` (C7 train/full + advisory pair strings) |
| F-12 (code) | `journal-dream` imported the generated bundle; `lib/rrsi.ts` lacked its source imports | three source imports added; script imports `../lib/rrsi.ts` | `bun rrsi/scripts/build.mjs --check` byte-identical; `journal-dream` deterministic over a frozen journal snapshot (two identical sha256); live reruns differ only because the journal grows; verify 32/32 |
| F-11 (checker) | `evidence:check` scanned only `self-improve/` | separate repo-wide `paths:check` + CI step + pass/fail fixtures | `bun run paths:check` exit 0; `node --test scripts/tests/checks.test.mjs` 10/10 |
| T-B9 | no claim-graph enforcement | `scripts/check-audit-claims.mjs` with pinned-scope quotes, PASS binding fields, candidate negative control | `node scripts/check-audit-claims.mjs --base e74140c` → `GAPS_OPEN (14)`; negative control exits 1 |
| T-B10 | `import` had no projection coverage | `projectionCoverage` promoted to the shared core and returned by `import` | `bun rrsi/scripts/verify.ts` case "import reports bounded projection coverage when the limit omits records" |

## Post-receipt sweep

| Observation | Evidence | Disposition |
| --- | --- | --- |
| Executing all 175 bound PASS rows (28 distinct commands) found one unreliable binding: `bun run test:self-improve` failed on the 86 IMP rows it binds | `tools/bound-sweep.mjs` → `reproductions/bound-sweep.txt`; failing command exited 1, its `test` guard red | Fixed at the source: `verification-receipts/tests/loop.test.ts` gave the offending test the file's existing `30000` ms timeout; `bun run test:verification` 82 pass, sweep 175/175 |
| The entire battery and sweep are re-runnable without network or model calls | `battery.md` (12/12 exit 0, `logSha256` verified) and `reproductions/bound-sweep.txt` | recorded, no action |

## Residual UNVERIFIABLE

The 63 UNVERIFIABLE claim rows stay unresolved by design (historical release
notes, private-store snapshots, overview figures). They are listed in
`verdicts.md` with their missing receipt; none is rounded to PASS.
