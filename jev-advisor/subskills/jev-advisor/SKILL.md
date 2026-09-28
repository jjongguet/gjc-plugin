---
name: jev-advisor
description: Opt-in delegation-effort advisories for subagent tasks via a remote decision model (OpenRouter or Typesafe Jev). Use when deciding which model tier a task delegation warrants or when the user asks for a Jev/Kev-style opinion on delegation.
---

# jev-advisor

Advisory only by default. The plugin has two surfaces:

1. **Automatic hook** (`task` tool, before phase): when a provider and API key are
   configured, every `task` call gets a tier recommendation (`fast` / `balanced` /
   `strong`) from the decision model.
   - `JEV_ADVISOR_MODE=shadow` (default): status line only, never blocks.
   - `JEV_ADVISOR_MODE=hint`: surfaces a non-blocking notification with the recommendation.
   - `JEV_ADVISOR_MODE=enforce`: blocks the task call only when the caller requested
     a WEAKER tier than recommended AND confidence >= `JEV_ADVISOR_MIN_CONFIDENCE`
     (default 0.6); unspecified tiers and low-confidence advice never block —
     the caller can re-issue with the recommended tier.
2. **`jev_advise` tool**: explicit ask. Pass `assignment` (the task text) and optionally
   `role`; returns `{tier, confidence, rationale}` JSON. Or pass `report="calibration"`
   for the local predicted-vs-outcome statistics (offline, no key needed; manual asks
   are not recorded — only real delegations feed the evidence memory).

Evidence memory: once a provider is configured, each delegation's fingerprint and
outcome are stored locally (`~/.gjc/agent/jev-advisor/state.json`, bounded, never
leaves the machine), pre-call advisories carry the prior outcomes of the identical
assignment, and the advisor's status/widget line shows a `· n prior` suffix — it
means the identical assignment has n prior recorded outcomes.

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEV_ADVISOR_PROVIDER` | `jev` | `jev` = TypeSafe Jev on OpenRouter via `/api/alpha/decisions` (default; model `typesafe/jev-1.13`); `openrouter` = generic chat model via chat/completions; `typesafe-jev` = TypeSafe hosted systemone; `ollaya` = local server `127.0.0.1:11435` (no key, `laya`); `off` = inert |
| `JEV_ADVISOR_API_KEY` | — | key resolution, single channel: `JEV_ADVISOR_API_KEY` (env) → `OPENROUTER_API_KEY` (env; same var gjc uses for its OpenRouter provider) → the same two in `~/.gjc/agent/jev-advisor/.env` → inert. The `.env` file survives upgrades (the installed tree does not) |
| `JEV_ADVISOR_MODEL` | per provider (`typesafe/jev-1.13`; `openai/gpt-5-mini` for openrouter chat; `laya` for ollaya) | decision model id |
| `JEV_ADVISOR_MODE` | `shadow` | `shadow` / `hint` / `enforce` |
| `JEV_ADVISOR_MIN_CONFIDENCE` | `0.6` | enforce gate; `0` disables tier-gating |
| `JEV_ADVISOR_TIMEOUT_MS` | `8000` | decision request timeout |
| `JEV_ADVISOR_MIN_INTERVAL_MS` | `15000` | rate limit between advisory calls |
| `JEV_ADVISOR_ENDPOINT` | per provider | override endpoint (code-enforced allowlist: HTTPS origins `openrouter.ai`, `api.typesafe.ai`, plus loopback HTTP for local servers; everything else is refused, no request leaves the machine) |
| `JEV_ADVISOR_MEMORY` | `on` | evidence-memory kill switch (`off` = no local recording, no evidence injection) |
| `JEV_ADVISOR_STATE` | `~/.gjc/agent/jev-advisor/state.json` | store path override |
| `JEV_ADVISOR_MEMORY_HEAD_CHARS` | `120` | assignment-head chars stored locally; `0` → fingerprints only |

## Usage policy

- Do not enable `enforce` mode until the tier thresholds have been validated on
  your own data (mirrors the gajae-code#5842 owner decision: no borrowed
  defaults; note the `0.6` gate compares chat-model self-reported confidence
  and systemone normalized confidence on different scales — recalibrate when
  switching providers).
- Task assignment text (role, task ids/descriptions/assignments/tiers, shared
  context; capped) is transmitted to the configured remote provider whenever a
  key is registered via `JEV_ADVISOR_API_KEY`/`OPENROUTER_API_KEY` (env or
  `~/.gjc/agent/jev-advisor/.env`). Default provider `jev` sends it to
  OpenRouter. Set `JEV_ADVISOR_PROVIDER=off` for sensitive material, or use
  the keyless local `ollaya` provider.
- With no key registered (fresh install, no env vars, no
  `~/.gjc/agent/jev-advisor/.env`) the plugin performs zero network calls and
  zero writes. Local evidence-memory writes begin only once a provider is
  configured; the store never leaves the machine and is bounded (see
  Evidence memory above).
