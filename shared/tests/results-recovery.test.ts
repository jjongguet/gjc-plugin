import { afterEach, expect, spyOn, test } from 'bun:test';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendPluginOutcome, inspectPluginOutcomeLock, readPluginOutcomeSnapshot } from '../lib/results';
import type { PluginOutcome } from '../lib/results';
// The released v0.0.27 journal module, byte-identical to `git show v0.0.27:shared/lib/results.ts`
// (also the copy inlined in the installed 0.0.17 bundles). It is the decoder every still-running
// old session uses, so new writes must stay readable and appendable by it.
import * as released from './fixtures/results-v0.0.27';

const RELEASED_SHA256 = '21d78dcbe8e28907e1160d148ccadd5cd4f9cc760fa860e590f89a1812193fa4';
const here = path.dirname(fileURLToPath(import.meta.url));
const resultsModule = path.join(here, '..', 'lib', 'results.ts');
const owned: string[] = [];
const children: { kill: () => void }[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of owned.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function fixture(plugin = 'jev-advisor') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'plugin-recovery-')));
  owned.push(root);
  const baseDir = path.join(root, '.gjc-plugin');
  const journal = path.join(baseDir, plugin, 'journal', 'v1');
  return { root, baseDir, journal, lockPath: path.join(journal, '.append.lock'), guardPath: path.join(baseDir, plugin, 'journal', '.append.reclaim.lock') };
}
const check: PluginOutcome = { operation: 'check', toolCallDigest: 'a'.repeat(64), durationMs: 812, check: { status: 'decision', verdict: 'correct', confidence: 0.9, confidenceKind: 'provider_choice' } };
async function missing(file: string) { try { await fs.lstat(file); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } }
async function journalLines(journal: string): Promise<string[]> {
  const marker = JSON.parse(await fs.readFile(path.join(journal, 'inventory.json'), 'utf8'));
  const lines: string[] = [];
  for (const segment of marker.segments) {
    const body = await fs.readFile(path.join(journal, segment.name));
    expect(createHash('sha256').update(body).digest('hex')).toBe(segment.digest);
    lines.push(...body.toString('utf8').trimEnd().split('\n'));
  }
  return lines;
}
/** Seed a journal, then plant a lock with the given body and age. */
async function plantLock(baseDir: string, lockPath: string, body: string, ageMs: number, plugin = 'jev-advisor') {
  expect((await appendPluginOutcome(plugin as 'jev-advisor', check, { baseDir })).persisted).toBe(true);
  await fs.writeFile(lockPath, body, { mode: 0o600 });
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(lockPath, when, when);
  return fs.lstat(lockPath);
}
const meta = (pid: number, host = hostname()) => JSON.stringify({ v: 1, pid, host, createdAt: Date.now() - 3_600_000, nonce: '00000000-0000-4000-8000-000000000000' });
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  expect(child.status).toBe(0);
  return child.pid!;
}
function liveChild(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

test('released decoder fixture is byte-identical to the v0.0.27 release', async () => {
  const bytes = await fs.readFile(path.join(here, 'fixtures', 'results-v0.0.27.ts'));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(RELEASED_SHA256);
  const tag = spawnSync('git', ['show', 'v0.0.27:shared/lib/results.ts'], { cwd: here, maxBuffer: 8 * 1024 * 1024 });
  if (tag.status !== 0) { console.log('# provenance skip(no-tag): v0.0.27 is absent in this checkout; digest assertion above still ran'); return; }
  expect(createHash('sha256').update(tag.stdout).digest('hex')).toBe(RELEASED_SHA256);
});

test('a live owner is never reclaimed: own pid, foreign live child, EPERM pid 1, live pid under another host name', async () => {
  for (const [label, body, owner] of [
    ['own pid', meta(process.pid), 'live'],
    ['live child', meta(liveChild()), 'live'],
    ['EPERM pid 1', meta(1), 'live'],
    ['other host, live local pid', meta(process.pid, 'another-host.invalid'), 'foreign_host'],
  ] as const) {
    const { baseDir, journal, lockPath, guardPath } = await fixture();
    const before = await plantLock(baseDir, lockPath, body, 3_600_000);
    const result = await appendPluginOutcome('jev-advisor', check, { baseDir, lockTimeoutMs: 10, legacyStaleMs: 1 });
    expect({ label, ...result }).toEqual({ label, persisted: false, reason: 'store_busy', lock: { ageMs: expect.any(Number), owner } });
    expect(await fs.readFile(lockPath, 'utf8')).toBe(body);
    expect((await fs.lstat(lockPath)).ino).toBe(before.ino);
    expect(await missing(guardPath)).toBe(true);
    expect((await journalLines(journal)).length).toBe(1);
  }
});

test('a young legacy lock and an old lock below the bound are contention, not stale', async () => {
  const { baseDir, lockPath } = await fixture();
  await plantLock(baseDir, lockPath, '', 5_000);
  const result = await appendPluginOutcome('jev-advisor', check, { baseDir, lockTimeoutMs: 10 });
  expect(result).toMatchObject({ persisted: false, reason: 'store_busy', lock: { owner: 'unknown' } });
  expect(await missing(lockPath)).toBe(false);
});

test('a legacy empty stale lock is reclaimed exactly once under concurrent in-process waiters', async () => {
  const { baseDir, journal, lockPath, guardPath } = await fixture();
  await plantLock(baseDir, lockPath, '', 3_600_000);
  const results = await Promise.all(Array.from({ length: 6 }, (_, durationMs) => appendPluginOutcome('jev-advisor', { ...check, durationMs }, { baseDir, legacyStaleMs: 1 })));
  expect(results.some(result => result.persisted)).toBe(true);
  for (const result of results) expect(['stored', 'store_busy']).toContain(result.reason);
  expect(results.filter(result => result.reclaim === 'reclaimed').length).toBe(1);
  expect((await journalLines(journal)).length).toBe(1 + results.filter(result => result.persisted).length);
  expect(await missing(lockPath)).toBe(true);
  expect(await missing(guardPath)).toBe(true);
  expect((await fs.readdir(journal)).sort()).toEqual((await fs.readdir(journal)).filter(name => name === 'inventory.json' || name.endsWith('.jsonl')).sort());
});

async function appendInChildren(baseDir: string, count: number) {
  const script = `import { appendPluginOutcome } from ${JSON.stringify(resultsModule)};\n` +
    `const result = await appendPluginOutcome('jev-advisor', { operation: 'check', toolCallDigest: '${'b'.repeat(64)}', durationMs: Number(process.argv[2]), check: { status: 'no_decision', reason: 'unconfigured' } }, { baseDir: ${JSON.stringify(baseDir)}, legacyStaleMs: 1 });\n` +
    `process.stdout.write(JSON.stringify(result));\n`;
  const file = path.join(path.dirname(baseDir), 'child.ts');
  await fs.writeFile(file, script);
  const runs = Array.from({ length: count }, (_, index) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, [file, String(index)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error('child exit ' + code)));
  }));
  return Promise.all(runs);
}

