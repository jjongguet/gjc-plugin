# P2 — 13-attempt freeze receipt (policy provenance)

Status: **recovered receipt, committed byte-identically.** This is the dream
receipt behind the deployed policy `pi-1-25` (13-attempt corpus). It is the
primary provenance for `self-improve/policies/pi-1-25.json`; it is **not** a new
measurement and it does not change the P2/P2b verdicts.

## Frozen inputs

- Ledger blob: `git show 7f2f97f:self-improve/ledger.jsonl` (14 rows, 13 cycle
  attempts, 1 adoption, 2 epochs).
- Raw-file sha256: `72e25ab9092fac9a2f9ac3a9903a9e5aa2c3fffae3038ecd25a9c91a5b2da72e`.
- Canonical-rows sha256 (`corpus.ledgerSha256`):
  `6700fb56d668b33e358f7239af7c11a460f32306aeb5754a955c1ace1d263071`.

## Receipt

- File: `dream-receipt-20261012.json`, sha256
  `cff80dfbec86402194c509f695aa3d18431c50a023f13d347cff541b5f007b6e`, 61028 bytes.
- `receiptHash`: `e7f987e5dfc0764bf0cb20ddc8e4e0262313a8134f0e7940dd506ee75dc2761c`.
- Selected policy: `pi-1-25` (`failure_greedy`, batch 1, `first_adoption`).
- Verdict: `insufficient evidence at pass-gate size — thresholds not evaluated`
  (13 attempts < 20 pass gate).

## Reproduction

```sh
git show 7f2f97f:self-improve/ledger.jsonl > /tmp/ledger-p2.jsonl
node self-improve/scripts/run.mjs dream --seed 1 --ledger /tmp/ledger-p2.jsonl --json \
  > /tmp/dream-p2.json
shasum -a 256 /tmp/dream-p2.json   # must equal cff80dfb…
```

The regenerated receipt is byte-identical to this committed copy. The
provenance binding is enforced by
`self-improve/tests/unit/policy-provenance.test.mjs`.

## Limits (must travel with the receipt)

- Below the pass gate: advisory numbers are not an evaluated threshold result and
  carry no statistical significance (one realized corpus, n=13).
- The receipt was produced during the M3 freeze campaign and recovered from the
  maintainer's local artifact directory; its bytes are committed unchanged so
  the `receiptHash` lineage stays intact.
- The P2b (22-attempt) verdict remains `unmet`; this file does not alter it.
- Cost is the recorded load-dependent `wallMs` proxy, not a fresh measurement.
