import { afterEach, expect, spyOn, test } from 'bun:test';
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendPluginOutcome, ensurePrivateResultDirectory, pluginResultsRoot, readPluginOutcomeSnapshot, readPrivateResultFile } from '../lib/results';
import type { PluginOutcome } from '../lib/results';

const owned: string[] = [];
afterEach(async () => { for (const dir of owned.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'plugin-results-')));
  owned.push(root);
  const baseDir = path.join(root, '.gjc-plugin');
  const journal = path.join(baseDir, 'verification-receipts', 'journal', 'v1');
  return { root, baseDir, journal };
}
const counts = { tests: 2, suites: 0, topLevel: 2, passed: 1, failed: 1, skipped: 0, todo: 0, cancelled: 0 };
const outcome: PluginOutcome = { operation: 'run', execution: { status: 'failed', reason: 'native_failure', counts }, assessment: { status: 'unavailable', reason: 'off' } };
async function inventory(journal: string) { return JSON.parse(await fs.readFile(path.join(journal, 'inventory.json'), 'utf8')); }
async function records(journal: string): Promise<Record<string, any>[]> {
  const marker = await inventory(journal);
  const lines: Record<string, any>[] = [];
  for (const segment of marker.segments) {
    const body = await fs.readFile(path.join(journal, segment.name));
    expect(body.length).toBe(segment.bytes);
    expect(createHash('sha256').update(body).digest('hex')).toBe(segment.digest);
    lines.push(...body.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)));
  }
  return lines;
}
async function missing(file: string): Promise<boolean> { try { await fs.lstat(file); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } }

test('journals preserve observed failures separately from assessment and storage outcomes', async () => {
  const { baseDir, journal } = await fixture();
  const value: PluginOutcome = { ...outcome, repositoryDigest: 'a'.repeat(64), receiptId: randomUUID(), toolCallDigest: 'b'.repeat(64), durationMs: 0, freshness: 'changed_during_run', stateOverrideIgnored: true, receiptStorage: { persisted: false, reason: 'store_full', count: 200, bytes: 2097152, nearCapacity: true }, evidenceStorage: { status: 'unavailable', reason: 'locked' } };
  const result = await appendPluginOutcome('verification-receipts', value, { baseDir });
  expect(result).toMatchObject({ persisted: true, reason: 'stored', rotated: 0, retainedSegments: 1 });
  const [stored] = await records(journal);
  expect(stored).toEqual({ schemaVersion: 1, plugin: 'verification-receipts', id: result.id, observedAt: stored.observedAt, ...value });
  expect(new Date(stored.observedAt).toISOString()).toBe(stored.observedAt);
  for (const dir of [baseDir, path.dirname(path.dirname(journal)), path.dirname(journal), journal]) expect((await fs.lstat(dir)).mode & 0o7777).toBe(0o700);
  for (const name of await fs.readdir(journal)) {
    const info = await fs.lstat(path.join(journal, name));
    expect(info.mode & 0o7777).toBe(0o600); expect(info.nlink).toBe(1); expect(info.uid).toBe(process.getuid!());
  }
  expect(await missing(path.join(journal, '.append.lock'))).toBe(true);
});

test('all handled operations and plugins accept missing repository/receipt identities', async () => {
  const { baseDir } = await fixture();
  const operations: PluginOutcome['operation'][] = ['run', 'status', 'advise', 'calibration', 'task_advice', 'task_launch', 'subagent_terminal'];
  for (const plugin of ['jev-advisor', 'verification-receipts', 'ui-regression'] as const) {
    for (const operation of operations) expect((await appendPluginOutcome(plugin, { operation, repositoryDigest: null, receiptId: null }, { baseDir })).persisted).toBe(true);
    expect((await records(path.join(baseDir, plugin, 'journal', 'v1'))).map(record => record.operation)).toEqual(operations);
  }
  const newer: { plugin: 'wiki' | 'rea' | 'backplan' | 'rrsi'; operations: PluginOutcome['operation'][] }[] = [
    { plugin: 'wiki', operations: ['wiki_query', 'wiki_propose'] },
    { plugin: 'rea', operations: ['rea_readiness'] },
    { plugin: 'backplan', operations: ['backplan_check'] },
    { plugin: 'rrsi', operations: ['capture', 'import', 'dream', 'status'] },
  ];
  for (const { plugin, operations: pluginOperations } of newer) {
    for (const operation of pluginOperations) expect((await appendPluginOutcome(plugin, { operation, repositoryDigest: null, receiptId: null }, { baseDir })).persisted).toBe(true);
    expect((await records(path.join(baseDir, plugin, 'journal', 'v1'))).map(record => record.operation)).toEqual(pluginOperations);
  }
}, 30000);

test('rrsi outcomes round-trip the action counters and reject malformed fields', async () => {
  const { baseDir } = await fixture();
  const value: PluginOutcome = {
    operation: 'dream', repositoryDigest: null, toolCallDigest: 'b'.repeat(64), durationMs: 12,
    rrsi: { action: 'dream', episodes: 2, attempts: 24, imported: 0, policies: 40, storage: 'ok' },
  };
  expect((await appendPluginOutcome('rrsi', value, { baseDir })).persisted).toBe(true);
  const stored = await records(path.join(baseDir, 'rrsi', 'journal', 'v1'));
  expect(stored.length).toBe(1);
  expect(stored[0].operation).toBe('dream');
  expect(stored[0].rrsi).toEqual({ action: 'dream', episodes: 2, attempts: 24, imported: 0, policies: 40, storage: 'ok' });
  const minimal: PluginOutcome = { operation: 'status', rrsi: { action: 'status', storage: 'missing' } };
  expect((await appendPluginOutcome('rrsi', minimal, { baseDir })).persisted).toBe(true);
  expect((await records(path.join(baseDir, 'rrsi', 'journal', 'v1')))[1].rrsi).toEqual({ action: 'status', storage: 'missing' });
  const rejected: PluginOutcome[] = [
    { operation: 'capture', rrsi: { action: 'explore' as any, storage: 'ok' } },
    { operation: 'capture', rrsi: { action: 'capture', storage: 'repaired' as any } },
    { operation: 'capture', rrsi: { action: 'capture' } as any },
    { operation: 'capture', rrsi: { action: 'capture', storage: 'ok', extra: true } as any },
    { operation: 'capture', rrsi: { action: 'capture', storage: 'ok', attempts: -1 } },
    { operation: 'capture', rrsi: { action: 'capture', storage: 'ok', policies: 1.5 } },
  ];
  for (const value of rejected) expect((await appendPluginOutcome('rrsi', value, { baseDir })).persisted).toBe(false);
  expect((await records(path.join(baseDir, 'rrsi', 'journal', 'v1'))).length).toBe(2);
});