test('multi-process waiters reclaim a legacy stale lock and a dead-pid lock exactly once each', async () => {
  for (const body of ['', meta(deadPid())]) {
    const { baseDir, journal, lockPath, guardPath } = await fixture();
    await plantLock(baseDir, lockPath, body, 3_600_000);
    const results = await appendInChildren(baseDir, 5);
    expect(results.filter(result => result.reclaim === 'reclaimed').length).toBe(1);
    for (const result of results) expect(['stored', 'store_busy']).toContain(result.reason as string);
    expect((await journalLines(journal)).length).toBe(1 + results.filter(result => result.persisted).length);
    expect(await missing(lockPath)).toBe(true);
    expect(await missing(guardPath)).toBe(true);
  }
});

test('a dead-pid lock is reclaimed immediately without waiting for the legacy age bound', async () => {
  const { baseDir, journal, lockPath } = await fixture();
  await plantLock(baseDir, lockPath, meta(deadPid()), 2_000);
  const result = await appendPluginOutcome('jev-advisor', check, { baseDir });
  expect(result).toMatchObject({ persisted: true, reason: 'stored', reclaim: 'reclaimed' });
  expect((await journalLines(journal)).length).toBe(2);
});

test('a stale reclaim guard fails closed: no takeover, no reclaim, no second writer', async () => {
  const { baseDir, journal, lockPath, guardPath } = await fixture();
  const lockBefore = await plantLock(baseDir, lockPath, '', 3_600_000);
  await fs.writeFile(guardPath, meta(deadPid()), { mode: 0o600 });
  const guardBefore = await fs.lstat(guardPath);
  const local = await Promise.all(Array.from({ length: 4 }, () => appendPluginOutcome('jev-advisor', check, { baseDir, lockTimeoutMs: 10, legacyStaleMs: 1 })));
  const remote = await appendInChildren(baseDir, 3);
  for (const result of [...local, ...remote]) {
    expect(result).toMatchObject({ persisted: false, reason: 'store_busy', reclaim: 'blocked_guard', lock: { owner: 'unknown', guardOwner: 'dead', reclaimBlocked: true } });
  }
  expect((await fs.lstat(lockPath)).ino).toBe(lockBefore.ino);
  expect((await fs.lstat(guardPath)).ino).toBe(guardBefore.ino);
  expect((await journalLines(journal)).length).toBe(1);
  const snapshot = await readPluginOutcomeSnapshot('jev-advisor', { baseDir });
  expect(snapshot).toMatchObject({ status: 'unavailable', reason: 'store_busy', lock: { owner: 'unknown', guardOwner: 'dead', reclaimBlocked: true } });
});

