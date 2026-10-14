# verification-receipts

Explicit `node:test` execution with native counts, immutable private receipts and source freshness, plus the post-delegation verification gate and its bounded `verification_loop` recheck.

## Install

```sh
gjc plugin install ./verification-receipts --user
```

Tools and hooks load at session start; verify in a fresh GJC process after install or upgrade.

## Tools

- **`verification_run`** — accepts explicit repository-relative `.js` / `.mjs` / `.cjs` files (1–32), not globs, arbitrary commands or alternate runners. Inspect test effects first: test code is not sandboxed. Native pass/fail/skip/TODO/cancellation counts are execution evidence, not assertion counts or coverage proof. Empty and skipped-only files cannot establish successful testing.
  Freshness covers normal Git-visible source **and the safely validated explicit selected test inputs, including ignored files**. A private receipt/repository/spec-bound input manifest lets status hash those same bytes. Missing, unsafe, sensitive/cache-excluded or unhashable inputs make freshness unavailable; they are never silently omitted. Dependency caches and excluded credentials are not covered.
- **`verification_status`** — reads a private receipt, recomputes its bound selected-input freshness without rerunning tests, and journals the lookup. Historical success is not current evidence, and no status call opens a browser or reruns a test.
- **`verification_loop`** — no parameters; ≤15s budget, no network. Recomputes the private post-delegation ledger for the current repository: open gates from this and earlier sessions, covering-receipt evaluation (this plugin's receipts only, recomputed freshness, passed status, changed test files included in the run's selected inputs), and honest gap kinds. `status:"clean"` is a mechanical recheck, not proof of correctness or coverage; unreadable state reports `blocked` instead of silently clean.

## Delegation verification gate

After a delegated `task` batch completes visibly (sync completion, a race-completed async envelope, or a terminal `job` / `subagent` observation), the plugin appends a bounded `[delegation-verification-gate]` block to that tool result: machine facts (changed files, commits, tree state, binding evidence, newest receipt), a required `verification_loop` recheck and a judgment-only sweep checklist. Backgrounded launches that are still `running` record a pending marker instead and are gated when their terminal observation arrives; the same job id never produces two gates across `job` and `subagent` polling. Failures, aborts and errors are never gated.

The gate is fail-open and bounded: the before-hook baseline capture shares a single 3s wall-clock budget and never blocks or throws; the after-hook appends text within its isolated execution and leaves the original result untouched on any failure. If the private state write is dropped (lock timeout or budget), the requirement text is still appended and the drop is journaled (`stateWrite:"drop"`). Gates and loop runs journal `gate_emitted` and `loop_run` counts under `~/.gjc-plugin/verification-receipts/journal/v1/`.

`silentPending` is an upper-bound proxy for launches without an observed terminal (it may include still-running or cancelled jobs), not a count of missed gates; `scanTruncated` marks bounded cross-session scans.

## Boundaries

Both this plugin's tools and the UI tools automatically attempt warning-only Jev adequacy via the fixed OpenRouter decision endpoint when configured; only validated supplied summaries/notes and bounded host facts leave, and missing or weak context never establishes sufficient verification. The gate is a requirement appended to a completed result, never a hard block. Private storage layout, journal contents and retention: [`../docs/private-results.md`](../docs/private-results.md).

## Build and verify

```sh
bun verification-receipts/scripts/build.mjs
bun verification-receipts/scripts/verify.ts
bun verification-receipts/scripts/build.mjs --check
node verification-receipts/scripts/smoke-host.mjs --installed   # private isolated GJC root, loopback only
```

The full smoke matrix (metrics, advisor, UI) is listed in [`../CONTRIBUTING.md`](../CONTRIBUTING.md#smoke-tests).