test('gate and loop outcomes round-trip canonical enums and reject malformed or unknown fields', async () => {
  const { baseDir } = await fixture();
  const gate: PluginOutcome = {
    operation: 'gate_emitted', repositoryDigest: null, toolCallDigest: 'a'.repeat(64),
    gate: { trigger: 'task', facts: 'available', baselinePresent: true, binding: 'none', stateWrite: 'ok', persistence: 'no_changes', changedFiles: 0, commits: 0, receiptState: 'none' },
  };
  const loop: PluginOutcome = {
    operation: 'loop_run', repositoryDigest: null, receiptId: null, freshness: 'fresh',
    loop: { status: 'gaps', openGates: 2, resolvedGates: 1, scannedSessionFiles: 3, scanTruncated: false, silentPending: 1, gapKinds: ['no_receipt_after_gate', 'changed_test_uncovered'] },
  };
  for (const value of [gate, loop]) expect((await appendPluginOutcome('verification-receipts', value, { baseDir })).persisted).toBe(true);
  const stored = await records(path.join(baseDir, 'verification-receipts', 'journal', 'v1'));
  expect(stored[0].gate).toEqual(gate.gate);
  expect(stored[1].loop).toEqual(loop.loop);
  const rejected: PluginOutcome[] = [
    { operation: 'gate_emitted', gate: { ...gate.gate!, trigger: 'other' as any } },
    { operation: 'gate_emitted', gate: { ...gate.gate!, facts: 'best' as any } },
    { operation: 'gate_emitted', gate: { ...gate.gate!, changedFiles: -1 } },
    { operation: 'gate_emitted', gate: { ...gate.gate!, extra: true } as any },
    { operation: 'gate_emitted', gate: { trigger: 'task', facts: 'available', baselinePresent: true, binding: 'none', stateWrite: 'ok', changedFiles: 0 } as any },
    { operation: 'loop_run', loop: { ...loop.loop!, status: 'done' as any } },
    { operation: 'loop_run', loop: { ...loop.loop!, gapKinds: Array.from({ length: 11 }, () => 'receipt_stale') as any } },
    { operation: 'loop_run', loop: { ...loop.loop!, gapKinds: ['unknown_kind'] as any } },
    { operation: 'loop_run', loop: { ...loop.loop!, silentPending: 1.5 } },
  ];
  for (const value of rejected) expect((await appendPluginOutcome('verification-receipts', value, { baseDir })).persisted).toBe(false);
  expect((await records(path.join(baseDir, 'verification-receipts', 'journal', 'v1'))).length).toBe(2);
});

test('strict nested metadata projection permits native assertions and bounded provider choices only', async () => {
  const { baseDir } = await fixture();
  const value: PluginOutcome = {
    operation: 'run', execution: { status: 'passed', reason: 'complete', counts: null, assertions: [{ step: 1, id: 'step-1', kind: 'text_substring', status: 'passed' }], cleanup: 'confirmed' },
    assessment: { status: 'scored', reason: 'scored', answers: { coverage_alignment: { type: 'choice', choice: 'aligned', confidence: 0.9, probabilities: { aligned: 0.9, gap: 0.1, none: 0, unknown: 0 } }, boundary_evidence: { type: 'choice', choice: 'present', confidence: 1, probabilities: { present: 1, missing: 0, none: 0, unknown: 0 } } } },
  };
  expect((await appendPluginOutcome('ui-regression', value, { baseDir })).persisted).toBe(true);
  const stored = await records(path.join(baseDir, 'ui-regression', 'journal', 'v1'));
  expect(stored[0].execution).toEqual(value.execution); expect(stored[0].assessment).toEqual(value.assessment);
  for (const advice of [{ status: 'decision', tier: 'strong', confidence: 0.8 }, { status: 'no_decision', reason: 'provider_error' }]) expect((await appendPluginOutcome('jev-advisor', { operation: 'advise', advice }, { baseDir })).persisted).toBe(true);
});
test('one bounded batch record covers all32 task decisions and refuses malformed nested metadata',async()=>{
 const{baseDir}=await fixture();
 const value:PluginOutcome={operation:'task_advice',toolCallDigest:'a'.repeat(64),durationMs:Number.MAX_SAFE_INTEGER,stateOverrideIgnored:true,evidenceStorage:{status:'unavailable',reason:'unsupported_version'},taskAdvice:Array.from({length:32},(_,index)=>({index,status:'decision',tier:'balanced',confidence:0.0000012345678901234567,basis:'provider_choice'}))};
 expect((await appendPluginOutcome('jev-advisor',value,{baseDir})).persisted).toBe(true);
 const rows=await records(path.join(baseDir,'jev-advisor','journal','v1'));expect(rows.length).toBe(1);expect(rows[0].taskAdvice.length).toBe(32);
 for(const taskAdvice of [[{index:32,status:'no_decision',reason:'disabled'}],[{index:0,status:'no_decision',reason:'disabled'},{index:0,status:'no_decision',reason:'disabled'}],[{index:0,status:'decision',tier:'balanced',confidence:0.9,assignment:'PRIVATE_TASK_CANARY'}]])expect((await appendPluginOutcome('jev-advisor',{operation:'task_advice',taskAdvice} as PluginOutcome,{baseDir})).reason).toBe('invalid_metadata');
 expect((await appendPluginOutcome('jev-advisor',{operation:'subagent_terminal',evidenceObservations:{completed:1,failed:1,cancelled:0,stored:2,unavailable:0}},{baseDir})).persisted).toBe(true);
});

