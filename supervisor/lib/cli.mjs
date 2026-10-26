// supervisor CLI — `once` collects, judges, reports and optionally steers one
// session; `loop` repeats it on a fixed interval inside a user-started tmux
// session. There is no daemon install, no session kill and no multi-target
// steer path here.
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { collectSessions } from "./collect.mjs";
import { createCiResolver } from "./ci.mjs";
import { resolveJudgment } from "./decide.mjs";
import { defaultRunner } from "./exec.mjs";
import { formatSteerMessage, sendDiscord, steerSession } from "./intervene.mjs";
import { judgeSession } from "./judge.mjs";
import {
  appendEvents,
  buildSnapshot,
  buildSummary,
  eventsFor,
  loadPreviousSnapshot,
  sessionLine,
  snapshotPaths,
  writeSnapshot,
} from "./report.mjs";

export const DEFAULT_INTERVAL_SECONDS = 600;
export const MIN_INTERVAL_SECONDS = 10;
const STEERABLE_STATES = new Set(["stalled", "thrashing"]);

const USAGE = `usage:
  supervisor once [--out DIR] [--no-discord] [--no-mini] [--steer TARGET] [--dry-run] [--json]
  supervisor loop [--interval SECONDS] [--count N] [--out DIR] [--no-discord] [--no-mini] [--steer TARGET] [--dry-run]

  --interval   seconds between loop runs (default ${DEFAULT_INTERVAL_SECONDS}, minimum ${MIN_INTERVAL_SECONDS})
  --count      stop after N loop runs (default: run until stopped)
  --steer      one lane session (lane-<name>, <name> or lane:<name>) to nudge; single target only
  --dry-run    collect and judge, print the report, touch no session and no webhook
  --no-discord skip the Discord summary; --no-mini skip the mini host
  --out        state directory (default ~/.gjc-plugin/supervisor)

  Discord webhook: DISCORD_REPORT_WEBHOOK_URL. Mini host: MINI_HOST (default macmini).`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return { command: "help" };
  if (command !== "once" && command !== "loop") throw new Error(`unknown command: ${command}`);
  const options = {
    command,
    out: path.join(os.homedir(), ".gjc-plugin", "supervisor"),
    discord: true,
    includeMini: true,
    steer: null,
    dryRun: false,
    json: false,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    count: null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const next = () => {
      index += 1;
      if (index >= rest.length) throw new Error(`missing value for ${flag}`);
      return rest[index];
    };
    switch (flag) {
      case "--out":
        options.out = next();
        break;
      case "--no-discord":
        options.discord = false;
        break;
      case "--no-mini":
        options.includeMini = false;
        break;
      case "--steer": {
        if (options.steer !== null) throw new Error("--steer accepts exactly one session");
        options.steer = next();
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--interval": {
        const value = Number(next());
        if (!Number.isInteger(value) || value < MIN_INTERVAL_SECONDS) throw new Error(`--interval must be an integer >= ${MIN_INTERVAL_SECONDS}`);
        options.intervalSeconds = value;
        break;
      }
      case "--count": {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1) throw new Error("--count must be a positive integer");
        options.count = value;
        break;
      }
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return options;
}

function applyHistory(sessions, previous, now) {
  const priorById = new Map((previous?.sessions ?? []).map(session => [session.id, session]));
  for (const session of sessions) {
    const prior = priorById.get(session.id);
    session.firstSeenAt = prior?.firstSeenAt ?? new Date(now).toISOString();
    session.dirtyDelta =
      prior && Number.isFinite(prior.dirty) && Number.isFinite(session.dirty) ? session.dirty - prior.dirty : null;
    if (session.ageMinutes === null && prior?.firstSeenAt) {
      const seen = Date.parse(prior.firstSeenAt);
      if (Number.isFinite(seen)) session.ageMinutes = Math.max(0, Math.floor((now - seen) / 60000));
    }
  }
}

export function resolveSteerTarget(sessions, requested) {
  const laneSessions = sessions.filter(session => session.target === "lane");
  const key = requested.startsWith("lane:") || requested.startsWith("lane-") ? requested : `lane:${requested}`;
  const matches = laneSessions.filter(session => session.id === key || session.tmuxSession === requested);
  if (matches.length === 1) return { session: matches[0] };
  const known = laneSessions.map(session => session.tmuxSession ?? session.id).join(", ") || "none";
  return { error: matches.length === 0 ? `unknown lane session: ${requested} (known: ${known})` : `ambiguous lane session: ${requested}` };
}

let runCounter = 0;
export function nextRunId(now) {
  runCounter += 1;
  return `${new Date(now).toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${String(runCounter).padStart(2, "0")}`;
}

/**
 * @param {object} options parsed options
 * @param {object} [deps] test seams
 */
