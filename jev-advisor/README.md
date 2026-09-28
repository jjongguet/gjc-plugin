# jev-advisor

GJC ([gajae-code](https://github.com/Yeachan-Heo/gajae-code)) plugin: decision-model advisories for subagent `task`
delegation — the Kev/Jev idea from gajae-code#5842, re-implemented as a
user-owned plugin so the upstream data-scope decision stays untouched.

- **Hook** (`tool_call` / `task` / before): asks a decision model for a
  `fast|balanced|strong` tier recommendation on every task call.
  `shadow` (default) → status line; `hint` → non-blocking notify;
  `enforce` → blocks only when a task requested a WEAKER tier than
  recommended and the confidence clears `JEV_ADVISOR_MIN_CONFIDENCE`.
  The question carries the prior outcomes of the *identical* assignment
  from the local evidence memory (see below) — recommendations are
  grounded in observed evidence, and the status line shows `· n prior`
  when the assignment has n recorded outcomes.
- **Hook** (`tool_result` / `task` / after): outcome review — feeds the
  completed delegation's assignment plus its outcome (statuses, durations,
  error flag, result head) to the same decision model and surfaces a re-tier
  recommendation for the next identical delegation. Observe-only: it never
  rewrites the tool result, and there is nothing to block post-hoc. The
  outcome (error flag, total subagent time, re-tier advice) is recorded to
  the evidence memory regardless of the rate limit.
- **Tool** `jev_advise`: explicit ask for an assignment/role pair — or
  `report="calibration"` for the local predicted-vs-outcome statistics
  (offline, works unconfigured; manual asks are not recorded).

Fail-open by construction: the hook swallows every error and returns
`undefined`, so it can never break delegation (gjc treats hook errors as
fail-closed). Unconfigured, it performs zero network calls and zero writes
(state writes begin only once a provider is configured); force it inert any
time with `JEV_ADVISOR_PROVIDER=off`.

The hook is a **legacy plugin hook** (no `capabilities` declared — gjc v0.18.0
refuses to execute function hooks in the host realm: they require an isolate
runtime the host does not provide). Network egress is restricted in code:
`isAllowedEndpoint` only allows `https://openrouter.ai` and
`https://api.typesafe.ai`, plus loopback HTTP for local servers — for hook
AND tool alike.

## Architecture

```
lib/decision.ts        single source of truth: config parsing, PROVIDERS registry,
                       REQUEST_STYLES (wire formats), decision parsing, summary format,
                       evidence memory (fingerprint, bounded store, calibration math)
src/hook.adapter.ts    hook adapter: legacy host-realm hook (api.on tool_call) + fail-open wrapper
src/tool.adapter.ts    tool adapter: typebox parameters + global fetch injection
src/result.adapter.ts  outcome-review adapter (api.on tool_result) — observe-only re-tier
scripts/build.mjs      inlines the four files above into the surface files
hooks/jev-advisor.ts   generated surface (do not edit by hand)
tools/jev-advise.ts    generated surface (do not edit by hand)
hooks/jev-advisor-result.ts  generated surface (do not edit by hand)
```
The evidence memory persists to `~/.gjc/agent/jev-advisor/state.json` —
outside the installed tree, so it survives upgrades. There is deliberately
**no module-level mutable state** in the core or adapters: each generated
surface inlines its own copy of the core, so the disk store is the only
channel shared by the two hooks and the tool (atomic unique-tmp rename,
mode `0600`, last-writer-wins across surfaces).

**Why generated surfaces:** the gjc installer copies only manifest-declared
files (`compiler.ts` builds `files` from the manifest; `installer.ts` copies
exactly that set — undeclared files are never copied). A shared `lib/` module
therefore cannot be imported at runtime from an installed surface. The build
inlines the core into each surface instead, so the repo stays DRY while every
installed file is self-contained.

**To change anything:** edit `lib/decision.ts` or `src/*.adapter.ts`, run
`bun scripts/build.mjs` (keyless — always), and commit the regenerated
surfaces; `gjc plugin upgrade jev-advisor --user` picks them up. There is no
owner-specific build: keys live in `~/.gjc/agent/jev-advisor/.env` for
everyone.

## Providers

| Provider | Endpoint | Model (default) | Key |
| --- | --- | --- | --- |
| `jev` (default) | OpenRouter `/api/alpha/decisions` | `typesafe/jev-1.13` | OpenRouter key |
| `openrouter` | OpenRouter `/api/v1/chat/completions` | `openai/gpt-5-mini` | OpenRouter key |
| `typesafe-jev` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | TypeSafe key |
| `ollaya` | local `127.0.0.1:11435/v1/systemone` | `laya` | none |

Notes:

- `jev` — TypeSafe Jev served on OpenRouter via the decisions API: decision
  models are rejected by `chat/completions` with HTTP 400, while the decisions
  API speaks the same `state` + typed `questions` wire as the systemone style.
  ~$0.042/M input tokens, $0/M output — roughly $0.000015 per advisory.
- `openrouter` — generic chat fallback. The `openai-chat` style budgets
  `max_tokens: 1024` and falls back to parsing `message.reasoning` when
  `content` comes back null (reasoning models).
- `typesafe-jev` / `ollaya` — the TypeSafe `systemone` wire format
  (`state` + typed `questions`). A local server is the zero-cost, private
  path (`ollaya run laya`).
- OpenRouter-bound calls carry `HTTP-Referer`/`X-Title` so advisories show up
  under a `jev-advisor` app on the OpenRouter dashboard instead of the
  anonymous "Unknown" bucket; other targets never receive these headers.

## Configuration

**Default state: inert until a key exists.** A fresh install makes zero
network calls and zero writes; local state writes begin only once a provider
is configured. To force it off entirely, set `JEV_ADVISOR_PROVIDER=off`.

There is exactly one key registration channel — the file
`~/.gjc/agent/jev-advisor/.env` (KEY=VALUE lines). It lives outside the
installed tree because the installer replaces that tree wholesale on every
install/upgrade:

```sh
mkdir -p ~/.gjc/agent/jev-advisor
printf 'OPENROUTER_API_KEY=sk-or-v1-...\n' >> ~/.gjc/agent/jev-advisor/.env
chmod 600 ~/.gjc/agent/jev-advisor/.env
```

Key resolution precedence: `JEV_ADVISOR_API_KEY` (env) → `OPENROUTER_API_KEY`
(env; the same variable gjc itself reads) → the same two in the `.env` file →
empty (inert).

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEV_ADVISOR_PROVIDER` | `jev` | `jev` \| `openrouter` \| `typesafe-jev` \| `ollaya` \| `off` |
| `JEV_ADVISOR_MODEL` | per provider | decision model id |
| `JEV_ADVISOR_MODE` | `shadow` | `shadow` \| `hint` \| `enforce` |
| `JEV_ADVISOR_MIN_CONFIDENCE` | `0.6` | enforce deny threshold |
| `JEV_ADVISOR_TIMEOUT_MS` | `8000` | decision request timeout |
| `JEV_ADVISOR_MIN_INTERVAL_MS` | `15000` | rate limit between advisory calls |
| `JEV_ADVISOR_ENDPOINT` | per provider | endpoint override (subject to the egress allowlist) |
| `JEV_ADVISOR_MEMORY` | `on` | evidence-memory kill switch (`off` stops all local recording and evidence injection) |
| `JEV_ADVISOR_STATE` | `~/.gjc/agent/jev-advisor/state.json` | store path override (also the test-isolation channel) |
| `JEV_ADVISOR_MEMORY_MAX_KEYS` | `200` | max tracked assignments (oldest `updatedAt` evicted) |
| `JEV_ADVISOR_MEMORY_MAX_EVENTS` | `10` | events kept per assignment (ring) |
| `JEV_ADVISOR_MEMORY_HEAD_CHARS` | `120` | assignment-head chars stored locally; `0` → fingerprints only |

Do not enable `enforce` until the thresholds are validated on your own data
(the `0.6` gate compares chat-model self-reported confidence and systemone
normalized confidence on different scales — recalibrate when switching
providers). Task assignment text is transmitted to the configured remote
provider whenever a key is registered; use `off` or the keyless local
`ollaya` provider for sensitive material.

## Evidence memory

Once a provider is configured, every `task` delegation is fingerprinted
(sha256 of the whitespace-collapsed assignment text, first 16 hex chars) and
remembered in `~/.gjc/agent/jev-advisor/state.json`:

- **Pre-call hook** records a `pre` event (requested tiers, recommendation
  once the provider answers) *before* the rate-limit gate, and injects a
  bounded evidence block (`prior outcomes (n=…): [fast→ok 12s, …] last
  re-tier: …`, ≤ 200 chars) ahead of the assignment so the decision model
  recommends from observed outcomes of the identical assignment. The status
  line gains a `· n prior` suffix when there is history.
- **Post-call hook** records a `post` event (error flag, total subagent
  time, re-tier advice) regardless of the rate limit, and pairs it with the
  latest unjoined recommendation-bearing `pre` of the same fingerprint.
- Bounds: 200 assignments × 10 events (≤ a few hundred KB), assignment
  heads capped at 120 chars (or fingerprints-only with
  `JEV_ADVISOR_MEMORY_HEAD_CHARS=0`), atomic `0600` writes, deterministic
  eviction. Kill switch: `JEV_ADVISOR_MEMORY=off`.
- The store never leaves the machine and manual `jev_advise` asks are not
  recorded — only real delegations feed it.

## Calibration report

```
jev_advise report="calibration"
```

Renders the accumulated predicted-vs-outcome statistics from the local
store: matched pairs, requested-vs-recommended agreement rate, error rate
and mean total subagent time per recommended tier, re-tier distribution,
and totals-only counts (unmatched outcomes, advisory calls without a
recommendation). Pure local read — works unconfigured and with
`JEV_ADVISOR_PROVIDER=off`; it is how you check whether the advisor's
recommendations are actually any good before trusting `enforce`.

## Verification

Offline suite — no network, no API spend (egress gate, config precedence,
both wire formats against a mock server, payload extraction, evidence-memory
store/eviction/join/calibration math, adapter harness over the concatenated
surfaces, generated-file tripwires):

```sh
cd jev-advisor && bun scripts/verify.ts   # expects: ALL PASS
gjc plugin list && gjc plugin doctor      # installed-surface health
```

## Install

See the [repository README](../README.md#install) for the one-command GitHub
install and key registration. Local development:

```sh
gjc plugin install "$(pwd)" --user     # from inside jev-advisor/
gjc plugin upgrade jev-advisor --user  # after rebuilds
```

## Extension points

| Want to… | Do this |
| --- | --- |
| Add a provider (e.g. a local server) | one `PROVIDERS` entry in `lib/decision.ts` — `openai-chat` or `systemone` style; loopback HTTP endpoints pass the egress gate, remote ones must be HTTPS |
| Add a non-OpenAI wire format | one `REQUEST_STYLES` entry, reference it from the provider |
| Add a tunable | `DEFAULTS` + `readConfig()` — config parsing exists in exactly one place |
| Change advisory wording / deny guidance | `formatSummary` / `ENFORCE_GUIDANCE` |
| Change tiers | `TIERS` (note: this changes the contract vocabulary gjc's task tool understands) |

Deliberately NOT built (no current requirement): gjc plugin settings-schema
plumbing (env config serves both hook and tool with one parser), multi-model
ensembles, local Kev supervisor (upstream owns that design), and a fix-mode
that rewrites the requested tier in place — the latter rides an undocumented
input-mutation channel and waits until the calibration report shows a
persistent requested-vs-recommended mismatch worth acting on.

## Platform constraints (gjc 0.18.0)

- Installer copies manifest-declared files only → shared code must be inlined (see Architecture).
- Hook `networkDestinations` must be full HTTPS origins — bare hostnames are rejected.
- `subskills` surface requires frontmatter `binds_to`/`phase`/`activation_arg`
  (it extends the four workflow skills / four role agents; not usable for a
  standalone advisor doc, so usage policy lives in this README and the tool
  description instead).
