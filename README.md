# gjc-plugin

Plugins for [gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`).
Each subdirectory carrying a `gajae-plugin.json` is an independently installable plugin.

| Plugin | Purpose |
| --- | --- |
| [`jev-advisor`](jev-advisor/) | Decision-model advisories for subagent `task` delegation — recommends a `fast` / `balanced` / `strong` tier via TypeSafe Jev on OpenRouter, a generic chat model, or a local server, and remembers delegation outcomes locally so recommendations and a calibration report are grounded in evidence. Shadow by default. |

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
- **Validator hook** — `dashboard/package.json` `vercel-build` runs `node ../../workspace-standard/validator/cli.mjs validate --root ..` before `next build`; a non-green validation fails the build. Run it locally with `npm run vercel-build` inside `dashboard/`.
- **Manual workflow** (`steps.json`) — three human-executed steps: record (mac: bump version + tag at release), verify (server: validator green), review (human). Nothing runs on a timer.

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `DASHBOARD_TOKEN` are listed in `dashboard/.env.example` and intentionally left unset until the Supabase connection ships.

## Related

- [gajae-code](https://github.com/Yeachan-Heo/gajae-code) — the coding agent these plugins extend
