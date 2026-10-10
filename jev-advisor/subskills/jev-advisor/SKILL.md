---
name: jev-advisor
description: Opt-in delegation-effort advisories for subagent tasks via a remote decision model (OpenRouter or Typesafe Jev). Use when deciding which model tier a task delegation warrants or when the user asks for a Jev/Kev-style opinion on delegation.
---

# jev-advisor

Advisory only by default. The plugin has two surfaces:

1. **Automatic hook** (`task` tool, before phase): when a provider and API key are
   configured, every `task` call gets a tier recommendation (`fast` / `balanced` /
   `strong`) from the decision model.
   - Every batch with a non-empty summary draws one keyed widget (`jev-advisor`)
     listing its advisories. The widget is batch-scoped and event-driven: cleared
     when the call ends (sync/error/abort/block) or when the batch's observed
     children reach terminal closure; replaced by the next batch; disposed by
     `/new`, `/drop`, fork/session switch, or restart (`/clear` keeps the session
     id and the widget). Lifecycle state is in-process only.
   - `JEV_ADVISOR_MODE=shadow` (default): draws the widget, never notifies or blocks.
   - `JEV_ADVISOR_MODE=hint`: adds one bounded single-line notification (multi-line
     payloads are never emitted: a printed chat entry cannot be removed).
   - `JEV_ADVISOR_MODE=enforce`: blocks the task call only when the caller requested
     a WEAKER tier than recommended AND confidence >= `JEV_ADVISOR_MIN_CONFIDENCE`
     (default 0.6); unspecified tiers and low-confidence advice never block —
     the caller can re-issue with the recommended tier.
2. **`jev_advise` tool**: explicit ask. Pass `assignment` (the task text) and optionally
   `role`; returns validated advice and separate `journalStorage`. Or pass `report="calibration"`
   for descriptive retained correlation coverage (offline, no key needed).
   Manual advice and reports append sanitized operational outcomes, but only
   real delegation observations feed correlation state. Confidence is not quality.

Evidence memory: once a provider is configured, each delegation's fingerprint and
terminal outcome are stored locally (`~/.gjc-plugin/jev-advisor/state.v2.json` —
metadata and fingerprints only, bounded, never leaves the machine; the legacy v1
`state.json` is preserved but is not migrated or read as v2 evidence). Prior
outcomes are never injected into advisories and no `prior` suffix exists in v2.

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEV_ADVISOR_PROVIDER` | `jev` | `jev` = TypeSafe Jev on OpenRouter via `/api/alpha/decisions`; `openrouter` = chat; `typesafe-jev` = hosted systemone; `ollaya` = keyless local server; `off` disables provider/correlation, not local journaling |
| `JEV_ADVISOR_API_KEY` | — | Environment overrides same-named file values in `~/.gjc/agent/jev-advisor/.env`; the merged plugin key takes priority over `OPENROUTER_API_KEY`. Credentials survive upgrades and are never result records |
| `JEV_ADVISOR_MODEL` | per provider (`typesafe/jev-1.13`; `openai/gpt-5-mini` for openrouter chat; `laya` for ollaya) | decision model id |
| `JEV_ADVISOR_MODE` | `shadow` | `shadow` / `hint` / `enforce` |
| `JEV_ADVISOR_MIN_CONFIDENCE` | `0.6` | per-task confidence threshold for explicit weaker-tier enforcement |
| `JEV_ADVISOR_TIMEOUT_MS` | `8000` | decision request timeout |
| `JEV_ADVISOR_MIN_INTERVAL_MS` | `15000` | rate limit between advisory calls |
| `JEV_ADVISOR_ENDPOINT` | per provider | override endpoint (code-enforced allowlist: HTTPS origins `openrouter.ai`, `api.typesafe.ai`, plus loopback HTTP for local servers; everything else is refused, no request leaves the machine) |
| `JEV_ADVISOR_MEMORY` | `on` | disables correlation-state writes, not sanitized outcome journaling; previous outcomes are never injected |

`JEV_ADVISOR_STATE` is retired and ignored with `state_override_ignored`;
results always use `~/.gjc-plugin`. `JEV_ADVISOR_MEMORY_HEAD_CHARS` is unused.
Existing `.gjc` results are preserved without migration or lookup. Credential
and installed-code paths remain GJC-managed and unchanged.

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
- With no key/keyless provider, there are zero network calls or correlation
  writes. Local outcome journaling still records unavailable/disabled operations
  under `~/.gjc-plugin/jev-advisor/journal/v1/`. It excludes assignment/rationale
  prose, keys and raw results; records are bounded to 4 KiB, segments to 1 MiB
  and eight retained segments. Inspect `journalStorage`: failed persistence is
  not durable evidence. Unsafe/corrupt storage is not automatically repaired.
