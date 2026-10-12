// GENERATED FILE — do not edit by hand.
// Core: lib/decision.ts + adapter: src/tool.adapter.ts
// Rebuild with: bun scripts/build.mjs

import { constants as resultsConstants, promises as resultsFs } from 'node:fs';
import type { Stats as ResultsStats } from 'node:fs';
import type { FileHandle as ResultsFileHandle } from 'node:fs/promises';
import { homedir as resultsHomedir } from 'node:os';
import { dirname as resultsDirname, join as resultsJoin, parse as resultsParse, resolve as resultsResolve, sep as resultsSep } from 'node:path';
import { createHash as resultsHash, randomUUID as resultsUUID } from 'node:crypto';
import { performance as resultsClock } from 'node:perf_hooks';

export type PluginOutcome = {
  operation: 'run' | 'status' | 'advise' | 'calibration' | 'task_advice' | 'task_launch' | 'subagent_terminal' | 'wiki_query' | 'wiki_propose' | 'rea_readiness' | 'backplan_check';
  repositoryDigest?: string | null;
  receiptId?: string | null;
  toolCallDigest?: string;
  durationMs?: number;
  freshness?: 'fresh' | 'stale' | 'changed_during_run' | 'unavailable';
  stateOverrideIgnored?: boolean;
  execution?: { status: string; reason: string; counts?: Record<string, number> | null; assertions?: { step: number; id: string; kind: string; status: string }[]; cleanup?: string };
  assessment?: { status: string; reason: string; answers?: { coverage_alignment: { type: 'choice'; choice: string; confidence?: number; probabilities?: Partial<Record<string, number>> }; boundary_evidence: { type: 'choice'; choice: string; confidence?: number; probabilities?: Partial<Record<string, number>> } } };
  advice?: { status: string; tier?: string; confidence?: number; confidenceKind?: string; probabilities?: Record<string, number>; reason?: string };
  taskAdvice?: { index:number; status:string; tier?:string; confidence?:number; basis?:string; reason?:string }[];
  evidenceObservations?: {completed:number;failed:number;cancelled:number;stored:number;unavailable:number};
  receiptStorage?: { persisted: boolean; reason: string; count?: number; bytes?: number; nearCapacity?: boolean };
  evidenceStorage?: { status: string; reason?: string };
};
type ResultsPlugin = 'jev-advisor' | 'verification-receipts' | 'ui-regression' | 'wiki' | 'rea' | 'backplan';
type ResultsAppend = { persisted: boolean; reason: string; id?: string; rotated?: number; retainedSegments?: number };
type ResultsDependencies = { baseDir?: string; maxRecordBytes?: number; maxSegmentBytes?: number; maxSegments?: number; lockTimeoutMs?: number };
const resultsPlugins = ['jev-advisor', 'verification-receipts', 'ui-regression', 'wiki', 'rea', 'backplan'];
const resultsOperations = ['run', 'status', 'advise', 'calibration', 'task_advice', 'task_launch', 'subagent_terminal', 'wiki_query', 'wiki_propose', 'rea_readiness', 'backplan_check'];
const resultsHex = /^[a-f0-9]{64}$/;
const resultsId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const resultsCountKeys = ['tests', 'suites', 'topLevel', 'passed', 'failed', 'skipped', 'todo', 'cancelled'];
const resultsExecutionReasons = [
  'not_run', 'invalid_or_unavailable_input', 'receipt_unavailable', 'invalid_file_count', 'invalid_root', 'invalid_test_path',
  'path_escape', 'symlink_test_path', 'invalid_test_file', 'missing_test_file', 'duplicate_test_file', 'invalid_timeout',
  'cancelled', 'process_groups_unavailable', 'node_unavailable', 'invalid_node_version', 'unsupported_node_version',
  'cleanup_unresolved', 'cleanup_unconfirmed', 'timeout', 'output_limit', 'spawn_unavailable', 'missing_summary',
  'invalid_summary_frame', 'runner_crash', 'native_failure', 'no_actual_passes', 'native_success', 'runner_setup_failed',
  'complete', 'origin_drift', 'missing_target', 'ambiguous_target', 'hidden_target', 'assertion_failed', 'unsupported_control',
  'runtime_error', 'missing_observations', 'output_overflow', 'malformed_observations', 'runner_exit', 'partial_observations',
  'missing_account', 'unsafe_lock', 'busy', 'lock_unavailable', 'runner_signal', 'missing_cli', 'runner_unavailable',
];
const resultsAssessmentReasons = ['scored', 'optional_scores_missing', 'unknown_choice', 'missing_context', 'insufficient_evidence', 'invalid_context', 'invalid_facts', 'off', 'missing_key', 'request_cap', 'response_cap', 'invalid_answer', 'http_auth', 'http_credit', 'http_rate', 'http_server', 'http_error', 'redirect', 'timeout', 'transport'];
const resultsAdviceReasons = ['invalid_task', 'unsupported_input', 'input_too_large', 'batch_limit', 'disabled', 'unconfigured', 'invalid_endpoint', 'rate_limited', 'budget_exceeded', 'already_pending', 'timeout', 'aborted', 'provider_error', 'invalid_response'];
const resultsReceiptReasons = ['stored', 'invalid_metadata', 'store_busy', 'store_corrupt', 'store_full', 'store_unavailable', 'no_receipt', 'not_requested'];
const resultsEvidenceReasons = ['locked', 'corrupt', 'unsupported_version', 'oversized', 'unsafe_path', 'io_error', 'invalid_input'];

function resultsFail(reason: string): never { throw new Error(reason); }
function resultsObject(value: unknown, keys: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) resultsFail('invalid_metadata');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))) resultsFail('invalid_metadata');
  const projected: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor) || !descriptor.enumerable) resultsFail('invalid_metadata');
    if (descriptor.value !== undefined) projected[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(projected, key))) resultsFail('invalid_metadata');
  return projected;
}
function resultsEnum(value: unknown, choices: readonly string[]): string {
  if (typeof value !== 'string' || !choices.includes(value)) resultsFail('invalid_metadata');
  return value;
}
function resultsInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) resultsFail('invalid_metadata');
  return value;
}
function resultsBoolean(value: unknown): boolean { if (typeof value !== 'boolean') resultsFail('invalid_metadata'); return value; }
function resultsProbability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) resultsFail('invalid_metadata');
  return value;
}
function resultsPattern(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) resultsFail('invalid_metadata'); return value; }
function resultsArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) resultsFail('invalid_metadata');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) resultsFail('invalid_metadata');
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) resultsFail('invalid_metadata');
    output.push(descriptor.value);
  }
  return output;
}
function resultsChoice(value: unknown, labels: readonly string[]): Record<string, unknown> {
  const raw = resultsObject(value, ['type', 'choice', 'confidence', 'probabilities'], ['type', 'choice']);
  const output: Record<string, unknown> = { type: resultsEnum(raw.type, ['choice']), choice: resultsEnum(raw.choice, labels) };
  if (raw.confidence !== undefined) output.confidence = resultsProbability(raw.confidence);
  if (raw.probabilities !== undefined) {
    const probabilities = resultsObject(raw.probabilities, labels);
    output.probabilities = Object.fromEntries(Object.entries(probabilities).map(([label, probability]) => [label, resultsProbability(probability)]));
  }
  return output;
}
function resultsAdvice(value:unknown):Record<string,unknown> {
  const a = resultsObject(value, ['status', 'tier', 'confidence', 'confidenceKind', 'probabilities', 'reason'], ['status']);
  const advice: Record<string, unknown> = { status: resultsEnum(a.status, ['decision', 'no_decision']) };
  if (a.tier !== undefined) advice.tier = resultsEnum(a.tier, ['fast', 'balanced', 'strong']);
  if (a.confidence !== undefined) advice.confidence = resultsProbability(a.confidence);
  if (a.confidenceKind !== undefined) advice.confidenceKind = resultsEnum(a.confidenceKind, ['provider_choice', 'self_reported']);
  if (a.probabilities !== undefined) {
    const probabilities = resultsObject(a.probabilities, ['fast', 'balanced', 'strong'], ['fast', 'balanced', 'strong']);
    advice.probabilities = Object.fromEntries(Object.entries(probabilities).map(([tier, probability]) => [tier, resultsProbability(probability)]));
  }
  if (a.reason !== undefined) advice.reason = resultsEnum(a.reason, resultsAdviceReasons);
  return advice;
}
function resultsProject(value: unknown): Record<string, unknown> {
  const raw = resultsObject(value, ['operation', 'repositoryDigest', 'receiptId', 'toolCallDigest', 'durationMs', 'freshness', 'stateOverrideIgnored', 'execution', 'assessment', 'advice', 'taskAdvice', 'evidenceObservations', 'receiptStorage', 'evidenceStorage'], ['operation']);
  const output: Record<string, unknown> = { operation: resultsEnum(raw.operation, resultsOperations) };
  for (const key of ['repositoryDigest', 'receiptId']) if (raw[key] !== undefined) output[key] = raw[key] === null ? null : resultsPattern(raw[key], key === 'receiptId' ? resultsId : resultsHex);
  if (raw.toolCallDigest !== undefined) output.toolCallDigest = resultsPattern(raw.toolCallDigest, resultsHex);
  if (raw.durationMs !== undefined) output.durationMs = resultsInteger(raw.durationMs);
  if (raw.freshness !== undefined) output.freshness = resultsEnum(raw.freshness, ['fresh', 'stale', 'changed_during_run', 'unavailable']);
  if (raw.stateOverrideIgnored !== undefined) output.stateOverrideIgnored = resultsBoolean(raw.stateOverrideIgnored);
  if (raw.execution !== undefined) {
    const ex = resultsObject(raw.execution, ['status', 'reason', 'counts', 'assertions', 'cleanup'], ['status', 'reason']);
    const execution: Record<string, unknown> = { status: resultsEnum(ex.status, ['passed', 'failed', 'no_tests', 'incomplete', 'not_run', 'unavailable']), reason: resultsEnum(ex.reason, resultsExecutionReasons) };
    if (ex.counts !== undefined) {
      const counts = ex.counts === null ? null : resultsObject(ex.counts, resultsCountKeys, resultsCountKeys);
      execution.counts = counts === null ? null : Object.fromEntries(resultsCountKeys.map(key => [key, resultsInteger(counts[key], 10000)]));
    }
    if (ex.cleanup !== undefined) execution.cleanup = resultsEnum(ex.cleanup, ['confirmed', 'unconfirmed']);
    if (ex.assertions !== undefined) {
      const seen = new Set<number>();
      execution.assertions = resultsArray(ex.assertions, 20).map(value => {
        const assertion = resultsObject(value, ['step', 'id', 'kind', 'status'], ['step', 'id', 'kind', 'status']);
        const step = resultsInteger(assertion.step, 19);
        if (seen.has(step) || assertion.id !== 'step-' + step) resultsFail('invalid_metadata');
        seen.add(step);
        return { step, id: 'step-' + step, kind: resultsEnum(assertion.kind, ['visible', 'text_exact', 'text_substring']), status: resultsEnum(assertion.status, ['passed', 'failed']) };
      });
    }
    output.execution = execution;
  }
  if (raw.assessment !== undefined) {
    const a = resultsObject(raw.assessment, ['status', 'reason', 'answers'], ['status', 'reason']);
    const assessment: Record<string, unknown> = { status: resultsEnum(a.status, ['scored', 'unscored', 'unknown', 'unavailable', 'invalid_input', 'invalid_response']), reason: resultsEnum(a.reason, resultsAssessmentReasons) };
    if (a.answers !== undefined) {
      const answers = resultsObject(a.answers, ['coverage_alignment', 'boundary_evidence'], ['coverage_alignment', 'boundary_evidence']);
      assessment.answers = { coverage_alignment: resultsChoice(answers.coverage_alignment, ['aligned', 'gap', 'none', 'unknown']), boundary_evidence: resultsChoice(answers.boundary_evidence, ['present', 'missing', 'none', 'unknown']) };
    }
    output.assessment = assessment;
  }
  if (raw.advice !== undefined) output.advice = resultsAdvice(raw.advice);
  if (raw.taskAdvice !== undefined) {
    const seen = new Set<number>();
    output.taskAdvice = resultsArray(raw.taskAdvice,32).map(value=>{
      const task=resultsObject(value,['index','status','tier','confidence','basis','reason'],['index','status']);
      const index=resultsInteger(task.index,31);if(seen.has(index))resultsFail('invalid_metadata');seen.add(index);
      // The compact batch field keeps all32 full-precision decisions within the 4KiB record budget.
      const {index:rawIndex,basis,...advice}=task;
      const {confidenceKind,...projected}=resultsAdvice({...advice,...(basis!==undefined?{confidenceKind:basis}:{})});
      return {index,...projected,...(confidenceKind!==undefined?{basis:confidenceKind}:{})};
    });
  }
  if (raw.evidenceObservations !== undefined) {
    const keys=['completed','failed','cancelled','stored','unavailable'];
    const counts=resultsObject(raw.evidenceObservations,keys,keys);
    output.evidenceObservations=Object.fromEntries(keys.map(key=>[key,resultsInteger(counts[key])]));
  }
  if (raw.receiptStorage !== undefined) {
    const s = resultsObject(raw.receiptStorage, ['persisted', 'reason', 'count', 'bytes', 'nearCapacity'], ['persisted', 'reason']);
    const storage: Record<string, unknown> = { persisted: resultsBoolean(s.persisted), reason: resultsEnum(s.reason, resultsReceiptReasons) };
    for (const key of ['count', 'bytes']) if (s[key] !== undefined) storage[key] = resultsInteger(s[key]);
    if (s.nearCapacity !== undefined) storage.nearCapacity = resultsBoolean(s.nearCapacity);
    output.receiptStorage = storage;
  }
  if (raw.evidenceStorage !== undefined) {
    const s = resultsObject(raw.evidenceStorage, ['status', 'reason'], ['status']);
    const storage: Record<string, unknown> = { status: resultsEnum(s.status, ['ok', 'missing', 'unavailable', 'disabled', 'not_requested']) };
    if (s.reason !== undefined) storage.reason = resultsEnum(s.reason, resultsEvidenceReasons);
    output.evidenceStorage = storage;
  }
  return output;
}