test('unknown fields, raw strings and privacy canaries are rejected before creating storage', async () => {
  const { baseDir } = await fixture();
  const canary = 'SECRET_CANARY /Users/private/account sk-secret https://private.invalid';
  const invalid: unknown[] = [
    { ...outcome, assignment: canary }, { ...outcome, rationale: canary }, { ...outcome, account: canary },
    { ...outcome, execution: { ...outcome.execution, rawLogs: canary } },
    { ...outcome, execution: { status: 'failed', reason: canary } },
    { ...outcome, assessment: { status: 'unavailable', reason: canary } },
    { ...outcome, assessment: { status: 'scored', reason: 'scored', answers: { coverage_alignment: { type: 'choice', choice: 'aligned', rationale: canary }, boundary_evidence: { type: 'choice', choice: 'present' } } } },
    { ...outcome, advice: { status: 'decision', tier: 'fast', confidence: 1, rationale: canary } },
    { ...outcome, receiptStorage: { persisted: false, reason: 'store_full', path: canary } },
    { ...outcome, evidenceStorage: { status: 'unavailable', reason: canary } },
    { ...outcome, execution: { status: 'passed', reason: 'complete', assertions: [{ step: 0, id: canary, kind: 'visible', status: 'passed' }] } },
    { ...outcome, schemaVersion: 1 }, { ...outcome, observedAt: canary }, { ...outcome, id: randomUUID() },
  ];
  for (const value of invalid) {
    const result = await appendPluginOutcome('verification-receipts', value as PluginOutcome, { baseDir });
    expect(result).toEqual({ persisted: false, reason: 'invalid_metadata' });
    expect(JSON.stringify(result)).not.toContain(canary);
  }
  expect(await missing(baseDir)).toBe(true);
});

test('invalid enum, digest, UUID, count, score, duplicate assertion and extra probability keys reject', async () => {
  const { baseDir } = await fixture();
  const invalid: unknown[] = [
    {}, { operation: 'unknown' }, { operation: 'run', repositoryDigest: '../escape' }, { operation: 'run', receiptId: '00000000-0000-1000-8000-000000000000' },
    { operation: 'run', toolCallDigest: null }, { operation: 'run', durationMs: -1 }, { operation: 'run', durationMs: 0.1 }, { operation: 'run', durationMs: Infinity },
    { operation: 'run', freshness: 'current' }, { operation: 'run', stateOverrideIgnored: 'true' },
    { ...outcome, execution: { status: 'passed', reason: 'native_success', counts: { ...counts, raw: 1 } } },
    { ...outcome, execution: { status: 'passed', reason: 'native_success', counts: { ...counts, tests: 10001 } } },
    { ...outcome, execution: { status: 'passed', reason: 'native_success', counts: { tests: 1 } } },
    { ...outcome, execution: { status: 'passed', reason: 'complete', assertions: [{ step: 1, id: 'step-1', kind: 'visible', status: 'passed' }, { step: 1, id: 'step-1', kind: 'visible', status: 'passed' }] } },
    { ...outcome, execution: { status: 'passed', reason: 'complete', assertions: [{ step: 20, id: 'step-20', kind: 'visible', status: 'passed' }] } },
    { operation: 'advise', advice: { status: 'decision', tier: 'ultra', confidence: 0.5 } },
    ...[-1, 1.01, NaN, Infinity].map(confidence => ({ operation: 'advise', advice: { status: 'decision', tier: 'fast', confidence } })),
    { operation: 'status', assessment: { status: 'scored', reason: 'scored', answers: { coverage_alignment: { type: 'choice', choice: 'aligned', probabilities: { secret: 0.5 } }, boundary_evidence: { type: 'choice', choice: 'present' } } } },
    { operation: 'run', receiptStorage: { persisted: false, reason: 'store_full', count: -1 } },
  ];
  for (const value of invalid) expect(await appendPluginOutcome('verification-receipts', value as PluginOutcome, { baseDir })).toEqual({ persisted: false, reason: 'invalid_metadata' });
  expect(await appendPluginOutcome('../escape' as any, outcome, { baseDir })).toEqual({ persisted: false, reason: 'invalid_metadata' });
  expect(await missing(baseDir)).toBe(true);
});

test('accessors, toJSON, symbol fields, sparse arrays and exotic prototypes never serialize', async () => {
  const { baseDir } = await fixture();
  let invoked = 0;
  const getter = () => { invoked++; throw new Error('SECRET_GETTER'); };
  const malicious = Object.defineProperty({ operation: 'run' }, 'execution', { enumerable: true, get: getter });
  const nested = Object.defineProperty({ status: 'passed' }, 'reason', { enumerable: true, get: getter });
  const assertion: any[] = []; Object.defineProperty(assertion, '0', { enumerable: true, get: getter });
  const values = [malicious, { operation: 'run', execution: nested }, { operation: 'run', toJSON: getter }, { operation: 'run', [Symbol('secret')]: 'SECRET' }, Object.create({ operation: 'run' }), { operation: 'run', execution: { status: 'passed', reason: 'complete', assertions: assertion } }, { operation: 'run', execution: { status: 'passed', reason: 'complete', assertions: Array(1) } }];
  for (const value of values) expect((await appendPluginOutcome('verification-receipts', value as PluginOutcome, { baseDir })).reason).toBe('invalid_metadata');
  expect(invoked).toBe(0); expect(await missing(baseDir)).toBe(true);
});

test('busy locks are never stolen or modified and return within a bounded wait', async () => {
  const { baseDir, journal } = await fixture();
  expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(true);
  const file = path.join(journal, '.append.lock');
  await fs.writeFile(file, 'OWNED_LOCK', { mode: 0o600 });
  const before = await fs.lstat(file);
  const start = performance.now();
  expect(await appendPluginOutcome('verification-receipts', outcome, { baseDir, lockTimeoutMs: 10 })).toEqual({ persisted: false, reason: 'store_busy' });
  expect(performance.now() - start).toBeLessThan(2000);
  expect(await fs.readFile(file, 'utf8')).toBe('OWNED_LOCK'); expect((await fs.lstat(file)).ino).toBe(before.ino);
  expect((await records(journal)).length).toBe(1);
});

test('concurrent appenders serialize without stealing and preserve every reported stored ID', async () => {
  const { baseDir, journal } = await fixture();
  const results = await Promise.all(Array.from({ length: 4 }, (_, durationMs) => appendPluginOutcome('verification-receipts', { operation: 'status', durationMs }, { baseDir })));
  expect(results.some(result => result.persisted)).toBe(true);
  for (const result of results) expect(['stored', 'store_busy']).toContain(result.reason);
  const stored = await records(journal);
  expect(stored.map(record => record.id).sort()).toEqual(results.filter(result => result.persisted).map(result => result.id).sort());
  expect(await missing(path.join(journal, '.append.lock'))).toBe(true);
});

