# Frozen-artifact annex

Frozen files are **not edited** by this audit. Each entry records the frozen
file, its pre-audit sha256 (see `frame.md`), the misstated or ambiguous sentence
verbatim, the recomputed value with its receipt, and why the file stays as-is.

## F-01 — dual-floor guard count

- File: `self-improve/rrsi-protocol.json`, `dualFloor.perAdoption[0]`: `"all 6 guards pass"`.
- Recomposition: `self-improve/lib/guards.mjs:31-53` plans `build`, `test`, then
  `validator` **only when `resolveValidatorEntry` resolves**, then the four smokes
  (`smoke-verification`, `smoke-loop`, `smoke-advisor`, `smoke-metrics`) when
  `includeSmoke`. Hosted CI plan = 6; local workspace plan = 7.
- Receipt: `bun run test:self-improve` printed
  `# plan: build,test,validator,smoke-verification,smoke-loop,smoke-advisor,smoke-metrics`
  (7 guards, all `pass`).
- Why frozen: the protocol is a pre-registration; the sentence is a plan
  invariant, not a measured result. Editing it after the runs would be a post-hoc
  edit. The accurate statement is "all planned guards pass", with the plan size
  (6 or 7) determined by the environment.

## F-02 — validation-slice adoption count

- File: `self-improve/replay-protocol-p2b.json:70`, `passGateSituation`:
  `"... the validation slice (last 6 attempts) includes 3 adoption cycles ..."`.
- Receipt: `self-improve/evidence/p2b/dream-seed1.json:2032` records
  `"validationAdoptions": 1`; the same protocol records
  `"adoptionsAtFreeze": 2` (`:66`). Three adoption cycles in a 6-attempt
  validation slice is arithmetically impossible given two adoptions in the whole
  22-attempt corpus.
- Why frozen: pre-registration text. The P2b verdict (`unmet`, cost threshold)
  is unaffected; the annex is the correction of record.

## F-03 — deployed policy provenance

- File: `self-improve/policies/pi-1-25.json:13-17` cites
  `corpus 6700fb56…`, `receiptHash e7f987…`, `createdAt 2026-10-12T22:07:34Z`.
- Reproduction: `git show 7f2f97f:self-improve/ledger.jsonl` has 14 rows / 13
  cycle attempts; canonical-rows sha `6700fb56d668b33e…` and raw-file sha
  `72e25ab9…`; `dream --seed 1 --ledger <blob>` reproduces
  `receiptHash e7f987e5dfc0764b…` (see `battery.md` / `reproductions/`).
- Receipt: the recovered path-free receipt is committed byte-identically as
  `self-improve/evidence/p2/dream-receipt-20261012.json`, and
  `self-improve/tests/unit/policy-provenance.test.mjs` binds the policy artifact
  to it.
- Why frozen: re-pointing or editing the deployed policy artifact would break the
  receipt-hash lineage; the missing receipt is added as evidence instead.

## F-04 — hash roles

- `self-improve/lib/replay.mjs:86` hashes the **attempt array**
  (`corpusFromAttempts().ledgerSha256`).
- `self-improve/lib/replay.mjs:108` hashes the **canonical parsed rows**
  (`sha256Hex(rows.map(JSON.stringify).join("\n"))`) and overwrites the corpus
  field for ledger loads.
- Observed values: `72e25ab9…` = raw file sha256 of the 13-attempt ledger;
  `6700fb56…` = canonical rows of that ledger; `9fc5668d…` = canonical rows of
  the 22-attempt ledger. A naive `shasum -a 256 self-improve/ledger.jsonl` can
  never equal a protocol `corpus.sha256`.
- Why frozen: `replay-protocol*.json` are pre-registrations; the
  hash-semantics register is published here and in
  `self-improve/evidence/README.md` (the mutable index), not by editing them.

## F-15 — two cycle counts in one object

- File: `self-improve/evidence/p3/summary.json`: `finalLoopState.counters.cycles = 5`
  (final campaign) and `finalLoopState.cycles = 7` (loop-state total), with
  `finalLoopState.caps.maxCycles = 5`.
- Recomposition: `5 <= 5` (cap respected); `7` counts campaigns
  `p3-20261019-2`/`-3`/`-4` attempts recorded in the loop state, not the final
  campaign's cycles. Without labels the pair reads as a cap breach.
- Why frozen: the file is a removed-log index bound by sha256 in
  `p3/README.md`; the annex supplies the labels.

## F-17 — sub-gate split overlap

- `self-improve/lib/dream.mjs:78-82` splits `train = attempts.slice(0, trainN)`
  and `validation = attempts.slice(total - validationN)`.
- For the 13-attempt corpus (`trainN` capped at 13, `validationN = 6`):
  train = 1–13, validation = 8–13 → overlap 8–13. The "advisory" validation
  numbers are therefore in-sample for those six attempts.
- The frozen verdict already refuses to evaluate thresholds below the pass gate;
  the annex records the overlap so the advisory numbers are never read as
  out-of-sample evidence.

## F-09 constraint (not frozen, recorded here)

`docs/agent-rules.md` is mutable but scored by the `rules-text` domain. The
exception sentence added by T-B6 must not restate the exactly-once markers
(`bun run build`, `bun run test`, the staging sentence) and must keep
`bun run test:self-improve` green.
