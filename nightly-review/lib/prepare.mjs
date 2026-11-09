// Deliberately imports neither runner, decisions nor the Linear adapter.
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectRepo } from './collect.mjs';
import { assertOwner, withLock, immutableJson, atomicWrite, readOptional, digest, jsonBytes } from './state.mjs';

export function validateSchedule(config, projectMap) {
  const keys = ['version', 'ownerHost', 'timezone', 'repos', 'hour', 'minute'];
  if (!config || Object.keys(config).some((k) => !keys.includes(k)) || config.version !== 1 || config.hour !== 5 || config.minute !== 0 || typeof config.ownerHost !== 'string' || !config.ownerHost || !Array.isArray(config.repos) || !config.repos.length || new Set(config.repos).size !== config.repos.length || config.repos.some((r) => !/^[A-Za-z0-9_-]+$/.test(r) || !projectMap[r])) throw new Error('invalid schedule or unmapped repository');
  if (typeof config.timezone !== 'string') throw new Error('invalid timezone');
  new Intl.DateTimeFormat('en-US', { timeZone: config.timezone }).format();
  return config;
}

function localDay(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export async function prepare({ configPath, out, mode, collect = collectRepo, clock = () => new Date(), host = os.hostname(), projectMap }) {
  if (!['scheduled', 'shadow'].includes(mode)) throw new Error('prepare mode must be scheduled or shadow');
  const rawConfig = await readFile(configPath, 'utf8');
  const mapping = projectMap ?? JSON.parse(await readFile(new URL('../config/projects.json', import.meta.url), 'utf8')).repos;
  const config = validateSchedule(JSON.parse(rawConfig), mapping);
  if (config.ownerHost !== host || Intl.DateTimeFormat().resolvedOptions().timeZone !== config.timezone) throw new Error('schedule host/timezone mismatch');
  return withLock(out, async () => {
    const owner = mode === 'scheduled' ? await assertOwner(out, { host }) : null;
    const started = clock();
    const day = localDay(started, config.timezone);
    const indexPath = path.join(out, 'preparation.json');
    const previousRaw = await readOptional(indexPath);
    const previous = previousRaw ? JSON.parse(previousRaw) : { version: 1 };
    const configHash = digest(rawConfig);
    if (previous.day === day && previous.configHash === configHash && previous.complete && previous.mode === mode) {
      return { version: 1, command: 'prepare', status: 'duplicate', runDir: previous.runDir, counters: { modelCalls: 0, decisions: 0, linearMutations: 0, reviewSpawns: 0 } };
    }
    const runDir = path.join(out, 'prepared', `${started.toISOString().replace(/[:.]/g, '-')}-${mode}`);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    // One-day overlap from last successful collection, never advance on partial coverage.
    const watermark = previous.complete ? previous.watermark : previous.lastSuccess;
    const since = new Date((watermark ? Date.parse(watermark) : started.getTime()) - 86400000).toISOString().slice(0, 10);
    const queue = [];
    const coverage = [];
    for (const repo of config.repos) {
      try {
        const prs = await collect({ repo, since, runDir, maxDiffBytes: 40000, withRules: true });
        const identities = new Set();
        for (const pr of prs) {
          const identity = `${repo}#${pr.number}:${pr.headRefOid}`;
          if (!identities.has(identity)) { identities.add(identity); queue.push(pr); }
        }
        // Collector's list cap is 100. A full page cannot prove enumeration complete.
        coverage.push({ repo, count: prs.length, complete: prs.length < 100, reason: prs.length >= 100 ? 'collection_cap' : null });
      } catch (error) {
        coverage.push({ repo, complete: false, reason: error.code === 'ENOENT' ? 'missing_binary' : 'collection_failed' });
      }
    }
    const complete = coverage.every((r) => r.complete);
    const queueHash = await immutableJson(path.join(runDir, 'queue.json'), { version: 1, prs: queue });
    const finished = clock();
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(started);
    const receipt = {
      version: 1, command: 'prepare', mode, status: complete ? 'prepared' : 'incomplete',
      startedAt: started.toISOString(), finishedAt: finished.toISOString(),
      calendarObservation: 'manual-or-launchd-unattributed', localDay: day, scheduledLocalTime: '05:00', actualLocalTime: local,
      // launchd does not pass its trigger reason. Correlate with launchd logs at the real tick.
      host, generation: owner?.generation ?? null, configHash, queueHash, since, coverage, runDir,
      counters: { prs: queue.length, modelCalls: 0, decisions: 0, linearMutations: 0, reviewSpawns: 0 },
      costUsd: 0, review: 'deferred_to_supervised_execution',
    };
    await immutableJson(path.join(runDir, 'receipt.json'), receipt);
    await atomicWrite(indexPath, jsonBytes({ version: 1, mode, day, configHash, complete, runDir, watermark: complete ? started.toISOString() : null, lastSuccess: complete ? started.toISOString() : watermark ?? null }), { expectedHash: previousRaw === null ? null : digest(previousRaw) });
    return receipt;
  });
}

export async function evaluateLocal(runDir) {
  const bytes = await readFile(path.join(runDir, 'queue.json'), 'utf8');
  const receipt = JSON.parse(await readFile(path.join(runDir, 'receipt.json'), 'utf8'));
  if (receipt.queueHash !== digest(bytes)) throw new Error('queue hash mismatch');
  const queue = JSON.parse(bytes);
  if (queue.version !== 1 || !Array.isArray(queue.prs)) throw new Error('invalid preparation queue');
  return { version: 1, command: 'evaluate-local', status: 'planned', sourceHash: digest(bytes), prs: queue.prs.length, truncated: queue.prs.filter((p) => p.truncated).length, counters: { modelCalls: 0, linearMutations: 0 }, review: 'not executed' };
}
