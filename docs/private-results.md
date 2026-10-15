# Private results

All plugin-owned result/state writes use **`~/.gjc-plugin/`**, not `~/.gjc/`. GJC still owns installed code under `~/.gjc/agent/gjc-plugins/`, and the Jev credential file (`~/.gjc/agent/jev-advisor/.env`) is unchanged.

## Inventory

| Path beneath `~/.gjc-plugin/` | Contents |
| --- | --- |
| `jev-advisor/state.v2.json` | Bounded metadata-only task/launch/terminal correlation |
| `verification-receipts/receipts/v1/<repository-digest>/<receipt-id>.json` | Shared immutable verification/UI storage envelopes: public receipt and private selected-input binding |
| `verification-receipts/loop/v1/<repository-digest>/<session-digest>.json` | Per-session delegation-gate state (baselines, pending async launches, gates and resolutions). Writer-owned: a session writes only its own file and read-merges at most 16 other session files |
| `<plugin>/journal/v1/` | Sanitized handled-outcome records, including run/status/manual/advice/observation failures and assessment/storage results |
| `rrsi/periodic.json` | Bounded periodic-refresh state (last attempt/success, outcome, reason, backoff, projection digest, applied limits) |
| `rrsi/runs/v1/<receiptId>.json` | Periodic run receipts; ≤ 64 KiB each, ≤ 60 retained, oldest pruned on write |
| `rrsi/{periodic.lock,store.lock}` | Exclusive plugin-local locks for the periodic writer and for capture/import read-modify-write sequences |
| `ui-regression/locks/` | Private owned browser-run coordination lock |

Directories are owned `0700`; files are owned single-link regular `0600`. Symlinks, unsafe owners/modes, hard links and corrupt/unknown inventory fail closed without permission repair, lock stealing or legacy fallback. `JEV_ADVISOR_STATE` does not select the result path; a supplied value is ignored and reported as `state_override_ignored`, and is never recorded.

Legacy `.gjc` result locations are never migrated, deleted or looked up automatically; receipt IDs from that location are not resolvable through this store. Uninstalling or upgrading code does not erase results. Archive or remove history only through an explicit user-owned operation after checking ownership and stopping writers.

## What is recorded

Every handled invocation attempts exactly one journal record after its known assessment/storage results. Jev batch advice records up to 32 normalized task indices, tiers, confidence semantics and no-decision reasons in one bounded record; per-task `basis` retains the normalized advice's `confidenceKind` without rounding scores. Result observers record terminal-status and storage-transaction counts in one record. Full validated probabilities remain in manual advice records and eligible correlation state. Disabled/unconfigured providers still produce local operational records; calibration remains network-free and correlation-read-only, but journals the lookup.

Records contain only allowlisted enums/reason codes, timestamps/durations, digests/UUID references, native counts, assertion kinds/outcomes, validated tier/score/probability fields and storage metadata. They contain **no** assignment/context/rationale prose, raw logs/source/stacks, credentials, account routing, snapshots, URLs, selectors or fill/expected values. Selected test locators exist only in the private bound storage envelope and are omitted from returned receipts, journals and provider requests.

Responses separate observed execution, adequacy assessment, receipt/evidence storage and `journalStorage`. A failed write never changes an actual test result. `persisted:false` means recording is not confirmed; disk failure cannot guarantee a durable error record. Status never reruns tests or opens a browser.

## Retention and capacity

Immutable receipt admission is bounded to **200 receipts / 2 MiB per repository / 32 KiB per complete envelope**. `count`, `bytes` and `nearCapacity` are returned when measurable; warning starts at 180 receipts or 90% bytes. `store_full` preserves history and does not advertise a rejected receipt as durable. The independent outcome journal can continue recording while receipts are full.

Each plugin journal has **4 KiB records, 1 MiB segments and eight retained segments**, with a 100 ms lock-wait bound. Marker-bound rotation retires only validated owned closed segments. `rotated` and `retainedSegments` describe the retention boundary; indefinite history is not promised. Unknown files or interrupted/corrupt publication are not adopted or repaired automatically. `rrsi/periodic.json` is reported like the store (`missing`/`invalid`, never repaired) and `rrsi/runs/v1/` receipts are bounded to 60 files with oldest-first pruning.
