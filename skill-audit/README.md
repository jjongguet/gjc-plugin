# skill-audit

Installed-vs-used audit of the GJC skill catalog: per-skill use counts, last use and install source from the retained session transcripts, plus unused, duplicate and dated-replica candidates with their basis. Read-only — it installs, deletes and configures nothing, and writes no file unless the CLI is given `--out`.

## Install

```sh
gjc plugin install ./skill-audit --user
# or run the CLI straight from the checkout
bun skill-audit/scripts/skill-audit.ts --json
```

## Usage

```sh
bun skill-audit/scripts/skill-audit.ts           # human summary
bun skill-audit/scripts/skill-audit.ts --json    # full report on stdout
bun skill-audit/scripts/skill-audit.ts --json --out artifacts/skill-audit/report.json
```

The `skill_audit` tool returns the same report and accepts exactly `{}`; anything else is `invalid_input`.

| Exit | Meaning |
| --- | --- |
| 0 | Audit complete, no unused or duplicate candidate |
| 1 | Audit complete, candidates found |
| 2 | Usage unknown or degraded — zero uses cannot be claimed |
| 64 | Invalid arguments |

## What counts as use

| Signal | Counted | Why |
| --- | --- | --- |
| `skill` tool call with `{"name":"<skill>"}` | yes, one per call | the only event that loads a SKILL.md body |
| `/skill:<name>` in an owner prompt | yes, one per transcript with no `skill` tool call for that skill | explicit invocation that may not produce a tool call |
| skill name in the catalog prompt | no | every installed skill is listed in every session |
| `skill_discovery` lookup, prompt mention, `history.db` match | no | discovery and mention are not use |

`used_count` = `tool_calls` + `prompt_only_sessions`, so a `/skill:x` prompt that also produced a tool call is not double counted. `last_used` is the newest transcript timestamp for either signal.

## Report

```json
{
  "schema_version": 1,
  "report": "skill_audit",
  "mode": "read_only",
  "status": "complete | partial | unknown",
  "usage": {
    "status": "ok | degraded | unknown",
    "sessions_root": "~/.gjc/agent/sessions",
    "transcripts": 1057,
    "files_scanned": 1057,
    "corrupt_lines": 0,
    "unreadable_files": 0,
    "window": { "first_file_mtime": "…", "last_file_mtime": "…" },
    "outside_roots": [{ "name": "ralplan", "used_count": 97, "last_used": "…" }]
  },
  "counts": { "installed": 109, "used": 13, "unused": 96, "usage_unknown": 0, "duplicate_candidates": 3, "stale_replicas": 2, "outside_roots": 4 },
  "skills": [
    { "name": "ralplan", "installed": true, "source": "~/.gjc/agent/skills", "scope": "user", "used_count": 97, "last_used": "…", "tool_calls": 97, "prompt_invocations": 0, "prompt_only_sessions": 0, "sessions_used": 86, "verdict": "used" }
  ],
  "candidates": {
    "unused": [{ "name": "vc-arca-curator", "basis": "0 skill tool calls and 0 prompt-only /skill: invocations across …" }],
    "duplicates": [{ "kind": "stale_replica", "skills": ["vc-arca-curator", "vc-arca-curator.stale-20260804"], "basis": "…" }]
  },
  "limitations": ["…"]
}
```

`source` is the install root (`user` = `~/.gjc/agent/skills`, `project` = `<cwd>/.gjc/skills`) with the owner's home collapsed to `~`, so a report can be committed without leaking an absolute home path.

Candidate kinds: `duplicate_name` (two installed copies declare the same frontmatter `name`), `identical_content` (byte-identical SKILL.md), `stale_replica` (`<base>.stale-YYYYMMDD` next to an installed `<base>`).

`usage.outside_roots` lists skill names that were observed loading with no directory in the audited roots — bundled workflow skills (`ralplan`, `ultragoal`, …) and project-scope skills land there. They are coverage notes, not cleanup candidates.

## Boundaries

- Missing or empty transcript coverage is `usage.status: "unknown"` with `used_count: null` and no unused candidates — an absent log cannot distinguish "never used" from "not measured". Corrupt lines or unreadable transcript paths make the report `partial`; the surviving counts are kept and the gaps are reported.
- Usage counts prove that a body was loaded or requested, not that the skill helped. A failed `skill` tool call still counts once; results are not correlated.
- Only retained transcripts are covered. Deleted, rotated-away or unretained sessions are absent, and file mtimes bound the stated window rather than proving an exact audit period.
- The plugin reads `~/.gjc/agent/skills` and `~/.gjc/agent/sessions` and never modifies them; it deletes, installs and changes no configuration. Rolling back means uninstalling the plugin only.

## Build and verify

```sh
bun skill-audit/scripts/build.mjs          # regenerate tools/skill-audit.ts
bun skill-audit/scripts/build.mjs --check  # drift check
bun test skill-audit/tests/audit.test.ts   # aggregation and boundary fixtures
bun skill-audit/scripts/verify.ts          # hermetic CLI end-to-end on a temporary HOME
```

Fixtures only: the verifier builds a temporary `HOME` with synthetic skills and transcripts, never reads the real catalog, and needs no network or key. A pass proves the aggregation and CLI contract, not that the owner's catalog has been cleaned up.
