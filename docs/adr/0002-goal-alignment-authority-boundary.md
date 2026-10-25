# ADR 0002: Goal-alignment authority boundary

Status: accepted and implemented in `jev-advisor`. Every rule below is a
statement about the code named in [Implementation](#implementation); nothing
here is a measured outcome.

## Context

- `jev-advisor` gains a before-tool surface that can block a write, which is a
  new kind of authority for a plugin whose other surfaces only advise.
- The alignment code is `jev-advisor/lib/alignment.ts` plus three adapters
  (`src/alignment.adapter.ts`, `src/alignment-observe.adapter.ts`,
  `src/alignment-shutdown.adapter.ts`), built into
  `hooks/jev-advisor-alignment{,-observe,-shutdown}.ts` and declared as the
  manifest entries `jev-goal-alignment`, `jev-goal-alignment-observe` and
  `jev-goal-alignment-shutdown` in `jev-advisor/gajae-plugin.json`.
- The existing tier advisor has its own mode (`JEV_ADVISOR_MODE`:
  `shadow`, `hint`, `enforce`) and its own confidence gate. It answers "which
  delegation tier fits this child task", not "what did the user ask for in this
  session".
- A blocking hook must be explainable after the fact, must not depend on a
  provider, and must not turn its own storage into an authority.

## Decision

1. **Authority is host session user entries only.** `collectAuthority` reads
   only entries that `isUserEntry` classifies as user (`type`/`role`/`info.role`);
   assistant and tool entries are ignored, and a branch with no user entry
   returns `null` — missing authority is never a block and never an invented
   request. The scan is bounded by `WINDOW_SIZE = 12` user entries, at most
   `MAX_SCAN_ENTRIES = 200` inspected entries, `MAX_ENTRY_TEXT = 8192`
   characters of entry text and `MAX_TARGETS = 16` targets. Only
   machine-shaped tokens become targets (`targetsInText`: backticked spans,
   slash paths, filenames with a known extension, `criterion=` markers),
   normalised by `normalizeTarget`, which drops URLs, whitespace and
   over-long values instead of guessing. Agent prose, todo lists and subagent
   output are data, never authority.
2. **Constraints are typed and sticky.** The constraint kinds are `read_only`,
   `stop` and `forbidden_target`. Only an explicit release clears them; hedged
   release wording is recorded as `release_ambiguous` and is **not** applied,
   and a later plain "continue" never clears read-only. `stop` additionally
   clears on a later add/narrow/supersede request, because a new request
   re-opens work.
3. **Deterministic blocking is limited to write-class actions.**
   `evaluateAction` applies ordered rules and the first match wins:

   | Rule id | Class | Verdict | Coverage | Blocks |
   | --- | --- | --- | --- | --- |
   | `drift_write_vs_readonly` | write | drift | evaluated | yes |
   | `drift_write_forbidden_target` | write | drift | evaluated | yes |
   | `drift_write_after_stop` | write | drift | evaluated | yes |
   | `aligned_write_within_requested_scope` | write | aligned | evaluated | no (stage-2 admissible) |
   | `uncertain_authority_ambiguous` | write | uncertain | coverage_gap | no |
   | `read_allow` | read | allow | evaluated | no |
   | `bash_observe` | bash | allow | coverage_gap | no |
   | `unknown_authority` | write | uncertain | coverage_gap | no |

   The before-tool adapter classifies tool names into write, read and bash
   sets and returns before evaluation for anything that is not write, so a read
   or bash call is never blocked and never journaled. The write set is `write`,
   `edit`, `patch` and their aliases (`write_file`, `edit_file`, `apply_patch`,
   `multiedit`, `multi_edit`, `multi_edit_file`, `str_replace`,
   `str_replace_editor`, `notebookedit`, `notebook_edit`). A multi-target write
   is evaluated per path, so one forbidden target still blocks; only a
   single-target write can be stage-2 admitted.
4. **Bash is observe-only with `coverage_gap`.** `bash_observe` allows every
   bash call and reports `coverage_gap` rather than a verdict. A mutation
   performed inside bash is therefore outside the evaluation: it is not
   classified, not blocked and not journaled.
5. **Four-stage recovery with a declared completion criterion.**
   - Step 1 `recordCorrection` (`correction_recorded`) pins the recovery
     identity (digest over the latest user entry id, change semantics, scope
     digests, criterion and constraints), the approved target digests, the
     criterion and `criterionBaseline`.
   - Step 2 `admitAlignedAction` (`aligned_admitted`) requires an evaluated,
     aligned, stage-2-admissible write whose target digest is in the approved
     scope and whose tool-call id digest is present.
   - Step 3 `observeResult` (`result_observed`) requires the exact
     `toolCallIdDigest`; a missing or different id goes straight to step 4 as
     `recovery_unverified` with reason `tool_call_mismatch`.
   - Step 4 `evaluateCompletion` returns `recovered` only on a declared
     criterion's `false|unknown → true` transition. No declared criterion →
     `recovery_unverified` / `no_declared_criterion`; a baseline that was
     already `true` → `recovery_unverified` / `baseline_true`; a non-true
     observation is rejected with `criterion_not_true`, not completed.
   - Criteria are declared by the user entry as `criterion=exit_zero`,
     `criterion=artifact_exists:<path>` or `criterion=criterion_file:<path>`
     (`CRITERION_MARKER`, `CriterionKind`).
6. **Storage failure is never a block reason, and deterministic blocking
   survives degradation.** The verdict comes from `evaluateAction` alone. The
   journal is best effort: `alignmentAppendEvents` returns `false` on any
   failure, `alignmentLoadJournal` reports `available: false` for an
   unreadable or oversized segment, and a thrown handler is a `hook_error`
   that fails open. While the store is unavailable the retry chain is kept in
   the in-process map `alignmentDegradedRetries` (at most
   `ALIGNMENT_DEGRADED_COUNTERS_MAX = 64` keys, cleared when full), so a
   repeated violation still reaches `stop_recommended`. A broken journal can
   neither create nor suppress a block.
7. **The journal is session-scoped and bounded.** Its path is
   `~/.gjc-plugin/jev-advisor/alignment/v1/<sessionDigest>/events.jsonl`, with
   one rotated predecessor `events.1.jsonl`; `<sessionDigest>` is the first 16
   hex characters of the session-id digest, or `default` when the session id
   cannot be read. Directories are created `0700` and files `0600`.
   `ALIGNMENT_LIMITS` fixes the caps: 200 records, 2048 bytes per record,
   256 KiB total, two segments and seven days of retention, plus a 60-second
   future-skew tolerance. Records carry digests, ids and typed statuses only —
   never raw user text. An over-cap record is dropped rather than truncated.
   `reduceJournal` derives `corrections`, `blocks`, `recovered`, `unverified`
   and `unresolved` counts, and the shutdown surface flushes one `shutdown`
   record per still-unresolved `recoveryId`, idempotently.
8. **One mode switch, unrelated to tier advice.** `JEV_ALIGNMENT_MODE` accepts
   `off`, `shadow` or `deterministic`; unset or unrecognised resolves to
   `shadow`. `off` is a kill switch (no evaluation, no journal, no block);
   `shadow` evaluates and journals but never blocks; `deterministic` may block
   write-class drift. `JEV_ADVISOR_MODE` governs tier advice
   (`shadow|hint|enforce`) and is never read by the alignment path. Semantic
   (model-based) enforcement does not exist in this layer: `lib/alignment.ts`
   is pure, the adapters make no provider call, and no credential or
   configuration file is read.

## Drivers

- A blocking hook must be auditable. Every block carries the rule id, an
  eight-character user-entry prefix and recovery guidance (`alignmentReason`),
  and the retry identity is derived from the user entry rather than the branch
  head, so appending assistant turns does not reset the retry chain.
- In a tool hook, a false block costs more than a missed one. Only explicit
  constraints block; anything ambiguous reports `coverage_gap`.
- Degradation must not change a verdict: a broken journal or a thrown handler
  must never become a block.
- Completion claims must be checkable. "Recovered" is a declared criterion's
  transition, not a narrative.

## Alternatives considered

- **Extend tier enforcement (`hint` → `enforce`) instead of a separate
  layer.** Rejected: tier advice is per delegated task and confidence-gated;
  it has no notion of the session's user request, of read-only/stop
  constraints, or of a completion criterion. One confidence threshold would
  then govern two unrelated authorities.
- **New top-level plugin.** Rejected: the surface must run inside the host
  session (branch entries, tool-call ids, shutdown) that `jev-advisor` already
  receives. A second plugin duplicates manifest surfaces and splits the
  journal namespace without adding isolation.
- **Prompt or rule only ("the agent should respect the goal").** Rejected: a
  prompt cannot produce a deterministic block, and the acceptance cases in
  `scripts/verify.ts` exercise the hook, not prose adherence.
- **Merge into the existing tier adapter.** Rejected: that adapter reads
  configuration, credentials and the network. The alignment path has to stay
  pure and keyless so it still blocks when the advisor is unconfigured or
  offline. `scripts/build.mjs` therefore builds the alignment surfaces with
  `shared: false` — no decision contract, results core or key block inlined.
- **Block bash too.** Rejected for now: bash input has no bounded target
  parser, so a block would rest on guesses. `bash_observe` reports
  `coverage_gap` instead of pretending coverage.
- **Treat a journal failure as a deny.** Rejected: storage would become a
  block reason, and the block would be unattributable to the user's request.

## Why chosen

- The only thing that can be proven deterministically is exactly what is
  blocked: user-authored entries with explicit constraints and machine-shaped
  targets.
- Every blocking rule is a pure function over supplied data, so
  `scripts/verify.ts` can exercise authority collection, the rule table and
  the transition chain without a provider, a key or a real session.
- Reusing `jev-advisor` keeps one install order, one journal root and one
  upgrade path, and the alignment surfaces stay keyless.

## Consequences

- `shadow` is the default: blocking is explicit opt-in, and installing the
  plugin does not change whether any existing workflow can write.
- Even in `deterministic`, only the three drift rules block. An ambiguous,
  unparsable or multi-target write is allowed and reported as `coverage_gap`.
- Coverage gaps are permanent and documented rather than scheduled away:
  reads and bash are never evaluated, and a turn with no write call (for
  example an answer-only turn) produces no evaluation at all. Actions that are
  already running are not re-evaluated — the hook only judges tool calls it
  receives — and work inside a subagent is only covered insofar as its tool
  calls reach this surface with a readable session branch.
- The journal is a retained window, not a lifetime audit log. Rotation and the
  seven-day retention mean `reduceJournal` counts describe retained records
  only.
- Turning the layer off is local and immediate (`JEV_ALIGNMENT_MODE=off`).
  Uninstalling the plugin removes the surfaces; existing alignment journal
  files remain until an operator removes them.

## Follow-ups

- **Semantic (model-based) evaluation is not implemented and stays disabled.**
  It would need a typed decision contract, an explicit confidence gate and its
  own acceptance cases before it could influence a verdict; none of that
  exists here.
- **A shipped mode switch is now `JEV_ALIGNMENT_MODE`.** It is a single
  global switch for the pre-tool surface; per-session or per-repository
  scoping does not exist.
- **Bash enforcement** needs a target parser and its own acceptance cases
  first. Until then `bash_observe` stays `coverage_gap`.
- **No consumer reads the alignment journal yet.** `plugin_metrics` and the
  `rrsi` projection do not include it; adding it is a separate decision with
  its own caps and its own non-causal statement.

## Implementation

- `jev-advisor/lib/alignment.ts` — authority collection, ordered rules,
  recovery transitions, journal limits.
- `jev-advisor/src/alignment.adapter.ts` — before-tool surface, mode
  resolution, degraded retry counters.
- `jev-advisor/src/alignment-observe.adapter.ts` — result binding, criterion
  observation, completion.
- `jev-advisor/src/alignment-shutdown.adapter.ts` — idempotent unresolved flush.
- `jev-advisor/hooks/jev-advisor-alignment{,-observe,-shutdown}.ts` —
  generated, do not edit.
- `jev-advisor/gajae-plugin.json` — `jev-goal-alignment`,
  `jev-goal-alignment-observe`, `jev-goal-alignment-shutdown`.
- `jev-advisor/scripts/verify.ts` — AC-A1/AC-A2 cases, mode resolution and
  degraded-storage cases.

The quality-evidence side of this work is a separate decision:
[ADR 0003](0003-quality-trial-evidence-boundary.md).