test('a lock generation replaced during the bounded wait is contention, not substitution', async () => {
  const { baseDir, journal } = await fixture();
  await appendPluginOutcome('verification-receipts', outcome, { baseDir });
  const lockPath = path.join(journal, '.append.lock');
  const next = path.join(journal, '.append.lock.next');
  await fs.writeFile(lockPath, 'FOREIGN_1', { mode: 0o600 });
  await fs.writeFile(next, 'FOREIGN_2', { mode: 0o600 });
  const original = fs.open;
  let armed = true;
  const probe = spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    const flags = args[1];
    if (armed && String(args[0]) === lockPath && typeof flags === 'number' && (flags & fsConstants.O_WRONLY) === 0) {
      // The holder releases and the next waiter atomically recreates the lock
      // while this probe is between its observations of the path.
      armed = false;
      await fs.rename(next, lockPath);
    }
    return original(...args);
  }) as typeof fs.open);
  try {
    expect(await appendPluginOutcome('verification-receipts', outcome, { baseDir, lockTimeoutMs: 20 })).toEqual({ persisted: false, reason: 'store_busy' });
  } finally { probe.mockRestore(); }
  expect(await fs.readFile(lockPath, 'utf8')).toBe('FOREIGN_2');
  expect(await missing(next)).toBe(true);
  expect((await records(journal)).length).toBe(1);
});

test('record and dependency resource limits reject without allocating journal files', async () => {
  const { baseDir } = await fixture();
  expect(await appendPluginOutcome('verification-receipts', outcome, { baseDir, maxRecordBytes: 1 })).toEqual({ persisted: false, reason: 'record_too_large' });
  expect(await appendPluginOutcome('verification-receipts', outcome, { baseDir, maxSegmentBytes: 1 })).toEqual({ persisted: false, reason: 'record_too_large' });
  for (const limits of [{ maxRecordBytes: 4097 }, { maxSegmentBytes: 1048577 }, { maxSegments: 9 }, { maxSegments: 0 }, { lockTimeoutMs: 101 }, { lockTimeoutMs: -1 }, { maxRecordBytes: NaN }]) expect(await appendPluginOutcome('verification-receipts', outcome, { baseDir, ...limits })).toEqual({ persisted: false, reason: 'invalid_limits' });
  const oversized: PluginOutcome = { operation: 'run', execution: { status: 'passed', reason: 'complete', assertions: Array.from({ length: 20 }, (_, step) => ({ step, id: 'step-' + step, kind: 'text_substring', status: 'passed' })) } };
  expect((await appendPluginOutcome('verification-receipts', oversized, { baseDir, maxRecordBytes: 1000 })).reason).toBe('record_too_large');
  expect(await missing(baseDir)).toBe(true);
});

test('rotation retains only bounded marker-owned segments, preserving receipts and legacy sentinels', async () => {
  const { root, baseDir, journal } = await fixture();
  const receiptDir = path.join(baseDir, 'verification-receipts', 'receipts', 'v1');
  await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 });
  const receipt = path.join(receiptDir, 'IMMUTABLE');
  const legacy = path.join(root, '.gjc', 'legacy'); await fs.mkdir(path.dirname(legacy), { mode: 0o700 });
  await fs.writeFile(receipt, 'IMMUTABLE_SENTINEL', { mode: 0o600 }); await fs.writeFile(legacy, 'LEGACY_SENTINEL', { mode: 0o600 });
  const oldNames: string[] = [];
  for (let index = 0; index < 12; index++) {
    const result = await appendPluginOutcome('verification-receipts', { operation: 'run', durationMs: index }, { baseDir, maxSegmentBytes: 220, maxSegments: 3 });
    expect(result).toMatchObject({ persisted: true, retainedSegments: Math.min(index + 1, 3), rotated: index < 3 ? 0 : 1 });
    const marker = await inventory(journal);
    oldNames.push(marker.segments.at(-1).name);
    expect(marker.segments.length).toBeLessThanOrEqual(3);
    expect((await fs.readdir(journal)).length).toBeLessThanOrEqual(4);
    expect(marker.segments.every((segment: any) => segment.bytes <= 220)).toBe(true);
  }
  expect((await records(journal)).map(record => record.durationMs)).toEqual([9, 10, 11]);
  for (const name of oldNames.slice(0, 9)) expect(await missing(path.join(journal, name))).toBe(true);
  expect(await fs.readFile(receipt, 'utf8')).toBe('IMMUTABLE_SENTINEL'); expect(await fs.readFile(legacy, 'utf8')).toBe('LEGACY_SENTINEL');
});

test('a single segment cap closes and retires its previous segment rather than stopping', async () => {
  const { baseDir, journal } = await fixture();
  for (let durationMs = 0; durationMs < 4; durationMs++) expect((await appendPluginOutcome('verification-receipts', { operation: 'status', durationMs }, { baseDir, maxSegmentBytes: 220, maxSegments: 1 })).persisted).toBe(true);
  expect((await records(journal)).map(record => record.durationMs)).toEqual([3]);
  expect((await inventory(journal)).segments).toHaveLength(1);
});

test('unexpected files, unbound segments and partial pending publications fail closed without deletion', async () => {
  for (const name of ['legacy.jsonl', '00000000-0000-4000-8000-000000000000-0.jsonl', '.inventory.pending']) {
    const { baseDir, journal } = await fixture();
    expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(true);
    const markerBefore = await fs.readFile(path.join(journal, 'inventory.json'));
    await fs.writeFile(path.join(journal, name), 'FOREIGN_SENTINEL', { mode: 0o600 });
    expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(false);
    expect(await fs.readFile(path.join(journal, name), 'utf8')).toBe('FOREIGN_SENTINEL');
    expect(await fs.readFile(path.join(journal, 'inventory.json'))).toEqual(markerBefore);
  }
});

test('invalid, wrong-plugin and filename-escaping inventories are not adopted', async () => {
  for (const change of ['broken', 'plugin', 'owner', 'segment', 'extra']) {
    const { baseDir, journal } = await fixture();
    await appendPluginOutcome('verification-receipts', outcome, { baseDir });
    const marker = await inventory(journal);
    if (change === 'plugin') marker.plugin = 'ui-regression';
    if (change === 'owner') marker.owner = randomUUID();
    if (change === 'segment') marker.segments[0].name = '../SENTINEL';
    if (change === 'extra') marker.raw = 'PRIVATE_CANARY';
    const body = change === 'broken' ? '{broken' : JSON.stringify(marker);
    await fs.writeFile(path.join(journal, 'inventory.json'), body);
    expect(await appendPluginOutcome('verification-receipts', outcome, { baseDir })).toEqual({ persisted: false, reason: 'store_corrupt' });
    expect(await fs.readFile(path.join(journal, 'inventory.json'), 'utf8')).toBe(body);
  }
});

