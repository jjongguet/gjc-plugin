# gjc-plugin

Plugins for [gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`).
Each subdirectory carrying a `gajae-plugin.json` is an independently installable plugin.

| Plugin | Purpose |
| --- | --- |
| [`jev-advisor`](jev-advisor/) | Decision-model advisories for subagent `task` delegation — recommends a `fast` / `balanced` / `strong` tier via TypeSafe Jev on OpenRouter, a generic chat model, or a local server, and remembers delegation outcomes locally so recommendations and a calibration report are grounded in evidence. Shadow by default. |
| [`verification-receipts`](verification-receipts/) | Explicit JavaScript `node:test` execution, native counts, immutable local receipts, source freshness, and automatic warning-only Jev adequacy (0.0.1). |
| [`ui-regression`](ui-regression/) | One bounded non-sensitive loopback Aside scenario, actual DOM assertions, and historical metadata receipts (0.0.1). No screenshot baselines. |

## Install

Requires [gajae-code](https://github.com/Yeachan-Heo/gajae-code) **≥ 0.18.0** (legacy hook contract) and `git` on PATH — URL installs clone through it.

```sh
gjc plugin install https://github.com/jjongguet/gjc-plugin --user
```

Pin a version by appending a git ref (`…/gjc-plugin#v0.0.3`). The installer discovers the plugin root itself, and the runtime surfaces are committed, so there is nothing to build.

Verify the install:

```sh
gjc plugin list && gjc plugin doctor
```

## Configure

Register an API key — one file, the single configuration channel, survives upgrades:

```sh
mkdir -p ~/.gjc/agent/jev-advisor
printf 'OPENROUTER_API_KEY=sk-or-v1-...\n' >> ~/.gjc/agent/jev-advisor/.env
chmod 600 ~/.gjc/agent/jev-advisor/.env
```

`OPENROUTER_API_KEY` is the same variable `gjc` itself reads for its OpenRouter provider; `JEV_ADVISOR_API_KEY` takes priority for a plugin-only key. Exported env vars always win over the file. To run without any key — nothing leaves the machine — set `JEV_ADVISOR_PROVIDER=ollaya` (local decision server), or `off` to disable the advisor entirely. Every other knob lives in the same file or env; the full table is in [jev-advisor/README.md](jev-advisor/README.md#configuration).

## Manage

| You want to | Run |
| --- | --- |
| Check health | `gjc plugin list && gjc plugin doctor` |
| Upgrade to latest | `gjc plugin upgrade jev-advisor --user` |
| Pin / downgrade to a version | `gjc plugin uninstall jev-advisor --user && gjc plugin install https://github.com/jjongguet/gjc-plugin#v0.0.3 --user` (install refuses over an existing copy; data survives both steps) |
| Disable temporarily | put `JEV_ADVISOR_PROVIDER=off` in the `.env` (or export it) |
| Turn off local memory only | put `JEV_ADVISOR_MEMORY=off` in the `.env` |
| Uninstall | `gjc plugin uninstall jev-advisor --user` |
| Purge all data | `rm -rf ~/.gjc/agent/jev-advisor` |

Notes:

- If an upgrade ever fails because its recorded source no longer exists (e.g. the checkout moved), uninstall and install again from the URL — both keep your data.
- Uninstall keeps, purge deletes. What lives where:

| Path | Contents | Survives uninstall | Survives upgrade |
| --- | --- | --- | --- |
| `~/.gjc/agent/gjc-plugins/jev-advisor/` | installed plugin code | no (removed) | no (replaced wholesale) |
| `~/.gjc/agent/jev-advisor/.env` | your key + config | yes | yes |
| `~/.gjc/agent/jev-advisor/state.json` | local evidence memory (bounded, `0600`) | yes | yes |

## Evidence memory & calibration

Once a provider is configured, the advisor keeps a bounded local record per delegation (`~/.gjc/agent/jev-advisor/state.json`, ≤ 200 assignments × 10 events, assignment heads capped at 120 chars). Pre-call advisories include the prior outcomes of the *identical* assignment; the status line shows `· n prior` when there are n. Ask for the predicted-vs-outcome statistics any time — offline, no key needed:

```
jev_advise report="calibration"
```

Turn the memory off with `JEV_ADVISOR_MEMORY=off`; store only fingerprints (no assignment text) with `JEV_ADVISOR_MEMORY_HEAD_CHARS=0`.

## Privacy & data flow

- **Nothing leaves the machine until a key exists** (or you select the local `ollaya` provider). A fresh install performs zero network calls and zero writes.
- Once configured, task assignment text (role, task ids/descriptions/assignments/tiers, shared context; capped) is transmitted to the configured provider on advisory calls. Default provider `jev` sends it to OpenRouter. Use `JEV_ADVISOR_PROVIDER=off` for sensitive material.
- The evidence memory never leaves the machine. It starts writing only once a provider is configured, stores bounded assignment heads (reducible to fingerprints only), never stores keys, and is file-mode `0600`.
- Egress is allowlisted in code: HTTPS `openrouter.ai` / `api.typesafe.ai` plus loopback HTTP for local servers; every other destination is refused before any request is sent. Attribution headers (`HTTP-Referer`, `X-Title`) go to OpenRouter only.

## Troubleshoot

| Symptom | Cause → fix |
| --- | --- |
| No advisories at all | Fresh install is inert until a key exists — see Configure. Or the 15 s per-surface rate limit is suppressing repeats; it counts per surface, not per session. |
| Advisories appear but nothing blocks | `shadow` is the default — status line only. `hint` notifies; `enforce` blocks only weaker-than-recommended tiers at confidence ≥ `JEV_ADVISOR_MIN_CONFIDENCE`. |
| `provider returned HTTP 401` | Bad or expired key — fix the `.env` entry. |
| `report="calibration"` says no data | Memory starts empty and only hooks feed it (manual `jev_advise` asks are not recorded); run a real `task` delegation first. |
| `state.json` looks corrupt | Delete it — the store auto-resets to empty and rebuilds from new events. |
| Upgrade fails on missing recorded source | Uninstall + install from the URL again (see Manage); `.env` and `state.json` survive. |

## Develop

From a local checkout, point the install at the plugin directory:

```sh
gjc plugin install "$(pwd)/jev-advisor" --user   # fresh install
gjc plugin upgrade jev-advisor --user            # after rebuilds
```

Architecture, configuration reference, and the offline test suite:
[jev-advisor/README.md](jev-advisor/README.md).

## Add a plugin

1. Create `<name>/gajae-plugin.json` (see jev-advisor for the shape).
2. Declare every runtime file the manifest references — the installer copies exactly the declared set, nothing else.
3. If the plugin generates surfaces, commit them keyless and never inline secrets at build time. Credentials belong in a user-owned file outside the installed tree; the installer replaces that tree on every upgrade.
4. Add a row to the table above.

Plugins are user-owned: gajae-code's upstream data-scope decisions (issue #5842) are unaffected — task text leaves the machine only when a provider and API key are explicitly configured.

## Workspace standard

The repo is onboarded to the workspace standard (`standard.json`, v1.0.1, profile `plugin-ts`, root `.`). Root `gjc-plugin.json` is a distribution index; each plugin's `gajae-plugin.json` remains the version source of truth.

- **Dashboard** (`dashboard/`) — a local operations view. Until its Supabase is connected (deferred — Addendum 1), it renders **local meta only**: the root package version and the latest git tag, read statically at build time. The envelope area states the disconnected status; there is no push-envelope.
- **Validator** — local-only: run `npm run validate` inside `dashboard/` (`node ../../workspace-standard/validator/cli.mjs validate --root ..`). It is not wired into `vercel-build` — the canonical `workspace-standard` repo does not exist on hosting build servers; the hosted build is `vercel-build` (`next build`) alone.
- **Manual workflow** (`steps.json`) — three human-executed steps: record (mac: bump version + tag at release), verify (server: validator green), review (human). Nothing runs on a timer.

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `DASHBOARD_TOKEN` are listed in `dashboard/.env.example` and intentionally left unset until the Supabase connection ships.

## Verification receipts

`verification_run` accepts 1–32 explicit repository-relative `.js`, `.mjs`, or `.cjs` test files and `timeoutMs` (default 30,000, maximum 120,000). Node 22+ is required. It uses a fixed native TestsStream reporter, not output-text heuristics or caller result imports. Counts are Node's native tests/suites/topLevel/passed/failed/skipped/todo/cancelled semantics, not unique leaf assertions or coverage. Empty, skipped/TODO-only, incomplete, cancelled, timed-out, and overflowed runs are not passes. Test code is **not sandboxed**: inspect and authorize its effects before execution. Arbitrary commands, flags, loaders and environment injection are unsupported.

`verification_status` requires `receiptId`, reads only this repository's stored receipt, and recomputes source freshness without rerunning tests. Historical execution and current freshness are separate. Fingerprints include HEAD, index entries, tracked/nonignored untracked bytes, deletions, modes and execution specification. Git/GJC state, dependencies, caches and recognized credential/private files are explicitly excluded; unsupported or over-limit inputs yield unavailable evidence. Bounds: 20,000 files / 128 MiB source, 1 MiB process output, 64 KiB frame, 10,000 native counts.

Receipts contain bounded metadata/digests only, stored outside installed code at `~/.gjc/agent/verification-receipts/receipts/v1/<repository-digest>/<receipt-id>.json` (0700 directories, 0600 immutable files, 200 receipts / 2 MiB per repository). Locks are never stolen and history is never auto-deleted. Failed persistence returns observed facts with `persisted:false`; later lookup is not promised. Local timestamps are descriptive, not authenticated event time.

Every run and status lookup automatically attempts adequacy assessment through **POST https://openrouter.ai/api/alpha/decisions**, model **typesafe/jev-1.13**; no separate user request or per-call opt-in is needed. This includes failed, empty, incomplete, unavailable and stale results, whose deterministic states are passed unchanged. The optional `assessment` object supplies caller-authored `changeSummary` and `expectedBehavior` (2,000 characters each) plus up to eight `caseNotes` (`id`, `note`, 300 characters); it is context, not an activation switch. Agents should include known non-sensitive context for meaningful coverage judgments. Without it, Jev still receives allowlisted facts and explicit `not_supplied` provenance, and the result remains `unknown` rather than pretending counts prove coverage. Nothing automatically mines logs, diffs, source, scenario text, snapshots, test names, paths, hashes, fill values, accounts or cookies. Detected secrets/oversized inputs are rejected, not truncated; detection cannot guarantee all personal-data removal. Existing env or `~/.gjc/agent/jev-advisor/.env` keys are read without changes. Missing keys, invalid context/facts, or the explicit operational kill switch `JEV_ADVISOR_PROVIDER=off` prevent transport and return an unavailable/invalid result, never a pass. Each call can incur provider usage and up to eight seconds of latency: one bounded request, no redirects/retries/fallbacks.

Jev judges coverage alignment and boundary adequacy only. Typed choices require type/choice; optional confidence/probabilities remain distinct and absent scores are unscored/unknown, not fabricated. Missing context returns `missing_context`; nonpassing, missing or stale evidence returns `insufficient_evidence` even if a model answers favorably. No rationale is requested or returned. Actual execution is never rewritten by provider results. At most three static next actions are warning-only: no completion/commit blocking or autonomous repair.

```sh
bun run build:verification
bun run test:verification
bun run build && bun run test  # unchanged advisor commands, then new suite
```

Generated standalone tools embed their runtime sources and need no installed sibling imports. Install each plugin directory independently with the normal GJC plugin installer. Builds are keyless and `bun verification-receipts/scripts/build.mjs --check` detects generated drift.

## UI regression

`ui_regression_run` requires explicit ephemeral `account` routing and a `scenario` with `id`, `expectedBehavior`, and 1–20 `steps`. The first step must be `goto`; at least one assertion is mandatory. Each step is a closed object:

```json
{"id":"local-ready","expectedBehavior":"The fixture displays Ready.","steps":[
  {"action":"goto","url":"http://127.0.0.1:3000/"},
  {"action":"fill","selector":"#message","value":"fixture message"},
  {"action":"click","selector":"#apply"},
  {"action":"assert","selector":"#result","kind":"text","match":"substring","expected":"fixture message"},
  {"action":"assert","selector":"#heading","kind":"visible"}
]}
```

Only one exact loopback origin is allowed; no credentials, query/hash data, sensitive routes, file/data/javascript URLs or arbitrary scripts. Selectors are current CSS, bounded to 256 characters; stale snapshot refs, missing/ambiguous/hidden targets fail. Only explicit `type="button"` buttons and non-sensitive text fields are supported; fill values are bounded to 1,000 characters. Inspect action handlers before authorizing a scenario. Local origin/control checks do not sandbox redirects or network side effects. The fixed interpreter opens a new owned tab, reads a full initial snapshot and fresh scoped observations, checks origin after navigation-capable actions, asserts literal text, and closes only that owned tab in `finally`. No user tab attachment, unrelated cleanup, screenshots, baseline images, or automatic repairs.

Text assertions use `match:"exact"` equality or `"substring"` literal inclusion; only line endings and surrounding whitespace normalize, preserving case/internal whitespace. One complete scenario runs in one shell-free `aside repl` invocation with default total timeout 60 seconds and maximum 90 seconds (below Aside's 120); per-step waits are at most five seconds. Native exit and nonce-scoped ordered observations determine facts, not caller booleans or imported scripts. Timeout, cancellation, partial/malformed output, caps and uncertain cleanup cannot pass. Raw snapshots, errors, fill values and account routing remain local ephemeral memory, never returned or stored in receipts.

`ui_regression_status` requires `receiptId`; it recomputes source freshness without opening a browser. `currentUiState:"not_reobserved"` and `browserBuildBinding:"unverified"` explicitly distinguish historical assertions from current/deployed UI. Both UI tools automatically attempt Jev assessment using the same bounded source embedded at build time; ui-regression installs independently without verification-receipts present. Assessment case-note IDs are `run` for Node execution or `step-N` for observed UI assertion indices; unknown IDs are rejected. Scored results below 0.8 confidence or selected probability remain uncertain guidance, never execution gates.

```sh
bun run build:ui && bun run test:ui
node verification-receipts/scripts/smoke-host.mjs # installed GJC, temporary isolated HOME/agent root, local mock only
node verification-receipts/scripts/smoke-host.mjs --installed # test a private copy of the user-installed verification bundle
UI_REGRESSION_ACCOUNT=<explicit-routing> node verification-receipts/scripts/smoke-host.mjs --installed --ui
UI_REGRESSION_ACCOUNT=<explicit-routing> bun ui-regression/scripts/smoke-aside.ts # inspected loopback fixture pass and mismatch
```

The installed-host smoke uses a temporary isolated plugin root and synthetic loopback provider, not a global runtime configuration or production credential. `--installed` reads the user-installed bundle and installs a private copy for the test; it never points a test session at the live user agent root. Before each child starts, the harness rejects escaped HOME/agent paths, inherited configuration overrides, real credentials and non-loopback provider URLs. It also checks that the user's configuration bytes remain unchanged, including on failure. The synthetic model selector is test-only: neither plugin sets GJC's default model. The current GJC session model consumes tool results; automatic adequacy assessment alone uses Jev. Offline smoke checks explicitly disable Jev transport and assert that each result reports `assessment.reason:"off"`; unit tests use mock transports to verify automatic calls. Node v24.15.0, installed GJC 0.18.5 and Aside 1.26.906.1630 are the local probe baseline; the actual browser smoke is separate from offline tests. Read current `aside guide repl` and `aside skills list` before browser work. External/sensitive targets, other test runners and deployment identity remain unsupported, not implied by receipts.

UI allowlisted host facts sent for automatic assessment include observed assertion IDs, kinds (`visible`, `text_exact`, `text_substring`) and outcomes, distinct from caller-authored semantic notes. Receipts retain bounded step action/outcome labels and assertion metadata; their array lengths are actual observed step/assertion counts. They contain no observed DOM text or expected/fill values. Missing/partial/non-pass/stale evidence retains deterministic warning guidance regardless of Jev's answer.

## Related

- [gajae-code](https://github.com/Yeachan-Heo/gajae-code) — the coding agent these plugins extend