test('a successor lock that replaces the judged stale lock before the guard is never removed', async () => {
  const { baseDir, journal, lockPath, guardPath } = await fixture();
  await plantLock(baseDir, lockPath, '', 3_600_000);
  const successor = meta(process.pid);
  const original = fs.open;
  let injected = false;
  const spy = spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    const flags = args[1];
    if (!injected && String(args[0]) === guardPath && typeof flags === 'number' && (flags & fsConstants.O_EXCL) !== 0) {
      // Another reclaimer finished first and a live writer now holds a fresh lock.
      injected = true;
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, successor, { mode: 0o600 });
    }
    return original(...args);
  }) as typeof fs.open);
  let result;
  try { result = await appendPluginOutcome('jev-advisor', check, { baseDir, lockTimeoutMs: 10, legacyStaleMs: 1 }); }
  finally { spy.mockRestore(); }
  expect(injected).toBe(true);
  expect(result).toMatchObject({ persisted: false, reason: 'store_busy', lock: { owner: 'live' } });
  expect(result.reclaim).toBeUndefined();
  expect(await fs.readFile(lockPath, 'utf8')).toBe(successor);
  expect(await missing(guardPath)).toBe(true);
  expect((await journalLines(journal)).length).toBe(1);
});

test('a lock name lost after publication keeps the stored outcome and never unlinks a successor', async () => {
  const { baseDir, journal, lockPath } = await fixture();
  expect((await appendPluginOutcome('jev-advisor', check, { baseDir })).persisted).toBe(true);
  const markerPath = path.join(journal, 'inventory.json');
  const successor = meta(process.pid);
  const original = fs.rename;
  const spy = spyOn(fs, 'rename').mockImplementation((async (...args: Parameters<typeof fs.rename>) => {
    await original(...args);
    if (String(args[1]) === markerPath) { await fs.unlink(lockPath); await fs.writeFile(lockPath, successor, { mode: 0o600 }); }
  }) as typeof fs.rename);
  let result;
  try { result = await appendPluginOutcome('jev-advisor', check, { baseDir }); }
  finally { spy.mockRestore(); }
  expect(result).toMatchObject({ persisted: true, reason: 'stored', lockLost: true });
  expect(await fs.readFile(lockPath, 'utf8')).toBe(successor);
  expect((await journalLines(journal)).length).toBe(2);
});

test('readers never reclaim and report the stale lock owner and age', async () => {
  const { baseDir, lockPath } = await fixture();
  const before = await plantLock(baseDir, lockPath, '', 3_600_000);
  const snapshot = await readPluginOutcomeSnapshot('jev-advisor', { baseDir });
  expect(snapshot).toMatchObject({ status: 'unavailable', reason: 'store_busy', records: [], lock: { owner: 'unknown' } });
  expect(snapshot.lock!.ageMs).toBeGreaterThanOrEqual(3_500_000);
  expect(await inspectPluginOutcomeLock('jev-advisor', { baseDir })).toMatchObject({ status: 'held', lock: { owner: 'unknown' } });
  expect((await fs.lstat(lockPath)).ino).toBe(before.ino);
  expect(await inspectPluginOutcomeLock('jev-telemetry', { baseDir })).toEqual({ status: 'none' });
});

test('an unsafe stale lock fails closed and is never removed', async () => {
  const { baseDir, lockPath } = await fixture();
  await plantLock(baseDir, lockPath, '', 3_600_000);
  await fs.chmod(lockPath, 0o644);
  expect(await appendPluginOutcome('jev-advisor', check, { baseDir, lockTimeoutMs: 10, legacyStaleMs: 1 })).toEqual({ persisted: false, reason: 'unsafe_path' });
  expect(await missing(lockPath)).toBe(false);
});