export function pluginResultsRoot(): string {
  // Bun can cache os.homedir across HOME changes; honor the process-owned home for isolated consumers.
  const home = process.env.HOME || resultsHomedir();
  return resultsJoin(home, '.gjc-plugin');
}
type ResultsDirectory = { path: string; info: ResultsStats };
function resultsSame(a: ResultsStats, b: ResultsStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode; }
function resultsPrivateFile(info: ResultsStats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1) resultsFail('unsafe_path');
}
async function resultsCheckFile(file: string, expected: ResultsStats): Promise<ResultsStats> {
  const current = await resultsFs.lstat(file);
  resultsPrivateFile(current);
  if (!resultsSame(expected, current)) resultsFail('unsafe_path');
  return current;
}
function resultsPrivateBoundary(dir: string): string {
  const absolute = resultsResolve(dir);
  const parts = absolute.slice(resultsParse(absolute).root.length).split(resultsSep);
  const index = parts.indexOf('.gjc-plugin');
  return index < 0 ? absolute : resultsJoin(resultsParse(absolute).root, ...parts.slice(0, index + 1));
}
async function resultsCheckDirectories(entries: ResultsDirectory[]): Promise<void> {
  for (const entry of entries) {
    const now = await resultsFs.lstat(entry.path);
    if (!now.isDirectory() || now.isSymbolicLink() || !resultsSame(entry.info, now)) resultsFail('unsafe_path');
  }
}
async function resultsDirectories(dir: string, create: boolean, boundary = resultsPrivateBoundary(dir)): Promise<ResultsDirectory[]> {
  if (typeof dir !== 'string' || dir.includes('\0') || dir.split(resultsSep).includes('..')) resultsFail('unsafe_path');
  const absolute = resultsResolve(dir);
  boundary = resultsResolve(boundary);
  if (absolute !== boundary && !absolute.startsWith(boundary + resultsSep)) resultsFail('unsafe_path');
  const root = resultsParse(absolute).root;
  const paths = [root];
  let current = root;
  for (const part of absolute.slice(root.length).split(resultsSep).filter(Boolean)) { current = resultsJoin(current, part); paths.push(current); }
  const entries: ResultsDirectory[] = [];
  for (const path of paths) {
    const privatePath = path === boundary || path.startsWith(boundary + resultsSep);
    let info: ResultsStats;
    try { info = await resultsFs.lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create || !privatePath) throw error;
      await resultsCheckDirectories(entries);
      try { await resultsFs.mkdir(path, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      info = await resultsFs.lstat(path);
      // A concurrent creator is subject to the same ownership/mode checks, never repaired.
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (privatePath && (info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700))) resultsFail('unsafe_path');
    const handle = await resultsFs.open(path, resultsConstants.O_RDONLY | resultsConstants.O_DIRECTORY | resultsConstants.O_NOFOLLOW);
    try { if (!resultsSame(info, await handle.stat())) resultsFail('unsafe_path'); }
    finally { await handle.close(); }
    entries.push({ path, info });
  }
  await resultsCheckDirectories(entries);
  return entries;
}
export async function ensurePrivateResultDirectory(dir: string, create = true): Promise<void> { await resultsDirectories(dir, create); }
async function resultsOpenChecked(file: string, flags: number, directories: ResultsDirectory[]): Promise<ResultsFileHandle> {
  await resultsCheckDirectories(directories);
  const before = await resultsFs.lstat(file);
  resultsPrivateFile(before);
  const handle = await resultsFs.open(file, flags | resultsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    resultsPrivateFile(opened);
    if (!resultsSame(before, opened)) resultsFail('unsafe_path');
    await resultsCheckFile(file, opened);
    await resultsCheckDirectories(directories);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
export async function readPrivateResultFile(file: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) resultsFail('resource_limit');
  const directories = await resultsDirectories(resultsDirname(file), false);
  const handle = await resultsOpenChecked(file, resultsConstants.O_RDONLY, directories);
  try {
    const before = await handle.stat();
    resultsPrivateFile(before);
    if (before.size > maxBytes) resultsFail('resource_limit');
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    resultsPrivateFile(after);
    if (!resultsSame(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || offset !== before.size) resultsFail('unsafe_path');
    const current = await resultsCheckFile(file, after);
    if (after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) resultsFail('unsafe_path');
    await resultsCheckDirectories(directories);
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
async function resultsSyncDirectory(path: string, directories: ResultsDirectory[]): Promise<void> {
  await resultsCheckDirectories(directories);
  const handle = await resultsFs.open(path, resultsConstants.O_RDONLY | resultsConstants.O_DIRECTORY | resultsConstants.O_NOFOLLOW);
  try {
    const expected = directories.find(entry => entry.path === path);
    if (!expected || !resultsSame(expected.info, await handle.stat())) resultsFail('unsafe_path');
    await handle.sync();
  } finally { await handle.close(); }
  await resultsCheckDirectories(directories);
}
async function resultsCreate(file: string, body: string, directories: ResultsDirectory[]): Promise<ResultsStats> {
  await resultsCheckDirectories(directories);
  const handle = await resultsFs.open(file, resultsConstants.O_WRONLY | resultsConstants.O_CREAT | resultsConstants.O_EXCL | resultsConstants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat(); resultsPrivateFile(info);
    await resultsCheckFile(file, info);
    await resultsCheckDirectories(directories);
    await handle.writeFile(body); await handle.sync();
    const after = await handle.stat(); resultsPrivateFile(after);
    if (!resultsSame(info, after) || after.size !== Buffer.byteLength(body)) resultsFail('unsafe_path');
    await resultsCheckFile(file, after);
    await resultsCheckDirectories(directories);
    return after;
  } finally { await handle.close(); }
}
type ResultsSegment = { name: string; bytes: number; digest: string };
type ResultsInventory = { schemaVersion: 1; plugin: ResultsPlugin; owner: string; next: number; segments: ResultsSegment[] };
function resultsDigest(body: string | Buffer): string { return resultsHash('sha256').update(body).digest('hex'); }
function resultsInventory(value: unknown, plugin: ResultsPlugin, maxSegments: number, maxSegmentBytes: number): ResultsInventory {
  const raw = resultsObject(value, ['schemaVersion', 'plugin', 'owner', 'next', 'segments'], ['schemaVersion', 'plugin', 'owner', 'next', 'segments']);
  if (raw.schemaVersion !== 1 || raw.plugin !== plugin) resultsFail('store_corrupt');
  const owner = resultsPattern(raw.owner, resultsId);
  const next = resultsInteger(raw.next);
  const segments = resultsArray(raw.segments, maxSegments).map(value => {
    const s = resultsObject(value, ['name', 'bytes', 'digest'], ['name', 'bytes', 'digest']);
    if (typeof s.name !== 'string') resultsFail('store_corrupt');
    return { name: s.name, bytes: resultsInteger(s.bytes, maxSegmentBytes), digest: resultsPattern(s.digest, resultsHex) };
  });
  if (!segments.length || next < segments.length || segments.some((s, i) => s.name !== `${owner}-${next - segments.length + i}.jsonl` || s.bytes === 0)) resultsFail('store_corrupt');
  return { schemaVersion: 1, plugin, owner, next, segments };
}
type ResultsDecodedRecord = { id: string; observedAt: string; record: Record<string, unknown> };
// The single canonical decoder. The writer and the snapshot reader share this
// exact projection, so the reader never keeps a second permissive parser.
function resultsDecodeSegment(body: Buffer, plugin: ResultsPlugin, maxRecordBytes: number): ResultsDecodedRecord[] {
  const text = body.toString('utf8');
  if (!text.endsWith('\n')) resultsFail('store_corrupt');
  const decoded: ResultsDecodedRecord[] = [];
  for (const line of text.slice(0, -1).split('\n')) {
    if (Buffer.byteLength(line + '\n') > maxRecordBytes) resultsFail('store_corrupt');
    const raw = JSON.parse(line);
    const record = resultsObject(raw, ['schemaVersion', 'plugin', 'id', 'observedAt', 'operation', 'repositoryDigest', 'receiptId', 'toolCallDigest', 'durationMs', 'freshness', 'stateOverrideIgnored', 'execution', 'assessment', 'advice', 'taskAdvice', 'evidenceObservations', 'receiptStorage', 'evidenceStorage'], ['schemaVersion', 'plugin', 'id', 'observedAt', 'operation']);
    if (record.schemaVersion !== 1 || record.plugin !== plugin) resultsFail('store_corrupt');
    const id = resultsPattern(record.id, resultsId);
    if (typeof record.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.observedAt) || !Number.isFinite(Date.parse(record.observedAt))) resultsFail('store_corrupt');
    const { schemaVersion, plugin: storedPlugin, id: storedId, observedAt, ...outcome } = record;
    const canonical = { schemaVersion, plugin: storedPlugin, id: storedId, observedAt, ...resultsProject(outcome) };
    if (JSON.stringify(canonical) !== line) resultsFail('store_corrupt');
    decoded.push({ id, observedAt, record: canonical });
  }
  return decoded;
}
function resultsValidateSegment(body: Buffer, plugin: ResultsPlugin, maxRecordBytes: number): void { resultsDecodeSegment(body, plugin, maxRecordBytes); }
function resultsFailure(error: unknown): ResultsAppend {
  const reason = error instanceof Error ? error.message : '';
  return { persisted: false, reason: ['unsafe_path', 'resource_limit', 'store_corrupt', 'store_busy'].includes(reason) ? reason : 'store_unavailable' };
}

/** Append metadata only. A partial publication is deliberately not repaired or adopted. */
export async function appendPluginOutcome(plugin: ResultsPlugin, outcome: PluginOutcome, deps: ResultsDependencies = {}): Promise<ResultsAppend> {
  let projected: Record<string, unknown>;
  try { resultsEnum(plugin, resultsPlugins); projected = resultsProject(outcome); }
  catch { return { persisted: false, reason: 'invalid_metadata' }; }
  const maxRecordBytes = deps.maxRecordBytes ?? 4096;
  const maxSegmentBytes = deps.maxSegmentBytes ?? 1024 * 1024;
  const maxSegments = deps.maxSegments ?? 8;
  const lockTimeoutMs = deps.lockTimeoutMs ?? 100;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 || maxRecordBytes > 4096 || !Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 1 || maxSegmentBytes > 1024 * 1024 || !Number.isSafeInteger(maxSegments) || maxSegments < 1 || maxSegments > 8 || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 100) return { persisted: false, reason: 'invalid_limits' };
  const id = resultsUUID();
  const body = JSON.stringify({ schemaVersion: 1, plugin, id, observedAt: new Date().toISOString(), ...projected }) + '\n';
  const size = Buffer.byteLength(body);
  if (size > maxRecordBytes || size > maxSegmentBytes) return { persisted: false, reason: 'record_too_large' };
  const base = resultsResolve(deps.baseDir ?? pluginResultsRoot());
  const dir = resultsJoin(base, plugin, 'journal', 'v1');
  const lockPath = resultsJoin(dir, '.append.lock');
  let directories: ResultsDirectory[] = [];
  let lock: ResultsFileHandle | undefined;
  let lockInfo: ResultsStats | undefined;
  let result: ResultsAppend = { persisted: false, reason: 'store_unavailable' };
  try {
    directories = await resultsDirectories(dir, true, base);
    const deadline = resultsClock.now() + lockTimeoutMs;
    while (!lock) {
      await resultsCheckDirectories(directories);
      try { lock = await resultsFs.open(lockPath, resultsConstants.O_WRONLY | resultsConstants.O_CREAT | resultsConstants.O_EXCL | resultsConstants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try { const busy = await resultsOpenChecked(lockPath, resultsConstants.O_RDONLY, directories); await busy.close(); }
        catch (checkError) { if ((checkError as NodeJS.ErrnoException).code !== 'ENOENT') throw checkError; }
        if (resultsClock.now() >= deadline) resultsFail('store_busy');
        await new Promise(resolve => setTimeout(resolve, Math.min(5, Math.max(0, deadline - resultsClock.now()))));
      }
    }
    lockInfo = await lock.stat(); resultsPrivateFile(lockInfo);
    await resultsCheckFile(lockPath, lockInfo);
    await resultsCheckDirectories(directories);
    await lock.sync();
    const names: string[] = [];
    const listing = await resultsFs.opendir(dir);
    for await (const entry of listing) {
      names.push(entry.name);
      if (names.length > maxSegments + 2) resultsFail('store_corrupt');
    }
    const markerPath = resultsJoin(dir, 'inventory.json');
    let inventory: ResultsInventory;
    let activeBody = Buffer.alloc(0);
    let markerInfo: ResultsStats | undefined;
    if (names.length === 1 && names[0] === '.append.lock') {
      inventory = { schemaVersion: 1, plugin, owner: resultsUUID(), next: 0, segments: [] };
    } else {
      if (!names.includes('inventory.json')) resultsFail('store_corrupt');
      try { inventory = resultsInventory(JSON.parse((await readPrivateResultFile(markerPath, 8192)).toString('utf8')), plugin, maxSegments, maxSegmentBytes); }
      catch (error) { if (error instanceof Error && error.message === 'unsafe_path') throw error; resultsFail('store_corrupt'); }
      markerInfo = await resultsFs.lstat(markerPath);
      const expected = new Set(['.append.lock', 'inventory.json', ...inventory.segments.map(segment => segment.name)]);
      if (names.length !== expected.size || names.some(name => !expected.has(name))) resultsFail('store_corrupt');
      for (const segment of inventory.segments) {
        const bytes = await readPrivateResultFile(resultsJoin(dir, segment.name), maxSegmentBytes);
        if (bytes.length !== segment.bytes || resultsDigest(bytes) !== segment.digest) resultsFail('store_corrupt');
        try { resultsValidateSegment(bytes, plugin, maxRecordBytes); } catch { resultsFail('store_corrupt'); }
        activeBody = bytes;
      }
    }
    const retired: { segment: ResultsSegment; info: ResultsStats }[] = [];
    const active = inventory.segments.at(-1);
    if (active && active.bytes + size <= maxSegmentBytes) {
      const path = resultsJoin(dir, active.name);
      const handle = await resultsOpenChecked(path, resultsConstants.O_WRONLY | resultsConstants.O_APPEND, directories);
      try {
        if ((await handle.stat()).size !== active.bytes) resultsFail('store_corrupt');
        await handle.writeFile(body); await handle.sync();
        const after = await handle.stat(); resultsPrivateFile(after);
        if (after.size !== active.bytes + size) resultsFail('unsafe_path');
        await resultsCheckFile(path, after);
      } finally { await handle.close(); }
      active.bytes += size;
      active.digest = resultsDigest(Buffer.concat([activeBody, Buffer.from(body)]));
      if (resultsDigest(await readPrivateResultFile(path, maxSegmentBytes)) !== active.digest) resultsFail('store_corrupt');
    } else {
      if (!Number.isSafeInteger(inventory.next + 1)) resultsFail('resource_limit');
      const name = `${inventory.owner}-${inventory.next++}.jsonl`;
      await resultsCreate(resultsJoin(dir, name), body, directories);
      inventory.segments.push({ name, bytes: size, digest: resultsDigest(body) });
      while (inventory.segments.length > maxSegments) {
        const segment = inventory.segments.shift()!;
        const info = await resultsFs.lstat(resultsJoin(dir, segment.name)); resultsPrivateFile(info);
        retired.push({ segment, info });
      }
    }
    // Fixed pending name makes interrupted publication detectable; never clean up/adopt it.
    const pending = resultsJoin(dir, '.inventory.pending');
    const pendingInfo = await resultsCreate(pending, JSON.stringify(inventory), directories);
    await resultsSyncDirectory(dir, directories);
    if (markerInfo) {
      const current = await resultsCheckFile(markerPath, markerInfo);
      if (markerInfo.size !== current.size || markerInfo.mtimeMs !== current.mtimeMs || markerInfo.ctimeMs !== current.ctimeMs) resultsFail('store_corrupt');
    } else {
      try { await resultsFs.lstat(markerPath); resultsFail('store_corrupt'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await resultsCheckDirectories(directories);
    await resultsCheckFile(pending, pendingInfo);
    await resultsFs.rename(pending, markerPath);
    await resultsCheckFile(markerPath, pendingInfo);
    await resultsSyncDirectory(dir, directories);
    // Only the previously validated, marker-bound closed segments can retire.
    for (const { segment, info } of retired) {
      const path = resultsJoin(dir, segment.name);
      await resultsCheckDirectories(directories);
      if (resultsDigest(await readPrivateResultFile(path, maxSegmentBytes)) !== segment.digest) resultsFail('store_corrupt');
      const current = await resultsCheckFile(path, info);
      if (info.size !== current.size || info.mtimeMs !== current.mtimeMs || info.ctimeMs !== current.ctimeMs) resultsFail('store_corrupt');
      await resultsFs.unlink(path);
    }
    await resultsSyncDirectory(dir, directories);
    // Persist the newly created hierarchy, not just its final directory entry.
    for (const entry of directories.filter(entry => entry.path === base || entry.path.startsWith(base + resultsSep)).reverse()) await resultsSyncDirectory(resultsDirname(entry.path), directories);
    result = { persisted: true, reason: 'stored', id, rotated: retired.length, retainedSegments: inventory.segments.length };
  } catch (error) { result = resultsFailure(error); }
  finally {
    if (lock) {
      try {
        await resultsCheckDirectories(directories);
        const current = await resultsFs.lstat(lockPath); resultsPrivateFile(current);
        if (!lockInfo || !resultsSame(lockInfo, current) || !resultsSame(lockInfo, await lock.stat())) resultsFail('unsafe_path');
        await resultsFs.unlink(lockPath);
        await resultsSyncDirectory(dir, directories);
      } catch (error) { result = resultsFailure(error); }
      try { await lock.close(); } catch { result = { persisted: false, reason: 'store_unavailable' }; }
    }
  }
  return result;
}
export type ResultsSnapshotReason = 'store_busy' | 'store_corrupt' | 'unsafe_path' | 'resource_limit' | 'changed_during_read' | 'store_unavailable';
export type ResultsSnapshot = {
  status: 'ok' | 'missing' | 'unavailable';
  reason: ResultsSnapshotReason | null;
  records: Record<string, unknown>[];
  segments: number;
  bytes: number;
};
type ResultsSnapshotDependencies = { baseDir?: string };
type ResultsDirectoryIdentity = { path: string; dev: number; ino: number; mode: number };
function resultsIdentity(info: ResultsStats): ResultsDirectoryIdentity { return { path: '', dev: info.dev, ino: info.ino, mode: info.mode }; }
function resultsStable(a: ResultsStats, b: ResultsStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink;
}
function resultsIdentityStable(list: ResultsDirectoryIdentity[], directories: ResultsDirectory[]): boolean {
  return list.length === directories.length && list.every((entry, index) => entry.path === directories[index].path && entry.dev === directories[index].info.dev && entry.ino === directories[index].info.ino && entry.mode === directories[index].info.mode);
}
function resultsSnapshotFailure(error: unknown): ResultsSnapshot {
  const reason = error instanceof Error ? error.message : '';
  if (['store_busy', 'store_corrupt', 'unsafe_path', 'resource_limit', 'changed_during_read'].includes(reason)) return { status: 'unavailable', reason: reason as ResultsSnapshotReason, records: [], segments: 0, bytes: 0 };
  return { status: 'unavailable', reason: 'store_unavailable', records: [], segments: 0, bytes: 0 };
}
function resultsSafeMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
/**
 * One bounded optimistic snapshot attempt. Never creates, repairs, deletes or
 * locks anything: an existing safe append lock means store_busy. A safe empty
 * journal directory is missing; a nonempty directory without an inventory is
 * unavailable rather than synthesized empty. All identities are rechecked
 * before any record is published, so a generation that changed mid-read is
 * discarded whole (changed_during_read), never salvaged as a prefix.
 */
export async function readPluginOutcomeSnapshot(plugin: ResultsPlugin, deps: ResultsSnapshotDependencies = {}): Promise<ResultsSnapshot> {
  const maxRecordBytes = 4096, maxSegmentBytes = 1024 * 1024, maxSegments = 8;
  try {
    resultsEnum(plugin, resultsPlugins);
    const base = resultsResolve(deps.baseDir ?? pluginResultsRoot());
    const dir = resultsJoin(base, plugin, 'journal', 'v1');
    let directories: ResultsDirectory[];
    try { directories = await resultsDirectories(dir, false, base); }
    catch (error) {
      if (resultsSafeMissing(error)) return { status: 'missing', reason: null, records: [], segments: 0, bytes: 0 };
      throw error;
    }
    const identities = directories.map(entry => ({ ...resultsIdentity(entry.info), path: entry.path }));
    // Bounded exact-name listing before any content read.
    const names: string[] = [];
    const listing = await resultsFs.opendir(dir);
    for await (const entry of listing) {
      names.push(entry.name);
      if (names.length > maxSegments + 2) resultsFail('store_corrupt');
    }
    if (names.includes('.append.lock')) {
      const lockPath = resultsJoin(dir, '.append.lock');
      const lockInfo = await resultsFs.lstat(lockPath);
      resultsPrivateFile(lockInfo);
      resultsFail('store_busy');
    }
    if (names.includes('.inventory.pending')) resultsFail('store_corrupt');
    const markerPath = resultsJoin(dir, 'inventory.json');
    if (!names.includes('inventory.json')) {
      if (names.length === 0) return { status: 'missing', reason: null, records: [], segments: 0, bytes: 0 };
      resultsFail('store_corrupt');
    }
    const markerInfo = await resultsFs.lstat(markerPath);
    resultsPrivateFile(markerInfo);
    const markerText = (await readPrivateResultFile(markerPath, 8192)).toString('utf8');
    let inventory: ResultsInventory;
    try { inventory = resultsInventory(JSON.parse(markerText), plugin, maxSegments, maxSegmentBytes); }
    catch { resultsFail('store_corrupt'); }
    const expected = new Set(['inventory.json', ...inventory.segments.map(segment => segment.name)]);
    if (names.length !== expected.size || names.some(name => !expected.has(name))) resultsFail('store_corrupt');
    const records: Record<string, unknown>[] = [];
    const segmentInfos: { name: string; info: ResultsStats }[] = [];
    let bytes = 0;
    const seenIds = new Set<string>();
    for (const segment of inventory.segments) {
      const path = resultsJoin(dir, segment.name);
      const info = await resultsFs.lstat(path);
      resultsPrivateFile(info);
      const body = await readPrivateResultFile(path, maxSegmentBytes);
      if (body.length !== segment.bytes || resultsDigest(body) !== segment.digest) resultsFail('store_corrupt');
      let decodedRecords: ResultsDecodedRecord[];
      try { decodedRecords = resultsDecodeSegment(body, plugin, maxRecordBytes); }
      catch { resultsFail('store_corrupt'); }
      for (const decoded of decodedRecords) {
        if (seenIds.has(decoded.id)) resultsFail('store_corrupt');
        seenIds.add(decoded.id);
        records.push(decoded.record);
      }
      bytes += body.length;
      segmentInfos.push({ name: segment.name, info });
    }
    // Recheck every identity, name, lock/pending absence and the marker before publishing.
    if (!resultsIdentityStable(identities, await resultsDirectories(dir, false, base))) resultsFail('changed_during_read');
    const after: string[] = [];
    const relisting = await resultsFs.opendir(dir);
    for await (const entry of relisting) {
      after.push(entry.name);
      if (after.length > maxSegments + 2) resultsFail('store_corrupt');
    }
    if (after.length !== names.length || after.some(name => !names.includes(name))) resultsFail('changed_during_read');
    if (after.includes('.append.lock') || after.includes('.inventory.pending')) resultsFail('changed_during_read');
    let currentMarker: ResultsStats;
    try { currentMarker = await resultsCheckFile(markerPath, markerInfo); }
    catch { resultsFail('changed_during_read'); }
    if (!resultsStable(markerInfo, currentMarker)) resultsFail('changed_during_read');
    const recheckText = (await readPrivateResultFile(markerPath, 8192)).toString('utf8');
    let recheckInventory: unknown;
    try { recheckInventory = resultsInventory(JSON.parse(recheckText), plugin, maxSegments, maxSegmentBytes); } catch { resultsFail('changed_during_read'); }
    if (JSON.stringify(recheckInventory) !== JSON.stringify(inventory)) resultsFail('changed_during_read');
    for (const { name, info } of segmentInfos) {
      const path = resultsJoin(dir, name);
      let current: ResultsStats;
      try { current = await resultsCheckFile(path, info); }
      catch { resultsFail('changed_during_read'); }
      if (!resultsStable(info, current)) resultsFail('changed_during_read');
      if (resultsDigest(await readPrivateResultFile(path, maxSegmentBytes)) !== inventory.segments.find(segment => segment.name === name)!.digest) resultsFail('changed_during_read');
    }
    return { status: 'ok', reason: null, records, segments: inventory.segments.length, bytes };
  } catch (error) { return resultsSnapshotFailure(error); }
}
/**
 * jev-advisor shared source. scripts/build.mjs inlines this file into the
 * generated hook and tool surfaces; edit this source, never the generated files.
 */

import {
	closeSync,
	constants as fsConstants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const TIERS = ["fast", "balanced", "strong"] as const;
export type Tier = (typeof TIERS)[number];
export type ConfidenceKind = "provider_choice" | "self_reported";

export type NoDecisionReason =
	| "invalid_task"
	| "unsupported_input"
	| "input_too_large"
	| "batch_limit"
	| "disabled"
	| "unconfigured"
	| "invalid_endpoint"
	| "rate_limited"
	| "budget_exceeded"
	| "already_pending"
	| "timeout"
	| "aborted"
	| "provider_error"
	| "invalid_response";

export type Advice =
	| {
			status: "decision";
			tier: Tier;
			confidence: number;
			probabilities?: Record<Tier, number>;
			confidenceKind: ConfidenceKind;
			rationale?: string;
	  }
	| { status: "no_decision"; reason: NoDecisionReason; httpStatus?: number };

export const DEFAULTS = {
	model: "typesafe/jev-1.13",
	timeoutMs: 8000,
	minIntervalMs: 15000,
	minConfidence: 0.6,
	memoryMaxKeys: 200,
	memoryMaxEvents: 10,
} as const;

export const MAX_TASKS_PER_INVOCATION = 32;
export const MAX_PROVIDER_REQUESTS_PER_INVOCATION = 4;
export const INVOCATION_BUDGET_MS = 8000;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_GROUPS = 200;
const MAX_TASKS_PER_GROUP = 10;
const MAX_RETAINED_RECORDS = 2000;
const MAX_LOCK_WAIT_MS = 100;
const MAX_ID_CHARS = 512;

export interface TaskInput {
	index: number;
	callerId: string | null;
	requestedTier: Tier | null;
	fingerprint: string;
	prompt: string;
	complete: boolean;
}

export interface Extraction {
	tasks: TaskInput[];
	rejected: { index: number; reason: NoDecisionReason }[];
	omittedCount: number;
}

export interface DecisionConfig {
	provider: string;
	mode: AdvisorMode;
	endpoint: string;
	apiKey: string;
	model: string;
	timeoutMs: number;
	minIntervalMs: number;
	minConfidence: number;
	memoryEnabled: boolean;
	stateFile: string;
	stateOverrideIgnored: boolean;
	memoryMaxKeys: number;
	memoryMaxEvents: number;
}
export type AdvisorConfig = DecisionConfig;
export type AdvisorMode = "shadow" | "hint" | "enforce";
type Env = Record<string, string | undefined>;

export function tierRank(tier: string): number {
	const index = TIERS.indexOf(String(tier ?? "").trim().toLowerCase() as Tier);
	return index < 0 ? 1 : index;
}

export function pluginEnvFile(): string {
	return path.join(os.homedir(), ".gjc", "agent", "jev-advisor", ".env");
}

/** Result-state base; the v2 store is derived without reading or migrating legacy data. */
export function pluginStateFile(): string {
	return path.join(pluginResultsRoot(), "jev-advisor", "state.json");
}

export function version2StateFile(base: string): string {
	const resolved = path.resolve(base);
	const extension = path.extname(resolved);
	return extension
		? `${resolved.slice(0, -extension.length)}.v2${extension}`
		: `${resolved}.v2`;
}

function loadPluginEnv(): Env {
	try {
		return parseEnvFile(readFileSync(pluginEnvFile(), "utf8"));
	} catch {
		return {};
	}
}

const REQUEST_STYLES = {
	"openai-chat": {
		request(cfg: { model: string; apiKey: string }, assignment: string) {
			return {
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${cfg.apiKey}`,
				},
				body: JSON.stringify({
					model: cfg.model,
					temperature: 0,
					max_tokens: 2048,
					messages: [
						{
							role: "system",
							content:
								"You are a delegation-effort advisor for a coding agent. Given one complete subagent task assignment, decide how much model effort it warrants. " +
								'Reply with ONLY JSON: {"tier":"fast"|"balanced"|"strong","confidence":<number from 0 to 1>,"rationale":"<max 120 chars>"}. ' +
								"fast = mechanical or small measured edits; balanced = default implementation work; strong = multi-file reasoning, architecture decisions, or high blast radius.",
						},
						{ role: "user", content: assignment },
					],
				}),
			};
		},
	},
	systemone: {
		request(cfg: { model: string; apiKey: string }, assignment: string) {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
			return {
				headers,
				body: JSON.stringify({
					model: cfg.model,
					state: assignment,
					questions: {
						tier: {
							type: "choice",
							instructions: "How much model effort does this subagent task assignment warrant?",
							criteria: {
								fast: "Mechanical or small measured edits",
								balanced: "Default implementation work",
								strong: "Multi-file reasoning, architecture decisions, or high blast radius",
							},
						},
					},
				}),
			};
		},
	},
} as const;

export const PROVIDERS: Record<
	string,
	{ endpoint: string; style: keyof typeof REQUEST_STYLES; keyless?: boolean; model?: string }
> = {
	jev: { endpoint: "https://openrouter.ai/api/alpha/decisions", style: "systemone", model: "typesafe/jev-1.13" },
	openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", style: "openai-chat", model: "openai/gpt-5-mini" },
	"typesafe-jev": { endpoint: "https://api.typesafe.ai/v1/systemone", style: "systemone", model: "jev-latest" },
	ollaya: { endpoint: "http://127.0.0.1:11435/v1/systemone", style: "systemone", keyless: true, model: "laya" },
};

const ALLOWED_ORIGINS = new Set(["https://openrouter.ai", "https://api.typesafe.ai"]);
const ATTRIBUTION_HEADERS: Record<string, string> = {
	"http-referer": "https://github.com/jjongguet/gjc-plugin",
	"x-title": "jev-advisor",
};
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isAllowedEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		if (url.username || url.password) return false;
		if (url.protocol === "https:") return ALLOWED_ORIGINS.has(url.origin);
		if (url.protocol === "http:")
			return LOOPBACK_HOSTS.has(url.hostname) && url.username === "" && url.password === "";
		return false;
	} catch {
		return false;
	}
}

export function providerPromptLimit(cfg: Pick<AdvisorConfig, "provider">): 1900 | 4000 {
	return cfg.provider === "ollaya" ? 1900 : 4000;
}

function nonNegativeInteger(raw: string | undefined, fallback: number, cap: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0
		? Math.min(parsed, cap)
		: fallback;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseEnvFile(text: string): Env {
	const out: Env = {};
	for (const rawLine of String(text ?? "").split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		let key = line.slice(0, eq).trim();
		if (key.startsWith("export ")) key = key.slice("export ".length).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		} else {
			const hash = value.indexOf(" #");
			if (hash !== -1) value = value.slice(0, hash).trim();
		}
		if (key) out[key] = value;
	}
	return out;
}

export function readConfig(
	env: Env = (globalThis as { process?: { env: Env } }).process?.env ?? {},
	fileEnv: Env = loadPluginEnv(),
): AdvisorConfig {
	const merged: Env = { ...fileEnv };
	for (const [key, value] of Object.entries(env)) if (value !== undefined) merged[key] = value;
	const provider = String(merged.JEV_ADVISOR_PROVIDER ?? "jev").trim().toLowerCase();
	const modeRaw = String(merged.JEV_ADVISOR_MODE ?? "shadow").trim().toLowerCase();
	const mode: AdvisorMode = modeRaw === "hint" || modeRaw === "enforce" ? modeRaw : "shadow";
	const trim = (value: unknown) => (typeof value === "string" ? value.trim() : "");
	const intervalRaw = Number(merged.JEV_ADVISOR_MIN_INTERVAL_MS);
	const confidenceRaw = Number(merged.JEV_ADVISOR_MIN_CONFIDENCE);
	const memoryRaw = String(merged.JEV_ADVISOR_MEMORY ?? "").trim().toLowerCase();
	return {
		provider,
		mode,
		endpoint: trim(merged.JEV_ADVISOR_ENDPOINT) || trim(PROVIDERS[provider]?.endpoint),
		apiKey: trim(merged.JEV_ADVISOR_API_KEY) || trim(merged.OPENROUTER_API_KEY),
		model: trim(merged.JEV_ADVISOR_MODEL) || trim(PROVIDERS[provider]?.model) || DEFAULTS.model,
		timeoutMs: Math.min(positiveNumber(merged.JEV_ADVISOR_TIMEOUT_MS, DEFAULTS.timeoutMs), INVOCATION_BUDGET_MS),
		minIntervalMs: Number.isFinite(intervalRaw) && intervalRaw >= 0 ? intervalRaw : DEFAULTS.minIntervalMs,
		minConfidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : DEFAULTS.minConfidence,
		memoryEnabled:
			memoryRaw === "" || !(memoryRaw === "off" || memoryRaw === "0" || memoryRaw === "false" || memoryRaw === "no"),
		stateFile: pluginStateFile(),
		stateOverrideIgnored: Boolean(trim(merged.JEV_ADVISOR_STATE)),
		memoryMaxKeys: nonNegativeInteger(merged.JEV_ADVISOR_MEMORY_MAX_KEYS, DEFAULTS.memoryMaxKeys, MAX_GROUPS),
		memoryMaxEvents: nonNegativeInteger(merged.JEV_ADVISOR_MEMORY_MAX_EVENTS, DEFAULTS.memoryMaxEvents, MAX_TASKS_PER_GROUP),
	};
}

export function isConfigured(cfg: AdvisorConfig): boolean {
	if (cfg.provider === "off" || !cfg.endpoint) return false;
	if (PROVIDERS[cfg.provider]?.keyless) return true;
	return Boolean(cfg.apiKey) && Boolean(PROVIDERS[cfg.provider] || cfg.endpoint);
}

function normalizeField(value: string): string {
	return value.replace(/\r\n?/g, "\n").trim();
}

function validTier(value: unknown): Tier | null {
	if (typeof value !== "string") return null;
	const tier = value.trim().toLowerCase();
	return TIERS.includes(tier as Tier) ? (tier as Tier) : null;
}

function boundedIdentity(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_ID_CHARS || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
	return normalized;
}

export function fingerprint(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Normalize a supported task batch without aggregating children or truncating
 * provider input. Rejected and omitted entries remain explicit coverage data.
 */
export function extractTasks(input: unknown, maxPromptChars: 1900 | 4000): Extraction {
	const rejected: Extraction["rejected"] = [];
	if (!isRecord(input) || !Array.isArray(input.tasks)) {
		return { tasks: [], rejected: [{ index: -1, reason: "unsupported_input" }], omittedCount: 0 };
	}
	const original = input.tasks as unknown[];
	const boundedCount = Math.min(original.length, MAX_TASKS_PER_INVOCATION);
	const omittedCount = Math.max(0, original.length - boundedCount);
	const agentRaw = Object.prototype.hasOwnProperty.call(input, "agent") ? input.agent : input.role;
	const sharedRaw = input.context;
	const sharedMalformed =
		(Object.prototype.hasOwnProperty.call(input, "agent") && typeof input.agent !== "string") ||
		(Object.prototype.hasOwnProperty.call(input, "role") && typeof input.role !== "string") ||
		(Object.prototype.hasOwnProperty.call(input, "context") && typeof sharedRaw !== "string");
	const role = typeof agentRaw === "string" ? normalizeField(agentRaw) : "";
	const sharedContext = typeof sharedRaw === "string" ? normalizeField(sharedRaw) : "";
	const tasks: TaskInput[] = [];
	for (let index = 0; index < boundedCount; index++) {
		const raw = original[index];
		if (!isRecord(raw) || sharedMalformed) {
			rejected.push({ index, reason: "invalid_task" });
			continue;
		}
		const badDescription = Object.prototype.hasOwnProperty.call(raw, "description") && typeof raw.description !== "string";
		const badAssignment = Object.prototype.hasOwnProperty.call(raw, "assignment") && typeof raw.assignment !== "string";
		if (badDescription || badAssignment) {
			rejected.push({ index, reason: "invalid_task" });
			continue;
		}
		const description = typeof raw.description === "string" ? normalizeField(raw.description) : "";
		const assignment = typeof raw.assignment === "string" ? normalizeField(raw.assignment) : "";
		if (!description && !assignment) {
			rejected.push({ index, reason: "invalid_task" });
			continue;
		}
		const canonical = JSON.stringify({ role, description, assignment, sharedContext });
		const promptParts: string[] = [];
		if (role) promptParts.push(`role:\n${role}`);
		if (sharedContext) promptParts.push(`shared context:\n${sharedContext}`);
		if (description) promptParts.push(`task description:\n${description}`);
		if (assignment) promptParts.push(`task assignment:\n${assignment}`);
		const prompt = promptParts.join("\n\n");
		const callerId = boundedIdentity(raw.id);
		tasks.push({
			index,
			callerId,
			requestedTier: validTier(raw.tier),
			fingerprint: fingerprint(canonical),
			prompt,
			complete: prompt.length <= maxPromptChars,
		});
	}
	return { tasks, rejected, omittedCount };
}

export interface TaskRef {
	sessionId: string;
	toolCallId: string;
	taskIndex: number;
}
export interface JobRef {
	sessionId: string;
	jobId: string;
}
export type TerminalStatus = "completed" | "failed" | "cancelled";

export function taskRefKey(ref: TaskRef): string | null {
	const sessionId = boundedIdentity(ref?.sessionId);
	const toolCallId = boundedIdentity(ref?.toolCallId);
	if (!sessionId || !toolCallId || !Number.isInteger(ref.taskIndex) || ref.taskIndex < 0 || ref.taskIndex >= MAX_TASKS_PER_INVOCATION) {
		return null;
	}
	return JSON.stringify([sessionId, toolCallId, ref.taskIndex]);
}

export function jobRefKey(ref: JobRef): string | null {
	const sessionId = boundedIdentity(ref?.sessionId);
	const jobId = boundedIdentity(ref?.jobId);
	return sessionId && jobId ? JSON.stringify([sessionId, jobId]) : null;
}

export interface StoredDecision {
	status: "decision";
	tier: Tier;
	confidence: number;
	probabilities?: Record<Tier, number>;
	confidenceKind: ConfidenceKind;
}
export type StoredAdvice = StoredDecision | Extract<Advice, { status: "no_decision" }>;
export type LaunchDisposition = "not_observed" | "observed" | "blocked";
export interface TaskRecord {
	ref: TaskRef;
	fingerprint: string;
	callerId: string | null;
	requestedTier: Tier | null;
	requestToken: string;
	advice: StoredAdvice | null;
	createdAt: number;
	updatedAt: number;
	launchDisposition: LaunchDisposition;
	jobKey: string | null;
	conflicts: string[];
}
export interface TaskGroup {
	updatedAt: number;
	tasks: Record<string, TaskRecord>;
}
export interface JobRecord {
	ref: JobRef;
	childId?: string;
	status: TerminalStatus;
	statusObservations: TerminalStatus[];
	durationMs?: number;
	durationObservations: number[];
	requestedModel?: string;
	requestedModelObservations: string[];
	effectiveModel?: string;
	effectiveModelObservations: string[];
	allocatedChildIds: string[];
	actualTier: null;
	observedAt: number;
	taskKey: string | null;
	conflicts: string[];
}
export interface EvidenceV2 {
	version: 2;
	groups: Record<string, TaskGroup>;
	jobs: Record<string, JobRecord>;
}
export interface StoreLimits {
	memoryMaxKeys: number;
	memoryMaxEvents: number;
}
export type StoreUnavailableReason =
	| "locked"
	| "corrupt"
	| "unsupported_version"
	| "oversized"
	| "unsafe_path"
	| "io_error";
export type StoreResult<T> =
	| { status: "ok"; value: T }
	| { status: "unavailable"; reason: StoreUnavailableReason };
export type StoreReadResult =
	| { status: "ok"; value: EvidenceV2 }
	| { status: "missing" }
	| { status: "unavailable"; reason: StoreUnavailableReason };

export function storeLimits(cfg: Pick<AdvisorConfig, "memoryMaxKeys" | "memoryMaxEvents">): StoreLimits {
	const keys = Number.isInteger(cfg.memoryMaxKeys) && cfg.memoryMaxKeys >= 0 ? Math.min(cfg.memoryMaxKeys, MAX_GROUPS) : DEFAULTS.memoryMaxKeys;
	const events = Number.isInteger(cfg.memoryMaxEvents) && cfg.memoryMaxEvents >= 0 ? Math.min(cfg.memoryMaxEvents, MAX_TASKS_PER_GROUP) : DEFAULTS.memoryMaxEvents;
	return { memoryMaxKeys: keys, memoryMaxEvents: events };
}

export function emptyEvidenceV2(): EvidenceV2 {
	return { version: 2, groups: {}, jobs: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(record).every(key => allowed.includes(key));
}

function validTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validProbabilityRecord(value: unknown): value is Record<Tier, number> {
	if (!isRecord(value) || Object.keys(value).length !== TIERS.length || !TIERS.every(tier => Object.prototype.hasOwnProperty.call(value, tier))) return false;
	const values = TIERS.map(tier => value[tier]);
	if (!values.every(number => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1)) return false;
	const sum = (values as number[]).reduce((a, b) => a + b, 0);
	return Math.abs(sum - 1) <= 0.001 + 1e-9;
}

function validateStoredAdvice(value: unknown): value is StoredAdvice {
	if (!isRecord(value)) return false;
	if (value.status === "no_decision") {
		const allowed = ["status", "reason", "httpStatus"];
		return hasOnlyKeys(value, allowed) && typeof value.reason === "string" && isNoDecisionReason(value.reason) &&
			(value.httpStatus === undefined || (typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599));
	}
	if (value.status !== "decision" || !validTier(value.tier) || typeof value.confidence !== "number" ||
		!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
		(value.confidenceKind !== "provider_choice" && value.confidenceKind !== "self_reported")) return false;
		if (!hasOnlyKeys(value, ["status", "tier", "confidence", "probabilities", "confidenceKind"])) return false;
	return value.probabilities === undefined || validProbabilityRecord(value.probabilities);
}

function isNoDecisionReason(value: string): value is NoDecisionReason {
	return [
		"invalid_task", "unsupported_input", "input_too_large", "batch_limit", "disabled", "unconfigured",
		"invalid_endpoint", "rate_limited", "budget_exceeded", "already_pending", "timeout", "aborted",
		"provider_error", "invalid_response",
	].includes(value);
}

function validTaskRef(value: unknown): value is TaskRef {
	if (!isRecord(value) || !hasOnlyKeys(value, ["sessionId", "toolCallId", "taskIndex"])) return false;
	return boundedIdentity(value.sessionId) !== null && boundedIdentity(value.toolCallId) !== null &&
		Number.isInteger(value.taskIndex) && Number(value.taskIndex) >= 0 && Number(value.taskIndex) < MAX_TASKS_PER_INVOCATION;
}

function validJobRef(value: unknown): value is JobRef {
	return isRecord(value) && hasOnlyKeys(value, ["sessionId", "jobId"]) &&
		boundedIdentity(value.sessionId) !== null && boundedIdentity(value.jobId) !== null;
}

function validStringArray(value: unknown, maxCount: number, maxLength: number): value is string[] {
	return Array.isArray(value) && value.length <= maxCount && value.every(item => typeof item === "string" && item.length <= maxLength && item.trim() === item);
}

const CONFLICT_FLAGS = new Set([
	"identity_input_conflict",
	"launch_mapping_evicted",
	"multiple_job_associations",
	"multiple_task_associations",
	"status_conflict",
	"duration_conflict",
	"requested_model_conflict",
	"effective_model_conflict",
	"child_id_conflict",
	"stale_job_mapping",
]);

function validConflictArray(value: unknown): value is string[] {
	return validStringArray(value, 8, 64) && value.every(flag => CONFLICT_FLAGS.has(flag));
}

function validJobKeyForSession(value: unknown, sessionId: string): value is string {
	if (typeof value !== "string") return false;
	try {
		const tuple: unknown = JSON.parse(value);
		return Array.isArray(tuple) && tuple.length === 2 && tuple[0] === sessionId &&
			boundedIdentity(tuple[1]) !== null && jobRefKey({ sessionId, jobId: tuple[1] as string }) === value;
	} catch {
		return false;
	}
}

function validateStore(value: unknown): value is EvidenceV2 {
	if (!isRecord(value) || value.version !== 2 || !hasOnlyKeys(value, ["version", "groups", "jobs"]) || !isRecord(value.groups) || !isRecord(value.jobs)) return false;
	const seenTasks = new Set<string>();
	for (const [fingerprintKey, rawGroup] of Object.entries(value.groups)) {
		if (!/^[0-9a-f]{64}$/.test(fingerprintKey) || !isRecord(rawGroup) || !hasOnlyKeys(rawGroup, ["updatedAt", "tasks"]) ||
			!validTime(rawGroup.updatedAt) || !isRecord(rawGroup.tasks)) return false;
		for (const [key, rawTask] of Object.entries(rawGroup.tasks)) {
			if (!isRecord(rawTask) || !hasOnlyKeys(rawTask, ["ref", "fingerprint", "callerId", "requestedTier", "requestToken", "advice", "createdAt", "updatedAt", "launchDisposition", "jobKey", "conflicts"])) return false;
			if (!validTaskRef(rawTask.ref) || taskRefKey(rawTask.ref) !== key || rawTask.fingerprint !== fingerprintKey ||
				(rawTask.callerId !== null && boundedIdentity(rawTask.callerId) === null) ||
				(rawTask.requestedTier !== null && !validTier(rawTask.requestedTier)) ||
				typeof rawTask.requestToken !== "string" || !/^[0-9a-f-]{36}$/i.test(rawTask.requestToken) ||
				(rawTask.advice !== null && !validateStoredAdvice(rawTask.advice)) || !validTime(rawTask.createdAt) || !validTime(rawTask.updatedAt) ||
				!(["not_observed", "observed", "blocked"] as unknown[]).includes(rawTask.launchDisposition) ||
				(rawTask.jobKey !== null && !validJobKeyForSession(rawTask.jobKey, rawTask.ref.sessionId)) || !validConflictArray(rawTask.conflicts)) return false;
			if (seenTasks.has(key)) return false;
			seenTasks.add(key);
		}
	}
	for (const [key, rawJob] of Object.entries(value.jobs)) {
		if (!isRecord(rawJob) || !hasOnlyKeys(rawJob, ["ref", "childId", "status", "statusObservations", "durationMs", "durationObservations", "requestedModel", "requestedModelObservations", "effectiveModel", "effectiveModelObservations", "allocatedChildIds", "actualTier", "observedAt", "taskKey", "conflicts"])) return false;
		if (!validJobRef(rawJob.ref) || jobRefKey(rawJob.ref) !== key ||
			!(["completed", "failed", "cancelled"] as unknown[]).includes(rawJob.status) ||
			!Array.isArray(rawJob.statusObservations) || rawJob.statusObservations.length < 1 || rawJob.statusObservations.length > 3 ||
			!rawJob.statusObservations.every(status => ["completed", "failed", "cancelled"].includes(String(status))) ||
			(rawJob.durationMs !== undefined && !(typeof rawJob.durationMs === "number" && Number.isFinite(rawJob.durationMs) && rawJob.durationMs > 0)) ||
			!Array.isArray(rawJob.durationObservations) || rawJob.durationObservations.length > 4 ||
			!rawJob.durationObservations.every(duration => typeof duration === "number" && Number.isFinite(duration) && duration > 0) ||
			(rawJob.requestedModel !== undefined && (typeof rawJob.requestedModel !== "string" || rawJob.requestedModel.length > 128)) ||
			(rawJob.effectiveModel !== undefined && (typeof rawJob.effectiveModel !== "string" || rawJob.effectiveModel.length > 128)) ||
			!validStringArray(rawJob.requestedModelObservations, 4, 128) || !validStringArray(rawJob.effectiveModelObservations, 4, 128) ||
			!validStringArray(rawJob.allocatedChildIds, 4, MAX_ID_CHARS) || rawJob.actualTier !== null || !validTime(rawJob.observedAt) ||
			(rawJob.childId !== undefined && boundedIdentity(rawJob.childId) === null) ||
			(rawJob.taskKey !== null && typeof rawJob.taskKey !== "string") || !validConflictArray(rawJob.conflicts)) return false;
	}
	const tasksByKey = new Map<string, TaskRecord>();
	for (const group of Object.values(value.groups)) {
		for (const [key, task] of Object.entries(group.tasks)) tasksByKey.set(key, task);
	}
	for (const [jobKey, job] of Object.entries(value.jobs)) {
		if (job.taskKey === null) continue;
		const task = tasksByKey.get(job.taskKey);
		if (!task || task.ref.sessionId !== job.ref.sessionId || task.jobKey !== jobKey) return false;
	}
	return true;
}

function normalizeLimits(limits: StoreLimits): { groups: number; perGroup: number; total: number } {
	const groups = Number.isInteger(limits.memoryMaxKeys) && limits.memoryMaxKeys >= 0 ? Math.min(limits.memoryMaxKeys, MAX_GROUPS) : DEFAULTS.memoryMaxKeys;
	const perGroup = Number.isInteger(limits.memoryMaxEvents) && limits.memoryMaxEvents >= 0 ? Math.min(limits.memoryMaxEvents, MAX_TASKS_PER_GROUP) : DEFAULTS.memoryMaxEvents;
	return { groups, perGroup, total: Math.min(groups * perGroup, MAX_RETAINED_RECORDS) };
}

function appendConflict(conflicts: string[], flag: string): void {
	if (!conflicts.includes(flag) && conflicts.length < 8) conflicts.push(flag);
}

function clearTaskAssociations(state: EvidenceV2, removedKey: string): void {
	for (const job of Object.values(state.jobs)) {
		if (job.taskKey === removedKey) {
			job.taskKey = null;
			appendConflict(job.conflicts, "launch_mapping_evicted");
		}
	}
}

function deleteTask(state: EvidenceV2, groupKey: string, key: string): void {
	const group = state.groups[groupKey];
	if (!group || !group.tasks[key]) return;
	delete group.tasks[key];
	clearTaskAssociations(state, key);
	if (Object.keys(group.tasks).length === 0) delete state.groups[groupKey];
}

function encodedBytes(state: EvidenceV2): number {
	return Buffer.byteLength(JSON.stringify(state), "utf8");
}

function capStore(state: EvidenceV2, limits: StoreLimits): boolean {
	const cap = normalizeLimits(limits);
	for (const [groupKey, group] of Object.entries(state.groups)) {
		const taskEntries = Object.entries(group.tasks);
		taskEntries.sort(([keyA, a], [keyB, b]) => a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : keyA.localeCompare(keyB));
		for (const [key] of taskEntries.slice(0, Math.max(0, taskEntries.length - cap.perGroup))) deleteTask(state, groupKey, key);
	}
	let groupKeys = Object.keys(state.groups);
	groupKeys.sort((a, b) => state.groups[a].updatedAt !== state.groups[b].updatedAt ? state.groups[a].updatedAt - state.groups[b].updatedAt : a.localeCompare(b));
	for (const key of groupKeys.slice(0, Math.max(0, groupKeys.length - cap.groups))) {
		for (const taskKey of Object.keys(state.groups[key]?.tasks ?? {})) clearTaskAssociations(state, taskKey);
		delete state.groups[key];
	}
	const allTasks = () => Object.entries(state.groups).flatMap(([groupKey, group]) => Object.entries(group.tasks).map(([key, task]) => ({ groupKey, key, time: task.createdAt })));
	let tasks = allTasks();
	tasks.sort((a, b) => a.time !== b.time ? a.time - b.time : a.key.localeCompare(b.key));
	for (const entry of tasks.slice(0, Math.max(0, tasks.length - cap.total))) deleteTask(state, entry.groupKey, entry.key);
	const jobLimit = cap.total;
	const jobs = Object.entries(state.jobs).sort(([keyA, a], [keyB, b]) => a.observedAt !== b.observedAt ? a.observedAt - b.observedAt : keyA.localeCompare(keyB));
	for (const [key] of jobs.slice(0, Math.max(0, jobs.length - jobLimit))) delete state.jobs[key];
	while (encodedBytes(state) > MAX_STORE_BYTES) {
		const candidates: Array<{ kind: "task" | "job"; groupKey?: string; key: string; time: number }> = [];
		for (const [groupKey, group] of Object.entries(state.groups)) {
			for (const [key, task] of Object.entries(group.tasks)) candidates.push({ kind: "task", groupKey, key, time: task.createdAt });
		}
		for (const [key, job] of Object.entries(state.jobs)) candidates.push({ kind: "job", key, time: job.observedAt });
		if (!candidates.length) return false;
		candidates.sort((a, b) => a.time !== b.time ? a.time - b.time : a.key.localeCompare(b.key) || a.kind.localeCompare(b.kind));
		const oldest = candidates[0];
		if (oldest.kind === "task") deleteTask(state, oldest.groupKey!, oldest.key);
		else delete state.jobs[oldest.key];
	}
	return true;
}

function statePath(file: string): { file: string; directory: string; lock: string } | null {
	if (typeof file !== "string" || !file.trim()) return null;
	const resolved = path.resolve(file);
	const basename = path.basename(resolved);
	if (!basename || basename === "." || basename === "..") return null;
	return { file: resolved, directory: path.dirname(resolved), lock: `${resolved}.lock` };
}

function isMissingError(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

type StateDirectoryIdentity = { path: string; dev: number; ino: number };

type StateFileMetadata = {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	uid: number;
	mode: number;
	nlink: number;
};

function sameStateFileMetadata(a: StateFileMetadata, b: StateFileMetadata): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink;
}

function verifyStateDirectory(directory: string, create: boolean, expected?: StateDirectoryIdentity[]): StateDirectoryIdentity[] {
	const absolute = path.resolve(directory);
	let current = path.parse(absolute).root;
	let pluginOwned = false;
	const identities: StateDirectoryIdentity[] = [];
	for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		pluginOwned ||= part === ".gjc-plugin";
		let created = false;
		try { lstatSync(current); } catch (error) {
			if (!create || !isMissingError(error)) throw error;
			mkdirSync(current, { mode: 0o700 });
			created = true;
		}
		const info = lstatSync(current);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe_path");
		if ((created || pluginOwned || current === absolute) && (info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)) throw new Error("unsafe_path");
		const fd = openSync(current, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
		try {
			const opened = fstatSync(fd);
			if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("unsafe_path");
		} finally { closeSync(fd); }
		identities.push({ path: current, dev: info.dev, ino: info.ino });
	}
	if (expected && (identities.length !== expected.length || identities.some((identity, index) => identity.path !== expected[index].path || identity.dev !== expected[index].dev || identity.ino !== expected[index].ino))) throw new Error("unsafe_path");
	return identities;
}

function readStoreFile(file: string): StoreReadResult {
	let fd: number | undefined;
	try {
		let info: ReturnType<typeof lstatSync>;
		try {
			info = lstatSync(file);
		} catch (error) {
			if (isMissingError(error)) return { status: "missing" };
			throw error;
		}
		if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) return { status: "unavailable", reason: "unsafe_path" };
		if ((info.mode & 0o7777) !== 0o600) return { status: "unavailable", reason: "unsafe_path" };
		if (info.size > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
		const noFollow = fsConstants.O_NOFOLLOW ?? 0;
		fd = openSync(file, fsConstants.O_RDONLY | noFollow);
		const opened = fstatSync(fd);
		if (!opened.isFile() || !sameStateFileMetadata(info, opened) || opened.nlink !== 1 || opened.uid !== process.getuid?.() || (opened.mode & 0o7777) !== 0o600) return { status: "unavailable", reason: "unsafe_path" };
		if (opened.size > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
		// Bounded descriptor read: at most MAX_STORE_BYTES plus one overflow-
		// detection byte are consumed before any decode or unbounded allocation.
		// A pre-read size check alone is insufficient when the file grows between
		// stat and read; growth is caught at the descriptor read itself and still
		// yields the existing oversized result before any decode of excess bytes.
		const bounded = new Uint8Array(MAX_STORE_BYTES + 1);
		let total = 0;
		while (total < bounded.length) {
			const read = readSync(fd, bounded, total, bounded.length - total, total);
			if (read === 0) break;
			total += read;
		}
		if (total > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
		if (total !== opened.size) return { status: "unavailable", reason: "unsafe_path" };
		const afterOpened = fstatSync(fd);
		if (!afterOpened.isFile() || !sameStateFileMetadata(opened, afterOpened) || afterOpened.nlink !== 1 || afterOpened.uid !== process.getuid?.() || (afterOpened.mode & 0o7777) !== 0o600) {
			return { status: "unavailable", reason: "unsafe_path" };
		}
		let afterPath: ReturnType<typeof lstatSync>;
		try {
			afterPath = lstatSync(file);
		} catch {
			return { status: "unavailable", reason: "unsafe_path" };
		}
		if (afterPath.isSymbolicLink() || !afterPath.isFile() || !sameStateFileMetadata(opened, afterPath)) {
			return { status: "unavailable", reason: "unsafe_path" };
		}
		const text = Buffer.from(bounded.buffer, bounded.byteOffset, total).toString("utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { status: "unavailable", reason: "corrupt" };
		}
		if (isRecord(parsed) && parsed.version !== 2) return { status: "unavailable", reason: "unsupported_version" };
		if (!validateStore(parsed)) return { status: "unavailable", reason: "corrupt" };
		return { status: "ok", value: parsed };
	} catch (error) {
		if (error instanceof Error && error.message === "unsafe_path") return { status: "unavailable", reason: "unsafe_path" };
		return { status: "unavailable", reason: "io_error" };
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
	}
}

function stateLockResult(lockFile: string): StoreReadResult | null {
	try {
		const lockInfo = lstatSync(lockFile);
		if (lockInfo.isSymbolicLink() || !lockInfo.isFile() || lockInfo.nlink !== 1 || lockInfo.uid !== process.getuid?.() || (lockInfo.mode & 0o7777) !== 0o600) {
			return { status: "unavailable", reason: "unsafe_path" };
		}
		return { status: "unavailable", reason: "locked" };
	} catch (error) {
		return isMissingError(error) ? null : { status: "unavailable", reason: "io_error" };
	}
}

export function readEvidenceV2(file: string): StoreReadResult {
	const paths = statePath(file);
	if (!paths) return { status: "unavailable", reason: "unsafe_path" };
	let directoryIdentity: StateDirectoryIdentity[];
	try { directoryIdentity = verifyStateDirectory(paths.directory, false); } catch (error) {
		return isMissingError(error) ? { status: "missing" } : { status: "unavailable", reason: "unsafe_path" };
	}
	// Public read-only lock rejection lives here, outside transaction-owned
	// readStoreFile: an existing transaction owns its lock and calls
	// readStoreFile directly, so it must not reject its own lock.
	const lockBeforeRead = stateLockResult(paths.lock);
	if (lockBeforeRead) return lockBeforeRead;
	const result = readStoreFile(paths.file);
	try { verifyStateDirectory(paths.directory, false, directoryIdentity); } catch { return { status: "unavailable", reason: "unsafe_path" }; }
	const lockAfterRead = stateLockResult(paths.lock);
	if (lockAfterRead) return lockAfterRead;
	return result;
}


function releaseOwnedLock(lockFile: string, lockFd: number, token: string, directoryIdentity: StateDirectoryIdentity[]): void {
	try {
		verifyStateDirectory(path.dirname(lockFile), false, directoryIdentity);
		const original = fstatSync(lockFd);
		const current = lstatSync(lockFile);
		if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid?.() || (current.mode & 0o7777) !== 0o600 || current.dev !== original.dev || current.ino !== original.ino) return;
		const checkFd = openSync(lockFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		try {
			const opened = fstatSync(checkFd);
			if (opened.dev !== original.dev || opened.ino !== original.ino || opened.nlink !== 1) return;
			if (readFileSync(checkFd, "utf8") === token) {
				verifyStateDirectory(path.dirname(lockFile), false, directoryIdentity);
				const latest = lstatSync(lockFile);
				if (latest.dev === original.dev && latest.ino === original.ino && latest.nlink === 1) unlinkSync(lockFile);
			}
		} finally {
			closeSync(checkFd);
		}
	} catch {}
}

function writeStateAtomically(file: string, state: EvidenceV2, directoryIdentity: StateDirectoryIdentity[]): void {
	const tmp = `${file}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	let temporaryIdentity: { dev: number; ino: number } | undefined;
	try {
		verifyStateDirectory(path.dirname(file), false, directoryIdentity);
		fd = openSync(tmp, "wx", 0o600);
		const created = fstatSync(fd);
		temporaryIdentity = { dev: created.dev, ino: created.ino };
		verifyStateDirectory(path.dirname(file), false, directoryIdentity);
		fchmodSync(fd, 0o600);
		writeSync(fd, JSON.stringify(state), undefined, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		verifyStateDirectory(path.dirname(file), false, directoryIdentity);
		const existing = readStoreFile(file);
		if (existing.status === "unavailable") throw new Error("unsafe state target");
		verifyStateDirectory(path.dirname(file), false, directoryIdentity);
		const currentTemporary = lstatSync(tmp);
		if (!currentTemporary.isFile() || currentTemporary.isSymbolicLink() || currentTemporary.dev !== temporaryIdentity.dev || currentTemporary.ino !== temporaryIdentity.ino || currentTemporary.nlink !== 1 || currentTemporary.uid !== process.getuid?.() || (currentTemporary.mode & 0o7777) !== 0o600) throw new Error("unsafe_path");
		renameSync(tmp, file);
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
		try {
			verifyStateDirectory(path.dirname(file), false, directoryIdentity);
			const currentTemporary = lstatSync(tmp);
			if (temporaryIdentity && currentTemporary.isFile() && !currentTemporary.isSymbolicLink() && currentTemporary.dev === temporaryIdentity.dev && currentTemporary.ino === temporaryIdentity.ino && currentTemporary.nlink === 1) unlinkSync(tmp);
		} catch {}
		throw error;
	}
}

/**
 * Fresh synchronous store transaction. The only await is bounded lock retry;
 * mutation callbacks must be synchronous and no snapshot escapes the lock.
 */
export async function transaction<T>(
	file: string,
	limits: StoreLimits,
	mutate: (latest: EvidenceV2) => T,
): Promise<StoreResult<T>> {
	const paths = statePath(file);
	if (!paths) return { status: "unavailable", reason: "unsafe_path" };
	const lockToken = randomUUID();
	const waitStarted = performance.now();
	let lockFd: number | undefined;
	let ownedDev = 0;
	let ownedIno = 0;
	let directoryIdentity: StateDirectoryIdentity[] | undefined;
	try {
		try {
			directoryIdentity = verifyStateDirectory(paths.directory, true);
		} catch {
			return { status: "unavailable", reason: "unsafe_path" };
		}
		while (lockFd === undefined) {
			try { verifyStateDirectory(paths.directory, false, directoryIdentity); } catch { return { status: "unavailable", reason: "unsafe_path" }; }
			try {
				lockFd = openSync(paths.lock, "wx", 0o600);
				const owner = fstatSync(lockFd);
				ownedDev = owner.dev;
				ownedIno = owner.ino;
				verifyStateDirectory(paths.directory, false, directoryIdentity);
				fchmodSync(lockFd, 0o600);
				writeSync(lockFd, lockToken, undefined, "utf8");
				fsyncSync(lockFd);
			} catch (error) {
				if (lockFd !== undefined) {
					let createdByThisTransaction = false;
					try {
						const owner = fstatSync(lockFd);
						createdByThisTransaction = owner.dev === ownedDev && owner.ino === ownedIno;
					} catch {}
					try { closeSync(lockFd); } catch {}
					lockFd = undefined;
					if (createdByThisTransaction) {
						try {
							verifyStateDirectory(paths.directory, false, directoryIdentity);
							const currentLock = lstatSync(paths.lock);
						if (currentLock.isFile() && !currentLock.isSymbolicLink() && currentLock.nlink === 1 && currentLock.dev === ownedDev && currentLock.ino === ownedIno) unlinkSync(paths.lock);
						} catch {}
					}
				}
				if (!isRecord(error) || error.code !== "EEXIST") return { status: "unavailable", reason: "io_error" };
				try {
					verifyStateDirectory(paths.directory, false, directoryIdentity);
					const lockInfo = lstatSync(paths.lock);
					if (lockInfo.isSymbolicLink() || !lockInfo.isFile() || lockInfo.nlink !== 1 || lockInfo.uid !== process.getuid?.() || (lockInfo.mode & 0o7777) !== 0o600) return { status: "unavailable", reason: "unsafe_path" };
				} catch {
					return { status: "unavailable", reason: "io_error" };
				}
				if (performance.now() - waitStarted >= MAX_LOCK_WAIT_MS) return { status: "unavailable", reason: "locked" };
				await new Promise<void>(resolve => setTimeout(resolve, 5));
			}
		}
		try { verifyStateDirectory(paths.directory, false, directoryIdentity); } catch { return { status: "unavailable", reason: "unsafe_path" }; }
		const current = readStoreFile(paths.file);
		try { verifyStateDirectory(paths.directory, false, directoryIdentity); } catch { return { status: "unavailable", reason: "unsafe_path" }; }
		if (current.status === "unavailable") return current;
		const latest = current.status === "missing" ? emptyEvidenceV2() : current.value;
		let value: T;
		try {
			value = mutate(latest);
			if (isRecord(value) && typeof value.then === "function") return { status: "unavailable", reason: "io_error" };
		} catch {
			return { status: "unavailable", reason: "io_error" };
		}
		if (!capStore(latest, limits)) return { status: "unavailable", reason: "oversized" };
		if (encodedBytes(latest) > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
		try {
			verifyStateDirectory(paths.directory, false, directoryIdentity);
			writeStateAtomically(paths.file, latest, directoryIdentity);
		} catch {
			return { status: "unavailable", reason: "io_error" };
		}
		return { status: "ok", value };
	} finally {
		if (lockFd !== undefined) {
			try {
				const stat = fstatSync(lockFd);
				if (directoryIdentity && stat.dev === ownedDev && stat.ino === ownedIno) releaseOwnedLock(paths.lock, lockFd, lockToken, directoryIdentity);
			} catch {}
			try { closeSync(lockFd); } catch {}
		}
	}
}

export function taskRefFor(sessionId: string, toolCallId: string, task: Pick<TaskInput, "index">): TaskRef | null {
	const ref = { sessionId, toolCallId, taskIndex: task.index };
	return taskRefKey(ref) ? ref : null;
}

export interface TaskPreparation {
	index: number;
	state: "created" | "reused" | "conflict";
	token: string | null;
	advice: StoredAdvice | null;
}

function findTask(state: EvidenceV2, key: string): { groupKey: string; task: TaskRecord } | null {
	for (const [groupKey, group] of Object.entries(state.groups)) {
		const task = group.tasks[key];
		if (task) return { groupKey, task };
	}
	return null;
}

function storedAdvice(advice: Advice): StoredAdvice {
	if (advice.status === "no_decision") return { ...advice };
	const result: StoredDecision = {
		status: "decision",
		tier: advice.tier,
		confidence: advice.confidence,
		confidenceKind: advice.confidenceKind,
	};
	if (advice.probabilities) result.probabilities = { ...advice.probabilities };
	return result;
}

export async function prepareTaskRecords(
	file: string,
	limits: StoreLimits,
	sessionId: string,
	toolCallId: string,
	tasks: TaskInput[],
	now = Date.now(),
): Promise<StoreResult<TaskPreparation[]>> {
	const baseRef = { sessionId, toolCallId, taskIndex: 0 };
	if (!taskRefKey(baseRef)) return { status: "unavailable", reason: "unsafe_path" };
	return transaction(file, limits, state => {
		const prepared: TaskPreparation[] = [];
		for (const task of tasks) {
			const ref: TaskRef = { sessionId, toolCallId, taskIndex: task.index };
			const key = taskRefKey(ref);
			if (!key) {
				prepared.push({ index: task.index, state: "conflict", token: null, advice: null });
				continue;
			}
			const existing = findTask(state, key);
			if (existing) {
				if (existing.task.fingerprint !== task.fingerprint ||
					existing.task.requestedTier !== task.requestedTier || existing.task.callerId !== task.callerId ||
					existing.task.conflicts.includes("identity_input_conflict")) {
					appendConflict(existing.task.conflicts, "identity_input_conflict");
					existing.task.updatedAt = now;
					state.groups[existing.groupKey].updatedAt = now;
					prepared.push({ index: task.index, state: "conflict", token: null, advice: null });
				} else if (!task.complete) {
					existing.task.requestToken = randomUUID();
					existing.task.advice = { status: "no_decision", reason: "input_too_large" };
					existing.task.updatedAt = now;
					state.groups[existing.groupKey].updatedAt = now;
					prepared.push({ index: task.index, state: "reused", token: existing.task.requestToken, advice: existing.task.advice });
				} else {
					prepared.push({ index: task.index, state: "reused", token: existing.task.requestToken, advice: existing.task.advice });
				}
				continue;
			}
			const token = randomUUID();
			const advice: StoredAdvice | null = task.complete ? null : { status: "no_decision", reason: "input_too_large" };
			const record: TaskRecord = {
				ref,
				fingerprint: task.fingerprint,
				callerId: task.callerId,
				requestedTier: task.requestedTier,
				requestToken: token,
				advice,
				createdAt: now,
				updatedAt: now,
				launchDisposition: "not_observed",
				jobKey: null,
				conflicts: [],
			};
			const group = (state.groups[task.fingerprint] ??= { updatedAt: now, tasks: {} });
			group.tasks[key] = record;
			group.updatedAt = now;
			prepared.push({ index: task.index, state: "created", token, advice });
		}
		return prepared;
	});
}

export async function updateTaskAdvice(
	file: string,
	limits: StoreLimits,
	ref: TaskRef,
	token: string,
	advice: Advice,
	now = Date.now(),
): Promise<StoreResult<boolean>> {
	const key = taskRefKey(ref);
	if (!key) return { status: "unavailable", reason: "unsafe_path" };
	return transaction(file, limits, state => {
		const found = findTask(state, key);
		if (!found || found.task.requestToken !== token || found.task.conflicts.includes("identity_input_conflict")) return false;
		found.task.advice = storedAdvice(advice);
		found.task.updatedAt = now;
		state.groups[found.groupKey].updatedAt = now;
		return true;
	});
}

export async function markInvocationBlocked(
	file: string,
	limits: StoreLimits,
	sessionId: string,
	toolCallId: string,
	now = Date.now(),
): Promise<StoreResult<number>> {
	return transaction(file, limits, state => {
		let count = 0;
		for (const group of Object.values(state.groups)) {
			for (const task of Object.values(group.tasks)) {
				if (task.ref.sessionId !== sessionId || task.ref.toolCallId !== toolCallId) continue;
				task.launchDisposition = "blocked";
				task.updatedAt = now;
				group.updatedAt = now;
				count++;
			}
		}
		return count;
	});
}

function associateTaskWithJob(state: EvidenceV2, task: TaskRecord, taskKey: string, ref: JobRef): void {
	const key = jobRefKey(ref);
	if (!key) return;
	const job = state.jobs[key];
	if (job?.conflicts.includes("launch_mapping_evicted")) {
		appendConflict(task.conflicts, "stale_job_mapping");
		return;
	}
	if (task.jobKey && task.jobKey !== key) {
		appendConflict(task.conflicts, "multiple_job_associations");
		return;
	}
	task.jobKey = key;
	if (job) {
		if (job.taskKey && job.taskKey !== taskKey) appendConflict(job.conflicts, "multiple_task_associations");
		else job.taskKey = taskKey;
	}
}

export async function observeTaskLaunch(
	file: string,
	limits: StoreLimits,
	sessionId: string,
	toolCallId: string,
	invocationObserved: boolean,
	singletonTaskIndex: number | null,
	job: JobRef | null,
	now = Date.now(),
): Promise<StoreResult<number>> {
	return transaction(file, limits, state => {
		let count = 0;
		for (const [groupKey, group] of Object.entries(state.groups)) {
			for (const [key, task] of Object.entries(group.tasks)) {
				if (task.ref.sessionId !== sessionId || task.ref.toolCallId !== toolCallId) continue;
				if (task.launchDisposition === "blocked") continue;
				if (task.launchDisposition === "observed") {
					if (singletonTaskIndex === task.ref.taskIndex && job) associateTaskWithJob(state, task, key, job);
					continue;
				}
				if (invocationObserved) {
					task.launchDisposition = "observed";
					if (singletonTaskIndex === task.ref.taskIndex && job) associateTaskWithJob(state, task, key, job);
				} else {
					task.launchDisposition = "not_observed";
				}
				task.updatedAt = now;
				group.updatedAt = now;
				count++;
			}
		}
		return count;
	});
}

export interface TerminalObservation {
	status: TerminalStatus;
	childId?: string;
	durationMs?: number;
	requestedModel?: string;
	effectiveModel?: string;
}

function addDistinct<T>(values: T[], value: T, limit: number): void {
	if (!values.includes(value) && values.length < limit) values.push(value);
}

function boundedModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const model = value.trim();
	if (!model || model.length > 128 || /[\u0000-\u001f\u007f]/.test(model)) return undefined;
	return model;
}

function findMappedTasks(state: EvidenceV2, key: string): string[] {
	const matches: string[] = [];
	for (const group of Object.values(state.groups)) {
		for (const [taskKey, task] of Object.entries(group.tasks)) if (task.jobKey === key) matches.push(taskKey);
	}
	return matches;
}

function applyTerminal(state: EvidenceV2, ref: JobRef, observation: TerminalObservation, now: number): void {
	const key = jobRefKey(ref)!;
	let job = state.jobs[key];
	if (!job) {
		const firstDuration = typeof observation.durationMs === "number" && Number.isFinite(observation.durationMs) && observation.durationMs > 0
			? observation.durationMs : undefined;
		const requestedModel = boundedModel(observation.requestedModel);
		const effectiveModel = boundedModel(observation.effectiveModel);
		job = {
			ref,
			...(observation.childId && boundedIdentity(observation.childId) ? { childId: boundedIdentity(observation.childId)! } : {}),
			status: observation.status,
			statusObservations: [observation.status],
			...(firstDuration === undefined ? {} : { durationMs: firstDuration }),
			durationObservations: firstDuration === undefined ? [] : [firstDuration],
			...(requestedModel ? { requestedModel } : {}),
			requestedModelObservations: requestedModel ? [requestedModel] : [],
			...(effectiveModel ? { effectiveModel } : {}),
			effectiveModelObservations: effectiveModel ? [effectiveModel] : [],
			allocatedChildIds: observation.childId && boundedIdentity(observation.childId) ? [boundedIdentity(observation.childId)!] : [],
			actualTier: null,
			observedAt: now,
			taskKey: null,
			conflicts: [],
		};
		const mappings = findMappedTasks(state, key);
		if (mappings.length === 1) job.taskKey = mappings[0];
		else if (mappings.length > 1) appendConflict(job.conflicts, "multiple_task_associations");
		state.jobs[key] = job;
		return;
	}
	addDistinct(job.statusObservations, observation.status, 3);
	if (job.statusObservations.length > 1) appendConflict(job.conflicts, "status_conflict");
	const duration = observation.durationMs;
	if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
		addDistinct(job.durationObservations, duration, 4);
		if (job.durationObservations.length > 1) appendConflict(job.conflicts, "duration_conflict");
		if (job.durationMs === undefined) job.durationMs = duration;
	}
	const requestedModel = boundedModel(observation.requestedModel);
	if (requestedModel) {
		addDistinct(job.requestedModelObservations, requestedModel, 4);
		if (job.requestedModelObservations.length > 1) appendConflict(job.conflicts, "requested_model_conflict");
		if (job.requestedModel === undefined) job.requestedModel = requestedModel;
	}
	const effectiveModel = boundedModel(observation.effectiveModel);
	if (effectiveModel) {
		addDistinct(job.effectiveModelObservations, effectiveModel, 4);
		if (job.effectiveModelObservations.length > 1) appendConflict(job.conflicts, "effective_model_conflict");
		if (job.effectiveModel === undefined) job.effectiveModel = effectiveModel;
	}
	const childId = boundedIdentity(observation.childId);
	if (childId) {
		addDistinct(job.allocatedChildIds, childId, 4);
		if (job.allocatedChildIds.length > 1) appendConflict(job.conflicts, "child_id_conflict");
		if (job.childId === undefined) job.childId = childId;
	}
	const mappings = findMappedTasks(state, key);
	if (mappings.length > 1) appendConflict(job.conflicts, "multiple_task_associations");
	else if (mappings.length === 1) {
		const mapped = mappings[0];
		if (job.taskKey && job.taskKey !== mapped) appendConflict(job.conflicts, "multiple_task_associations");
		else if (!job.conflicts.includes("launch_mapping_evicted")) job.taskKey = mapped;
	}
}

export async function observeTerminalJob(
	file: string,
	limits: StoreLimits,
	ref: JobRef,
	observation: TerminalObservation,
	now = Date.now(),
): Promise<StoreResult<void>> {
	if (!jobRefKey(ref) || !["completed", "failed", "cancelled"].includes(observation.status)) {
		return { status: "unavailable", reason: "unsafe_path" };
	}
	return transaction(file, limits, state => {
		applyTerminal(state, ref, observation, now);
	});
}

export interface CalibrationSummary {
	window: "retained_v2_metadata";
	retainedGroups: number;
	retainedTaskRecords: number;
	conflictedTaskRecords: number;
	advice: { decisions: number; noDecisions: Record<string, number> };
	launch: { observed: number; blocked: number; notObserved: number };
	agreement: { agree: number; denominator: number; rate: number | null };
	terminalJobs: {
		count: number;
		joined: number;
		unjoined: number;
		conflicted: number;
		byStatus: Record<TerminalStatus, number>;
		byRecommendation: Record<string, { jobs: number; byStatus: Record<TerminalStatus, number>; durationMs: { sum: number; measured: number; average: number | null } }>;
		effectiveModel: { known: number; unknown: number };
		requestedModel: { known: number; unknown: number };
		durationMs: { sum: number; measured: number; average: number | null };
		actualTier: null;
		quality: null;
	};
	coverage: { unknownIdentityObservationsNotRetained: true; unobservedTerminalsOutsideCoverage: true };
}

function emptyStatusCounts(): Record<TerminalStatus, number> {
	return { completed: 0, failed: 0, cancelled: 0 };
}

function emptyTierStats() {
	return { jobs: 0, byStatus: emptyStatusCounts(), durationMs: { sum: 0, measured: 0, average: null as number | null } };
}

export function calibrationSummary(state: EvidenceV2): { json: CalibrationSummary; text: string } {
	const taskRecords = Object.values(state.groups).flatMap(group => Object.entries(group.tasks).map(([key, task]) => ({ key, task })));
	const byTaskKey = new Map(taskRecords.map(entry => [entry.key, entry.task]));
	const invocationLaunches = new Map<string, LaunchDisposition>();
	const summary: CalibrationSummary = {
		window: "retained_v2_metadata",
		retainedGroups: Object.keys(state.groups).length,
		retainedTaskRecords: taskRecords.length,
		conflictedTaskRecords: taskRecords.filter(entry => entry.task.conflicts.length > 0).length,
		advice: { decisions: 0, noDecisions: {} },
		launch: { observed: 0, blocked: 0, notObserved: 0 },
		agreement: { agree: 0, denominator: 0, rate: null },
		terminalJobs: {
			count: Object.keys(state.jobs).length,
			joined: 0,
			unjoined: 0,
			conflicted: 0,
			byStatus: emptyStatusCounts(),
			byRecommendation: {},
			effectiveModel: { known: 0, unknown: 0 },
			requestedModel: { known: 0, unknown: 0 },
			durationMs: { sum: 0, measured: 0, average: null },
			actualTier: null,
			quality: null,
		},
		coverage: { unknownIdentityObservationsNotRetained: true, unobservedTerminalsOutsideCoverage: true },
	};
	for (const { task } of taskRecords) {
		if (task.advice?.status === "decision") {
			summary.advice.decisions++;
			if (task.requestedTier !== null && task.conflicts.length === 0) {
				summary.agreement.denominator++;
				if (task.requestedTier === task.advice.tier) summary.agreement.agree++;
			}
		} else if (task.advice?.status === "no_decision") {
			const reason = task.advice.reason;
			summary.advice.noDecisions[reason] = (summary.advice.noDecisions[reason] ?? 0) + 1;
		}
		const invocationKey = JSON.stringify([task.ref.sessionId, task.ref.toolCallId]);
		const prior = invocationLaunches.get(invocationKey);
		if (prior !== "blocked" && (task.launchDisposition === "blocked" || prior === undefined || task.launchDisposition === "observed")) {
			invocationLaunches.set(invocationKey, task.launchDisposition);
		}
	}
	for (const disposition of invocationLaunches.values()) {
		if (disposition === "observed") summary.launch.observed++;
		else if (disposition === "blocked") summary.launch.blocked++;
		else summary.launch.notObserved++;
	}
	summary.agreement.rate = summary.agreement.denominator ? summary.agreement.agree / summary.agreement.denominator : null;
	for (const job of Object.values(state.jobs)) {
		const task = job.taskKey ? byTaskKey.get(job.taskKey) : undefined;
		const joined = task !== undefined && task.jobKey === jobRefKey(job.ref) &&
			!job.conflicts.includes("multiple_task_associations") && !job.conflicts.includes("launch_mapping_evicted") &&
			task.conflicts.length === 0;
		if (joined) summary.terminalJobs.joined++;
		else summary.terminalJobs.unjoined++;
		if (job.conflicts.length) summary.terminalJobs.conflicted++;
		const statusConflict = job.conflicts.includes("status_conflict");
		if (!statusConflict) summary.terminalJobs.byStatus[job.status]++;
		const effectiveConflict = job.conflicts.includes("effective_model_conflict");
		if (job.effectiveModel && !effectiveConflict) summary.terminalJobs.effectiveModel.known++;
		else summary.terminalJobs.effectiveModel.unknown++;
		const requestedConflict = job.conflicts.includes("requested_model_conflict");
		if (job.requestedModel && !requestedConflict) summary.terminalJobs.requestedModel.known++;
		else summary.terminalJobs.requestedModel.unknown++;
		const durationConflict = job.conflicts.includes("duration_conflict");
		if (!durationConflict && job.durationMs !== undefined) {
			summary.terminalJobs.durationMs.sum += job.durationMs;
			summary.terminalJobs.durationMs.measured++;
		}
		if (!joined || !task?.advice || task.advice.status !== "decision") continue;
		const tier = task.advice.tier;
		const stats = (summary.terminalJobs.byRecommendation[tier] ??= emptyTierStats());
		stats.jobs++;
		if (!statusConflict) stats.byStatus[job.status]++;
		if (!durationConflict && job.durationMs !== undefined) {
			stats.durationMs.sum += job.durationMs;
			stats.durationMs.measured++;
		}
	}
	const totalDuration = summary.terminalJobs.durationMs;
	if (totalDuration.measured) totalDuration.average = totalDuration.sum / totalDuration.measured;
	for (const stats of Object.values(summary.terminalJobs.byRecommendation)) {
		if (stats.durationMs.measured) stats.durationMs.average = stats.durationMs.sum / stats.durationMs.measured;
	}
	const textLines = [
		"jev-advisor retained v2 coverage report (metadata only; not quality or correctness).",
		`retained task records: ${summary.retainedTaskRecords} across ${summary.retainedGroups} semantic groups; conflicted task records: ${summary.conflictedTaskRecords}; decisions: ${summary.advice.decisions}; no-decisions: ${JSON.stringify(summary.advice.noDecisions)}.`,
		`task-call launch invocations: ${summary.launch.observed} observed, ${summary.launch.blocked} blocked, ${summary.launch.notObserved} not observed; observations do not attribute batch children or establish terminal outcomes.`,
		`requested/recommended agreement: ${summary.agreement.agree}/${summary.agreement.denominator}${summary.agreement.rate === null ? " (no comparable records)" : ` (${Math.round(summary.agreement.rate * 100)}%; not correctness)`}.`,
		`terminal jobs: ${summary.terminalJobs.count}, joined by exact session+job mapping: ${summary.terminalJobs.joined}, unjoined: ${summary.terminalJobs.unjoined}, conflicted: ${summary.terminalJobs.conflicted}; status counts exclude conflicts: ${JSON.stringify(summary.terminalJobs.byStatus)}.`,
		`duration: ${totalDuration.measured ? `${totalDuration.sum} ms across ${totalDuration.measured} measured jobs; average ${totalDuration.average} ms` : "unknown (no positive non-conflicted measurements)"}; effective model known/unknown ${summary.terminalJobs.effectiveModel.known}/${summary.terminalJobs.effectiveModel.unknown}; requested model known/unknown ${summary.terminalJobs.requestedModel.known}/${summary.terminalJobs.requestedModel.unknown}.`,
		"Actual tier and task quality are unknown. Missing-identity observations are not retained, and unobserved terminals are outside coverage. This report describes only the bounded retained window.",
	];
	for (const [tier, stats] of Object.entries(summary.terminalJobs.byRecommendation)) {
		const duration = stats.durationMs.measured
			? `${stats.durationMs.sum} ms across ${stats.durationMs.measured} measured jobs; average ${stats.durationMs.average} ms`
			: "duration unknown";
		textLines.push(`${tier} recommendation (exactly joined): ${stats.jobs} jobs, statuses ${JSON.stringify(stats.byStatus)}, ${duration}.`);
	}
	const text = textLines.join("\n");
	return { json: summary, text };
}


// ─── plugin_metrics: offline descriptive report (plan S06/S07/S08) ───────────
// Read-only orchestration over the shared journals and the retained v2 state.
// Never appends a journal record, never loads credentials, never touches the
// network. All helpers below are pure except the snapshot reads themselves.

export type MetricsFrequency = Record<string, number>;

export interface MetricsFraction {
	numerator: number;
	denominator: number;
	rate: number | null;
}

export interface MetricsDuration {
	measured: number;
	sum: number | null;
	average: number | null;
}

export interface MetricsFieldCounts {
	present: number;
	byStatus: MetricsFrequency;
	byReason: MetricsFrequency;
}

export type MetricsOperation =
	| "run" | "status" | "advise" | "calibration" | "task_advice" | "task_launch" | "subagent_terminal";

export interface RunStatusMetrics {
	operations: MetricsFrequency;
	run: OperationMetrics;
	status: OperationMetrics;
}

export interface OperationMetrics {
	invocations: number;
	execution: MetricsFieldCounts;
	executionMissing: number;
	passedFraction: MetricsFraction;
	assessment: MetricsFieldCounts;
	assessmentAnswers: {
		coverage_alignment: { present: number; choices: MetricsFrequency };
		boundary_evidence: { present: number; choices: MetricsFrequency };
	};
	freshness: { present: number; counts: MetricsFrequency };
	cleanup: { present: number; counts: MetricsFrequency };
	receiptStorage: {
		present: number; persisted: number; notPersisted: number;
		byReason: MetricsFrequency; nearCapacityPresent: number; nearCapacityTrue: number;
	};
	recordedReceiptDurationMs: MetricsDuration | null;
	nativeCounts: null | { contributingRecords: number; totals: Record<string, number> };
	assertions: null | { contributingRecords: number; entries: number; byKind: MetricsFrequency; byStatus: MetricsFrequency };
}

export interface JevMetrics {
	operations: MetricsFrequency;
	manualAdvice: {
		invocations: number; present: number;
		byStatus: MetricsFrequency; byTier: MetricsFrequency;
		confidenceBasis: MetricsFrequency; byReason: MetricsFrequency;
	};
	taskAdvice: {
		batches: number; batchesWithEntries: number; entries: number;
		byStatus: MetricsFrequency; byTier: MetricsFrequency;
		confidenceBasis: MetricsFrequency; byReason: MetricsFrequency;
		recordedPreJournalHookDurationMs: MetricsDuration;
	};
	evidenceObservations: Partial<Record<MetricsOperation, {
		contributingRecords: number; completed: number; failed: number;
		cancelled: number; stored: number; unavailable: number;
	}>>;
	evidenceStorage: MetricsFieldCounts;
}

export type JournalSourceReason = "store_busy" | "store_corrupt" | "unsafe_path" | "resource_limit" | "changed_during_read" | "store_unavailable";

export interface JournalSource<T> {
	status: "ok" | "missing" | "unavailable";
	reason: JournalSourceReason | null;
	readStartedAt: string;
	readCompletedAt: string;
	retention: { maxRecordBytes: 4096; maxSegmentBytes: 1048576; maxSegments: 8 };
	snapshot: { segments: number; bytes: number; records: number; oldestObservedAt: string | null; newestObservedAt: string | null } | null;
	metrics: T | null;
}

export type CalibrationReport = Omit<CalibrationSummary, "terminalJobs"> & {
	terminalJobs: Omit<CalibrationSummary["terminalJobs"], "durationMs" | "byRecommendation"> & {
		durationMs: MetricsDuration;
		byRecommendation: Record<string, Omit<CalibrationSummary["terminalJobs"]["byRecommendation"][string], "durationMs"> & { durationMs: MetricsDuration }>;
	};
};

export interface CorrelationSource {
	status: "ok" | "missing" | "unavailable";
	reason: StoreUnavailableReason | null;
	readStartedAt: string;
	readCompletedAt: string;
	window: "retained_v2_metadata";
	metrics: CalibrationReport | null;
}

export interface PluginMetricsReport {
	schemaVersion: 1;
	report: "plugin_metrics";
	mode: "offline_descriptive";
	window: "all_retained";
	scope: "current_process_home_all_repositories";
	generatedAt: string;
	status: "complete" | "partial" | "unavailable";
	plugins: {
		"jev-advisor": JournalSource<JevMetrics>;
		"verification-receipts": JournalSource<RunStatusMetrics>;
		"ui-regression": JournalSource<RunStatusMetrics>;
	};
	correlation: CorrelationSource;
	unavailableMeasures: {
		pluginOverheadMs: null; providerLatencyMs: null; assessmentLatencyMs: null;
		endToEndInvocationMs: null; providerCost: null; tokenUsage: null;
		quality: null; accuracy: null; causalRoi: null;
	};
	limitations: string[];
}

function metricsFreq(): MetricsFrequency { return {}; }
function metricsBump(freq: MetricsFrequency, key: string): void {
	if (!Number.isSafeInteger(freq[key] ?? 0) || (freq[key] ?? 0) + 1 > Number.MAX_SAFE_INTEGER) throw new Error("resource_limit");
	freq[key] = (freq[key] ?? 0) + 1;
}
function metricsDuration(): MetricsDuration { return { measured: 0, sum: null, average: null }; }
function metricsDurationAdd(d: MetricsDuration, value: number): void {
	if (!Number.isSafeInteger(value)) throw new Error("resource_limit");
	d.measured++;
	d.sum = (d.sum ?? 0) + value;
	if (d.sum > Number.MAX_SAFE_INTEGER) throw new Error("resource_limit");
	d.average = d.sum / d.measured;
}
function metricsFraction(numerator: number, denominator: number): MetricsFraction {
	return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}
function metricsEmptyFieldCounts(): MetricsFieldCounts { return { present: 0, byStatus: metricsFreq(), byReason: metricsFreq() }; }
function metricsEmptyOperation(statusDurationNull: boolean): OperationMetrics {
	return {
		invocations: 0,
		execution: metricsEmptyFieldCounts(),
		executionMissing: 0,
		passedFraction: metricsFraction(0, 0),
		assessment: metricsEmptyFieldCounts(),
		assessmentAnswers: {
			coverage_alignment: { present: 0, choices: metricsFreq() },
			boundary_evidence: { present: 0, choices: metricsFreq() },
		},
		freshness: { present: 0, counts: metricsFreq() },
		cleanup: { present: 0, counts: metricsFreq() },
		receiptStorage: { present: 0, persisted: 0, notPersisted: 0, byReason: metricsFreq(), nearCapacityPresent: 0, nearCapacityTrue: 0 },
		recordedReceiptDurationMs: statusDurationNull ? null : metricsDuration(),
		nativeCounts: null,
		assertions: null,
	};
}

const RESULTS_COUNT_KEYS = ["tests", "suites", "topLevel", "passed", "failed", "skipped", "todo", "cancelled"];
const RESULTS_ASSESSMENT_ANSWERS = ["coverage_alignment", "boundary_evidence"] as const;

/** Run/status journals (verification-receipts, ui-regression) → RunStatusMetrics. Plan S07. */
export function aggregateRunStatusMetrics(
	records: Record<string, unknown>[],
	source: "verification-receipts" | "ui-regression",
): RunStatusMetrics {
	const report: RunStatusMetrics = {
		operations: metricsFreq(),
		run: metricsEmptyOperation(false),
		status: metricsEmptyOperation(true),
	};
	for (const record of records) {
		const op = String(record.operation);
		metricsBump(report.operations, op);
		if (op !== "run" && op !== "status") continue;
		const bucket = op === "run" ? report.run : report.status;
		bucket.invocations++;
		const execution = record.execution as Record<string, unknown> | undefined;
		if (execution === undefined) {
			bucket.executionMissing++;
		} else {
			bucket.execution.present++;
			metricsBump(bucket.execution.byStatus, String(execution.status));
			metricsBump(bucket.execution.byReason, String(execution.reason));
			if (execution.status === "passed") bucket.passedFraction.numerator++;
			bucket.passedFraction.denominator++;
			const counts = execution.counts as Record<string, number> | null | undefined;
			if (source === "verification-receipts" && op === "run" && counts) {
				if (bucket.nativeCounts === null) bucket.nativeCounts = { contributingRecords: 0, totals: Object.fromEntries(RESULTS_COUNT_KEYS.map(key => [key, 0])) };
				bucket.nativeCounts.contributingRecords++;
				for (const key of RESULTS_COUNT_KEYS) {
					const value = counts[key];
					if (typeof value === "number") {
						if (!Number.isSafeInteger(bucket.nativeCounts.totals[key]! + value)) throw new Error("resource_limit");
						bucket.nativeCounts.totals[key]! += value;
					}
				}
			}
			const assertions = execution.assertions as Record<string, unknown>[] | undefined;
			if (source === "ui-regression" && op === "run" && Array.isArray(assertions)) {
				if (bucket.assertions === null) bucket.assertions = { contributingRecords: 0, entries: 0, byKind: metricsFreq(), byStatus: metricsFreq() };
				bucket.assertions.contributingRecords++;
				for (const assertion of assertions) {
					bucket.assertions.entries++;
					metricsBump(bucket.assertions.byKind, String(assertion.kind));
					metricsBump(bucket.assertions.byStatus, String(assertion.status));
				}
			}
		}
		const assessment = record.assessment as Record<string, unknown> | undefined;
		if (assessment !== undefined) {
			bucket.assessment.present++;
			metricsBump(bucket.assessment.byStatus, String(assessment.status));
			metricsBump(bucket.assessment.byReason, String(assessment.reason));
			const answers = assessment.answers as Record<string, Record<string, unknown>> | undefined;
			if (answers !== undefined) {
				for (const answerKey of RESULTS_ASSESSMENT_ANSWERS) {
					const answer = answers[answerKey];
					if (answer === undefined) continue;
					bucket.assessmentAnswers[answerKey].present++;
					metricsBump(bucket.assessmentAnswers[answerKey].choices, String(answer.choice));
				}
			}
		}
		if (record.freshness !== undefined) {
			bucket.freshness.present++;
			metricsBump(bucket.freshness.counts, String(record.freshness));
		}
		const executionCleanup = execution?.cleanup;
		if (executionCleanup !== undefined) {
			bucket.cleanup.present++;
			metricsBump(bucket.cleanup.counts, String(executionCleanup));
		}
		const storage = record.receiptStorage as Record<string, unknown> | undefined;
		if (storage !== undefined) {
			bucket.receiptStorage.present++;
			if (storage.persisted === true) bucket.receiptStorage.persisted++;
			else bucket.receiptStorage.notPersisted++;
			metricsBump(bucket.receiptStorage.byReason, String(storage.reason));
			if (storage.nearCapacity !== undefined) {
				bucket.receiptStorage.nearCapacityPresent++;
				if (storage.nearCapacity === true) bucket.receiptStorage.nearCapacityTrue++;
			}
		}
		if (op === "run" && record.durationMs !== undefined) {
			if (bucket.recordedReceiptDurationMs === null) bucket.recordedReceiptDurationMs = metricsDuration();
			metricsDurationAdd(bucket.recordedReceiptDurationMs, Number(record.durationMs));
		}
	}
	for (const op of ["run", "status"] as const) {
		const bucket = op === "run" ? report.run : report.status;
		bucket.passedFraction = metricsFraction(bucket.passedFraction.numerator, bucket.execution.present);
	}
	return report;
}

/** Jev journal → JevMetrics. Manual advise vs task_advice buckets, plan S07. */
export function aggregateJevMetrics(records: Record<string, unknown>[]): JevMetrics {
	const report: JevMetrics = {
		operations: metricsFreq(),
		manualAdvice: { invocations: 0, present: 0, byStatus: metricsFreq(), byTier: metricsFreq(), confidenceBasis: metricsFreq(), byReason: metricsFreq() },
		taskAdvice: {
			batches: 0, batchesWithEntries: 0, entries: 0,
			byStatus: metricsFreq(), byTier: metricsFreq(), confidenceBasis: metricsFreq(), byReason: metricsFreq(),
			recordedPreJournalHookDurationMs: metricsDuration(),
		},
		evidenceObservations: {},
		evidenceStorage: metricsEmptyFieldCounts(),
	};

	for (const record of records) {
		const op = String(record.operation);
		metricsBump(report.operations, op);
		const advice = record.advice as Record<string, unknown> | undefined;
		if (op === "advise") {
			report.manualAdvice.invocations++;
			if (advice !== undefined) {
				report.manualAdvice.present++;
				metricsBump(report.manualAdvice.byStatus, String(advice.status));
				if (advice.tier !== undefined) metricsBump(report.manualAdvice.byTier, String(advice.tier));
				if (advice.confidenceKind !== undefined) metricsBump(report.manualAdvice.confidenceBasis, String(advice.confidenceKind));
				if (advice.reason !== undefined) metricsBump(report.manualAdvice.byReason, String(advice.reason));
			}
		}
		const taskAdvice = record.taskAdvice as Record<string, unknown>[] | undefined;
		if (op === "task_advice") {
			report.taskAdvice.batches++;
			if (record.durationMs !== undefined) metricsDurationAdd(report.taskAdvice.recordedPreJournalHookDurationMs, Number(record.durationMs));
			if (Array.isArray(taskAdvice) && taskAdvice.length > 0) {
				report.taskAdvice.batchesWithEntries++;
				for (const task of taskAdvice) {
					report.taskAdvice.entries++;
					metricsBump(report.taskAdvice.byStatus, String(task.status));
					if (task.tier !== undefined) metricsBump(report.taskAdvice.byTier, String(task.tier));
					if (task.basis !== undefined) metricsBump(report.taskAdvice.confidenceBasis, String(task.basis));
					if (task.reason !== undefined) metricsBump(report.taskAdvice.byReason, String(task.reason));
				}
			}
		}
		const observations = record.evidenceObservations as Record<string, number> | undefined;
		if (observations !== undefined) {
			const bucket = report.evidenceObservations[op] ??= { contributingRecords: 0, completed: 0, failed: 0, cancelled: 0, stored: 0, unavailable: 0 };
			bucket.contributingRecords++;
			for (const key of ["completed", "failed", "cancelled", "stored", "unavailable"] as const) {
				const value = observations[key];
				if (typeof value === "number") {
					if (!Number.isSafeInteger(bucket[key] + value)) throw new Error("resource_limit");
					bucket[key] += value;
				}
			}
		}
		const evidenceStorage = record.evidenceStorage as Record<string, unknown> | undefined;
		if (evidenceStorage !== undefined) {
			report.evidenceStorage.present++;
			metricsBump(report.evidenceStorage.byStatus, String(evidenceStorage.status));
			if (evidenceStorage.reason !== undefined) metricsBump(report.evidenceStorage.byReason, String(evidenceStorage.reason));
		}
	}
	return report;
}

/** Presentation-only validation/null projection. Calibration arithmetic unchanged. */
export function projectCalibrationForReport(summary: CalibrationSummary): StoreResult<CalibrationReport> {
	const durationIsRepresentable = (d: CalibrationSummary["terminalJobs"]["durationMs"]) =>
		Number.isFinite(d.sum) && (!Number.isInteger(d.sum) || Number.isSafeInteger(d.sum)) &&
		(d.average === null || Number.isFinite(d.average));
	if (!durationIsRepresentable(summary.terminalJobs.durationMs) ||
		Object.values(summary.terminalJobs.byRecommendation).some(stats => !durationIsRepresentable(stats.durationMs))) {
		return { status: "unavailable", reason: "corrupt" };
	}
	const project = (d: CalibrationSummary["terminalJobs"]["durationMs"]): MetricsDuration =>
		d.measured === 0 ? { ...d, sum: null } : d;
	return {
		status: "ok",
		value: {
			...summary,
			terminalJobs: {
				...summary.terminalJobs,
				durationMs: project(summary.terminalJobs.durationMs),
				byRecommendation: Object.fromEntries(
					Object.entries(summary.terminalJobs.byRecommendation).map(([tier, stats]) => [
						tier,
						{ ...stats, durationMs: project(stats.durationMs) },
					]),
				),
			},
		},
	};
}

const METRICS_BASE_LIMITATIONS = [
	"retained_not_lifetime",
	"unrecorded_invocations_unknown",
	"independent_source_snapshots",
	"wall_clock_not_event_authority",
	"run_observations_not_unique_executions",
	"status_not_reexecution",
	"terminal_sightings_not_unique_jobs",
	"correlation_window_independent",
	"unknown_identity_and_unobserved_terminals",
	"receipt_duration_excludes_storage_assessment_journal",
	"hook_duration_excludes_journal",
	"provider_assessment_latency_unmeasured",
	"end_to_end_and_isolated_overhead_unmeasured",
	"historical_version_unidentified",
	"smoke_real_workload_unidentified",
	"counts_not_coverage",
	"assessment_not_quality",
	"causal_effect_unmeasured",
] as const;

type MetricsJournalSnapshot = {
	status: string;
	reason: string | null;
	records: Record<string, unknown>[];
	segments: number;
	bytes: number;
};

function aggregateJournalSnapshot<T>(
	snapshot: MetricsJournalSnapshot,
	aggregate: (records: Record<string, unknown>[]) => T,
): { snapshot: MetricsJournalSnapshot; metrics: T | null } {
	if (snapshot.status !== "ok") return { snapshot, metrics: null };
	try {
		return { snapshot, metrics: aggregate(snapshot.records) };
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "resource_limit") throw error;
		return {
			snapshot: { status: "unavailable", reason: "resource_limit", records: [], segments: 0, bytes: 0 },
			metrics: null,
		};
	}
}

function journalSourceEnvelope<T>(
	startedAt: Date,
	completedAt: Date,
	snapshot: MetricsJournalSnapshot | null,
	metrics: T | null,
): JournalSource<T> {
	const status = (snapshot?.status ?? "unavailable") as JournalSource<T>["status"];
	let oldestObservedAt: string | null = null;
	let newestObservedAt: string | null = null;
	let oldestObservedAtMs = Number.POSITIVE_INFINITY;
	let newestObservedAtMs = Number.NEGATIVE_INFINITY;
	if (status === "ok" && snapshot) {
		for (const record of snapshot.records) {
			const observedAt = record.observedAt as string;
			const observedAtMs = Date.parse(observedAt);
			if (observedAtMs < oldestObservedAtMs) {
				oldestObservedAt = observedAt;
				oldestObservedAtMs = observedAtMs;
			}
			if (observedAtMs > newestObservedAtMs) {
				newestObservedAt = observedAt;
				newestObservedAtMs = observedAtMs;
			}
		}
	}
	return {
		status,
		reason: status === "ok" || status === "missing" ? null : ((snapshot?.reason ?? "store_unavailable") as JournalSourceReason),
		readStartedAt: startedAt.toISOString(),
		readCompletedAt: completedAt.toISOString(),
		retention: { maxRecordBytes: 4096, maxSegmentBytes: 1048576, maxSegments: 8 },
		snapshot: status === "ok" && snapshot ? {
			segments: snapshot.segments,
			bytes: snapshot.bytes,
			records: snapshot.records.length,
			oldestObservedAt,
			newestObservedAt,
		} : null,
		metrics: status === "ok" ? metrics : null,
	};
}

/**
 * Offline orchestration: three journal snapshots + one canonical calibration
 * projection. Strictly read-only — no append, no lock, no credential, no network.
 */
export async function buildPluginMetricsReport(): Promise<PluginMetricsReport> {
	const startedAt = new Date();
	const plugins: PluginMetricsReport["plugins"] = {
		"jev-advisor": null as unknown as JournalSource<JevMetrics>,
		"verification-receipts": null as unknown as JournalSource<RunStatusMetrics>,
		"ui-regression": null as unknown as JournalSource<RunStatusMetrics>,
	};
	for (const plugin of ["jev-advisor", "verification-receipts", "ui-regression"] as const) {
		const sourceStartedAt = new Date();
		const snapshot = await readPluginOutcomeSnapshot(plugin);
		const completedAt = new Date();
		if (plugin === "jev-advisor") {
			const source = aggregateJournalSnapshot(snapshot, aggregateJevMetrics);
			plugins[plugin] = journalSourceEnvelope(sourceStartedAt, completedAt, source.snapshot, source.metrics);
		} else {
			const source = aggregateJournalSnapshot(snapshot, records => aggregateRunStatusMetrics(records, plugin));
			plugins[plugin] = journalSourceEnvelope(sourceStartedAt, completedAt, source.snapshot, source.metrics);
		}
	}
	const stateStartedAt = new Date();
	const stateRead = readEvidenceV2(version2StateFile(pluginStateFile()));
	const stateCompletedAt = new Date();
	const correlationRead = stateRead.status === "ok"
		? projectCalibrationForReport(calibrationSummary(stateRead.value).json)
		: stateRead;
	const correlation: CorrelationSource = {
		status: correlationRead.status,
		reason: correlationRead.status === "unavailable" ? correlationRead.reason : null,
		readStartedAt: stateStartedAt.toISOString(),
		readCompletedAt: stateCompletedAt.toISOString(),
		window: "retained_v2_metadata",
		metrics: correlationRead.status === "ok" ? correlationRead.value : null,
	};
	const statuses = [plugins["jev-advisor"].status, plugins["verification-receipts"].status, plugins["ui-regression"].status, correlation.status];
	const okCount = statuses.filter(status => status === "ok").length;
	const status: PluginMetricsReport["status"] = okCount === 4 ? "complete" : okCount === 0 ? "unavailable" : "partial";
	const limitations: string[] = [...METRICS_BASE_LIMITATIONS];
	if (statuses.includes("missing")) limitations.push("source_missing");
	if (statuses.includes("unavailable")) limitations.push("source_unavailable");
	return {
		schemaVersion: 1,
		report: "plugin_metrics",
		mode: "offline_descriptive",
		window: "all_retained",
		scope: "current_process_home_all_repositories",
		generatedAt: startedAt.toISOString(),
		status,
		plugins,
		correlation,
		unavailableMeasures: {
			pluginOverheadMs: null, providerLatencyMs: null, assessmentLatencyMs: null,
			endToEndInvocationMs: null, providerCost: null, tokenUsage: null,
			quality: null, accuracy: null, causalRoi: null,
		},
		limitations,
	};
}

export function readSessionId(ctx: unknown): string | null {
	if (!isRecord(ctx) || !isRecord(ctx.sessionManager) || typeof ctx.sessionManager.getSessionId !== "function") return null;
	try {
		return boundedIdentity(ctx.sessionManager.getSessionId.call(ctx.sessionManager));
	} catch {
		return null;
	}
}

export function noDecision(reason: NoDecisionReason, httpStatus?: number): Advice {
	return httpStatus === undefined ? { status: "no_decision", reason } : { status: "no_decision", reason, httpStatus };
}

function parseProbabilityMap(value: unknown): Record<Tier, number> | null {
	if (!isRecord(value) || Object.keys(value).length !== TIERS.length || !TIERS.every(tier => Object.prototype.hasOwnProperty.call(value, tier))) return null;
	const probabilities = {} as Record<Tier, number>;
	for (const tier of TIERS) {
		const probability = value[tier];
		if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
		probabilities[tier] = probability;
	}
	const sum = TIERS.reduce((total, tier) => total + probabilities[tier], 0);
	return Math.abs(sum - 1) <= 0.001 + 1e-9 ? probabilities : null;
}

/** Strict JSON parser. It accepts a whole JSON document or one complete JSON fence, never a partial object. */
export function parseDecision(raw: string, confidenceKind: ConfidenceKind = "self_reported"): Advice {
	try {
		let text = String(raw ?? "").trim();
		if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return noDecision("invalid_response");
		const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
		if (fence) text = fence[1].trim();
		if (!text.startsWith("{") || !text.endsWith("}")) return noDecision("invalid_response");
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["tier", "confidence", "probabilities", "rationale"])) return noDecision("invalid_response");
		const tier = validTier(parsed.tier);
		if (!tier || typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
			return noDecision("invalid_response");
		}
		let probabilities: Record<Tier, number> | undefined;
		if (Object.prototype.hasOwnProperty.call(parsed, "probabilities")) {
			const candidate = parseProbabilityMap(parsed.probabilities);
			if (!candidate) return noDecision("invalid_response");
			probabilities = candidate;
		}
		if (Object.prototype.hasOwnProperty.call(parsed, "rationale") && typeof parsed.rationale !== "string") return noDecision("invalid_response");
		const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 120) : undefined;
		return {
			status: "decision",
			tier,
			confidence: parsed.confidence,
			...(probabilities ? { probabilities } : {}),
			confidenceKind,
			...(rationale ? { rationale } : {}),
		};
	} catch {
		return noDecision("invalid_response");
	}
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function extractChatFinal(data: unknown): string | null {
	if (!isRecord(data) || !Array.isArray(data.choices)) return null;
	const first = data.choices[0];
	if (!isRecord(first) || first.error !== undefined) return null;
	const message = isRecord(first.message) ? first.message : null;
	if (!message) return null;
	const content = message.content;
	if (typeof content === "string") return content.trim() ? content : null;
	if (Array.isArray(content)) {
		const chunks = content.map(part => isRecord(part) && typeof part.text === "string" ? part.text : "");
		const joined = chunks.join("");
		return joined.trim() ? joined : null;
	}
	return null;
}

function extractSystemoneFinal(data: unknown): string | null {
	if (!isRecord(data) || !isRecord(data.answers) || !isRecord(data.answers.tier)) return null;
	const answer = data.answers.tier;
	if (typeof answer.choice !== "string" || typeof answer.confidence !== "number") return null;
	const payload: Record<string, unknown> = { tier: answer.choice, confidence: answer.confidence };
	if (Object.prototype.hasOwnProperty.call(answer, "probabilities")) payload.probabilities = answer.probabilities;
	if (Object.prototype.hasOwnProperty.call(answer, "rationale")) payload.rationale = answer.rationale;
	return JSON.stringify(payload);
}

async function readBoundedResponse(response: Response): Promise<string | null> {
	const length = response.headers?.get?.("content-length");
	if (length && Number.isFinite(Number(length)) && Number(length) > MAX_RESPONSE_BYTES) return null;
	if (!response.body || typeof response.body.getReader !== "function") return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				try { await reader.cancel(); } catch {}
				return null;
			}
			chunks.push(value);
		}
	} finally {
		try { reader.releaseLock(); } catch {}
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function timeoutDecision(signal: AbortSignal | undefined, timeoutSignal: AbortSignal): Advice {
	if (signal?.aborted) return noDecision("aborted");
	if (timeoutSignal.aborted) return noDecision("timeout");
	return noDecision("provider_error");
}

export async function askDecisionModel(
	cfg: AdvisorConfig,
	task: TaskInput,
	fetchImpl: FetchLike | undefined,
	signal?: AbortSignal,
	timeoutLimitMs = cfg.timeoutMs,
): Promise<Advice> {
	if (!task.complete) return noDecision("input_too_large");
	if (typeof fetchImpl !== "function") return noDecision("provider_error");
	if (cfg.provider === "off") return noDecision("disabled");
	if (!isConfigured(cfg)) return noDecision("unconfigured");
	const provider = PROVIDERS[cfg.provider] ?? (cfg.endpoint ? { endpoint: cfg.endpoint, style: "openai-chat" as const } : undefined);
	if (!provider) return noDecision("unconfigured");
	const url = cfg.endpoint || provider.endpoint;
	if (!isAllowedEndpoint(url)) return noDecision("invalid_endpoint");
	const style = REQUEST_STYLES[provider.style];
	const timeoutMs = Math.max(1, Math.min(INVOCATION_BUDGET_MS, cfg.timeoutMs, timeoutLimitMs));
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (signal?.aborted) return noDecision("aborted");
	const composedSignal = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const wire = style.request({ model: cfg.model, apiKey: cfg.apiKey }, task.prompt);
	const headers = new URL(url).origin === "https://openrouter.ai" ? { ...wire.headers, ...ATTRIBUTION_HEADERS } : wire.headers;
	try {
		const response = await fetchImpl(url, {
			method: "POST",
			redirect: "error",
			headers,
			body: wire.body,
			signal: composedSignal,
		});
		if (!response?.ok) return noDecision("provider_error", Number.isInteger(response?.status) ? response.status : undefined);
		const text = await readBoundedResponse(response);
		if (text === null) return noDecision("invalid_response");
		let data: unknown;
		try { data = JSON.parse(text); } catch { return noDecision("invalid_response"); }
		const final = provider.style === "systemone" ? extractSystemoneFinal(data) : extractChatFinal(data);
		if (!final) return noDecision("invalid_response");
		return parseDecision(final, provider.style === "systemone" ? "provider_choice" : "self_reported");
	} catch {
		return timeoutDecision(signal, timeoutSignal);
	}
}

export function formatSummary(advice: Advice): string {
	if (advice.status === "no_decision") return `jev-advisor: no decision (${advice.reason})`;
	return `jev-advisor: tier=${advice.tier} confidence=${advice.confidence.toFixed(2)}`;
}

export const ENFORCE_GUIDANCE =
	"Re-issue this task call with the recommended tier, or set JEV_ADVISOR_MODE=hint for non-blocking advisories.";

/**
 * Widget lifecycle registry — in-process, metadata-only UI bookkeeping.
 * The two generated hook surfaces live in separate modules (build.mjs
 * concatenates lib/decision.ts into each) but are imported into one host
 * realm, so a namespaced globalThis slot is genuinely shared. The slot must
 * be resolved inside function bodies: a module-level binding would be
 * per-generated-file and would not be shared across the two surfaces.
 */
export const WIDGET_LIFECYCLE_SLOT = "gjc.jev-advisor.widget-lifecycle";
export const WIDGET_LIFECYCLE_VERSION = 1;
/** Session entries kept at once; the oldest session is evicted past this. */
export const WIDGET_LIFECYCLE_MAX_SESSIONS = 8;
/**
 * Job ids tracked per batch entry. MAX_TASKS_PER_INVOCATION (32) is the
 * admission clamp on input.tasks.length, but historical/resumed jobs and
 * foreign same-session terminals can push more distinct ids past the fold,
 * so the map bound is deliberately 2x the admission clamp (64).
 */
export const WIDGET_LIFECYCLE_MAX_JOB_IDS = 64;

export type WidgetJobStatus = "terminal" | "nonTerminal" | "unknown";

export interface WidgetJobState {
	status: WidgetJobStatus;
	everNonTerminal: boolean;
}

export interface WidgetBatchState {
	toolCallId: string;
	/** Clamp(raw input.tasks.length, 1, 32); fallback tasks+rejected. */
	taskCount: number;
	awaitingAsync: boolean;
	primaryJobId: string | null;
	jobs: Record<string, WidgetJobState>;
}

interface WidgetLifecycleState {
	version: number;
	sessions: Record<string, WidgetBatchState>;
}

function lifecycleSlot(): { state: WidgetLifecycleState } | null {
	const holder = globalThis as { [key: symbol]: unknown };
	const key = Symbol.for(WIDGET_LIFECYCLE_SLOT);
	return typeof holder[key] === "object" && holder[key] !== null
		? (holder[key] as { state: WidgetLifecycleState })
		: null;
}

function ensureLifecycleSlot(): { state: WidgetLifecycleState } {
	const existing = lifecycleSlot();
	if (existing) return existing;
	const holder = globalThis as { [key: symbol]: unknown };
	const key = Symbol.for(WIDGET_LIFECYCLE_SLOT);
	const slot = { state: { version: WIDGET_LIFECYCLE_VERSION, sessions: {} } as WidgetLifecycleState };
	holder[key] = slot;
	return slot;
}

/** Fail-toward-keeping: a missing/mismatched-version/malformed slot reads as empty. */
function lifecycleState(): WidgetLifecycleState {
	const slot = lifecycleSlot();
	if (!slot) return { version: WIDGET_LIFECYCLE_VERSION, sessions: {} };
	const state = slot.state;
	if (
		typeof state !== "object" || state === null ||
		state.version !== WIDGET_LIFECYCLE_VERSION ||
		typeof state.sessions !== "object" || state.sessions === null
	) {
		return { version: WIDGET_LIFECYCLE_VERSION, sessions: {} };
	}
	return state;
}

function boundedJobId(value: unknown): string | null {
	return boundedIdentity(value);
}

function clampTaskCount(raw: number): number {
	return Math.min(Math.max(raw, 1), MAX_TASKS_PER_INVOCATION);
}

function evictOldestSessions(sessions: Record<string, WidgetBatchState>): void {
	const ids = Object.keys(sessions);
	if (ids.length <= WIDGET_LIFECYCLE_MAX_SESSIONS) return;
	for (const id of ids.slice(0, ids.length - WIDGET_LIFECYCLE_MAX_SESSIONS)) delete sessions[id];
}

export function widgetSessionEntry(sessionId: unknown): WidgetBatchState | null {
	const id = boundedIdentity(sessionId);
	if (!id) return null;
	return lifecycleState().sessions[id] ?? null;
}

export function widgetLifecycleResetForTests(): void {
	const slot = lifecycleSlot();
	if (slot) slot.state = { version: WIDGET_LIFECYCLE_VERSION, sessions: {} };
}

/**
 * Record the batch the pre-hook just drew. Replaces any prior entry for the
 * session (supersede); the new entry owns the widget from this point on.
 */
export function widgetRecordBatch(
	sessionId: string,
	toolCallId: string,
	taskCount: number,
): void {
	const session = boundedIdentity(sessionId);
	const call = boundedIdentity(toolCallId);
	if (!session || !call) return;
	const slot = ensureLifecycleSlot();
	slot.state.sessions[session] = {
		toolCallId: call,
		taskCount: clampTaskCount(taskCount),
		awaitingAsync: false,
		primaryJobId: null,
		jobs: {},
	};
	evictOldestSessions(slot.state.sessions);
}

/**
 * Latest-observation-wins fold with no regression: a terminal sighting is
 * never undone by a later non-terminal or unknown sighting; running/paused/
 * queued set nonTerminal + everNonTerminal; unknown/absent statuses record
 * `unknown` (blocks a clear, contributes nothing to the terminal count).
 * Excess job ids past the map bound evict the oldest entries (bounded memory);
 * a dropped ever-non-terminal id can weaken the closure check in extreme
 * corners (advisory-only residual).
 */
export function widgetFoldSnapshot(
	sessionId: unknown,
	entries: { jobId: unknown; status: unknown }[],
): void {
	const session = boundedIdentity(sessionId);
	if (!session) return;
	const state = lifecycleState();
	const batch = state.sessions[session];
	if (!batch) return;
	for (const item of entries) {
		const jobId = boundedJobId(item.jobId);
		if (!jobId) continue;
		const existing = batch.jobs[jobId];
		const status = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
		if (status === "completed" || status === "failed" || status === "cancelled") {
			batch.jobs[jobId] = { status: "terminal", everNonTerminal: existing?.everNonTerminal ?? false };
		} else if (status === "running" || status === "paused" || status === "queued") {
			if (existing?.status === "terminal") continue; // no regression
			batch.jobs[jobId] = { status: "nonTerminal", everNonTerminal: true };
		} else if (existing?.status === "terminal") {
			continue; // unknown/absent never regresses a terminal id
		} else {
			batch.jobs[jobId] = {
				status: "unknown",
				everNonTerminal: existing?.everNonTerminal ?? false,
			};
		}
	}
	const ids = Object.keys(batch.jobs);
	if (ids.length > WIDGET_LIFECYCLE_MAX_JOB_IDS) {
		for (const id of ids.slice(0, ids.length - WIDGET_LIFECYCLE_MAX_JOB_IDS)) delete batch.jobs[id];
	}
}

/** Mark the batch as waiting on an async envelope and pin the primary job. */
export function widgetMarkAwaitingAsync(
	sessionId: string,
	toolCallId: string,
	jobId: string,
): void {
	const session = boundedIdentity(sessionId);
	const call = boundedIdentity(toolCallId);
	const job = boundedJobId(jobId);
	if (!session || !call || !job) return;
	const batch = lifecycleState().sessions[session];
	if (!batch || batch.toolCallId !== call) return;
	batch.awaitingAsync = true;
	batch.primaryJobId = job;
}

/** Drop a session entry without touching the widget (caller clears the UI). */
export function widgetDropSession(sessionId: unknown): void {
	const session = boundedIdentity(sessionId);
	if (!session) return;
	const state = lifecycleState();
	delete state.sessions[session];
}

/**
 * CLEAR predicate (Design 3). All of (a)-(f) must hold:
 * (a) a registry entry exists for this session with awaitingAsync === true
 *     (supersede resets awaitingAsync, so this also proves the entry's
 *     toolCallId is still the one whose widget was drawn);
 * (b) the snapshot lists at least 1 entry with a bounded jobId;
 * (c) every listed entry resolves terminal (non-terminal or unknown blocks);
 * (d) every ever-non-terminal id in the window is now terminal (closure);
 * (e) count of terminal ids in the window >= taskCount;
 * (f) primaryJobId === null OR the primary job is terminal.
 */
export function widgetShouldClear(
	sessionId: unknown,
	listedEntries: { jobId: unknown; status: unknown }[],
): boolean {
	// (a) registry entry for this session, awaiting async, same toolCallId
	const session = boundedIdentity(sessionId);
	if (!session) return false;
	const batch = lifecycleState().sessions[session];
	if (!batch || !batch.awaitingAsync) return false;
	// (b) at least one listed entry with a bounded jobId
	const normalized = listedEntries.map(item => ({
		jobId: boundedJobId(item?.jobId),
		status: typeof item?.status === "string" ? item.status.trim().toLowerCase() : "",
	}));
	const listed = normalized.filter(item => item.jobId !== null);
	if (listed.length === 0) return false;
	// (c) every listed entry resolves terminal — including entries whose jobId is
	// not bounded (they cannot join the count, but a non-terminal one must not be
	// skipped away to let an untracked running child slip past the clear)
	for (const item of normalized) {
		if (item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled") return false;
	}
	// (d) closure: every ever-non-terminal id must now be terminal
	for (const job of Object.values(batch.jobs)) {
		if (job.everNonTerminal && job.status !== "terminal") return false;
	}
	// (e) terminal count reaches the raw task count
	const terminalIds = new Set(
		Object.entries(batch.jobs)
			.filter(([, job]) => job.status === "terminal")
			.map(([id]) => id),
	);
	if (terminalIds.size < batch.taskCount) return false;
	// (f) primary job (first child) must be terminal
	if (batch.primaryJobId !== null && !terminalIds.has(batch.primaryJobId)) return false;
	return true;
}

// Keyless build. Activation: ~/.gjc/agent/jev-advisor/.env or JEV_ADVISOR_API_KEY /
// OPENROUTER_API_KEY env (env wins over the file), or JEV_ADVISOR_PROVIDER=ollaya (local, no key).

// Explicit task advice and an offline correlation report; both journal sanitized outcomes.
export default function jevAdvise(pi: {
 typebox: {Type: {Object:(fields:Record<string,unknown>)=>unknown;String:(options?:Record<string,unknown>)=>unknown;Optional:(schema:unknown)=>unknown}};
}) {
 return {
  name:'jev_advise',label:'JEV Advise',
  description:'Ask for bounded fast/balanced/strong advice, or report="calibration" for an offline descriptive correlation report. Every handled outcome is journaled privately under ~/.gjc-plugin; calibration never calls a provider or modifies correlation state. No quality or correctness is inferred.',
  parameters:pi.typebox.Type.Object({
   assignment:pi.typebox.Type.Optional(pi.typebox.Type.String({description:'One complete task assignment to evaluate'})),
   role:pi.typebox.Type.Optional(pi.typebox.Type.String({description:'Intended subagent role'})),
   report:pi.typebox.Type.Optional(pi.typebox.Type.String({description:'Offline correlation report; only "calibration" is valid. Appends a private outcome record.'})),
  }),
  async execute(_toolCallId:string,params:{assignment?:string;role?:string;report?:string}) {
   const cfg=readConfig();
   const operation=params?.report==='calibration'?'calibration':'advise';
   const finish=async(value:string|Advice,evidenceStorage?:{status:string;reason?:string})=>{
    const advice=typeof value==='string'?undefined:value.status==='decision'?{status:value.status,tier:value.tier,confidence:value.confidence,confidenceKind:value.confidenceKind,...(value.probabilities?{probabilities:value.probabilities}:{})}:{status:value.status,reason:value.reason};
    let journalStorage;
    try { journalStorage=await appendPluginOutcome('jev-advisor',{
     operation,toolCallDigest:createHash('sha256').update(_toolCallId).digest('hex'),stateOverrideIgnored:cfg.stateOverrideIgnored,
     ...(advice?{advice}:{}),...(evidenceStorage?{evidenceStorage}:{}),
    }); } catch { journalStorage={persisted:false,reason:'store_unavailable'}; }
    const persistence={journalStorage,stateOverrideIgnored:cfg.stateOverrideIgnored};
    const text=typeof value==='string'?value+'\n'+JSON.stringify(persistence):JSON.stringify({...value,...persistence},null,2);
    return {content:[{type:'text',text}]};
   };
   if(operation==='calibration') {
    try {
     const result=readEvidenceV2(version2StateFile(cfg.stateFile));
     if(result.status==='unavailable') return finish(`jev_advise: retained v2 report unavailable (${result.reason}); correlation state was not changed.`,{status:result.status,reason:result.reason});
     const state=result.status==='missing'?emptyEvidenceV2():result.value;
     const {text}=calibrationSummary(state);
     return finish((result.status==='missing'?'No v2 store exists yet. ':'')+text,{status:result.status});
    } catch { return finish('jev_advise: retained v2 report unavailable (io_error); correlation state was not changed.',{status:'unavailable',reason:'io_error'}); }
   }
   if(params?.report!==undefined&&params.report!=='') return finish('jev_advise: unknown report. The only valid value is report="calibration".',{status:'unavailable',reason:'invalid_input'});
   if(typeof params?.assignment!=='string'||!params.assignment.trim()||(params.role!==undefined&&typeof params.role!=='string')) return finish(noDecision('invalid_task'));
   const extraction=extractTasks({agent:params.role??'',tasks:[{assignment:params.assignment}]},providerPromptLimit(cfg));
   const task=extraction.tasks[0];
   if(!task) return finish(noDecision('invalid_task'));
   try { return finish(await askDecisionModel(cfg,task,(input,init)=>fetch(input,init))); }
   catch { return finish(noDecision('provider_error')); }
  },
 };
}
