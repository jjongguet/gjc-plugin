# backplan

GJC workflow gate for backward-derived work plans (역기획): every work request
becomes a Linear project/issue **before** execution. Deterministic, offline and
keyless — it grades the draft and renders the payloads; registration itself
stays with the agent's Linear MCP tools and the workspace trace tool.

Two deliverables:

- **`backplan_check` tool** — validates a structured plan draft (end state,
  success criteria, per-issue objective/scope/completion criteria, Linear
  project mapping, policy decisions, automation candidates) against the fixed
  contract, and returns Linear-ready project/issue payload text plus a stable
  content digest. It never writes to Linear, reads credentials or contacts the
  network. Invalid drafts (orphan issues without a project mapping, missing or
  generic completion criteria, in-scope automation smuggled into the plan,
  unknown keys, duplicate titles) are rejected with path-addressed errors.
- **`skills/backplan/SKILL.md`** — the loose skill payload describing the
  method (write the end state first, decompose backwards, map every issue to a
  project, surface policy decisions and automation candidates) and the
  register-then-execute flow.

## Install (once per machine)

From this checkout root:

```sh
# 1. Plugin surface (backplan_check)
gjc plugin install ./backplan --user

# 2. Loose skill payload (bundles cannot register top-level skills)
mkdir -p ~/.gjc/agent/skills/backplan
cp backplan/skills/backplan/SKILL.md ~/.gjc/agent/skills/backplan/SKILL.md
```

Restart GJC after installing so new sessions pick up the tool and skill; a
running session does not.

## Draft contract

Required sections (snake_case JSON): `goal`, `end_state`, `success_criteria`,
`project` (`{name, mode: "reuse"|"create", reason, boundaries?}`), `issues`,
`policy_decisions`, `automation_candidates`; optional `request` and per-issue
`dependencies[]`/`labels[]`. Sizes are bounded (strings ≤ 2000 characters,
plan ≤ 256 KiB); unknown keys are rejected. See
[`skills/backplan/SKILL.md`](skills/backplan/SKILL.md) for the method and a
minimal example.

## What the tool checks (and does not)

Checks: required sections and types; non-empty goal/end state; per-issue
objective/context/scope_in/scope_out/delivery; at least one observable
completion criterion per issue (generic phrases are rejected, repeated entries
warn and duplicate titles are rejected); a project mapping with a reason for every draft; policy decisions
carry `needs_user_decision`, options and a record location; automation
candidates are `backlog` or `out_of_scope` only.

Does not: write to Linear, approve or publish anything, execute work, read
credentials, or prove that a registered ticket exists — registration remains
the agent's Linear MCP / `linear-trace.py` step.

## Build and verify

```sh
bun scripts/build.mjs   # regenerate tools/backplan-check.ts (keyless)
bun scripts/verify.ts   # hermetic offline acceptance (isolated HOME, no network)
```

Repo root: `bun run build:backplan`, `bun run test:backplan`. The generated
package embeds `shared/lib/results.ts` and its core/adapter sources; rebuild
after any `lib/` or `src/` change.

## Boundaries

Local-only: this plugin adds no provider, credential or network channel.
Approvals, publishing, spending and every Linear write remain outside the
plugin, on the human/agent side of the trace flow.