test('truncated segments and even rebound records with unapproved fields fail closed', async () => {
  for (const rebind of [false, true]) {
    const { baseDir, journal } = await fixture();
    await appendPluginOutcome('verification-receipts', outcome, { baseDir });
    const marker = await inventory(journal);
    const segment = marker.segments[0];
    const file = path.join(journal, segment.name);
    let body: string;
    if (rebind) { const record = (await records(journal))[0]; body = JSON.stringify({ ...record, secret: 'PRIVATE_CANARY' }) + '\n'; }
    else body = (await fs.readFile(file, 'utf8')).slice(0, -1);
    await fs.writeFile(file, body);
    if (rebind) { segment.bytes = Buffer.byteLength(body); segment.digest = createHash('sha256').update(body).digest('hex'); await fs.writeFile(path.join(journal, 'inventory.json'), JSON.stringify(marker)); }
    expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).reason).toBe('store_corrupt');
    expect(await fs.readFile(file, 'utf8')).toBe(body);
  }
});

test('symlink ancestors and plugin roots never reach external sentinels', async () => {
  const { root, baseDir } = await fixture();
  const external = path.join(root, 'external'); await fs.mkdir(external, { mode: 0o700 });
  const sentinel = path.join(external, 'sentinel'); await fs.writeFile(sentinel, 'OUTSIDE', { mode: 0o600 });
  await fs.symlink(external, baseDir);
  expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).reason).toBe('unsafe_path');
  await expect(ensurePrivateResultDirectory(path.join(baseDir, 'child'))).rejects.toThrow();
  await expect(readPrivateResultFile(path.join(baseDir, 'sentinel'), 100)).rejects.toThrow();
  const alias = path.join(root, 'alias'); await fs.symlink(external, alias);
  await expect(ensurePrivateResultDirectory(path.join(alias, '.gjc-plugin'))).rejects.toThrow();
  expect(await fs.readdir(external)).toEqual(['sentinel']); expect(await fs.readFile(sentinel, 'utf8')).toBe('OUTSIDE');
});

test('symlink and hardlinked inventory, segment and lock files refuse writes or cleanup', async () => {
  for (const target of ['inventory', 'segment', 'lock']) for (const kind of ['symlink', 'hardlink']) {
    const { root, baseDir, journal } = await fixture();
    await appendPluginOutcome('verification-receipts', outcome, { baseDir });
    const marker = await inventory(journal);
    const file = path.join(journal, target === 'inventory' ? 'inventory.json' : target === 'segment' ? marker.segments[0].name : '.append.lock');
    const external = path.join(root, 'SENTINEL'); await fs.writeFile(external, 'EXTERNAL', { mode: 0o600 });
    if (target !== 'lock') await fs.unlink(file);
    if (kind === 'symlink') await fs.symlink(external, file); else await fs.link(external, file);
    expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir, lockTimeoutMs: 0 })).persisted).toBe(false);
    expect(await fs.readFile(external, 'utf8')).toBe('EXTERNAL');
    expect(await missing(file)).toBe(false);
    if (kind === 'hardlink') expect((await fs.lstat(file)).nlink).toBe(2); else expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
  }
});

test('unsafe directory and file modes are never repaired', async () => {
  for (const target of ['base', 'plugin', 'journal', 'inventory', 'segment']) {
    const { baseDir, journal } = await fixture();
    await appendPluginOutcome('verification-receipts', outcome, { baseDir });
    const marker = await inventory(journal);
    const file = target === 'base' ? baseDir : target === 'plugin' ? path.join(baseDir, 'verification-receipts') : target === 'journal' ? journal : path.join(journal, target === 'inventory' ? 'inventory.json' : marker.segments[0].name);
    const mode = ['base', 'plugin', 'journal'].includes(target) ? 0o755 : 0o644;
    await fs.chmod(file, mode);
    expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(false);
    expect((await fs.lstat(file)).mode & 0o7777).toBe(mode);
  }
});

test('home ancestors need not be private, while result root and every descendant must be', async () => {
  const { root, baseDir } = await fixture();
  await fs.chmod(root, 0o755);
  const directory = path.join(baseDir, 'plugin', 'nested');
  await ensurePrivateResultDirectory(directory);
  expect((await fs.lstat(root)).mode & 0o7777).toBe(0o755);
  expect((await fs.lstat(baseDir)).mode & 0o7777).toBe(0o700);
  await fs.chmod(path.join(baseDir, 'plugin'), 0o755);
  await expect(ensurePrivateResultDirectory(directory, false)).rejects.toThrow();
  expect((await fs.lstat(path.join(baseDir, 'plugin'))).mode & 0o7777).toBe(0o755);
});

test('read helper enforces a bounded single-link regular file and never follows final symlinks', async () => {
  const { baseDir, root } = await fixture();
  await ensurePrivateResultDirectory(baseDir);
  const file = path.join(baseDir, 'private.json'); await fs.writeFile(file, '12345', { mode: 0o600 });
  expect(await readPrivateResultFile(file, 5)).toEqual(Buffer.from('12345'));
  await expect(readPrivateResultFile(file, 4)).rejects.toThrow('resource_limit');
  await expect(readPrivateResultFile(file, 0)).rejects.toThrow('resource_limit');
  await expect(readPrivateResultFile(file, Infinity)).rejects.toThrow('resource_limit');
  await fs.link(file, path.join(root, 'hardlink'));
  await expect(readPrivateResultFile(file, 5)).rejects.toThrow('unsafe_path');
  await fs.unlink(path.join(root, 'hardlink')); await fs.chmod(file, 0o640);
  await expect(readPrivateResultFile(file, 5)).rejects.toThrow('unsafe_path');
  await fs.chmod(file, 0o600);
  const symlink = path.join(baseDir, 'symlink'); await fs.symlink(file, symlink);
  await expect(readPrivateResultFile(symlink, 5)).rejects.toThrow('unsafe_path');
  const directory = path.join(baseDir, 'directory'); await fs.mkdir(directory, { mode: 0o700 });
  await expect(readPrivateResultFile(directory, 5)).rejects.toThrow('unsafe_path');
  expect(await fs.readFile(file, 'utf8')).toBe('12345');
});

test('a mismatched owner is rejected without chown or mutation', async () => {
  const { baseDir } = await fixture(); await ensurePrivateResultDirectory(baseDir);
  const original = fs.lstat;
  const probe = spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const info = await original(...args);
    if (String(args[0]) === baseDir) return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: process.getuid!() + 1 });
    return info;
  }) as typeof fs.lstat);
  try { expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).reason).toBe('unsafe_path'); }
  finally { probe.mockRestore(); }
  expect((await fs.lstat(baseDir)).uid).toBe(process.getuid!()); expect(await fs.readdir(baseDir)).toEqual([]);
});

