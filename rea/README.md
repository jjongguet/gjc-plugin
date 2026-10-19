# rea

GJC integration surface for [REA](https://github.com/morluto/rea) (reverse-engineer-anything, MIT) — pinned to **rea-agents 6.4.0**.

Two deliverables:

- **`skills/rea/SKILL.md`** — the GJC workflow skill payload (CLI invocation, output budgeting, target routing, evidence discipline, evidence hand-off to wiki/backplan/rrsi, recovery steps) for the loose skill surface. This is the primary integration: REA runs as the pinned CLI (`npx -y rea-agents@6.4.0 <command>`), so no MCP registration and no standing tool-schema cost is needed.
- **`rea_readiness` tool** — read-only, offline readiness report: Node/npx or Bun/bunx availability and REA engine version fit, the pinned CLI invocation, optional GJC MCP registration state in user (`~/.gjc/agent/mcp.json`) and project (`<cwd>/.gjc/mcp.json`) scope, loose-skill installation state, and remediation commands. It accepts exactly `{}`; any other input is rejected as `invalid_input` before a probe runs. It never installs, registers, downloads or runs REA, and never contacts the network.

## Install (once per machine)

From this checkout root, after `gjc plugin install ./rea --user`:

```sh
# 1. Plugin surfaces (rea_readiness)
gjc plugin install ./rea --user

# 2. Loose skill payload (bundles cannot register top-level skills)
mkdir -p ~/.gjc/agent/skills/rea
cp rea/skills/rea/SKILL.md ~/.gjc/agent/skills/rea/SKILL.md
```

That is the full CLI-first setup: the first `npx -y rea-agents@6.4.0 <command>` call fetches the pinned package into the npx cache; later calls start fast. The CLI needs Node `^22.19 || ^24.11 || >=26` (or Bun via `bunx`); `rea_readiness` reports the fit. Restart GJC after installing so new sessions pick up the plugin surface and skill; a running session does not.

### Optional: MCP mode

Sessions that genuinely need the stateful MCP surface (a retained active target, MCP prompts, Hopper GUI navigation tools) can register the server instead:

```sh
gjc mcp add rea --timeout 60000 -- npx -y rea-agents@6.4.0 mcp
```

The `--` separator is required: `gjc`'s parser rejects `-y` as an unknown option when it appears before it. `--timeout 60000` also matters: without a declared positive timeout, ordinary sessions wait only ~250ms for MCP startup, which an npx-backed server cannot satisfy; with it, the connection may settle inside its window and publish tools. `rea_readiness` reports a registration that lacks a declared timeout.

Registration is deliberately NOT the default: GJC 0.18.5 exposes every tool of a conventionally registered server in every session, and REA's ~170 tool schemas are a large standing context cost. Restart GJC after changing registrations.

## Why the plugin does not register the MCP server itself

GJC 0.18.5 refuses plugin-bundle stdio MCP servers off Linux ("authenticated plugin MCP stdio launch capsules are available only on Linux"), and the bundle `mcps` grammar can only launch a bare `node`/`bun` on an in-bundle script — it cannot express a pinned `npx rea-agents@…` command. A `mcps` entry would quarantine on macOS, so registration stays a documented one-liner using the same `gjc mcp add` path as any other MCP server (optional, see above).

Symmetrically, GJC plugin bundles cannot register top-level skills; the workflow skill ships here as a loose-surface payload copied in step 2.

## Version pin

The plugin pins `rea-agents@6.4.0` in the manifest, README, skill payload and readiness report; a bump is a new plugin release. The pinned package's own `--llms` manifest and each command's `--schema` remain the source of truth for capabilities.

## What rea_readiness checks (and does not)

Checks: `node`/`npx`/`bun`/`bunx` presence with bounded local `--version` probes, Node engine fit (`^22.19 || ^24.11 || >=26`), the pinned CLI invocation, optional REA registration state per scope (`registered`/`disabled`/`autoload_off`/`missing`/`unreadable`, including the `disabledServers` list and a missing declared timeout — reported, never required), loose-skill file presence, and the exact remediation commands.

Does not: install anything, write any config, run REA, contact the network, or prove that the pinned package is cached. A `ready` report means the CLI prerequisites are in place (`ready` no longer requires any MCP registration), not that any command ran. Deep native analysis additionally needs a user-provided Hopper, Ghidra or IDA.

## Build and verify

```sh
bun scripts/build.mjs   # regenerate tools/rea-readiness.ts (keyless)
bun scripts/verify.ts   # hermetic offline acceptance (fake probes, isolated HOME, no network)
```

Repo root: `bun run build:rea`, `bun run test:rea`. The generated package embeds `shared/lib/results.ts` and its core/adapter sources; rebuild after any `lib/` or `src/` change.

## Boundaries

REA is local-only; this plugin adds no provider, credential or network channel. Engine installation, `rea-agents` updates and every reverse-engineering target decision remain operator responsibilities, subject to the workspace authorization rules. Screenshots and target data never leave the machine through this plugin.
