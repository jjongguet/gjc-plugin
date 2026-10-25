# ui-regression

One bounded, non-sensitive loopback Aside scenario with literal DOM assertions and historical metadata receipts. No screenshot baselines.

## Install

```sh
gjc plugin install ./ui-regression --user
```

Requires a connected Aside profile for runs (explicit ephemeral account routing); status reads never open a browser. Tools load at session start; verify in a fresh GJC process after install or upgrade.

## Tools

- **`ui_regression_run`** — requires explicit ephemeral account routing, one exact loopback origin, a first `goto`, and at least one assertion. It supports unique visible current CSS targets, non-sensitive text fields and explicit `button[type="button"]`. One scenario uses one Aside REPL invocation and closes only its owned tab. Inspect handlers first: loopback and post-action origin checks do not sandbox redirects, popups or network effects. Timeouts, cancellation, malformed/partial observations or unconfirmed cleanup cannot pass.
- **`ui_regression_status`** — inspects historical UI evidence and current source freshness, then journals the lookup. It never re-observes the browser and never proves a deployed build. Status explicitly reports `currentUiState:"not_reobserved"` and `browserBuildBinding:"unverified"`; historical success is not current/deployed UI evidence.

Text matching preserves case and internal whitespace, normalizing only line endings and surrounding whitespace. **Normalized-empty substring expectations are rejected**; exact-empty assertions and empty fills remain meaningful supported cases.

Both tools take an optional `repository`: a Git work-tree root, absolute or relative to the session directory, that is the session repository or lies inside it. Pass it when the session directory is not inside a work tree (a workspace root holding several repositories). Without it the run is `not_run` / `not_a_repository` and status is `unavailable` / `not_a_repository`; a repository outside the session directory is `repository_outside_session_cwd`, and a path that is not an existing work-tree root is `invalid_repository`. Pass the same `repository` to `ui_regression_status` that `ui_regression_run` received.

## Boundaries

Runs are limited to loopback and non-sensitive inputs; they are not a general browser-testing surface and provide no screenshot diffing or visual-regression baselines. Like `verification_run`, the tool automatically attempts warning-only Jev adequacy via the fixed OpenRouter decision endpoint when configured; omitted context or weak evidence never establishes sufficient verification. Private storage layout and retention: [`../docs/private-results.md`](../docs/private-results.md).

## Build and verify

```sh
bun ui-regression/scripts/build.mjs
bun ui-regression/scripts/verify.ts
bun ui-regression/scripts/build.mjs --check
```

Browser smoke requires an actually connected Aside profile and inspected owned loopback handlers; see [`../CONTRIBUTING.md`](../CONTRIBUTING.md#smoke-tests). Source tests, installed dispatch, browser observations and real-provider judgment are reported separately, never blended.