function wrappedHandle(handle: FileHandle, replace: Record<string, (...args: any[]) => any>): FileHandle {
  return new Proxy(handle, { get(target, key) { if (typeof key === 'string' && Object.hasOwn(replace, key)) return replace[key]; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
}
test('file fsync failure reports unavailable and a partial publication is not adopted later', async () => {
  const { baseDir, journal } = await fixture();
  const original = fs.open;
  let injected = false;
  const probe = spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith('.jsonl') && !injected) return wrappedHandle(handle, { sync: async () => { injected = true; throw new Error('INJECTED_PRIVATE_FAILURE'); } });
    return handle;
  }) as typeof fs.open);
  try { expect(await appendPluginOutcome('verification-receipts', outcome, { baseDir })).toEqual({ persisted: false, reason: 'store_unavailable' }); }
  finally { probe.mockRestore(); }
  expect(injected).toBe(true);
  expect(await missing(path.join(journal, 'inventory.json'))).toBe(true);
  expect((await fs.readdir(journal)).some(name => name.endsWith('.jsonl'))).toBe(true);
  expect(await appendPluginOutcome('verification-receipts', outcome, { baseDir })).toEqual({ persisted: false, reason: 'store_corrupt' });
});

test('directory fsync failure never reports confirmed publication or repairs pending state', async () => {
  const { baseDir, journal } = await fixture();
  const original = fs.open;
  let injected = false;
  const probe = spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]) === journal) return wrappedHandle(handle, { sync: async () => { injected = true; throw new Error('INJECTED_DIR_FAILURE'); } });
    return handle;
  }) as typeof fs.open);
  try { expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(false); }
  finally { probe.mockRestore(); }
  expect(injected).toBe(true);
  expect(await missing(path.join(journal, '.inventory.pending'))).toBe(false);
  expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(false);
});

test('read detects descriptor/path substitution without returning bytes', async () => {
  const { baseDir } = await fixture(); await ensurePrivateResultDirectory(baseDir);
  const file = path.join(baseDir, 'record'); await fs.writeFile(file, 'SAFE', { mode: 0o600 });
  const original = fs.open;
  let injected = false;
  const probe = spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]) === file) return wrappedHandle(handle, { read: async (...readArgs: any[]) => {
      if (!injected) { injected = true; await fs.rename(file, file + '.old'); await fs.writeFile(file, 'OTHER', { mode: 0o600 }); }
      return (handle.read as any)(...readArgs);
    } });
    return handle;
  }) as typeof fs.open);
  try { await expect(readPrivateResultFile(file, 100)).rejects.toThrow('unsafe_path'); }
  finally { probe.mockRestore(); }
  expect(injected).toBe(true); expect(await fs.readFile(file, 'utf8')).toBe('OTHER');
});

test('read refuses a file that grows during its bounded descriptor read', async () => {
  const { baseDir } = await fixture(); await ensurePrivateResultDirectory(baseDir);
  const file = path.join(baseDir, 'record'); await fs.writeFile(file, 'SAFE', { mode: 0o600 });
  const original = fs.open;
  let injected = false;
  const probe = spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]) === file) return wrappedHandle(handle, { read: async (...readArgs: any[]) => {
      if (!injected) { injected = true; await fs.appendFile(file, 'GROWTH'); }
      return (handle.read as any)(...readArgs);
    } });
    return handle;
  }) as typeof fs.open);
  try { await expect(readPrivateResultFile(file, 100)).rejects.toThrow('unsafe_path'); }
  finally { probe.mockRestore(); }
  expect(injected).toBe(true); expect(await fs.readFile(file, 'utf8')).toBe('SAFEGROWTH');
});

test('a partial write remains quarantined and is never repaired into a published outcome', async () => {
  const { baseDir, journal } = await fixture();
  const original = fs.open;
  let injected = false;
  const probe = spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith('.jsonl')) return wrappedHandle(handle, { writeFile: async (body: string) => {
      injected = true; await handle.writeFile(body.slice(0, 10)); throw new Error('PRIVATE_PARTIAL_WRITE');
    } });
    return handle;
  }) as typeof fs.open);
  try { expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).reason).toBe('store_unavailable'); }
  finally { probe.mockRestore(); }
  expect(injected).toBe(true);
  const names = await fs.readdir(journal);
  expect(names).toHaveLength(1); expect(names[0].endsWith('.jsonl')).toBe(true);
  expect((await fs.readFile(path.join(journal, names[0]))).length).toBe(10);
  expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).reason).toBe('store_corrupt');
  expect((await fs.readFile(path.join(journal, names[0]))).length).toBe(10);
});

test('production root ignores legacy state environment overrides', () => {
  const before = process.env.JEV_ADVISOR_STATE_PATH;
  process.env.JEV_ADVISOR_STATE_PATH = '/PRIVATE_LEGACY_SENTINEL';
  try { expect(pluginResultsRoot()).toBe(path.join(homedir(), '.gjc-plugin')); expect(pluginResultsRoot()).not.toContain('PRIVATE_LEGACY_SENTINEL'); }
  finally { if (before === undefined) delete process.env.JEV_ADVISOR_STATE_PATH; else process.env.JEV_ADVISOR_STATE_PATH = before; }
});
test('HOME changes select independent private consumers despite a cached OS home',async()=>{
 const first=await fixture(),second=await fixture(),previous=process.env.HOME;
 try {
  process.env.HOME=first.root;expect(pluginResultsRoot()).toBe(first.baseDir);
  const a=await appendPluginOutcome('verification-receipts',outcome);expect(a.persisted).toBe(true);
  process.env.HOME=second.root;expect(pluginResultsRoot()).toBe(second.baseDir);
  const b=await appendPluginOutcome('verification-receipts',outcome);expect(b.persisted).toBe(true);
  expect((await records(first.journal)).map(row=>row.id)).toEqual([a.id]);expect((await records(second.journal)).map(row=>row.id)).toEqual([b.id]);
 }finally{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;}
});
test('snapshot reader distinguishes missing home, empty directory and readable full journals without creating anything', async () => {
  const { root, baseDir, journal } = await fixture();
  // Missing: nothing exists at all, and the reader must not create it.
  const absent = await readPluginOutcomeSnapshot('verification-receipts', { baseDir: path.join(root, 'absent') });
  expect(absent.status).toBe('missing'); expect(absent.reason).toBeNull();
  expect(await missing(path.join(root, 'absent'))).toBe(true);
  // Safe empty journal directory is missing, never synthesized as empty metrics.
  await ensurePrivateResultDirectory(journal);
  const empty = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
  expect(empty.status).toBe('missing'); expect(empty.reason).toBeNull();
  // Full readable journal returns records exactly as stored.
  const result = await appendPluginOutcome('verification-receipts', { ...outcome, durationMs: 12 }, { baseDir });
  expect(result.persisted).toBe(true);
  const second = await appendPluginOutcome('jev-advisor', { operation: 'advise', advice: { status: 'no_decision', reason: 'disabled' } }, { baseDir });
  expect(second.persisted).toBe(true);
  const full = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
  expect(full.status).toBe('ok'); expect(full.reason).toBeNull();
  expect(full.records.map(record => record.id)).toEqual([result.id]);
  expect(full.segments).toBe((await inventory(journal)).segments.length);
  expect(full.bytes).toBe((await inventory(journal)).segments.reduce((sum: number, segment: any) => sum + segment.bytes, 0));
  const other = await readPluginOutcomeSnapshot('jev-advisor', { baseDir });
  expect(other.status).toBe('ok');
  expect(other.records.length).toBe(1);
  expect((await records(journal)).length).toBe(1);
  expect(await missing(path.join(journal, '.append.lock'))).toBe(true);
});

