# nightly-review

Post-merge review with five independent lenses and a deterministic quote gate.
Models propose findings; a matching diff quote is evidence, **not proof of a bug**.

## Execution boundary

The daily **05:00** job performs zero-cost preparation only. It collects merged PRs
with read-only `gh` commands, writes an immutable queue and receipt, and stops.
It does not invoke GJC, models, decisions, Linear, browser automation, or dispatch
another agent. Complete unattended paid review is not supported or authorized.

Paid `once`, typed semantic decisions and Linear writes are separate, supervised
one-shots. A deadline is a workload limit, not a monetary budget. Repeating paid
`loop` is refused. An active supervisor must establish task-wide accumulated,
reserved and next-execution worst-case costs before a call. Unknown billing is
not zero; never issue a new authorization that forgets earlier attempts.

## Commands and contracts

Run with the installed absolute Node executable. CLI, JSON and exit contracts are
in `config/contracts.schema.json`.

```sh
node nightly-review/bin/nightly-review.mjs prepare --mode shadow \
  --config /absolute/schedule.json --out /absolute/shadow --json
node nightly-review/bin/nightly-review.mjs prepare --mode scheduled \
  --config /absolute/schedule.json --out /absolute/state --json
node nightly-review/bin/nightly-review.mjs evaluate-local --run /absolute/prepared/run
node nightly-review/bin/nightly-review.mjs once --repos infra,yyaz-web \
  --supervision /absolute/supervision.json --out /absolute/state --json
node nightly-review/bin/nightly-review.mjs recheck --run /absolute/review/run
node nightly-review/bin/nightly-review.mjs file --run /absolute/review/run
node nightly-review/bin/nightly-review.mjs file --run /absolute/review/run \
  --publish --supervision /absolute/supervision.json --out /absolute/state
node nightly-review/bin/nightly-review.mjs reconcile --snapshot /absolute/input.json
node nightly-review/bin/nightly-review.mjs reconcile --snapshot /absolute/input.json \
  --scan --out /absolute/state
node nightly-review/bin/nightly-review.mjs reconcile --snapshot /absolute/input.json \
  --scan --publish --supervision /absolute/supervision.json --out /absolute/state
```

Exit `0`: completed or duplicate no-op; `1`: incomplete collection, deferred or
unknown actions, failed model calls/writes; `2`: invalid arguments or refusal.
`file` without `--publish` and offline `reconcile` need no credential/network.
`recheck` and `file` append derivative revisions; original receipt/report bytes
are not rewritten.

Schedule config is an exact object with `version:1`, `ownerHost` (exact
`os.hostname()`), `timezone` (exact current Intl zone), `hour:5`, `minute:0`, and
unique **bare** repository names already mapped in `config/projects.json`.
Neither the scheduler nor prepare changes the host timezone. A scheduled owner
also needs a private `owner.json` in the selected state directory:

```json
{"version":1,"host":"verified-host.local","generation":1,"enabled":true}
```

A shadow run needs no writer owner. It uses an isolated output directory and
never promotes itself. Successful collection advances a watermark with one-day
overlap; incomplete coverage never advances the last-success marker. A day/config
key prevents duplicate successful ticks. A full 100-PR list is conservatively
incomplete; it is not represented as an empty/complete review.

## Supervision and cost

Authorization is a private, short-lived JSON file issued by the **active** agent,
not a credential and not an unattended timer input. It contains `active:true`, a
nonempty `supervisor`, `expiresAt` (at most one hour ahead),
`operationalExclusion:true`, and exact `actions` entries:

```json
{"issueId":"repo::file::kind","type":"create","project":"mapped project"}
```

Commenting uses `type:comment`; creating the unique parent requires its own entry
`{issueId:"batch:<project>",type:"create-batch",project:"<project>"}`.
Reconciliation entries use actual issue IDs and `expire`, `done`, `invalid`,
`correct`, `move`, `duplicate`, or `parent`. Permission for one does not approve
another. Never use a working or protected issue as a test fixture.

