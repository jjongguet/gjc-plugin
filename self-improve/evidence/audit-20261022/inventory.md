# Surface inventory (L0)

Identity is taken from manifests and code, never from prose. All paths are
repository-relative; the observed install identity is recorded separately.

## Runtime surfaces

| Surface | Manifest | Version | Tools | Hooks | Generated files |
| --- | --- | --- | --- | --- | --- |
| `rrsi` | `rrsi/gajae-plugin.json` | 0.0.2 | `rrsi` (capture/import/dream/status) | `session_start` → `rrsi-periodic` | `rrsi/tools/rrsi.ts`, `rrsi/hooks/rrsi-periodic.ts` |
| `self-improve` (engine, not a plugin) | — | — | CLI `self-improve/scripts/run.mjs` | — | none |

- Build edge: `rrsi/scripts/build.mjs` inlines `shared/lib/results.ts` plus
  `self-improve/lib/{types,ledger,replay,dream,policy}.mjs` into both generated
  files; local imports are stripped and builtin imports de-duplicated. The
  generated files declare this banner themselves.
- Source: `rrsi/lib/{rrsi,periodic}.ts`, `rrsi/src/{rrsi,periodic}.adapter.ts`,
  `rrsi/scripts/{build.mjs,verify.ts,journal-dream.mjs}`.
| Tests: `rrsi/scripts/verify.ts` (32 acceptance cases at HEAD; 31 at the audit base), `rrsi/tests/real-journal.test.ts`,
  `rrsi/tests/periodic.test.mjs` (+ child harness).

## Self-improve engine

| Area | Count | Path |
| --- | --- | --- |
| engine modules | 16 | `self-improve/lib/*.mjs` |
| CLI scripts | 4 | `self-improve/scripts/{run,verify-unit,verify-integration,propose-with-gjc}.mjs` |
| unit suite files | 24 | `self-improve/tests/unit/` |
| integration suite files | 9 | `self-improve/tests/integration/` |
| probes/held-out | 2 domains | `self-improve/domains/{gjc-plugin,rules-text}/` |
| frozen protocols | 3 | `rrsi-protocol.json`, `replay-protocol.json`, `replay-protocol-p2b.json` |
| ledger | 31 rows | `self-improve/ledger.jsonl` (append-only) |
| policies | 1 deployed | `self-improve/policies/pi-1-25.json` + `current.json` |

## Distribution index

`gjc-plugin.json` lists every plugin manifest; observed plugin versions:
aside-memory 0.0.1, backplan 0.0.6, jev-advisor 0.0.7, rea 0.0.3, rrsi 0.0.2,
ui-regression 0.0.3, verification-receipts 0.0.3, wiki 0.0.3.

## Installed vs repository

| Item | Repository | Installed (user scope) |
| --- | --- | --- |
| rrsi manifest version | 0.0.2 | 0.0.2 |
| rrsi surfaces | tool `rrsi`, hook `session_start::rrsi-periodic` | same two surfaces, `enabled: true`, not quarantined |
| `gjc plugin doctor` | — | 8 ok, 3 warnings (plugins directory / package manifest / node_modules absent), 0 errors |

Installed **code bytes** are not compared: the installer copies the manifest-declared
files, and this audit does not hash the installed copies. That limit is recorded
in the final verdict.

## Runtime roots (read-only sample)

`~/.gjc-plugin/rrsi/store.json` (0700 dir / 0600 file), `periodic.json`,
`runs/v1/` receipts, `journal/v1/`; the jev-advisor journal at
`~/.gjc-plugin/jev-advisor/journal/v1/` is read read-only by the projection.