export async function runOnce(options, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const runner = deps.runner ?? defaultRunner;
  const write = deps.stdout ?? (line => process.stdout.write(`${line}\n`));
  const runId = deps.runId ?? nextRunId(now);
  const previous = deps.previous ?? (await loadPreviousSnapshot(options.out));
  const collect = deps.collectSessions ?? collectSessions;
  const { sessions, errors } = await collect({
    runner,
    now,
    includeMini: options.includeMini,
    miniHost: deps.miniHost ?? process.env.MINI_HOST ?? "macmini",
  });
  applyHistory(sessions, previous, now);

  const judgments = [];
  for (const session of sessions) {
    const verdict = judgeSession(session, { now, previous });
    const resolved = await resolveJudgment(session, verdict, {
      runner,
      decisionAsk: deps.decisionAsk,
      model: deps.decisionModel,
      now,
    });
    session.judgmentState = resolved.state;
    judgments.push({
      id: resolved.id,
      state: resolved.state,
      reasons: resolved.reasons,
      source: resolved.source,
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(resolved.confidence !== undefined ? { confidence: resolved.confidence } : {}),
      ...(resolved.error ? { error: resolved.error } : {}),
    });
  }

  // CI reads go to the public GitHub API without credentials in this workspace,
  // so they run after judging and are spent on the sessions that matter first.
  const ciResolver = deps.ciResolver ?? (await createCiResolver({ cacheFile: path.join(options.out, "ci-cache.json"), now, fetchImpl: deps.fetchImpl }));
  const ciPriority = { stalled: 0, thrashing: 1, progressing: 2, starting: 3, unknown: 4 };
  for (const session of [...sessions].sort((a, b) => (ciPriority[a.judgmentState] ?? 9) - (ciPriority[b.judgmentState] ?? 9))) {
    session.ci = await ciResolver.resolve(session);
  }

  const interventions = [];
  if (options.steer) {
    const resolved = resolveSteerTarget(sessions, options.steer);
    if (resolved.error) throw new UsageError(resolved.error);
    const session = resolved.session;
    const judgment = judgments.find(entry => entry.id === session.id);
    const target = session.tmuxSession;
    const marker = `sv-${runId.slice(-6)}`;
    const message = formatSteerMessage({ session, judgment, marker });
    if (!STEERABLE_STATES.has(judgment.state)) {
      interventions.push({
        mode: options.dryRun ? "dry-run" : "real",
        target,
        delivered: false,
        verified: false,
        marker,
        command: [],
        error: `skipped_not_stalled:${judgment.state}`,
        message,
      });
    } else {
      interventions.push(await steerSession({ target, message, marker, dryRun: options.dryRun, runner, settleMs: deps.settleMs }));
    }
  }

  const snapshot = buildSnapshot({
    now,
    runId,
    host: { hostname: os.hostname(), miniHost: options.includeMini ? (deps.miniHost ?? process.env.MINI_HOST ?? "macmini") : null },
    sessions,
    judgments,
    interventions,
    errors,
  });
  const paths = await writeSnapshot({ outDir: options.out, snapshot, now });

  if (options.discord && !options.dryRun) {
    const webhookUrl = deps.webhookUrl ?? process.env.DISCORD_REPORT_WEBHOOK_URL;
    snapshot.discord = await sendDiscord({ webhookUrl, content: buildSummary(snapshot), fetchImpl: deps.fetchImpl });
    await writeSnapshot({ outDir: options.out, snapshot, now });
  }
  if (ciResolver.flush) await ciResolver.flush();
  await appendEvents(options.out, eventsFor(snapshot));

  const summary = buildSummary(snapshot);
  if (options.json) write(JSON.stringify(snapshot, null, 2));
  else {
    write(summary);
    if (options.dryRun) write("\n(dry-run: no steer, no Discord)");
    if (snapshot.discord) write(`discord: ${snapshot.discord.ok ? `sent (${snapshot.discord.status})` : `${snapshot.discord.skipped ? "skipped" : "failed"}: ${snapshot.discord.error}`}`);
    write(`snapshot: ${paths.snapshot}`);
  }
  return { snapshot, paths, summary };
}

export class UsageError extends Error {}

/** Sleeps up to `ms`, waking early when `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runLoop(options, deps = {}) {
  const write = deps.stdout ?? (line => process.stdout.write(`${line}\n`));
  const sleepImpl = deps.sleep ?? sleep;
  const controller = deps.controller ?? new AbortController();
  const limit = options.count ?? Number.POSITIVE_INFINITY;
  let iteration = 0;
  while (iteration < limit && !controller.signal.aborted) {
    iteration += 1;
    const started = deps.now ? deps.now() : Date.now();
    try {
      const result = await runOnce({ ...options, json: false }, deps);
      write(`[loop ${iteration}] ${sessionLineCounts(result.snapshot)}`);
    } catch (error) {
      write(`[loop ${iteration}] error: ${error.message}`);
      if (error instanceof UsageError) throw error;
    }
    if (iteration >= limit || controller.signal.aborted) break;
    await sleepImpl(options.intervalSeconds * 1000, controller.signal);
  }
  return iteration;
}

function sessionLineCounts(snapshot) {
  const parts = Object.entries(snapshot.counts)
    .filter(([key]) => key !== "sessions")
    .map(([key, value]) => `${key}=${value}`);
  return `sessions=${snapshot.counts.sessions} ${parts.join(" ")}`;
}

export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? (line => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? (line => process.stderr.write(`${line}\n`));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.command === "help") {
    stdout(USAGE);
    return 0;
  }
  const controller = deps.controller ?? new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      stderr(`supervisor: ${signal}, stopping after the current run`);
      controller.abort();
    });
  }
  try {
    if (options.command === "loop") {
      await runLoop(options, { ...deps, stdout, controller });
      return 0;
    }
    await runOnce(options, deps);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    stderr(`supervisor: ${error.stack ?? error.message}`);
    return 1;
  }
}