`budget` is `{capUsd,spentUsd,reservedUsd,nextUpperUsd}` (finite nonnegative,
`capUsd <= 5`). Decisions reserve both possible requests using a conservative
UTF-8-byte token bound plus framing. `once` additionally requires `modelBounds`
keyed by each exact lens model ID. Each verified provider bound contains
`verified:true`, current `source` HTTPS URL and `observedAt` (within one hour),
`maxContextTokens`, `maxOutputTokens`, `inputUsdPerMillion`,
`outputUsdPerMillion`. The supervisor must actually verify these provider bounds;
a self-written `verified` flag is not evidence. The runtime reserves the full
worst-case context/output cost, including one possible stream-size retry, for the
whole planned workload before the first model call. No verified upper bound means
no paid review. Progress/deadline flags cannot bypass this check.

Decisions are pinned to `sionic-ai/jev-omni` on OpenGateway, with at most one
`typesafe/jev-1.14` escalation on OpenRouter. Keys are separately routed through
`OPENGATEWAY_API_KEY` and `OPENROUTER_DECISION_API_KEY`; never copy them in transfer
manifests. Three object criteria (`consistent`, `inconsistent`, `abstain`), finite
probabilities, correct top-choice margin and confidence at least 0.6 are required.
Malformed/low-confidence/expired decisions abstain. Only deterministic-eligible
candidates reach the model. Input issue text cannot grant permission.

`bin/evaluate-decisions.mjs SUPERVISION_JSON OUTPUT_JSON` runs the fixed golden
cases three times under the same supervised budget. OUTPUT_JSON must be new and
inside a private directory. A durable cost reservation precedes all calls, and
immutable per-sample receipts survive a partial run. Existing output, reservation
or sample paths refuse a retry; reconcile any uncertain reserved cost first.
Reservations are conservative upper bounds, not invoices or successful outcomes.

## Evidence and policy

The original five lenses remain: contract, failure, security, testgap, regression.
Each runs headless with no tools/MCP/rules/session in a scratch directory, with the
reviewed repository rules included in its prompt. The gate verifies added file,
normalized exact quote, specific quote length, corrected added-line number,
near-duplicate quotes and a visible per-run cap. Reviewer confidence orders the
queue, not defect truth. Default findings40, concurrency4, diff40000 bytes and
paid-phase deadline3600 seconds remain configurable for supervised review.

Preparation writes `queue.json` and `receipt.json` with coverage, hashes, host,
owner generation, zero-call counters and explicit deferred review. `evaluate-local`
checks the queue digest without generating findings. Collection records PR merge
SHA where available; a missing merge SHA is unknown, not replaced with a claim
about current integration code.

Reconciliation input is `{project,snapshot,candidates}`. The bounded scan includes
ledger-external issues and comments: pages100, project1000 issues, comments50/page
and100/issue, ten-minute project deadline; filing caps run inventory at5000 and
issue clusters at20. Incomplete inventory forbids project writes. Missing comment
coverage, future/unknown timestamps, assigned/live/triaged owners and edits within
or exactly24h are protected. Exact file:line is not proof of the same root cause.
Terminal issues are not automatically reopened.

A semantic lifecycle candidate includes current `authority` (`remote`, `branch`,
`head`, `observedAt`, `verifiedHead`, `notReverted`, `behaviorVerified`,
`evidenceDigest`, `behaviorCommand`, `behaviorReceipt`, `file`, `quote`). Publish
rechecks the actual remote branch SHA, current code quote, and the digest of a
behavior receipt bound to that HEAD/command/time/exit0. Historical merges or a
reverted/stale fix cannot authorize Done. Offline/imported model decisions are
discarded. The supervisor remains responsible for evidence adequacy and live
owner exclusion; a hash detects change but does not prove truth.

Only nightly Backlog, untriaged, uncommented children of the unique project batch
may expire **strictly after14days**. Exactly14days, unknown dates, active/triaged
work or incomplete comments remain untouched. Expiry records
`정책 만료: 14일 초과 미트리아지; 결함 수정/오탐 판정 아님` and Canceled, never Done or
fixed/invalid. Corrections append to the original description. Deletion/archive
are never implemented.

