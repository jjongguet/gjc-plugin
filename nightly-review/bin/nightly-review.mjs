#!/usr/bin/env node
// nightly-review — daily post-merge review with independent lenses and a
// deterministic gate.
//
// The models propose. The gate decides. Surviving findings land in a run directory
// as a report plus a receipt, and the `file` step turns them into Linear issues that
// carry the evidence — one issue per (repo, file, kind), reused instead of duplicated.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { collectRepo } from '../lib/collect.mjs';
import { buildPrompt, selectLenses } from '../lib/lenses.mjs';
import { DEFAULT_MAX_FINDINGS, gateFindings, indexDiff } from '../lib/gate.mjs';
import { runAll, runLens } from '../lib/runner.mjs';
import { makeDeadline } from '../lib/deadline.mjs';
import {
  DEFAULT_MAX_ISSUES,
  applyFiling,
  clusterFindings,
  planFiling,
  summarizeFiling,
} from '../lib/filing.mjs';
import { DEFAULT_LINEAR_CLI, createLinearClient, loadProjectMap } from '../lib/linear.mjs';

const DEFAULT_STATE_DIR = path.join(process.env.HOME ?? '.', '.gjc-plugin', 'nightly-review');
const DEFAULT_FILED_STATE = 'filed.json';

function usage() {
  return `usage: nightly-review <command> [options]

  once   --repos a,b [--since YYYY-MM-DD] [--lenses id,id] [--out DIR]
         [--max-diff-bytes N] [--concurrency N] [--max-findings N] [--deadline-seconds N]
         [--file-findings] [--publish] [--max-issues N] [--json]
  loop   (same options) --interval SECONDS
  recheck --run DIR [--max-findings N] [--json]
  file   --run DIR [--publish] [--max-issues N] [--linear-cli PATH] [--json]

Commands
  once     collect merged PRs, run every lens, gate findings, write report + receipt
  loop     run "once" repeatedly; lives only inside the terminal you started
  recheck  re-apply the gate to a finished run's stored findings (no model calls)
  file     turn a finished run's kept findings into Linear issues; plan only without --publish

Options
  --repos        comma-separated repository names under jjongguet/ (required for once)
  --since        merged:>= date, default yesterday in local time
  --lenses       subset of contract,failure,security,testgap,regression (default all)
  --out          state directory (default ${DEFAULT_STATE_DIR})
  --max-diff-bytes  per-PR diff cap (default 40000)
  --concurrency  parallel model calls (default 4)
  --soft-bytes   stop reading a call's stream after this many bytes once the answer is in (default 100663296)
  --max-findings kept findings per run (default 40)
  --deadline-seconds  stop starting new model calls after this long in the paid phase (default 3600)
  --no-rules     do not attach the repository's AGENTS.md to the review
  --file-findings  with once: run the file step after the receipt is written
  --publish      actually write to Linear (default: print the plan and write nothing)
  --max-issues   issue clusters filed per run (default 8)
  --linear-cli   linear-trace.py path (default ${DEFAULT_LINEAR_CLI})

Exit codes: 0 ok, 1 some Linear writes failed, 2 invalid arguments.
`;
}

function parseArgs(argv) {
  const [head, ...rest] = argv;
  const command = head && !head.startsWith('--') ? head : undefined;
  const tokens = command ? rest : [head, ...rest].filter(Boolean);
  const options = { command, lenses: [], repos: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const takeValue = () => {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
      i += 1;
      return value;
    };
    switch (key) {
      case 'repos':
        options.repos = takeValue().split(',').map((v) => v.trim()).filter(Boolean);
        break;
      case 'lenses':
        options.lenses = takeValue().split(',').map((v) => v.trim()).filter(Boolean);
        break;
      case 'since':
        options.since = takeValue();
        break;
      case 'out':
        options.out = takeValue();
        break;
      case 'run':
        options.run = takeValue();
        break;
      case 'max-diff-bytes':
        options.maxDiffBytes = Number(takeValue());
        break;
      case 'concurrency':
        options.concurrency = Number(takeValue());
        break;
      case 'soft-bytes':
        options.softBytes = Number(takeValue());
        break;
      case 'deadline-seconds':
        options.deadlineSeconds = Number(takeValue());
        break;
      case 'max-findings':
        options.maxFindings = Number(takeValue());
        break;
      case 'interval':
        options.interval = Number(takeValue());
        break;
      case 'publish':
        options.publish = true;
        break;
      case 'file-findings':
        options.fileFindings = true;
        break;
      case 'max-issues':
        options.maxIssues = Number(takeValue());
        break;
      case 'linear-cli':
        options.linearCli = takeValue();
        break;
      case 'json':
        options.json = true;
        break;
      case 'no-rules':
        options.noRules = true;
        break;
      case 'help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: --${key}`);
    }
  }
  return options;
}

function localDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() - offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function runIdFrom(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function sumUsage(results) {
  const total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };
  for (const result of results) {
    const usage = result.usage;
    if (!usage) continue;
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.cachedInputTokens += usage.cachedInputTokens ?? 0;
    total.totalTokens += usage.totalTokens ?? 0;
  }
  return total;
}

function renderReport({ runDir, since, repos, prs, gate, calls, usage }) {
  const lines = [];
  lines.push(`# nightly-review — ${since} .. ${localDate(0)}`);
  lines.push('');
  lines.push(`Run directory: \`${runDir}\``);
  lines.push('');
  lines.push('## Volume');
  lines.push('');
  lines.push(`- repositories: ${repos.join(', ')}`);
  lines.push(`- merged PRs reviewed: ${prs.length}`);
  lines.push(`- lens calls: ${calls.length} (failed ${calls.filter((c) => !c.ok).length})`);
  lines.push(`- findings submitted: ${gate.stats.submitted}, kept: ${gate.stats.kept}, dropped: ${gate.stats.dropped}`);
  lines.push(`- tokens: in ${usage.inputTokens} (cached ${usage.cachedInputTokens}), out ${usage.outputTokens}`);
  lines.push('');
  lines.push('## Gate outcome');
  lines.push('');
  if (Object.keys(gate.stats.byReason).length === 0) {
    lines.push('- nothing dropped');
  } else {
    for (const [reason, count] of Object.entries(gate.stats.byReason)) {
      lines.push(`- ${reason}: ${count}`);
    }
  }
  lines.push('');

  if (gate.kept.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('None survived the gate.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Findings');
  lines.push('');
  for (const finding of gate.kept) {
    lines.push(`### ${finding.repo}#${finding.pr} — ${finding.file}:${finding.line}`);
    lines.push('');
    lines.push(`- kind: ${finding.kind}`);
    lines.push(`- lens: ${finding.lens} (${finding.model})`);
    lines.push(`- confidence: ${finding.confidence}`);
    if (finding.lineCorrected) lines.push('- line: corrected to the added line that contains the quote');
    lines.push(`- PR: ${finding.prUrl ?? ''}`);
    lines.push('');
    lines.push('```');
    lines.push(finding.quote);
    lines.push('```');
    lines.push('');
    lines.push(finding.why_matters ?? '');
    lines.push('');
  }
  return lines.join('\n');
}

async function executeOnce(options) {
  if (!options.repos || options.repos.length === 0) {
    throw new Error('--repos is required (e.g. --repos infra,yyaz-web)');
  }
  const since = options.since ?? localDate(1);
  const maxDiffBytes = options.maxDiffBytes ?? 40_000;
  const concurrency = options.concurrency ?? 4;
  const softBytes = options.softBytes ?? 96 * 1024 * 1024;
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const deadlineSeconds = options.deadlineSeconds ?? 3600;
  const stateDir = options.out ?? DEFAULT_STATE_DIR;
  const lenses = selectLenses(options.lenses);
  const runDir = path.join(stateDir, runIdFrom());
  await mkdir(runDir, { recursive: true });

  // Progress always goes to stderr, including under --json: a timer run has no
  // other way to distinguish slow work from a hang. --json controls stdout only.
  const log = (message) => {
    process.stderr.write(`${message}\n`);
  };
  log(`run: ${runDir}`);
  log(`since: ${since}, lenses: ${lenses.map((lens) => lens.id).join(',')}`);
  log(`deadline: ${deadlineSeconds}s from the first model call`);

  const startedAt = new Date().toISOString();
  const prs = [];
  for (const repo of options.repos) {
    try {
      const collected = await collectRepo({
        repo,
        since,
        runDir,
        maxDiffBytes,
        withRules: !options.noRules,
        log,
      });
      prs.push(...collected);
    } catch (error) {
      log(`${repo}: collection failed: ${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
  log(`collected ${prs.length} PR(s)`);

  const tasks = [];
  for (const pr of prs) {
    for (const lens of lenses) {
      tasks.push({
        meta: { repo: pr.repo, pr: pr.number, lens: lens.id },
        execute: () =>
          runLens({ prompt: buildPrompt({ repo: pr.repo, pr, lens }), lens, softBytes }),
      });
    }
  }

  // Raw results are written as each call finishes: a long run must show progress
  // and must survive being stopped half way.
  const rawDir = path.join(runDir, 'raw');
  await mkdir(rawDir, { recursive: true });
  // The deadline covers the paid phase only: collection is free and needs to
  // finish before the clock starts, or a slow GitHub would eat the budget.
  const deadline = makeDeadline(deadlineSeconds);
  const { results: calls, skipped } = await runAll({
    tasks,
    concurrency,
    shouldStop: () => deadline.reached(),
    onResult: (result) => {
      log(
        `${result.repo}#${result.pr} ${result.lens}: ${result.ok ? `${result.findings.length} findings` : result.error}`,
      );
      void writeFile(
        path.join(rawDir, `${result.repo}-${result.pr}-${result.lens}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
        'utf8',
      );
    },
  });

  const { kept, dropped, stats } = gateAcross({ prs, calls, maxFindings });
  const usage = sumUsage(calls);
  const finishedAt = new Date().toISOString();
  const deadlineReached = skipped > 0;
  if (deadlineReached) {
    log(`deadline reached: ${skipped} call(s) not started`);
  }

  const gate = { kept, dropped, stats };
  const receipt = {
    tool: 'nightly-review',
    version: 1,
    runDir,
    startedAt,
    finishedAt,
    since,
    repos: options.repos,
    deadline: {
      seconds: deadlineSeconds,
      reached: deadlineReached,
      skippedCalls: skipped,
      plannedCalls: tasks.length,
    },
    lenses: lenses.map((lens) => ({ id: lens.id, model: lens.model })),
    prs: prs.map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      mergedAt: pr.mergedAt,
      additions: pr.additions,
      deletions: pr.deletions,
      truncated: pr.truncated,
      rules: (pr.rules ?? []).map((doc) => ({
        path: doc.path,
        bytes: doc.text.length,
        truncated: doc.truncated,
      })),
    })),
    calls: calls.map((call) => ({
      repo: call.repo,
      pr: call.pr,
      lens: call.lens,
      model: call.model,
      ok: call.ok,
      error: call.error ?? null,
      latencyMs: call.latencyMs,
      streamBytes: call.streamBytes ?? null,
      streamTrimmed: call.streamTrimmed ?? false,
      retriedForSize: call.retriedForSize ?? false,
      findings: call.findings.length,
      usage: call.usage,
      cost: call.cost,
    })),
    usage,
    gate: stats,
    dropped: dropped.slice(0, 200),
    findings: kept,
    linear: { filed: 0, note: 'not filed: issue creation is a separate approved step' },
  };

  let filingFailed = false;
  if (options.fileFindings) {
    const filing = await fileFindings({
      runDir,
      findings: kept,
      stateDir,
      options,
      log,
    });
    receipt.linear = filing.receiptBlock;
    // An unattended run must not look clean when a Linear write failed: the exit
    // code is the only signal launchd keeps.
    filingFailed = (filing.result?.errors?.length ?? 0) > 0;
  }

  await writeFile(path.join(runDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(runDir, 'report.md'),
    `${renderReport({ runDir, since, repos: options.repos, prs, gate, calls, usage })}\n`,
    'utf8',
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    process.stdout.write(
      `kept ${stats.kept}/${stats.submitted} findings, ${calls.filter((c) => !c.ok).length} failed call(s)\n` +
        `report: ${path.join(runDir, 'report.md')}\nrecheck: nightly-review recheck --run ${runDir}\n`,
    );
  }
  return filingFailed ? 1 : 0;
}

function gateAcross({ prs, calls, maxFindings }) {
  const byPr = new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]));
  const filesByPr = new Map();
  for (const [key, pr] of byPr) filesByPr.set(key, indexDiff(pr.diff));

  const submitted = [];
  for (const call of calls) {
    if (!call.ok) continue;
    const key = `${call.repo}#${call.pr}`;
    const pr = byPr.get(key);
    for (const finding of call.findings) {
      submitted.push({ ...finding, repo: call.repo, pr: call.pr, prUrl: pr?.url });
    }
  }

  // A finding is verified against its own PR diff, so a model cannot launder a
  // guess by attributing it to a different pull request.
  const kept = [];
  const dropped = [];
  const stats = { submitted: 0, kept: 0, dropped: 0, byReason: {} };
  for (const [key, files] of filesByPr) {
    const scoped = submitted.filter((finding) => `${finding.repo}#${finding.pr}` === key);
    const result = gateFindings(scoped, files, { maxFindings });
    kept.push(...result.kept);
    dropped.push(...result.dropped.map((entry) => ({ ...entry, prKey: key })));
    stats.submitted += result.stats.submitted;
    stats.dropped += result.stats.dropped;
    for (const [reason, count] of Object.entries(result.stats.byReason)) {
      stats.byReason[reason] = (stats.byReason[reason] ?? 0) + count;
    }
  }
  kept.sort((a, b) => b.confidence - a.confidence);
  const capped = kept.slice(0, maxFindings);
  for (const finding of kept.slice(maxFindings)) {
    dropped.push({
      reason: 'over_run_cap',
      prKey: `${finding.repo}#${finding.pr}`,
      file: finding.file,
      lens: finding.lens,
      quote: finding.quote,
    });
    stats.byReason.over_run_cap = (stats.byReason.over_run_cap ?? 0) + 1;
    stats.dropped += 1;
  }
  stats.kept = capped.length;
  return { kept: capped, dropped, stats };
}

async function fileFindings({ runDir, findings, stateDir, options, log }) {
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const statePath = path.join(stateDir, DEFAULT_FILED_STATE);
  const state = existsSync(statePath)
    ? JSON.parse(await readFile(statePath, 'utf8'))
    : { version: 1, clusters: {} };
  const runId = path.basename(runDir);
  const clusters = clusterFindings(findings);
  const actions = planFiling({ clusters, state, maxIssues });

  if (!options.publish) {
    // Offline by design: a dry run must not need the credential or the network.
    for (const action of actions) {
      log(`file: plan ${action.type} ${action.cluster.key}${action.reason ? ` (${action.reason})` : ''}`);
    }
    if (actions.length === 0) log('file: nothing to file (no kept findings)');
    log('file: plan only — add --publish to write to Linear');
    return {
      plan: actions,
      receiptBlock: {
        filed: 0,
        published: false,
        planned: actions.map((action) => ({
          type: action.type,
          key: action.cluster.key,
          reason: action.reason ?? null,
        })),
        note: 'dry run: --publish not given',
      },
    };
  }

  const projectMap = await loadProjectMap();
  const client = createLinearClient({
    cli: options.linearCli ?? DEFAULT_LINEAR_CLI,
    projectMap,
    publish: true,
  });
  const { state: nextState, result } = await applyFiling({ actions, client, state, runId });
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');

  log(`file: ${summarizeFiling(result)}`);
  for (const created of result.created) {
    log(`file: created ${created.issue.id} ${created.issue.url ?? ''}`);
  }
  for (const skipped of result.skipped) log(`file: skipped ${skipped.key} (${skipped.reason})`);
  for (const failure of result.errors) log(`file: failed ${failure.key}: ${failure.error}`);

  return {
    result,
    receiptBlock: {
      filed: result.created.length,
      published: true,
      commented: result.commented.length,
      skipped: result.skipped,
      errors: result.errors,
      issues: result.created.map((created) => ({
        key: created.key,
        id: created.issue.id,
        url: created.issue.url,
      })),
    },
  };
}

async function executeFile(options) {
  const runDir = options.run;
  if (!runDir || !existsSync(runDir)) throw new Error('--run DIR is required and must exist');
  const receiptPath = path.join(runDir, 'receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const log = (message) => {
    process.stderr.write(`${message}\n`);
  };
  const filing = await fileFindings({
    runDir,
    findings: receipt.findings ?? [],
    stateDir: options.out ?? DEFAULT_STATE_DIR,
    options,
    log,
  });
  if (options.publish) {
    receipt.linear = filing.receiptBlock;
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(filing.receiptBlock, null, 2)}\n`);
  } else if (filing.result) {
    process.stdout.write(`${summarizeFiling(filing.result)}\n`);
  } else {
    const planned = filing.plan.filter((action) => action.type === 'create').length;
    process.stdout.write(`plan only: ${planned} issue(s) would be created\n`);
  }
  return filing.result?.errors?.length ? 1 : 0;
}

async function executeRecheck(options) {
  const runDir = options.run;
  if (!runDir || !existsSync(runDir)) throw new Error('--run DIR is required and must exist');
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const { readFile, readdir } = await import('node:fs/promises');

  const prs = [];
  const inputDir = path.join(runDir, 'input');
  for (const repo of await readdir(inputDir)) {
    for (const file of await readdir(path.join(inputDir, repo))) {
      if (!file.endsWith('.json')) continue;
      prs.push(JSON.parse(await readFile(path.join(inputDir, repo, file), 'utf8')));
    }
  }
  const calls = [];
  const rawDir = path.join(runDir, 'raw');
  if (existsSync(rawDir)) {
    for (const file of await readdir(rawDir)) {
      if (!file.endsWith('.json')) continue;
      calls.push(JSON.parse(await readFile(path.join(rawDir, file), 'utf8')));
    }
  }

  const { kept, dropped, stats } = gateAcross({ prs, calls, maxFindings });
  const receiptPath = path.join(runDir, 'receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.gate = stats;
  receipt.dropped = dropped.slice(0, 200);
  receipt.findings = kept;
  receipt.recheckedAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(runDir, 'report.md'),
    `${renderReport({ runDir, since: receipt.since, repos: receipt.repos, prs, gate: { kept, dropped, stats }, calls, usage: receipt.usage })}\n`,
    'utf8',
  );
  process.stdout.write(
    `recheck kept ${stats.kept}/${stats.submitted}, dropped ${stats.dropped} (${JSON.stringify(stats.byReason)})\n`,
  );
  return 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.command) {
    process.stdout.write(usage());
    return 0;
  }
  switch (options.command) {
    case 'once':
      return executeOnce(options);
    case 'recheck':
      return executeRecheck(options);
    case 'file':
      return executeFile(options);
    case 'loop': {
      const interval = options.interval ?? 86_400;
      if (interval < 60) throw new Error('--interval must be at least 60 seconds');
      process.stderr.write(`loop: every ${interval}s; stop with Ctrl-C\n`);
      for (;;) {
        await executeOnce(options).catch((error) =>
          process.stderr.write(`once failed: ${String(error?.message ?? error)}\n`),
        );
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      }
    }
    default:
      process.stderr.write(`unknown command: ${options.command}\n\n${usage()}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (error) => {
    process.stderr.write(`nightly-review: ${String(error?.message ?? error)}\n`);
    process.exit(2);
  },
);
