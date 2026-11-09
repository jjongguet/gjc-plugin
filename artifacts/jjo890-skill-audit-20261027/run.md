# JJO-890 skill-audit — real run receipt

Host: mac mini (`~/jjongguet/gjc-plugin`, branch `feat/jjo890-skill-audit-mini-m5`)
Run: 2026-10-27 02:17 local (02:17 UTC+09), `generated_at 2026-10-26T17:17:41Z`
Tool: `bun skill-audit/scripts/skill-audit.ts` (plugin `skill-audit` 0.0.1)

## Commands and results

| Command | Exit | Observed |
| --- | --- | --- |
| `bun skill-audit/scripts/skill-audit.ts --out artifacts/jjo890-skill-audit-20261027/report.json` | 1 | `status complete`, `usage ok`, 0.7 s wall on 1057 transcripts |
| `HOME=/tmp/jjo890-boundary-unknown-* bun … --out boundary-unknown.json` | 2 | `status unknown`, 1 installed, `used_count null`, unused withheld |
| `HOME=/tmp/jjo890-boundary-degraded-* bun … --out boundary-degraded.json` | 2 | `status partial`, `usage degraded`, `corrupt_lines 1`, `unreadable_files 1`, surviving skill `used_count 1` |
| `bun test skill-audit/tests/audit.test.ts` | 0 | 11 pass, 0 fail |
| `bun skill-audit/scripts/verify.ts` | 0 | 9 cases pass (hermetic HOME, tool surface, CLI exit codes, no-write check) |

## Real catalog result (this host)

- installed 109 · used 7 · unused 102 · usage unknown 0 · duplicate/stale candidates 4 (2 `duplicate_name`, 2 `stale_replica`)
- coverage: 1057 retained transcripts, file mtimes 2026-10-01T17:19Z..2026-10-26T17:17Z, 339 `skill` tool calls, 12 `/skill:` mentions, 0 corrupt lines, 0 unreadable files
- used: `ui-ux-pro-max` 16 (last 2026-10-26T09:58Z), `shortform-factory` 4, `backplan` 1, `notion-cli` 1, `rea` 1, `seo-technical` 1, `statechart` 1
- `pstack-router`: installed, **0 uses** in the whole window — the router itself is never loaded
- stale replicas still exposed: `vc-arca-curator.stale-20260804` (next to `vc-arca-curator`), `vc-civitai-r2-sync.stale-20260804` (next to `vc-civitai-r2-sync`)
- observed outside the audited roots (bundled or project scope, not cleanup candidates): `ultragoal` 123, `ralplan` 97, `autoresearch` 88, `deep-interview` 5, `prompt-craft` 1

The bundled workflow skills dominate real usage; the installed catalog contributes 7 used skills out of 109. That is the over-registration evidence this ticket asked for, stated as measured counts rather than a judgment about the skills themselves.

## Not covered

- Only retained transcripts; sessions deleted or rotated away before 2026-10-01 are absent, so "0 uses" means "no use in the scanned window".
- Call success is not correlated: a `skill` call that failed still counts once.
- Quality/effect is out of scope; the report proves loading, not usefulness.
- No skill was deleted, no configuration changed, and no session runtime file was modified.