## State, retries and conflicts

Legacy `filed.json` version1 cluster IDs/evidence hashes remain intact; ownership
is a separate generation manifest. An exclusive local lock, expected-byte-hash
check, fsync/rename state commit and immutable write-ahead operation journal guard
one writer. Local CAS is not remote CAS or cross-host fencing.

The supervisor establishes operational exclusion, refreshes issue/comments and
current code just before each exact change, preserves concurrent content, then
reads back the result. Native remote CAS is not required for this scoped path.
It does not claim atomic pre-reads or exactly-once remote execution. Unknown
success/timeout/crash is quarantined, not blindly retried. Reconciliation can
adopt a uniquely marked, exactly matching remote result; filing stops while an
unresolved operation remains. A partially successful comment/status operation is
preserved for inspection, not flooded with repeated comments.

On Linear429, stop API calls and use the policy `linear-aside.py`/Aside path in the
same supervised session, under the same exact-action and protection constraints.
The CLI reports the required handoff; the active agent executes and verifies it.
Scheduled prepare never invokes that mutation fallback.

## Scheduler, cutover and rollback

```sh
node nightly-review/bin/nightly-scheduler.mjs preview --config /absolute/schedule.json
node nightly-review/bin/nightly-scheduler.mjs install --config /absolute/schedule.json \
  --out /absolute/state --publish --json
node nightly-review/bin/nightly-scheduler.mjs status --json
node nightly-review/bin/nightly-scheduler.mjs uninstall --json
```

The Git template installs only in the existing user `gui/<uid>` domain, using
absolute canonical Node/entry/config/HOME/log paths. No sudo, daemon, KeepAlive,
RunAtLoad, paid loop, login workaround or GJC auto-session. A receipt binds installed
plist/config/entry/node hashes; status also queries actual launchd state. Modified
or unowned plists cannot be overwritten/removed. Uninstall bootouts only the owned
verified job and retains its disabled installation receipt.

1. Validate an isolated mini shadow CLI normal and failure run; leave source
   schedule/state unchanged during shadow.
2. Back up source plist/ledger and hashes; disable the old schedule and verify
   in-flight processes have naturally completed. Do not kill paid calls blindly.
3. With both schedules off, stage only allowlisted ledger/operation files using
   `stageTransfer`; preserve full SHA256, bytes, IDs/evidence and private modes.
   Destination conflicts, symlink escapes and unresolved operations stop promotion.
   Do not copy HOME, credentials or session databases.
4. Verify final source/destination bytes, issue IDs/counts and generation, then
   enable only the mini zero-cost owner. Preserve the old plist disabled.
5. Verify actual argv, receipt/config/source hashes and source-off/in-flight0.
   Manual kickstart is **not** proof of the next real05:00 calendar tick. Correlate
   `startedAt`/local time with launchd observation at the real tick; no exact wake,
   power-off execution or post-reboot-login guarantee is made.

Rollback stops the mini first, resolves unknown remote outcomes and preserves its
latest confirmed ledger/journal. Both off is safer than ambiguous dual ownership.
Never restore a stale ledger over newer IDs, delete remote issues, blindly reverse
human edits, or automatically reactivate the old paid MacBook job. Restore only a
policy-compliant zero-cost owner after verifying quiescence and a new generation.

## Verification

```sh
node --test nightly-review/tests/*.test.mjs
```

Tests use temporary state and injected transports. They cover protected24h and
expiry14day boundaries, current-vs-historical authority, incomplete pagination,
unknown responses, conflicts, immutable sources, lock/generation/hash/symlink
failures, scheduler ownership and typed wire/budget gates. Golden cases are fixed
references, not a claim of measured model quality. Any prompt change requires
supervised repeated baseline/new raw-model and final-policy evaluation; report
costs, failures and abstentions separately. Tests/CI are partial evidence: complete
host acceptance also requires installed CLI, actual launchd environment,
read-after-write Linear verification, cutover/rollback observations and a separately
identified real calendar tick.