test('new writes stay appendable and readable by the released decoder; extended keys live only in jev-telemetry', async () => {
  const { baseDir, journal } = await fixture();
  // New bundle: legacy-compatible check record plus a joined telemetry record.
  expect((await appendPluginOutcome('jev-advisor', check, { baseDir })).persisted).toBe(true);
  const telemetry: PluginOutcome = { operation: 'check', toolCallDigest: check.toolCallDigest, durationMs: 812, check: { status: 'decision', verdict: 'correct', provider: 'jev', model: 'typesafe/jev-1.14', sessionKey: '0123456789abcdef', usage: { promptTokens: 1200, completionTokens: 0, totalTokens: 1200 } } };
  expect((await appendPluginOutcome('jev-telemetry', telemetry, { baseDir })).persisted).toBe(true);
  // A metadata lock left behind by a new-bundle writer is still a plain busy lock to the old one.
  // Old bundle appends after new records and its snapshot reads every line.
  expect(await released.appendPluginOutcome('jev-advisor', { operation: 'check', toolCallDigest: 'c'.repeat(64), check: { status: 'no_decision', reason: 'provider_error' } }, { baseDir })).toMatchObject({ persisted: true, reason: 'stored' });
  const old = await released.readPluginOutcomeSnapshot('jev-advisor', { baseDir });
  expect(old).toMatchObject({ status: 'ok', reason: null });
  expect(old.records.length).toBe(2);
  // New reader reads lines the old writer produced.
  expect((await readPluginOutcomeSnapshot('jev-advisor', { baseDir })).records.length).toBe(2);
  const tele = await readPluginOutcomeSnapshot('jev-telemetry', { baseDir });
  expect(tele).toMatchObject({ status: 'ok' });
  expect(tele.records[0]).toMatchObject({ toolCallDigest: check.toolCallDigest, check: { provider: 'jev', model: 'typesafe/jev-1.14', usage: { promptTokens: 1200 } } });
  // The legacy namespace refuses extended keys, so a new bundle cannot break old readers.
  expect(await appendPluginOutcome('jev-advisor', { ...check, check: { ...check.check!, provider: 'jev' } }, { baseDir })).toEqual({ persisted: false, reason: 'invalid_metadata' });
  for (const line of await journalLines(journal)) expect(Object.keys(JSON.parse(line).check ?? {}).every(key => ['status', 'verdict', 'confidence', 'confidenceKind', 'probabilities', 'reason'].includes(key))).toBe(true);
});

test('jev-telemetry accepts only bounded joined check records', async () => {
  const { baseDir } = await fixture('jev-telemetry');
  const base: PluginOutcome = { operation: 'check', toolCallDigest: 'd'.repeat(64), durationMs: 1, check: { status: 'no_decision', reason: 'provider_error', provider: 'jev', model: 'typesafe/jev-1.14', httpStatus: 503 } };
  expect((await appendPluginOutcome('jev-telemetry', base, { baseDir })).persisted).toBe(true);
  const invalid: unknown[] = [
    { ...base, check: { ...base.check, httpStatus: 99 } },
    { ...base, check: { ...base.check, httpStatus: 600 } },
    { ...base, check: { ...base.check, model: 'bad\nmodel' } },
    { ...base, check: { ...base.check, provider: 'Bad Provider' } },
    { ...base, check: { ...base.check, usage: {} } },
    { ...base, check: { ...base.check, usage: { promptTokens: -1 } } },
    { ...base, check: { ...base.check, sessionKey: 'not-hex' } },
    { ...base, operation: 'task_advice' },
    { operation: 'check', durationMs: 1, check: base.check },
    { ...base, freshness: 'fresh' },
  ];
  for (const value of invalid) expect(await appendPluginOutcome('jev-telemetry', value as PluginOutcome, { baseDir })).toEqual({ persisted: false, reason: 'invalid_metadata' });
  // The widest valid record still fits the 4 KiB line cap.
  const widest: PluginOutcome = { operation: 'check', toolCallDigest: 'e'.repeat(64), durationMs: Number.MAX_SAFE_INTEGER, check: { status: 'decision', verdict: 'unsure', confidence: 0.12345678901234567, confidenceKind: 'provider_choice', probabilities: { correct: 0.12345678901234567, incorrect: 0.12345678901234567, unsure: 0.12345678901234567 }, reason: 'invalid_response', provider: 'p'.repeat(40), model: 'm'.repeat(64), httpStatus: 599, sessionKey: 'f'.repeat(16), usage: { promptTokens: 1e12, completionTokens: 1e12, totalTokens: 1e12, costMicroUsd: 1e12 } } };
  expect((await appendPluginOutcome('jev-telemetry', widest, { baseDir })).persisted).toBe(true);
});
