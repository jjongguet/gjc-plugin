# RRSI + Harness² introduction audit (2026-10-22)

Answers one question: **was the recent RRSI + Harness² work introduced
correctly?** — not whether the technique works.

- Base: `e74140c` (== `origin/main`), branch `feat/mbp-rrsi-harness2-audit-01a15f70`.
- Verdict: **`GAPS_OPEN (14)`** at audit time; 732 PASS / 14 GAP / 63
  UNVERIFIABLE over 809 claim rows. See [`verdicts.md`](verdicts.md).
- Approved plan: `.gjc/_session-01a15f70-…/plans/ralplan/…/pending-approval.md`
  (ralplan consensus: Architect `CLEAR`, Critic `OKAY`).

## Method (six layers)

| Layer | Question | Output |
| --- | --- | --- |
| L0 inventory | what exists, at which identity? | [`inventory.md`](inventory.md) |
| L1 claim graph | which sentences assert something falsifiable? | [`candidates.jsonl`](candidates.jsonl), [`dispositions.jsonl`](dispositions.jsonl), [`claims.csv`](claims.csv) |
| L2 receipts | does the cited receipt change if the claim is false? | [`battery.md`](battery.md), [`battery-final.md`](battery-final.md), [`reproductions/`](reproductions/) | |
| L3 boundaries | does every number travel with its limit? | [`verdicts.md`](verdicts.md) |
| L4 drift | do code, docs, generated surfaces and runtime agree? | [`annex.md`](annex.md), [`verdicts.md`](verdicts.md) |
| L5 verdicts | PASS / GAP / UNVERIFIABLE + remediation | [`verdicts.md`](verdicts.md), [`closures.md`](closures.md) |

Claim classes: `IMP` implementation, `MEAS` number, `BND` boundary/caveat,
`RDM` roadmap, `REF` path/sha/link. A PASS needs a `binding_command`,
`observed` value and `evidence_sha256`; the binding test is "if the claim were
false, which byte of which receipt would differ?".

## Reproduce

```sh
# frame + battery digests
node self-improve/evidence/audit-20261022/tools/frame.mjs /tmp

# frozen-corpus reproductions (P2b 22-attempt and P2 13-attempt)
git show e6675cb:self-improve/ledger.jsonl > /tmp/rrsi-audit/ledger-p2b.jsonl
git show 7f2f97f:self-improve/ledger.jsonl > /tmp/rrsi-audit/ledger-p2.jsonl
node self-improve/scripts/run.mjs dream  --seed 1 --ledger /tmp/rrsi-audit/ledger-p2b.jsonl --json > /tmp/rrsi-audit/dream-p2b.json
node self-improve/scripts/run.mjs replay --ledger /tmp/rrsi-audit/ledger-p2b.jsonl --json > /tmp/rrsi-audit/replay-p2b.json
node self-improve/scripts/run.mjs dream  --seed 1 --ledger /tmp/rrsi-audit/ledger-p2.jsonl --json > /tmp/rrsi-audit/dream-p2.json
node self-improve/evidence/audit-20261022/tools/verify-reproductions.mjs /tmp/rrsi-audit

# claim graph
node self-improve/evidence/audit-20261022/tools/audit-candidates.mjs
node self-improve/evidence/audit-20261022/tools/triage.mjs
node scripts/check-audit-claims.mjs --base e74140c
```

Accepted values: P2b corpus `9fc5668d…` + receiptHash `d6635a0…`; P2 corpus
`6700fb56…` + receiptHash `e7f987…`; 13-attempt ledger raw-file sha `72e25ab9…`.

## Reproductions (digests, not duplicated receipts)

[`reproductions/verify.txt`](reproductions/verify.txt) is the verifier output;
[`reproductions/digests.json`](reproductions/digests.json) pins the bytes and
sha256 of each regenerated artifact. The full dream receipts stay out of the
repository because they are regenerated deterministically and duplicate the
frozen evidence.

## Honest limits

- Claim triage is mechanical generation plus human disposition; a sentence the
  generator missed cannot be counted, which is why candidate re-enumeration and
  the two negative controls are part of the checker.
- 63 rows stay UNVERIFIABLE (historical release notes, private-store snapshots,
  overview figures). They are listed with the missing receipt, never rounded to
  PASS.
- No efficacy, live-provider, installed-byte or Linear-workflow verdict is made.
- Frozen artifacts are never edited; their defects are recorded in
  [`annex.md`](annex.md) with recomputed values.
