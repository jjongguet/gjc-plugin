# ui-regression

One bounded, non-sensitive loopback Aside scenario with literal DOM assertions and historical metadata receipts. No screenshot baselines.

## Install

```sh
gjc plugin install ./ui-regression --user
```

Requires a connected Aside profile for runs (explicit ephemeral account routing); status reads never open a browser. Tools load at session start; verify in a fresh GJC process after install or upgrade.

## Tools

- **`ui_regression_run`** — requires explicit ephemeral account routing, one exact loopback origin, a first `goto`, and at least one assertion. The invocation pins the Aside REPL to the **local session host** (`--host local`): the origin is strictly loopback, so the browser must run on this machine and a cloud session host can never reach the fixture (JJO-745). It supports unique visible current CSS targets, non-sensitive text fields and explicit `button[type="button"]`. One scenario uses one Aside REPL invocation in the local Aside Browser, opens only its own new tab (never attaching to existing tabs) and closes only that tab. Inspect handlers first: loopback and post-action origin checks do not sandbox redirects, popups or network effects. Timeouts, cancellation, malformed/partial observations or unconfirmed cleanup cannot pass.
- **`ui_regression_status`** — inspects historical UI evidence and current source freshness, then journals the lookup. It never re-observes the browser and never proves a deployed build. Status explicitly reports `currentUiState:"not_reobserved"` and `browserBuildBinding:"unverified"`; historical success is not current/deployed UI evidence.

Text matching preserves case and internal whitespace, normalizing only line endings and surrounding whitespace. **Normalized-empty substring expectations are rejected**; exact-empty assertions and empty fills remain meaningful supported cases.

Both tools take an optional `repository`: a Git work-tree root, absolute or relative to the session directory, that is the session repository or lies inside it. Pass it when the session directory is not inside a work tree (a workspace root holding several repositories). Without it the run is `not_run` / `not_a_repository` and status is `unavailable` / `not_a_repository`; a repository outside the session directory is `repository_outside_session_cwd`, and a path that is not an existing work-tree root is `invalid_repository`. Pass the same `repository` to `ui_regression_status` that `ui_regression_run` received.

## Boundaries

Runs are limited to loopback and non-sensitive inputs; they are not a general browser-testing surface and provide no screenshot diffing or visual-regression baselines. Like `verification_run`, the tool automatically attempts warning-only Jev adequacy via the fixed OpenRouter decision endpoint when configured; omitted context or weak evidence never establishes sufficient verification. Private storage layout and retention: [`../docs/private-results.md`](../docs/private-results.md).

## Assessment case IDs

For both tools, `assessment.caseNotes[].id` has the syntax `step-N`, where N is
the zero-based scenario step index (0–19). **Only observed assertions are
eligible**, including reached failed assertions. Planned, non-assertion and
unreached steps are not evidence. Run and status use the same observed IDs.
For a `goto` at index 0 and an assertion at index 1:

```json
{
  "changeSummary": "Update the local result label.",
  "expectedBehavior": "The fixture result is visible.",
  "caseNotes": [{"id": "step-1", "note": "The visible result assertion was observed."}]
}
```

IDs must be unique; at most 8 notes of 1–300 characters are allowed. Summaries
are non-sensitive text of 1–2000 characters. The public `assessment` and `scenario`
schemas are plain strings: eligible IDs, actions and limits are stated in field
descriptions and decided in-plugin, because a host-side schema rejection can echo
the call arguments.
`invalid_context` means unsafe text, shape, duplicate or limit rejection.
`invalid_case_id` means a well-formed ID is not in the observed assertion set;
the safe action lists only eligible host-owned IDs.

Run validation order is top-level input → scenario → assessment shape/safety
→ repository → browser → observed membership. Invalid scenarios and unsafe
assessment stop before the browser and create no receipt. A shape-valid note
for an unobserved assertion is rejected **after execution**; it must not be
reported as a zero-browser run. Rejected assessment makes no adequacy request.

## Rejection and recovery

Adapter rejections are `not_run` with a fixed `scenario_*` reason and
`recommendedNextActions`, journaled without caller values. They do not instruct
the caller to inspect unexecuted tests or retry forbidden input.

| Reason | Corrective action |
| --- | --- |
| `scenario_url_sensitive`, `scenario_sensitive` | Do not pass authentication, account, payment or sensitive data. Use a separate authorized browser workflow for those real paths; never rename or encode input to evade screening. |
| `scenario_url_host` | Use an inspected owned loopback fixture. Real/deployed sites require a separate authorized browser workflow. |
| `scenario_url`, `scenario_url_scheme`, `scenario_url_unsafe`, `scenario_origin` | Use valid explicit HTTP(S) loopback navigation on one origin without credentials, query or fragment. |
| `scenario_selector`, `scenario_selector_unsafe`, `scenario_value` | Use current visible CSS selectors and supported non-sensitive fixture controls/values. |
| `scenario_object`, `scenario_fields`, `scenario_id`, `scenario_expected_behavior`, `scenario_steps`, `scenario_step` | Correct the documented object fields, ID, text and step limits. |
| `scenario_first_goto`, `scenario_no_assertion` | Start with goto and include a visible or literal-text assertion. |
| `scenario_assert_kind`, `scenario_match`, `scenario_expected`, `scenario_action` | Use supported actions and literal assertions. Arbitrary JavaScript, screenshots and imported results remain unsupported. |

Repository reasons remain distinct. Unknown top-level/account/timeout input is
`invalid_or_unavailable_input` with safe input guidance. Top-level parameters
keep their schema constraints; whether a host rejection there echoes arguments
is unmeasured. The `--ui-rejections` smoke sends an unsupported action with a
synthetic canary and requires the plugin, not the host, to reject it without
echoing the canary. No scenario payload, URL, selector,
fill value or account is added to journal or adequacy diagnostics.

## Build and verify

```sh
bun ui-regression/scripts/build.mjs
bun ui-regression/scripts/verify.ts
bun ui-regression/scripts/build.mjs --check
UI_REGRESSION_ACCOUNT=synthetic-route node verification-receipts/scripts/smoke-host.mjs --ui-rejections
```

`--ui-rejections` uses a counted inert launcher and five fresh-CLI rejection
probes (sensitive route/value, nonloopback host, external repository, unsafe
assessment). Its synthetic launch is an observer control only: it observes no
real browser. Every tool probe must add zero launches and zero receipts.
Add `--installed` only after the released user bundle is installed.

Browser smoke requires an actually connected Aside profile and inspected owned loopback handlers; see [`../CONTRIBUTING.md`](../CONTRIBUTING.md#smoke-tests). Source tests, installed dispatch, browser observations and real-provider judgment are reported separately, never blended.
