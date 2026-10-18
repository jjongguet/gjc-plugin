# P2b — 22-attempt replay measurement (JJO-213)

Status: **measured, verdict `unmet`** (attempts threshold met; cost threshold not met).
This is a separate post-v0.0.6 pre-registration, not a retroactive edit of the
original 13-attempt P2 verdict.

## Frozen inputs

- Protocol: `self-improve/replay-protocol-p2b.json`, commit `e6675cb`,
  sha256 `1fe71eb0274f7738b17af79bd10c214f737e01e04f1be68a9ec8d6fa1906ba06`.
- Corpus: `self-improve/ledger.jsonl` at freeze, sha256
  `9fc5668d4542fd1e6e410edd6bcee53d968e13d7e3c9294fb88aa82daf211638`
  (22 attempts, 2 adoption rows, 2 epochs).
- Split: train = attempts 1–14, validation = attempts 17–22 (6 attempts,
  1 adoption row); attempts 15–16 are excluded from the two slices and used
  only in the full-corpus anti-fluke score. Thresholds are unchanged from the
  original `replay-protocol.json`.

## Commands

```sh
node self-improve/scripts/run.mjs dream --seed 1 --json > self-improve/evidence/p2b/dream-seed1.json
node self-improve/scripts/run.mjs replay --json > self-improve/evidence/p2b/replay-b0b1.json
```

## Result

- Gate: `ok` — 22 attempts >= 20; validation 6 with 1 adoption.
- Selected policy: `pi-1-25` (`failure_greedy`, batch 1, `first_adoption`).
- Thresholds evaluated: **yes**.
  - attempts: π* **5** <= min(B0, B1) − 1 = **5** → **met**
  - cost: π* **876,237 ms** <= 0.7 × B0 **726,720 ms** → **not met**
  - anti-fluke: full-corpus π* cost **met**
- Verdict: **`unmet`**.
- Calibration: π* predicted 6 attempts / 407,924 ms vs realized 5 / 876,237 ms;
  B0/B1 predicted 12 / 873,652 ms vs realized 6 / 1,038,172 ms.
- Determinism: `dream-seed1.json` receiptHash
  `d6635a0bac2575a48cfbea0bb777f4b7b6986836662fb42ccea163bdc61df489`.

## Limits (must travel with the result)

- The 22-attempt corpus was assembled after the original 13-attempt P2 run; this
  is a new pre-registration, not evidence that the original P2 threshold was met.
- The validation slice contains one adoption row; attempts-to-first-adoption is
  measured on a small, realized corpus. No statistical significance is claimed.
- The cost proxy is load-dependent recorded `wallMs`, not a fresh measurement.
- The verdict is `unmet` because the cost threshold failed; the attempts
  threshold alone is not a pass.
