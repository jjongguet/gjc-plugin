# P3 — redeployed policy campaign (JJO-213)

Status: **completed — five live completed cycles, zero guard failures, zero adoptions**.

This campaign measures the redeployed policy selected by the frozen P2b dream. It
does not replace the P2b replay verdict (`unmet`) and does not claim an adoption or
a statistical result.

## Frozen inputs

- Policy: `pi-1-25` (`failure_greedy`, batch 1, first-adoption stop), selected in
  `self-improve/evidence/p2b/README.md`.
- Calibration: the frozen P2b replay's predicted-vs-realized receipts remain the
  calibration; this campaign reuses `pi-1-25` and does not re-fit or re-score
  them.
- Proposer: `openrouter/~google/gemini-pro-latest` via
  `self-improve/scripts/propose-with-gjc.mjs`; live calls require `--live-approved`
  and an approved OpenRouter budget.
- Loop: `p3-20261019-4`; `--max-cycles 5 --max-proposer-calls 8
  --max-wall-ms 1800000 --batch-size 1 --proposer-timeout-ms 300000`.
- Receipts: `loop-state-p3-20261019-4.json`, `loop-p3-20261019-4.log.jsonl`.
  The earlier live attempts are preserved as `loop-p3-20261019-2.log.jsonl` and
  `loop-p3-20261019-3.log.jsonl`.

## Commands

```sh
node self-improve/scripts/run.mjs loop --repo . --proposer cmd \
  --proposer-cmd 'GJC_PROPOSER_MODEL="openrouter/~google/gemini-pro-latest" GJC_PROPOSER_TIMEOUT_MS=300000 node self-improve/scripts/propose-with-gjc.mjs {request} {response}' \
  --live-approved --max-cycles 5 --max-proposer-calls 8 --max-wall-ms 1800000 \
  --batch-size 1 --proposer-timeout-ms 300000 --loop-id p3-20261019-4 --json
```

The loop is live and paid; re-running requires an approved OpenRouter budget. The
repository verification for this evidence update was `bun run test:self-improve`
(unit 106 cases, integration 41 cases, all pass).

## Result

- Loop counters: 5 cycles, 7 proposer calls, 0 head moves, 2 invalid proposals,
  stopped at `max_cycles`.
- Five ledger rows, sequence 27–31:

| seq | cycle | objective | verdict | held-out |
| --- | --- | --- | --- | --- |
| 27 | `cyc-20261018185941-9f39` | `probe.egress_boundary` | reject: `floor_not_met` | coverage 1.0, 0 regressions |
| 28 | `cyc-20261018190244-9942` | `probe.extract_coverage` | reject: `floor_not_met`, `cost_rule` | coverage 1.0, 0 regressions |
| 29 | `cyc-20261018190540-fab5` | `probe.egress_boundary` | reject: `critic_secret`, `floor_not_met` | coverage 1.0, 0 regressions |
| 30 | `cyc-20261018190917-97bb` | `probe.extract_coverage` | reject: `floor_not_met` | coverage 1.0, 0 regressions |
| 31 | `cyc-20261018191208-3956` | `probe.egress_boundary` | reject: `critic_secret`, `floor_not_met` | coverage 1.0, 0 regressions |

- All seven guards passed in every cycle; there were zero guard failures and zero
  gate stops. The critic blocked two cycles for a secret-like assignment
  (`critic_secret`); those are verdict reasons, not guard failures.
- No cycle met the `0.01` floor (`delta = 0`), so all five were rejected; the
  campaign produced no adoption and no head movement.
- Selection was `policy:failure_greedy` with `policyId=pi-1-25`, alternating the
  two probe objectives as shown above.
- Earlier live attempts: `p3-20261019-2` recorded three `cmd_proposer_failed` calls
  ("The model is temporarily unavailable") around one completed cycle
  (`cyc-20261018182238-50bb`). `p3-20261019-3` recorded eight invalid
  proposals and zero cycles; a manual reproduction of the same proposer returned `proposer_reply_missing_patch`. The final campaign
  used a stronger OpenRouter model after the credit top-up.

## Limits

- All five cycles are rejects. The campaign demonstrates policy steering, guard
  behavior, and held-out cleanliness, not an improvement or an adoption.
- The `critic_secret` blocks and the `cost_rule` rejection are verdict-level
  reasons; they are not failures of the seven guards.
- Live model output is not deterministic; the committed loop logs, loop state and
  ledger rows are the receipt. The proposer is a paid external dependency.
- The cost proxy is recorded `wallMs`, which is load-dependent, not a fresh
  measurement.
- The P2b verdict remains `unmet`; this campaign does not change it and makes no
  statistical-significance claim.
