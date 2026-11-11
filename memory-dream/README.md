# memory-dream

Offline dreaming pass for GJC's project memory. It reads the notes GJC injects
(`memory_summary.md` and `MEMORY.md`), decomposes them into claims, runs
deterministic checks, retrieves bounded canonical evidence, and can ask the
advisory Jev decision model whether each evidence-bearing claim is consistent
with that evidence. It writes one private report under
`~/.gjc-plugin/memory-dream/`.

**It proves** which notes have a citation, which have a dead reference or an
over-budget injection layer, and what an advisory decision model returned for a
bounded claim/evidence pair.

**It does not prove** that a note is true or false, that the cited evidence is
complete, or that a correction will be adopted. GJC regenerates
`MEMORY.md`/`memory_summary.md`; this plugin never edits, deletes or enqueues
them. A report is advisory.

## Why a report and a session notice, not a memory edit

GJC 0.20.0 exposes `/memory view`, `/memory clear`, `/memory reset`,
`/memory enqueue` and `/memory rebuild`. `clear`/`reset` delete every memory row
and job in the shared database, not just the current project, so they are not a
correction interface. The consolidation pipeline has no public "this note is
wrong" input. The correction path is therefore:

1. the full report in `~/.gjc-plugin/memory-dream/`;
2. a bounded `session_start` notice that shows only the latest report's
   `contradicted` notes (5 lines / 600 UTF-8 bytes, measured), with no model
   call and no file write.

The missing upstream correction interface is reported as a GJC defect candidate,
not worked around by editing generated files.

## Install

```sh
gjc plugin install "$(pwd)" --user     # from this directory
gjc plugin list
```

Start a **new** `gjc` process and ask:

> Run memory_dream for this project.

Rollback: `gjc plugin uninstall memory-dream --user`. Reports already written
under `~/.gjc-plugin/memory-dream/` are not deleted by uninstall.

## Tool

`memory_dream` accepts:

| Field | Meaning |
| --- | --- |
| `memory_dir` | Existing scope under `<agent>/memories/`; defaults to the current project's scope. Read-only. |
| `project_root` | Repository whose `SYSTEM.md`, `RULES.md`, `AGENTS.md`, `rules/*.md`, root docs and plugin READMEs are canonical evidence; defaults to the session directory. |
| `jev` | Opt in to Jev for evidence-bearing claims (default false while the golden adoption threshold is unmeasured). Without a key the verdict is `no-decision`, never `supported`. |
| `max_claims` | 1–200, default 100. |
| `max_jev_calls` | 1–120, default 60. The cap counts actual provider attempts, not keyless/no-decision attempts. |
| `confidence_threshold` | 0–1, default 0.7. An `incorrect` verdict below the threshold is `unverified`, not `contradicted`. |

Output summary:

```text
memory_dream: ok
claims=50 supported=0 contradicted=0 unverified=13 no-decision=37
sent_to_jev=0 jev=typesafe/jev-1.14 jev_reason=unconfigured prompt=memory-dream/jev-consistency/v1
memory_unchanged=yes
report=/…/.gjc-plugin/memory-dream/reports/<id>/report.json
latest=/…/.gjc-plugin/memory-dream/latest.json
```

Each run writes `report.json`, `report.md` and a `latest.json` pointer. The
report keeps before/after sha256 for every memory file it read and sets
`memory.unchanged` only when they match.

## Deterministic checks

- injection budgets: `memory_summary.md` 8 KiB / 120 lines and `MEMORY.md`
  25 KiB / 200 lines; over-budget is a warning, not a verdict;
- dead and masked `rule://` references (a missing rule file, or a name broken by
  redaction such as `rule://wo[REDACTED]`);
- missing backticked paths under the project or home;
- elapsed days for dated facts, flagged past 30 days;
- secret-shaped claims (`sk-`, GitHub tokens, AWS key ids, PEM private keys,
  bearer tokens, assigned passwords/keys, long base64). A secret claim is
  redacted in the report, marked `externalSend:false`, and never sent;
