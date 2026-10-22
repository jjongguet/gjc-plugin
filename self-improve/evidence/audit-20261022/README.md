# RRSI + Harness² introduction audit (2026-10-22)

Answers one question: **was the recent RRSI + Harness² work introduced
correctly?** — not whether the technique works.

- Base: `e74140c` (== `origin/main` at audit time), branch `feat/mbp-rrsi-harness2-audit-01a15f70`.
- Verdict: **`GAPS_OPEN (14)`** at audit time; 732 PASS (175 bound / 557
  self) / 14 GAP / 63 UNVERIFIABLE over 809 claim rows. See [`verdicts.md`](verdicts.md).
- Approved plan: ralplan run `01a15f70-095c-724d-b819-168c0e264701`
  (`pending-approval.md` is session-local and not committed; the plan text is
  preserved in the session transcript and the run state).

## Method (six layers)

| Layer | Question | Output |
| --- | --- | --- |
| L0 inventory | what exists, at which identity? | [`inventory.md`](inventory.md) |
| L1 claim graph | which sentences assert something falsifiable? | [`candidates.jsonl`](candidates.jsonl), [`dispositions.jsonl`](dispositions.jsonl), [`claims.csv`](claims.csv) |
| L2 receipts | does the cited receipt change if the claim is false? | [`battery.md`](battery.md), [`reproductions/`](reproductions/) |
| L3 boundaries | does every number travel with its limit? | [`verdicts.md`](verdicts.md), [`sweeps.md`](sweeps.md) |
| L4 drift | do code, docs, generated surfaces and runtime agree? | [`annex.md`](annex.md), [`sweeps.md`](sweeps.md), [`verdicts.md`](verdicts.md) |
| L5 verdicts | PASS / GAP / UNVERIFIABLE + remediation | [`verdicts.md`](verdicts.md), [`closures.md`](closures.md) |

Claim classes: `IMP` implementation, `MEAS` number, `BND` boundary/caveat,
`RDM` roadmap, `REF` path/sha/link. A PASS needs a `binding_command`,
`observed` value, `evidence_sha256` and a `binding_strength` (`bound` = an
independent command or receipt; `self` = the quoted text is present at the
pinned scope). The headline splits them so 732 cannot be read as 732
independently verified claims.

## Reproduce

```sh
# frame + battery (battery.md is rendered from real exit codes)
node self-improve/evidence/audit-20261022/tools/frame.mjs
node self-improve/evidence/audit-20261022/tools/run-battery.mjs
node self-improve/evidence/audit-20261022/tools/render-battery.mjs

# frozen-corpus reproductions (P2b 22-attempt and P2 13-attempt), self-contained
node self-improve/evidence/audit-20261022/tools/verify-reproductions.mjs

# claim graph (regenerated from base e74140c, not from HEAD)
node self-improve/evidence/audit-20261022/tools/audit-candidates.mjs
node self-improve/evidence/audit-20261022/tools/triage.mjs
node scripts/check-audit-claims.mjs --base e74140c

# execution half: run every distinct bound command (~3.5 min, mostly the test suites)
node self-improve/evidence/audit-20261022/tools/bound-sweep.mjs --out self-improve/evidence/audit-20261022/reproductions/bound-sweep.txt

# independent extraction from the pre-fix tree (e74140c export)
rm -rf /tmp/audit-carriers && mkdir -p /tmp/audit-carriers
git archive e74140c | tar -x -C /tmp/audit-carriers
node scripts/check-audit-claims.mjs --base e74140c --reenumerate --carriers-dir /tmp/audit-carriers
```

Accepted values: P2b corpus `9fc5668d…` + receiptHash `d6635a0…`; P2 corpus
`6700fb56…` + receiptHash `e7f987…`; 13-attempt ledger raw-file sha `72e25ab9…`.

## Reproductions (digests, not duplicated receipts)

[`reproductions/verify.txt`](reproductions/verify.txt) is the verifier output;
[`reproductions/digests.json`](reproductions/digests.json) pins the bytes and
sha256 of each regenerated artifact. The regenerated dream/replay JSON stays out
of the repository because it is deterministic and duplicates the frozen
evidence; the recovered 13-attempt receipt is the exception and is committed at
[`../p2/dream-receipt-20261012.json`](../p2/dream-receipt-20261012.json).

