# jev-gate — Hermes cron pre-delivery gate

A Python 3.9+ standard-library Hermes plugin (`__init__.py` entry point). It
registers one `transform_llm_output` hook and evaluates final cron output before delivery:

1. deterministic detection of empty/abort/truncated output;
2. a strict, bounded JEV check (`typesafe/jev-1.13` through OpenRouter);
3. a metadata-only replacement notice when held;
4. a bounded retry request and a final alert when the budget is exhausted.

The gate never stores or prints the artifact, the question, the API key or the
provider rationale. Receipts contain metadata only.

## Install

The plugin lives at `integrations/hermes/jev-gate/` in this repository and is
copied to the Hermes host (`<hermes-host>` is the ssh alias of the machine running the
Hermes gateway):

```sh
COPYFILE_DISABLE=1 tar -C integrations/hermes -czf - jev-gate \
  | ssh <hermes-host> 'mkdir -p ~/.hermes/plugins && tar -xzf - -C ~/.hermes/plugins'
ssh <hermes-host> '~/.hermes/plugins/jev-gate/install.sh --install'
```

`install.sh --install` creates `~/.hermes/plugins/jev-gate-data/config.json`
from `config.example.json` with mode `off`, then runs `--check`. Enable the
plugin and reload the gateway:

```sh
hermes plugins enable jev-gate
hermes plugins list
```

Do not install Node or Bun. The host runs python3 only.

## Configuration

Live config: `~/.hermes/plugins/jev-gate-data/config.json` (0600). State and
receipts: `~/.hermes/plugins/jev-gate-data/<profile>/` (0700; files 0600).

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `off` | `off`, `dry_run` (receipt only, original delivered), `hold` |
| `allowlist` | `[]` | job ids the gate may act on |
| `questions` | `{}` | per-job check question; required for every allowlisted job |
| `channels` | `{}` | per-job Discord channel id for the replacement notice |
| `home_channel` | `""` | Discord channel id for gate-level failure alerts; empty records `alert_delivery: "no_channel"` and sends nothing |
| `max_attempts` | `3` | total generations per run group |
| `wall_clock_ms` | `900000` | 15-minute retry budget |
| `hold_confidence` | `0.9` | hold only at `incorrect` with confidence >= this |
| `max_artifact_chars` | `4000` | composed `question + artifact` admission bound |
| `timeout_ms` | `8000` | provider timeout |
| `abort_patterns` | see example | first-line deterministic patterns |
| `allow_force_fixture` | `false` | allow `force_fixture` only in self-test/canary |
| `force_fixture` | `null` | canary-only fixture name under `fixtures/precision/bad/`; requires the guard |

Only enabled assistant-output jobs are gated; `no_agent` script jobs are
excluded. `config.example.json` uses placeholder job ids (`job-id-1`..`job-id-3`)
and channels (`channel-1`); replace them with the operator's own Hermes job ids
(`python3 gate.py --print-job-map`) and Discord channel ids.

`install.sh --install` never overwrites an existing `config.json`, so an
upgraded host keeps its explicit `home_channel`. A fresh install must set
`home_channel` (and per-job `channels`) before alerts are delivered.

## Decision rule

- Empty/whitespace, first-line abort patterns, or a short abort/truncation text
  -> hold without a provider call.
- `[SILENT]` -> allow (Hermes suppresses it anyway).
- Otherwise, when a key exists and the composed prompt is <= 4,000 chars, call
  the JEV check. Hold only `verdict=incorrect` at or above `hold_confidence`.
- `unsure`, low confidence, no decision, timeout, HTTP error, missing key, or
  oversize -> allow. Missing key/timeout/HTTP error also sends a home alert.
- `dry_run` records the decision and delivers the original.

## Hold, retry and alerts

On hold, the hook returns a metadata-only notice. That notice is the
replacement text and is delivered to the job channel, so the original abort
text is never delivered. The notice includes job, attempt, stage, reason,
artifact sha prefix and character count — never artifact prose.

A detached helper waits up to 60 seconds for the current execution to become
terminal in `~/.hermes/cron/executions.db` (or `hermes cron runs <job_id>`),
then triggers `hermes cron run <job_id>` exactly once as a detached process.
The CLI owns the replacement execution for the whole agent turn, so the helper
never waits on or kills it; the retry is tracked by the continuation marker and
recorded as `enqueue_status=spawned`. If the ledger is unavailable or the wait
expires, the helper records `enqueue_status=skipped` and does not enqueue.

A replacement joins the pending retry only through the per-job continuation
marker and `enqueue_key`, and only while the run group is inside its
wall-clock budget. On this host the helper-triggered `hermes cron run` is
executed by the scheduler and reaches the hook as a scheduled run, so the
join is recognized there; a genuinely new scheduled occurrence, a run past
the budget, or a run without a matching marker starts a fresh run group and
supersedes the old retrying one. A `source=direct` run that arrives without
the marker is recorded as a user manual run and does not consume the budget.

The budget is per job and never resets on a join miss. On exhaustion the hook
returns the exhausted notice; no replacement is requested.

## Receipts

One JSONL per job under `<profile>/receipts/<job_id>.jsonl`, bounded to 64
records, 0600. Fields include config digest, job/execution identity, run group,
attempt/max, stage, decision, check status, verdict/confidence, reason,
question sha, composed chars, artifact sha/chars, key source, provider/model,
join/enqueue status, lock status and alert flag. No artifact or question text.

## Rollback

Persistent rollback is either:

```sh
# edit ~/.hermes/plugins/jev-gate-data/config.json: "mode": "off"
# or
hermes plugins disable jev-gate
```

Then reload/restart the gateway and run one manual cron job. There must be no
new gate receipts and delivery must be unchanged. A transient `JEV_GATE_MODE=off`
in an ssh shell is not rollback.

## Credential boundary

The key is read only from `~/.gjc/agent/jev-advisor/.env`
(`JEV_ADVISOR_API_KEY`, fallback `OPENROUTER_API_KEY`). The gate never reads
`~/.hermes/.env` or inherited process environment keys. If the key is absent,
the gate stays fail-open and alerts the home channel; live `hold` is blocked.

## Verification

```sh
python3 -m unittest discover integrations/hermes/jev-gate/tests -v
python3 integrations/hermes/jev-gate/gate.py --self-test
python3 integrations/hermes/jev-gate/gate.py --config-check
python3 integrations/hermes/jev-gate/gate.py --print-job-map
```

`--self-test` runs the committed 10 bad / 10 good precision fixtures with no
network and no send. A canary uses a forced `abort_217` fixture and a valid
output; see the main plan for the host canary and rollback procedure.

## Limitations

The JEV verdict is advisory, not verification evidence; confidence is not a
success probability. The gate does not regenerate content itself, does not
route models, and does not inspect artifacts above the composed 4,000-char
bound. Provider errors are fail-open with an alert, not a retry loop.
