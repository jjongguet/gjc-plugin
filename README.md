# gjc-plugin

Plugins for [gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`).
Each subdirectory carrying a `gajae-plugin.json` is an independently installable plugin.

| Plugin | Purpose |
| --- | --- |
| [`jev-advisor`](jev-advisor/) | Decision-model advisories for subagent `task` delegation — recommends a `fast` / `balanced` / `strong` tier via TypeSafe Jev on OpenRouter, a generic chat model, or a local server. Shadow by default. |

## Install

Requires [gajae-code](https://github.com/Yeachan-Heo/gajae-code) **≥ 0.18.0** (legacy hook contract) and `git` on PATH — URL installs clone through it.

```sh
gjc plugin install https://github.com/jjongguet/gjc-plugin --user
```

The installer discovers the plugin root itself, and the runtime surfaces are committed, so there is nothing to build.

Register an API key — one file, the single configuration channel, survives upgrades:

```sh
mkdir -p ~/.gjc/agent/jev-advisor
printf 'OPENROUTER_API_KEY=sk-or-v1-...\n' >> ~/.gjc/agent/jev-advisor/.env
chmod 600 ~/.gjc/agent/jev-advisor/.env
```

`OPENROUTER_API_KEY` is the same variable `gjc` itself reads for its OpenRouter provider; `JEV_ADVISOR_API_KEY` takes priority for a plugin-only key. Exported env vars always win over the file. To run without any key — nothing leaves the machine — set `JEV_ADVISOR_PROVIDER=ollaya` (local decision server).

Verify:

```sh
gjc plugin list && gjc plugin doctor
```

Pin a version by appending a git ref to the URL (`…/gjc-plugin#v0.0.2`). If an upgrade ever fails because its recorded source no longer exists, uninstall and install again — `~/.gjc/agent/jev-advisor/.env` survives both.

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

## Related

- [gajae-code](https://github.com/Yeachan-Heo/gajae-code) — the coding agent these plugins extend