## Landing

- The audit delta landed directly on `main` as `b05f034` (base `e74140c`); CI
  run [39693968843](https://github.com/jjongguet/gjc-plugin/actions/runs/39693968843)
  passed for that sha. No frozen path changed: `0` hits from
  `git diff --name-only e74140c..HEAD` against the frozen prefixes.
- Battery ([`battery-results.json`](battery-results.json), `executedAt`
  `2026-10-21T23:49:05.988Z`): 12/12 commands exit 0 and every recorded `logSha256`
  recomputes from `battery-logs/`; [`battery.md`](battery.md) is rendered from it.
- Bound sweep: **175/175 rows, 0 failing commands**
  ([`reproductions/bound-sweep.txt`](reproductions/bound-sweep.txt)).
- Pinned digests reproduce byte-exactly from the `e6675cb` and `7f2f97f` blobs,
  including the recovered 13-attempt receipt (`cff80dfb…`, committed as
  [`../p2/dream-receipt-20261012.json`](../p2/dream-receipt-20261012.json)).
- Verification receipts: `verification_run` over the self-contained unit suites
  (`policy-provenance`, `replay`, `protocol`, `ledger`) — 20/20, exit 0,
  receipt `b9319343-15b2-4314-a1c3-a2b14c8193b2`, freshness `fresh`;
  `verification_loop` → `clean`, 0 open gates. Subprocess-spawning suites cannot
  run under that tool's environment (it passes only `LANG`/`TZ`, no `PATH`), so
  they are covered by the battery instead of by a receipt.

## Honest limits

- Claim triage is mechanical generation plus human disposition; the generator
  only emits sentences with a number, a modal claim verb, a path/sha/link, or a
  boundary phrase, so 809 is a **filtered subset**, not a sentence count. A
  sentence outside those hints cannot be counted; candidate re-enumeration and
  the negative control bound the risk but do not remove it.
- `bound` PASS rows point at a command or receipt that could fail; `self` rows
  assert only that the quoted text is present at the pinned scope. The split is
  printed with the headline and is the honest denominator. `observed` for MEAS
  rows is the captured `check-number` output; for REF/IMP rows it is a recorded
  summary. The checker does not execute those commands; `tools/bound-sweep.mjs`
  does, running each distinct bound command once and recording how many rows it
  covers ([`reproductions/bound-sweep.txt`](reproductions/bound-sweep.txt):
  **175/175 rows over 28 distinct commands, 0 failures**). A PASS row's
  `evidence_sha256` is the carrier blob digest and `evidence_kind: a` is
  required — it proves the quoted text, not the prose.
- `dispositions.jsonl` maps every candidate to a claim automatically; the 14
  findings are the hand-written part. 63 UNVERIFIABLE rows are one of four
  carrier-level reasons (historical release notes, private-store snapshots,
  overview figures, process statements), not per-row research.
- The scope-unavailable fallback (`--allow-worktree-fallback`) exists for an
  exported tree whose carriers still match the audit scope; on a post-fix
  export it fails closed at the first changed quote. The full positive run
  requires the audit-scope commit and is the only mode that re-enumerates.
- 63 rows stay UNVERIFIABLE (historical release notes, private-store snapshots,
  overview figures). They are listed with the missing receipt, never rounded to
  PASS.
- The first bound sweep failed the 86 rows bound to `bun run test:self-improve`:
  its nested full-suite guard hit a 5000 ms per-test timeout in
  `verification-receipts/tests/loop.test.ts` (observed 5015.91 ms, `test` guard
  red). The test was unchanged since the audit base and sits at the default
  limit; it now carries the file's existing explicit `30000` ms timeout, and
  both `bun run test:verification` (82 pass) and the sweep are green. The fix is
  a test-harness timeout, not a product behavior change.
- No efficacy, live-provider, installed-byte or Linear-workflow verdict is made.
- Frozen artifacts are never edited; their defects are recorded in
  [`annex.md`](annex.md) with recomputed values.