- lexical evidence search, canonical first: `SYSTEM.md`, `RULES.md`,
  `AGENTS.md`, `rules/*.md`, then root docs/plugin READMEs, then at most one
  bounded recent transcript excerpt. Every citation is `path:line` or
  `transcript:<16-hex>:<line>`.

`no_evidence` is `unverified`; it is never promoted to `supported`. Secret
screening also drops an evidence excerpt that contains a secret.

## Jev path

The Jev path is **opt-in** (`jev: true`) until the three-run golden adoption threshold is measured. The default run is deterministic only; an evidence-bearing claim is `no-decision` (`disabled`), never `supported`. When opted in, only claims with evidence are sent. The artifact is the bounded claim plus at
most two cited excerpts (≤400 characters each, ≤6,000 characters total). The
request uses the same model and question shape as the Jev decision contract:

- model `typesafe/jev-1.14`, endpoint `https://openrouter.ai/api/alpha/decisions`;
- question `consistency` with criteria `correct` / `incorrect` / `unsure`;
- `incorrect` + canonical evidence + confidence ≥ threshold → `contradicted`;
- `correct` → `supported`; `unsure` or below-threshold → `unverified`;
- no key, provider off, timeout, HTTP error or invalid response → `no-decision`
  with its reason. It never becomes `supported`.

The key is read from `JEV_ADVISOR_API_KEY`, `OPENROUTER_API_KEY` or
`OPENROUTER_DECISION_API_KEY` (process env wins over
`<agent>/jev-advisor/.env`). The key value is never printed or written to a
report.

## Golden set and scoring

The synthetic set is in [`tests/fixtures/golden/`](tests/fixtures/golden/):
36 claims (12 supported, 12 contradicted, 12 unverifiable) covering the real
drift shapes: 429 retry↔quota exhaustion, SSH alias inversion, renamed rule,
expired snapshot, masked `rule://`, PATH forwarding and HOME withholding.

```sh
bun scripts/golden.ts --offline                 # keyless deterministic baseline
bun scripts/golden.ts --fake perfect --runs 3   # hermetic mapping fixture
bun scripts/golden.ts --runs 3                  # real Jev, needs a key
```

The deterministic baseline says "supported" when any evidence is retrieved. It
is deliberately naive: it measures the gap the semantic decision model is meant
to close. On this set it scores **0.67 accuracy (24/36)**, contradicted
precision **null** (it predicts none) and recall **0.00**.

The real path uses one model, one prompt version and three runs. Contradicted
precision and recall are computed at thresholds 0.5–0.9; the selected threshold
is the lowest one whose three-run mean reaches precision ≥ 0.9 and recall ≥ 0.7.
If no threshold qualifies, the scores are reported and Jev is not adopted as a
default verdict source. A fixture transport is labelled as such and is never
reported as a model measurement.

`scripts/golden.ts` writes its JSON under `~/.gjc-plugin/memory-dream/golden/`
and records the OpenRouter usage delta when the key endpoint exposes it; an
unmeasured cost is `null`, never zero.

## Host smoke

```sh
node scripts/smoke-host.mjs --project-root <repo> --agent-dir <agent> --keep-installed
```

It installs the plugin into the user scope, starts a fresh `gjc --print`
process against a scripted loopback model endpoint, calls `memory_dream` once,
checks the report and the before/after sha256, then uninstalls unless
`--keep-installed` is passed. The default mode sets `JEV_ADVISOR_PROVIDER=off`,
so the run is keyless and cannot spend; `--live-jev` is the explicit exception.
The scripted endpoint is local; `remoteModelRequests` is reported as 0.

## Known limits

- Evidence search is lexical. A missing citation is not proof that no evidence
  exists, and an irrelevant citation can be retrieved for an unusual claim.
- The report analyses at most 100 claims by default; the rest are counted as
  omitted.
- The session notice repeats the latest report's contradicted notes until a
  newer report replaces them.
- No timer, launchd job or poller is installed. The tool runs only when invoked.
- GJC memory and session files are read-only inputs. The plugin writes only
  under `~/.gjc-plugin/memory-dream/` with `0700` directories and `0600` files.