test('snapshot reader distinguishes an absent journal from a readable empty canonical inventory', async () => {
  const { baseDir, journal } = await fixture();
  const absent = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
  expect(absent).toMatchObject({ status: 'missing', reason: null, records: [] });
  expect(await missing(baseDir)).toBe(true);

  expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(true);
  const marker = await inventory(journal);
  const markerPath = path.join(journal, 'inventory.json');
  const emptyInventory = JSON.stringify({ ...marker, segments: [] });
  await fs.writeFile(markerPath, emptyInventory, { mode: 0o600 });
  await fs.unlink(path.join(journal, marker.segments[0].name));

  const snapshot = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
  expect(snapshot).toMatchObject({ status: 'unavailable', reason: 'store_corrupt', records: [], segments: 0, bytes: 0 });
  expect(await fs.readFile(markerPath, 'utf8')).toBe(emptyInventory);
});

test('snapshot reader maps malformed inventory JSON to store_corrupt without records', async () => {
  const { baseDir, journal } = await fixture();
  expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(true);
  const markerPath = path.join(journal, 'inventory.json');
  await fs.writeFile(markerPath, '{ malformed JSON', { mode: 0o600 });

  const snapshot = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
  expect(snapshot).toMatchObject({ status: 'unavailable', reason: 'store_corrupt', records: [], segments: 0, bytes: 0 });
  expect(await fs.readFile(markerPath, 'utf8')).toBe('{ malformed JSON');
});

test('snapshot reader classifies shape-invalid inventory metadata as corrupt without modifying it', async () => {
  for (const variant of ['empty object', 'missing owner', 'invalid segment bytes']) {
    const { baseDir, journal } = await fixture();
    expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(true);
    expect((await readPluginOutcomeSnapshot('verification-receipts', { baseDir })).status).toBe('ok');
    const marker = await inventory(journal);
    const markerPath = path.join(journal, 'inventory.json');
    const invalid = variant === 'empty object' ? {} : variant === 'missing owner' ? { ...marker, owner: undefined } : { ...marker, segments: [{ ...marker.segments[0], bytes: -1 }] };
    const body = JSON.stringify(invalid);
    await fs.writeFile(markerPath, body, { mode: 0o600 });
    const names = (await fs.readdir(journal)).sort();

    expect(await readPluginOutcomeSnapshot('verification-receipts', { baseDir })).toEqual({ status: 'unavailable', reason: 'store_corrupt', records: [], segments: 0, bytes: 0 });
    expect(await fs.readFile(markerPath, 'utf8')).toBe(body);
    expect((await fs.readdir(journal)).sort()).toEqual(names);
  }
});

test('snapshot reader rejects digest-matching malformed and schema-invalid segments without salvaging records', async () => {
  for (const variant of ['malformed JSON', 'invalid operation']) {
    const { baseDir, journal } = await fixture();
    for (let index = 0; index < 2; index++) expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(true);
    expect((await readPluginOutcomeSnapshot('verification-receipts', { baseDir })).records).toHaveLength(2);
    const stored = await records(journal);
    const marker = await inventory(journal);
    const segment = marker.segments[0];
    const segmentPath = path.join(journal, segment.name);
    const invalidLine = variant === 'malformed JSON' ? '{"schemaVersion":' : JSON.stringify({ ...stored[1], operation: 'invalid' });
    const body = JSON.stringify(stored[0]) + '\n' + invalidLine + '\n';
    segment.bytes = Buffer.byteLength(body);
    segment.digest = createHash('sha256').update(body).digest('hex');
    const markerPath = path.join(journal, 'inventory.json');
    const markerBody = JSON.stringify(marker);
    await fs.writeFile(segmentPath, body);
    await fs.writeFile(markerPath, markerBody);

    expect(await readPluginOutcomeSnapshot('verification-receipts', { baseDir })).toEqual({ status: 'unavailable', reason: 'store_corrupt', records: [], segments: 0, bytes: 0 });
    expect(await fs.readFile(segmentPath, 'utf8')).toBe(body);
    expect(await fs.readFile(markerPath, 'utf8')).toBe(markerBody);
  }
});

test('snapshot reader keeps inventory and segment descriptor I/O failures distinct from corrupt content', async () => {
  for (const target of ['inventory', 'segment']) {
    const { baseDir, journal } = await fixture();
    expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(true);
    const before = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
    expect(before.status).toBe('ok');
    const marker = await inventory(journal);
    const file = path.join(journal, target === 'inventory' ? 'inventory.json' : marker.segments[0].name);
    const body = await fs.readFile(file);
    const original = fs.open;
    let injected = false;
    const probe = spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]) === file) return wrappedHandle(handle, { read: async () => { injected = true; throw Object.assign(new Error('PRIVATE_IO_FAILURE'), { code: 'EIO' }); } });
      return handle;
    }) as typeof fs.open);
    try { expect(await readPluginOutcomeSnapshot('verification-receipts', { baseDir })).toEqual({ status: 'unavailable', reason: 'store_unavailable', records: [], segments: 0, bytes: 0 }); }
    finally { probe.mockRestore(); }
    expect(injected).toBe(true);
    expect(await fs.readFile(file)).toEqual(body);
    expect(await readPluginOutcomeSnapshot('verification-receipts', { baseDir })).toEqual(before);
  }
});

