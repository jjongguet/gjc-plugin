# jev-advisor

[GJC](https://github.com/Yeachan-Heo/gajae-code) plugin for task-level
`fast` / `balanced` / `strong` delegation advice and local execution metadata.
Advice is not model selection, process completion is not accepted code quality,
and confidence is not a probability of task success.

## Behavior

- **Before `task`:** ask separately for each eligible child. Normalize at most
  32 entries; dispatch at most four sequential requests within an eight-second
  batch budget. Later or invalid entries receive explicit no-decision reasons.
  Each prompt contains that child's role, description, assignment and shared
  context, without requested tiers, invocation IDs or previous results.
- **After `task`:** observe a launch receipt, not a completed delegation.
- **After `subagent`:** observe structured `completed`, `failed` or `cancelled`
  snapshots. Running, paused, queued, missing and unknown states are not terminal.
  Result hooks never call a provider, re-tier, or rewrite a tool result.
- **`jev_advise`:** explicitly request advice for one assignment/role, or use
  `report="calibration"` for an offline descriptive report. Manual advice does
  not create a delegation record.

`shadow` is the source default; `hint` adds a non-blocking notification.
`enforce` can block a whole task call only when an individual complete task has
an explicit requested tier weaker than its own recommendation and its confidence
meets the configured gate. Unknown, invalid, oversized or unavailable advice
cannot justify blocking. Neither mode rewrites input or chooses an actual model.
No routing settings are enabled by this plugin.

One pre-hook invocation reserves the cooldown before dispatch, including failed
requests. Cached complete advice is still evaluated for enforcement; a genuinely
rate-limited task has no new recommendation and fails open. Manual requests are
independent of this hook cooldown. Storage/provider errors fail open and are
reported as unavailable/no-decision, not successful observations.

## Complete inputs and provider responses

Complete encoded prompts are bounded to **4,000 characters** for hosted Jev,
TypeSafe Jev and chat, and **1,900** for Ollaya's local constraint. These are plugin
admission budgets, not claims about maximum hosted model context. Inputs above
the applicable bound are rejected without a request; shared context is never
silently sliced away. Full semantic input is fingerprinted independently of
invocation IDs, requested tier and task order; fingerprints never join executions.

Confidence must be a finite number in `[0,1]`; missing, coerced or out-of-range
values are rejected. A supplied probability distribution must contain exactly the
three tiers, finite probabilities in `[0,1]`, and sum to one within `0.001`.
Validated distributions are retained unchanged; missing ones are not invented.
Chat requires final content, not a reasoning-only fallback. Provider errors,
invalid/partial responses, response overflow, timeout and cancellation yield
explicit no-decision. There are no retries or automatic provider fallbacks.

Systemone choice confidence and chat self-reported confidence have different
semantics. Neither is independent correctness evidence. Validate any enforcement
policy independently; a confidence threshold alone does not establish safety.

## Providers

| Provider | Endpoint | Default model | Key |
| --- | --- | --- | --- |
| `jev` | OpenRouter `/api/alpha/decisions` | `typesafe/jev-1.13` | OpenRouter |
| `openrouter` | OpenRouter `/api/v1/chat/completions` | `openai/gpt-5-mini` | OpenRouter |
| `typesafe-jev` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | TypeSafe |
| `ollaya` | `http://127.0.0.1:11435/v1/systemone` | `laya` | none |

Jev uses `state` plus typed `questions`, not chat completions. Provider/model
selection remains explicit. Egress permits only HTTPS `openrouter.ai` and
`api.typesafe.ai`, or loopback HTTP; redirects are rejected. OpenRouter alone
receives attribution headers (`HTTP-Referer` and `X-Title`).

## Configuration

Configuration lives outside the replaceable installation tree in
`~/.gjc/agent/jev-advisor/.env`. Process environment overrides same-named file
values; the merged `JEV_ADVISOR_API_KEY` takes priority over `OPENROUTER_API_KEY`.
No key and no keyless provider means zero hook network calls or state writes.
`JEV_ADVISOR_PROVIDER=off` disables hooks; an explicit offline report still works.

```sh
mkdir -p ~/.gjc/agent/jev-advisor
printf 'OPENROUTER_API_KEY=sk-or-v1-...\n' >> ~/.gjc/agent/jev-advisor/.env
chmod 600 ~/.gjc/agent/jev-advisor/.env
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEV_ADVISOR_PROVIDER` | `jev` | `jev`, `openrouter`, `typesafe-jev`, `ollaya`, `off` |
| `JEV_ADVISOR_MODEL` | per provider | Advisor model, not delegated execution model |
| `JEV_ADVISOR_MODE` | `shadow` | `shadow`, `hint`, `enforce` |
| `JEV_ADVISOR_MIN_CONFIDENCE` | `0.6` | Per-task enforcement confidence gate |
| `JEV_ADVISOR_TIMEOUT_MS` | `8000` | Per-request timeout, also bounded by remaining hook budget |
| `JEV_ADVISOR_MIN_INTERVAL_MS` | `15000` | Pre-hook batch cooldown; zero disables cooldown |
| `JEV_ADVISOR_ENDPOINT` | per provider | Override subject to egress restrictions |
| `JEV_ADVISOR_MEMORY` | `on` | `off` disables hook store access/writes |
| `JEV_ADVISOR_STATE` | `~/.gjc/agent/jev-advisor/state.json` | Legacy base path; v2 sibling is derived without accessing the base |
| `JEV_ADVISOR_MEMORY_MAX_KEYS` | `200` | Retained semantic groups, hard ceiling 200 |
| `JEV_ADVISOR_MEMORY_MAX_EVENTS` | `10` | Task records per group, hard ceiling 10 |

`JEV_ADVISOR_MEMORY_HEAD_CHARS` is no longer used: v2 stores no assignment heads.
Existing configuration and legacy memory are not changed or migrated.

## Private versioned evidence

The default store is `~/.gjc/agent/jev-advisor/state.v2.json`. For a custom base
`/x/my.json` the new path is `/x/my.v2.json`; `/x/custom` becomes `/x/custom.v2`.
The base file is never read, rewritten or silently converted. Existing v1 data
remains untouched and is not counted as verified v2 evidence.

- Task records use exact `(sessionId, toolCallId, taskIndex)` identity. Terminal
  records use `(sessionId, jobId)`; a resumed job is a different execution.
- Only a valid **original singleton** task launch with an explicit job ID and no
  scheduling failures can join to a terminal observation. A batch with one valid
  child after filtering is still a batch. Multi-child mappings are not inferred
  from text, caller IDs, array positions or fingerprints.
- Repeated inspect/list/await observations enrich one retained job, including
  terminal-before-launch delivery. Missing correlation stays unjoined. Missing
  session/job identity cannot be counted as a distinct retained execution.
- Requested tier, advisor recommendation, requested model, observed effective
  model and terminal status remain separate. Actual tier and independent quality
  remain unknown. Contradictory observations are flagged, not overwritten into a
  success story. Conflicted measurements are excluded from their aggregates.
- The store contains bounded metadata, fingerprints and validated advice, not
  assignment/context/result prose, rationale, provider payloads or credentials.
  Retention and eviction limit deduplication to the retained window.

Updates acquire a private exclusive lock, load the latest state, synchronously
mutate it and atomically rename a unique `0600` temporary file. No network await
holds a transaction or a stale state snapshot. Lock waiting is bounded to 100 ms;
foreign or abandoned locks are never stolen. Corrupt, unsupported, oversized or
unsafe stores remain unavailable rather than being reset. Recovery requires an
explicit operator decision; do not delete memory just to silence an error.

The job table is bounded by the effective task budget (at most 2,000 jobs), and
the serialized store by 2 MiB. Zero retention keeps no records. New plugin-owned
directories use `0700`; unrelated existing parents are not chmodded. Memory off,
store failure, missing identity and eviction limit persistent replay suppression.

## Offline report

```text
jev_advise report="calibration"
```

The existing parameter is retained, but output is **descriptive retained-window
coverage**, not an accuracy or savings benchmark. It separates advice/no-decision,
launch visibility, blocked calls, exact joins, unjoined terminals, conflicts,
process statuses and observed/unknown effective model coverage. It reports
requested-vs-recommended agreement only for individual records with both values.
Agreement is not correctness or evidence that a recommended model actually ran.

Duration means use only positive, nonconflicted observed durations: a 12-second
job plus an unknown-duration job has a 12-second mean over one measured job.
All-missing means unknown, not zero. Unobserved terminals and missing-identity
observations are outside report coverage. No automatic NEXT recommendation,
prior-outcome prompt injection, accepted-quality or cost-saving claim is made.

## Architecture and verification

```text
lib/decision.ts             Config, task inputs, providers, v2 transactions/report
src/hook.adapter.ts         Per-task pre-call advice and optional enforcement
src/result.adapter.ts       Provider-free task/subagent receipt observer
src/tool.adapter.ts         Explicit advice and offline report
scripts/build.mjs           Keyless concatenation of core and adapters
hooks/jev-advisor.ts         Generated pre-call surface
hooks/jev-advisor-result.ts  Generated result surface, two manifest targets
tools/jev-advise.ts          Generated explicit-tool surface
```

Installed surfaces are self-contained because the installer copies only
manifest-declared files. Edit core/adapters, never generated outputs by hand.
The surfaces share disk transactions, not an in-memory evidence cache.

```sh
bun scripts/build.mjs
bun scripts/verify.ts
```

The verifier starts an isolated child with fresh HOME/environment/cwd before
product imports. It uses synthetic credentials, temporary state and scripted
in-memory fetch only: no real provider, local-model server or user memory.
It exercises actual generated adapters, strict parsing, mixed/oversized tasks,
throttle/enforce boundaries, terminal identity/replays/conflicts, concurrent
writes, legacy preservation, unavailable stores and report denominators. It
compares all three generated files byte-for-byte against the unchanged builder
run in a temporary fixture, including a deliberately stale candidate.

These checks establish local package behavior, not installed-host dispatch,
real-provider conformance or actual task efficacy. The manifest declares legacy
before-task and after-task/after-subagent hooks. Public host source exposes scoped
session identity and structured terminal snapshots; unavailable runtime fields
remain unknown. The plugin does not scrape private histories or install itself.

## Install

See the [repository README](../README.md#install). Installation and activation are
separate operator actions, not part of building or offline verification:

```sh
gjc plugin install "$(pwd)" --user     # from jev-advisor/, fresh install
gjc plugin upgrade jev-advisor --user
gjc plugin list && gjc plugin doctor
```

Health labels alone do not prove terminal observation coverage or model routing.
