# Ultragoal gate evidence

What the ultragoal quality gate accepts as `executorQa` evidence, observed against the compiled gjc 0.18.12 release binary. `gjc ultragoal quality-gate validate` checks a whole gate file, and `checkpoint --status complete --quality-gate-json` and `review --executor-qa-json` apply the same artifact checks; `--help` does not describe these shapes.

[`scripts/tests/ultragoal-gate.test.mjs`](../scripts/tests/ultragoal-gate.test.mjs) (part of `bun run test`) reproduces every rule below against the installed `gjc` in a disposable repository and HOME, and fails when a release changes one. It skips with a recorded reason when no `gjc` is on `PATH`.

## Start from the scaffold

```sh
gjc ultragoal quality-gate init --surface package --out quality-gate.json
```

`--surface` (repeatable, default `web`) fills `executorQa.surfaceEvidence` and the artifacts that surface family needs. Every scaffold also carries an `adversarial-report` (`failure-mode-test`), which must be an existing non-empty file.

| Surface | Scaffolded artifact | Accepted when |
| --- | --- | --- |
| `package`, `api` | `test-report` at `artifacts/api-report-1.xml` | the file exists and is non-empty |
| `cli` | `cli-replay` at `artifacts/cli-replay-1.json` | the replay record executes, or it carries a valid `replayExempt` |
| `web` | `browser-run` and `screenshot` | not covered here |

## Paths and the source hash

- `artifactRefs[].path` is resolved against the working tree the command runs in and must stay inside it. A path that does not exist there fails with `requires an existing non-empty file`, which is what evidence written into another worktree (the shared checkout while the command runs in a lane) looks like. A file under `.gjc/` is accepted when it exists in that tree.
- `iteration.reviewCohort.sourceHash` and every lane `sourceHash` must equal the `sourceHash` printed by `gjc ultragoal quality-gate source-hash --json`. Untracked files are part of the hashed source, so take the hash after the last artifact is written, or the gate reports `source_hash_mismatch`. Keep the gate file itself outside the working tree for the same reason. The hash needs a resolvable integration base such as `main`.

## CLI replay

A `cli-replay` record is either a JSON file at the artifact's `path` or inline fields on the artifact entry, never both (`must not mix inline replay fields with an artifact path`).

| Field | Rule |
| --- | --- |
| `schemaVersion` | `1` |
| `kind` | `cli-replay` |
| `command` | non-empty argv string array; a shell string is rejected |
| `replaySafe` | `true` |
| `recordedStdout` | string |
| optional | `recordedStderr`, `expectedExitCode` (integer, default `0`), `timeoutMs`, `normalization` (`default`), `invariants`, `cwd`, `env` |

Only `bun --version` and `bun -e "console.log(...)"` with literal arguments are replayable; every other command, including a focused `bun test`, is blocked. In the compiled release binary replay never executes, because `process.execPath` is the GJC application rather than Bun, so a `cli` surface fails with `CLI replay execution is unavailable in the compiled GJC runtime` unless its record carries a `replayExempt`.

## `replayExempt`

Put it on the replay record, in the JSON file or on the inline entry:

```json
"replayExempt": {
  "reasonCode": "platform_unavailable",
  "reason": "The compiled GJC runtime cannot execute a Bun CLI replay for this command.",
  "approvedBy": "human:owner",
  "fallbackArtifactRefs": ["cli-pty-1"]
}
```

- `reasonCode` is one of `unsafe_side_effect`, `requires_credentials`, `requires_network`, `non_deterministic_external`, `destructive`, `interactive_only`, `platform_unavailable`.
- `reason` has at least 30 characters and at least five words; placeholders such as `TODO`, `TBD`, `n/a` or `none` fail with `must be audited and substantive`.
- `approvedBy` names who approved the exemption.
- `fallbackArtifactRefs` lists ids of other `executorQa.artifactRefs` entries, never paths (`references unknown id`) and never the replay record itself. At least one must be a structurally valid fallback, decided by its `kind`:

| `kind` contains | Structural rule |
| --- | --- |
| `pty`, `tui` or `terminal-capture` | an existing file of at least 512 bytes containing terminal control sequences and a printable run of at least 10 characters |
| `screenshot`, `image` or `visual` | a decodable PNG or marker-validated JPEG of at least 4096 bytes and 320×180 pixels that is not blank or uniform |
| `browser`, `playwright` or `automation` | a JSON transcript with `schemaVersion: 1`, a non-empty `tool`, non-empty `actions` with parseable, non-decreasing `timestamp`s, at least one selector-bearing action or passed assertion, and a `surface`, if present, matching the gate's surface |

Only the kind and the structure count; location, Git tracking and attached receipts play no part. A JSON report under `artifacts/` or `.gjc/qa/`, a git-tracked file, a file at the repository root, a command transcript and a typed `verifiedReceipt` on the artifact entry therefore all fail with `requires at least one structurally-valid fallback artifact`, as does any `test-report` or `failure-mode-test`.

For a CLI the honest fallback is a real terminal capture of the command. On macOS:

```sh
FORCE_COLOR=1 TERM=xterm-256color script -q artifacts/cli-pty-1.txt <command> [args...]
```

`NO_COLOR` or `TERM=dumb` remove the control sequences the rule requires. A file written only to satisfy these checks is fabricated evidence, not a capture.

## Surfaces for this repository

Plugin tools and hooks are packages that GJC loads, and their suites exercise the generated surfaces as black-box tests. Classify that work as `package` with the suite's real report, for example `node --test --test-reporter=junit --test-reporter-destination=artifacts/api-report-1.xml <files>`: the gate validates and `review --spec <contract> --executor-qa-json <executorQa>` returns `pass` with `cleanPassEligible: true`. Use `cli` only for a command-line surface a user runs, and plan for its `replayExempt` and terminal capture.