test('snapshot reader bounds oversized inventory reads and returns unavailable without records', async () => {
  const { baseDir, journal } = await fixture();
  expect((await appendPluginOutcome('verification-receipts', outcome, { baseDir })).persisted).toBe(true);
  const markerPath = path.join(journal, 'inventory.json');
  const oversized = (await fs.readFile(markerPath, 'utf8')) + ' '.repeat(8192);
  await fs.writeFile(markerPath, oversized, { mode: 0o600 });
  expect((await fs.lstat(markerPath)).size).toBeGreaterThan(8192);

  const snapshot = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
  expect(snapshot).toMatchObject({ status: 'unavailable', reason: 'resource_limit', records: [], segments: 0, bytes: 0 });
  expect(await fs.readFile(markerPath, 'utf8')).toBe(oversized);
});

test('snapshot reader returns busy for a safe lock and unsafe_path for an unsafe one, never stealing either', async () => {
  for (const variant of ['safe', 'unsafe']) {
    const { baseDir, journal } = await fixture();
    await appendPluginOutcome('verification-receipts', outcome, { baseDir });
    const file = path.join(journal, '.append.lock');
    await fs.writeFile(file, 'FOREIGN_LOCK', { mode: variant === 'safe' ? 0o600 : 0o644 });
    const before = await fs.lstat(file);
    const snapshot = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.reason).toBe(variant === 'safe' ? 'store_busy' : 'unsafe_path');
    expect(await fs.readFile(file, 'utf8')).toBe('FOREIGN_LOCK');
    expect((await fs.lstat(file)).ino).toBe(before.ino);
  }
});

test('snapshot reader fails closed on unknown, pending and unlisted files and on corrupt canonical records', async () => {
  for (const [name, body] of [['legacy.jsonl', 'FOREIGN'], ['.inventory.pending', '{}'], ['00000000-0000-4000-8000-000000000000-9.jsonl', 'FOREIGN']] as const) {
    const { baseDir, journal } = await fixture();
    await appendPluginOutcome('verification-receipts', outcome, { baseDir });
    await fs.writeFile(path.join(journal, name), body, { mode: 0o600 });
    const snapshot = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.reason).toBe(name === '.inventory.pending' ? 'store_corrupt' : name === 'legacy.jsonl' || name.endsWith('-9.jsonl') ? 'store_corrupt' : 'store_corrupt');
    expect(await fs.readFile(path.join(journal, name), 'utf8')).toBe(body);
  }
  {
    const { baseDir, journal } = await fixture();
    await appendPluginOutcome('verification-receipts', outcome, { baseDir });
    const marker = await inventory(journal);
    const file = path.join(journal, marker.segments[0].name);
    const body = (await fs.readFile(file, 'utf8')).slice(0, -1);
    await fs.writeFile(file, body);
    const snapshot = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
    expect(snapshot).toMatchObject({ status: 'unavailable', reason: 'store_corrupt', records: [] });
    expect(await fs.readFile(file, 'utf8')).toBe(body);
  }
});

test('snapshot reader rejects duplicate record UUIDs as corrupt instead of deduplicating', async () => {
  const { baseDir, journal } = await fixture();
  const first = await appendPluginOutcome('verification-receipts', outcome, { baseDir });
  expect(first.persisted).toBe(true);
  const stored = (await records(journal))[0];
  expect((await readPluginOutcomeSnapshot('verification-receipts', { baseDir })).status).toBe('ok');
  // Rebind the stored record with a duplicated canonical id through the writer path.
  const duplicate = JSON.parse(JSON.stringify(stored));
  await appendPluginOutcome('verification-receipts', { operation: 'status', durationMs: 5 }, { baseDir });
  const marker = await inventory(journal);
  const segment = path.join(journal, marker.segments[0].name);
  const body = (await fs.readFile(segment, 'utf8'));
  const lines = body.trimEnd().split('\n');
  lines[lines.length - 1] = JSON.stringify(duplicate);
  await fs.writeFile(segment, lines.join('\n') + '\n');
  const snapshot = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
  expect(snapshot.status).toBe('unavailable');
  expect(snapshot.reason).toBe('store_corrupt');
  expect(snapshot.records).toEqual([]);
});

test('unsafe inventory, segment and directory ownership never reaches snapshot records', async () => {
  for (const target of ['inventory', 'segment', 'journal']) {
    const { baseDir, journal } = await fixture();
    await appendPluginOutcome('verification-receipts', outcome, { baseDir });
    const marker = await inventory(journal);
    await fs.chmod(target === 'journal' ? journal : target === 'inventory' ? path.join(journal, 'inventory.json') : path.join(journal, marker.segments[0].name), target === 'journal' ? 0o755 : 0o644);
    const snapshot = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.reason).toBe('unsafe_path');
    expect(snapshot.records).toEqual([]);
  }
  {
    const { root, baseDir } = await fixture();
    const external = path.join(root, 'EXTERNAL'); await fs.mkdir(external, { mode: 0o700 });
    await fs.writeFile(path.join(external, 'sentinel'), 'OUTSIDE', { mode: 0o600 });
    await fs.symlink(external, baseDir);
    const snapshot = await readPluginOutcomeSnapshot('verification-receipts', { baseDir });
    expect(snapshot.reason).toBe('unsafe_path');
    expect(await fs.readFile(path.join(external, 'sentinel'), 'utf8')).toBe('OUTSIDE');
  }
});

test('snapshot reader discards a journal generation that changes mid-read instead of salvaging a prefix', async () => {
  const { baseDir, journal } = await fixture();
  await appendPluginOutcome('verification-receipts', outcome, { baseDir });
  const marker = await inventory(journal);
  const segmentPath = path.join(journal, marker.segments[0].name);
  const original = fs.open;
  let segmentOpens = 0;
  let injected = false;
  const probe = spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]) === segmentPath && ++segmentOpens === 2 && !injected) {
      injected = true;
      await appendPluginOutcome('verification-receipts', { operation: 'status', durationMs: 9 }, { baseDir });
    }
    return handle;
  }) as typeof fs.open);
  try { expect((await readPluginOutcomeSnapshot('verification-receipts', { baseDir })).reason).toBe('changed_during_read'); }
  finally { probe.mockRestore(); }
  expect(injected).toBe(true);
  expect((await records(journal)).length).toBe(2);
  expect(marker.segments.length).toBeLessThanOrEqual(8);
});
