# gjc-plugin

Plugins for [gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`).
Each subdirectory carrying a `gajae-plugin.json` is an independently installable plugin.

| Plugin | Purpose |
| --- | --- |
| [`jev-advisor`](jev-advisor/) | Bounded per-child `fast` / `balanced` / `strong` advice via Jev, chat or a local server, with exact-or-unjoined terminal metadata and an offline coverage report. Completion and recommendation agreement are not task-quality evidence. Shadow by default. |

## Install

Requires [gajae-code](https://github.com/Yeachan-Heo/gajae-code) **≥ 0.18.0** (legacy hook contract) and `git` on PATH — URL installs clone through it.

Terminal coverage additionally depends on structured `subagent` result snapshots
and public session identity. Offline package checks do not establish installed-host
dispatch; absent identity remains unknown rather than being inferred.

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
| `~/.gjc/agent/jev-advisor/state.json` | legacy memory, preserved and not migrated | yes | yes |
| `~/.gjc/agent/jev-advisor/state.v2.json` | bounded metadata-only evidence, `0600` | yes | yes |

## Evidence memory & calibration

Advice is task-scoped: at most four sequential requests share an eight-second
hook budget, with explicit no-decision for invalid, oversized or unadmitted tasks.
Complete prompt limits are 4,000 characters for hosted Jev/TypeSafe/chat and 1,900
for Ollaya; no shared context is silently truncated.

The separate v2 store preserves old memory. It records requested/recommended
tiers separately from observed terminal status and optional effective model.
Only exact scoped singleton launch/job mappings join; batch terminals remain
unjoined. Repeated observations are deduplicated within bounded retention.
Running launches are not outcomes, and result hooks make no provider calls.
Ask for descriptive retained-window coverage — offline, no key needed:

```
jev_advise report="calibration"
```

The report shows unknowns, conflicts, joins, per-task recommendation agreement
and measured-duration denominators, not accuracy, quality or savings. Actual
execution tier is unknown. Turn hook storage off with `JEV_ADVISOR_MEMORY=off`.
V2 stores no assignment/result prose; `JEV_ADVISOR_MEMORY_HEAD_CHARS` is obsolete.
Custom state bases derive a separate `.v2` sibling without reading or modifying
the base. See the [full storage contract](jev-advisor/README.md#private-versioned-evidence).

## Privacy & data flow

- **Nothing leaves the machine until a key exists** (or you select the local `ollaya` provider). A fresh install performs zero network calls and zero writes.
- Once configured, one task's role, description, assignment and shared context are transmitted on pre-call/manual advisories. Requested tiers and invocation IDs are excluded. Oversized complete inputs are refused, not sliced. Default `jev` sends text to OpenRouter; use `off` for sensitive material.
- V2 evidence stays local and contains metadata/fingerprints, not assignment heads, result prose, rationale or keys. It starts writing only once a provider is configured and uses private transactional writes. There is no prior-outcome prompt injection or automatic NEXT/re-tier request.
- Egress is allowlisted in code: HTTPS `openrouter.ai` / `api.typesafe.ai` plus loopback HTTP for local servers; every other destination is refused before any request is sent. Attribution headers (`HTTP-Referer`, `X-Title`) go to OpenRouter only.

## Troubleshoot

| Symptom | Cause → fix |
| --- | --- |
| No advisories at all | Check configuration and explicit no-decision reasons: batch cooldown, input size, request budget or provider failure. The default cooldown is 15 s per pre-hook instance; manual requests are independent. |
| Advisories appear but nothing blocks | Shadow/hint do not block. Enforce requires a complete task, explicit weaker requested tier and that task's valid recommendation at the confidence gate. This does not enable model autorouting. |
| `provider returned HTTP 401` | Bad or expired key — fix the `.env` entry. |
| `report="calibration"` says no data | V2 starts separately and does not import legacy outcomes. Manual advice is not a delegation. Missing identity/unobserved terminals and retention limit coverage. |
| V2 store is corrupt, unsafe or locked | Storage reports unavailable and delegation fails open. Do not automatically delete/reset memory or steal locks; inspect and authorize recovery separately. Legacy state is untouched. |
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

## Related

- [gajae-code](https://github.com/Yeachan-Heo/gajae-code) — the coding agent these plugins extend
