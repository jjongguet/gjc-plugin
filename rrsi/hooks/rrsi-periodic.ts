// GENERATED FILE — do not edit by hand.
// Core: lib/rrsi.ts + lib/periodic.ts + adapter: src/periodic.adapter.ts
// Inlined: shared/lib/results.ts and self-improve/lib/{types,ledger,replay,dream,policy}.mjs
// Rebuild with: bun scripts/build.mjs
// One session_start registration; doubles as the detached worker CLI (RRSI_PERIODIC_WORKER=1).

import { constants as resultsConstants, promises as resultsFs } from 'node:fs';
import type { Stats as ResultsStats } from 'node:fs';
import type { FileHandle as ResultsFileHandle } from 'node:fs/promises';
import { homedir as resultsHomedir } from 'node:os';
import { dirname as resultsDirname, join as resultsJoin, parse as resultsParse, resolve as resultsResolve, sep as resultsSep } from 'node:path';
import { createHash as resultsHash, randomUUID as resultsUUID } from 'node:crypto';
import { performance as resultsClock } from 'node:perf_hooks';

export type PluginOutcome = {
  operation: 'run' | 'status' | 'advise' | 'calibration' | 'check' | 'task_advice' | 'task_launch' | 'subagent_terminal' | 'wiki_query' | 'wiki_propose' | 'rea_readiness' | 'backplan_check' | 'gate_emitted' | 'loop_run' | 'capture' | 'import' | 'dream';
  repositoryDigest?: string | null;
  receiptId?: string | null;
  toolCallDigest?: string;
  durationMs?: number;
  freshness?: 'fresh' | 'stale' | 'changed_during_run' | 'unavailable';
  stateOverrideIgnored?: boolean;
  execution?: { status: string; reason: string; counts?: Record<string, number> | null; assertions?: { step: number; id: string; kind: string; status: string }[]; cleanup?: string };
  assessment?: { status: string; reason: string; answers?: { coverage_alignment: { type: 'choice'; choice: string; confidence?: number; probabilities?: Partial<Record<string, number>> }; boundary_evidence: { type: 'choice'; choice: string; confidence?: number; probabilities?: Partial<Record<string, number>> } } };
  advice?: { status: string; tier?: string; confidence?: number; confidenceKind?: string; probabilities?: Record<string, number>; reason?: string };
  check?: { status: string; verdict?: string; confidence?: number; confidenceKind?: string; probabilities?: Record<string, number>; reason?: string };
  taskAdvice?: { index:number; status:string; tier?:string; confidence?:number; basis?:string; reason?:string }[];
  evidenceObservations?: {completed:number;failed:number;cancelled:number;stored:number;unavailable:number};
  receiptStorage?: { persisted: boolean; reason: string; count?: number; bytes?: number; nearCapacity?: boolean };
  evidenceStorage?: { status: string; reason?: string };
  gate?: { trigger: 'task' | 'task_async' | 'subagent_terminal' | 'job_terminal'; facts: 'available' | 'partial' | 'unavailable'; baselinePresent: boolean; binding: 'none' | 'bound' | 'unknown'; stateWrite: 'ok' | 'drop'; persistence?: 'applied' | 'no_changes' | 'recovery_available'; changedFiles: number; commits?: number; receiptState: 'none' | 'present' | 'fresh_passed' | 'unavailable' };
  loop?: { status: 'clean' | 'gaps' | 'blocked'; openGates: number; resolvedGates: number; scannedSessionFiles: number; scanTruncated: boolean; silentPending: number; gapKinds: LoopGapKind[] };
  rrsi?: { action: RrsiAction; episodes?: number; attempts?: number; imported?: number; policies?: number; storage: 'ok' | 'missing' | 'unavailable' | 'invalid' };
};
export type RrsiAction = 'capture' | 'import' | 'dream' | 'status';
export type LoopGapKind = 'no_receipt_after_gate' | 'receipt_not_passed' | 'receipt_no_tests' | 'receipt_incomplete' | 'receipt_stale' | 'receipt_changed_during_run' | 'receipt_freshness_unavailable' | 'changed_test_uncovered' | 'state_unavailable' | 'not_a_repository';
type ResultsPlugin = 'jev-advisor' | 'verification-receipts' | 'ui-regression' | 'wiki' | 'rea' | 'backplan' | 'rrsi';
type ResultsAppend = { persisted: boolean; reason: string; id?: string; rotated?: number; retainedSegments?: number };
type ResultsDependencies = { baseDir?: string; maxRecordBytes?: number; maxSegmentBytes?: number; maxSegments?: number; lockTimeoutMs?: number };
const resultsPlugins = ['jev-advisor', 'verification-receipts', 'ui-regression', 'wiki', 'rea', 'backplan', 'rrsi'];
const resultsOperations = ['run', 'status', 'advise', 'calibration', 'check', 'task_advice', 'task_launch', 'subagent_terminal', 'wiki_query', 'wiki_propose', 'rea_readiness', 'backplan_check', 'gate_emitted', 'loop_run', 'capture', 'import', 'dream'];
const resultsRrsiActions = ['capture', 'import', 'dream', 'status'];
const resultsGapKinds = ['no_receipt_after_gate', 'receipt_not_passed', 'receipt_no_tests', 'receipt_incomplete', 'receipt_stale', 'receipt_changed_during_run', 'receipt_freshness_unavailable', 'changed_test_uncovered', 'state_unavailable', 'not_a_repository'];
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
const resultsCheckVerdicts = ['correct', 'incorrect', 'unsure'];
function resultsCheck(value: unknown): Record<string, unknown> {
  const c = resultsObject(value, ['status', 'verdict', 'confidence', 'confidenceKind', 'probabilities', 'reason'], ['status']);
  const check: Record<string, unknown> = { status: resultsEnum(c.status, ['decision', 'no_decision']) };
  if (c.verdict !== undefined) check.verdict = resultsEnum(c.verdict, resultsCheckVerdicts);
  if (c.confidence !== undefined) check.confidence = resultsProbability(c.confidence);
  if (c.confidenceKind !== undefined) check.confidenceKind = resultsEnum(c.confidenceKind, ['provider_choice', 'self_reported']);
  if (c.probabilities !== undefined) {
    const probabilities = resultsObject(c.probabilities, resultsCheckVerdicts, resultsCheckVerdicts);
    check.probabilities = Object.fromEntries(Object.entries(probabilities).map(([verdict, probability]) => [verdict, resultsProbability(probability)]));
  }
  if (c.reason !== undefined) check.reason = resultsEnum(c.reason, resultsAdviceReasons);
  return check;
}
function resultsGate(value: unknown): Record<string, unknown> {
  const g = resultsObject(value, ['trigger', 'facts', 'baselinePresent', 'binding', 'stateWrite', 'persistence', 'changedFiles', 'commits', 'receiptState'], ['trigger', 'facts', 'baselinePresent', 'binding', 'stateWrite', 'changedFiles', 'receiptState']);
  const gate: Record<string, unknown> = {
    trigger: resultsEnum(g.trigger, ['task', 'task_async', 'subagent_terminal', 'job_terminal']),
    facts: resultsEnum(g.facts, ['available', 'partial', 'unavailable']),
    baselinePresent: resultsBoolean(g.baselinePresent),
    binding: resultsEnum(g.binding, ['none', 'bound', 'unknown']),
    stateWrite: resultsEnum(g.stateWrite, ['ok', 'drop']),
    changedFiles: resultsInteger(g.changedFiles, 100000),
    receiptState: resultsEnum(g.receiptState, ['none', 'present', 'fresh_passed', 'unavailable']),
  };
  if (g.persistence !== undefined) gate.persistence = resultsEnum(g.persistence, ['applied', 'no_changes', 'recovery_available']);
  if (g.commits !== undefined) gate.commits = resultsInteger(g.commits, 100000);
  return gate;
}
function resultsLoop(value: unknown): Record<string, unknown> {
  const l = resultsObject(value, ['status', 'openGates', 'resolvedGates', 'scannedSessionFiles', 'scanTruncated', 'silentPending', 'gapKinds'], ['status', 'openGates', 'resolvedGates', 'scannedSessionFiles', 'scanTruncated', 'silentPending', 'gapKinds']);
  const loop: Record<string, unknown> = {
    status: resultsEnum(l.status, ['clean', 'gaps', 'blocked']),
    openGates: resultsInteger(l.openGates, 10000),
    resolvedGates: resultsInteger(l.resolvedGates, 10000),
    scannedSessionFiles: resultsInteger(l.scannedSessionFiles, 1000),
    scanTruncated: resultsBoolean(l.scanTruncated),
    silentPending: resultsInteger(l.silentPending, 10000),
    gapKinds: resultsArray(l.gapKinds, 10).map(value => resultsEnum(value, resultsGapKinds)),
  };
  return loop;
}
function resultsProject(value: unknown): Record<string, unknown> {
  const raw = resultsObject(value, ['operation', 'repositoryDigest', 'receiptId', 'toolCallDigest', 'durationMs', 'freshness', 'stateOverrideIgnored', 'execution', 'assessment', 'advice', 'check', 'taskAdvice', 'evidenceObservations', 'receiptStorage', 'evidenceStorage', 'gate', 'loop', 'rrsi'], ['operation']);
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
  if (raw.check !== undefined) output.check = resultsCheck(raw.check);
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
  if (raw.gate !== undefined) output.gate = resultsGate(raw.gate);
  if (raw.loop !== undefined) output.loop = resultsLoop(raw.loop);
  if (raw.rrsi !== undefined) {
    const r = resultsObject(raw.rrsi, ['action', 'episodes', 'attempts', 'imported', 'policies', 'storage'], ['action', 'storage']);
    const rrsi: Record<string, unknown> = {
      action: resultsEnum(r.action, resultsRrsiActions),
      storage: resultsEnum(r.storage, ['ok', 'missing', 'unavailable', 'invalid']),
    };
    for (const key of ['episodes', 'attempts', 'imported', 'policies']) {
      if (r[key] !== undefined) rrsi[key] = resultsInteger(r[key], 100000);
    }
    output.rrsi = rrsi;
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
    const record = resultsObject(raw, ['schemaVersion', 'plugin', 'id', 'observedAt', 'operation', 'repositoryDigest', 'receiptId', 'toolCallDigest', 'durationMs', 'freshness', 'stateOverrideIgnored', 'execution', 'assessment', 'advice', 'check', 'taskAdvice', 'evidenceObservations', 'receiptStorage', 'evidenceStorage', 'gate', 'loop', 'rrsi'], ['schemaVersion', 'plugin', 'id', 'observedAt', 'operation']);
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

// ---- inlined from self-improve/lib/types.mjs (Dream-RSI core, keyless plain ESM) ----
/**
 * Shared enums and shape validators for the self-improve ledger and proposals.
 * Runs on plain Node (node: builtins only).
 */
import { createHash } from "node:crypto";

export const LEDGER_SCHEMA = "gjc.self-improve.ledger.v1";
export const MAX_LEDGER_ROW_BYTES = 2048;

export const ROW_KINDS = Object.freeze(["cycle", "adoption", "policy"]);
export const VERDICTS = Object.freeze(["adopt", "reject", "inconclusive"]);
export const INSTALL_STATES = Object.freeze(["not_attempted", "upgraded", "failed"]);
export const POLICY_DECISIONS = Object.freeze(["deploy", "retire"]);

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const HEX_REVISION = /^[0-9a-f]{7,64}$/;
const HEX256 = /^[0-9a-f]{64}$/;

export function validateProposal(proposal) {
  assert(isPlainObject(proposal), "proposal must be an object");
  assert(proposal.source === "manual" || proposal.source === "agent", "proposal.source must be manual|agent");
  assert(
    typeof proposal.patchSha256 === "string" && HEX256.test(proposal.patchSha256),
    "proposal.patchSha256 must be a sha256 hex",
  );
  assert(Array.isArray(proposal.files) && proposal.files.length > 0, "proposal.files must be a non-empty array");
  for (const file of proposal.files) {
    assert(typeof file === "string" && file.length > 0, "proposal.files entries must be non-empty strings");
  }
  assert(Number.isInteger(proposal.hunks) && proposal.hunks >= 0, "proposal.hunks must be a non-negative integer");
}

export function validateCost(cost) {
  assert(isPlainObject(cost), "cost must be an object");
  assert(
    typeof cost.wallMs === "number" && cost.wallMs >= 0,
    "cost.wallMs must be measured (number); null is not allowed for executed cycles",
  );
  assert(typeof cost.bytes === "number" && cost.bytes >= 0, "cost.bytes must be measured (number)");
  assert(
    cost.tokens === null || (typeof cost.tokens === "number" && cost.tokens >= 0),
    "cost.tokens must be a number or null (null means unmeasured)",
  );
}

export function validateScores(scores) {
  assert(isPlainObject(scores), "scores must be an object");
  assert(typeof scores.delta === "number", "scores.delta must be a number");
  assert(typeof scores.floor === "number" && scores.floor >= 0, "scores.floor must be a non-negative number");
  assert(isPlainObject(scores.baseline), "scores.baseline object required");
  assert(isPlainObject(scores.candidate), "scores.candidate object required");
  if (scores.heldout !== undefined) {
    assert(isPlainObject(scores.heldout), "scores.heldout must be an object when present");
    if (scores.heldout.ok !== undefined) {
      assert(typeof scores.heldout.ok === "boolean", "scores.heldout.ok must be a boolean when present");
    }
    if (scores.heldout.regressions !== undefined) {
      assert(Array.isArray(scores.heldout.regressions), "scores.heldout.regressions must be an array when present");
    }
  }
}

export function validateCycleRow(row) {
  assert(isPlainObject(row), "cycle row must be an object");
  assert(row.kind === "cycle", "cycle row kind must be cycle");
  assert(row.schema === LEDGER_SCHEMA, `cycle row schema must be ${LEDGER_SCHEMA}`);
  assert(typeof row.cycleId === "string" && row.cycleId.length > 0, "cycleId required");
  assert(typeof row.domain === "string" && row.domain.length > 0, "domain required");
  assert(typeof row.campaignId === "string" && row.campaignId.length > 0, "campaignId required");
  assert(typeof row.baseCommit === "string" && HEX_REVISION.test(row.baseCommit), "baseCommit must be a hex revision");
  assert(Number.isInteger(row.budgetRung) && row.budgetRung >= 0, "budgetRung must be a non-negative integer");
  validateProposal(row.proposal);
  assert(
    typeof row.hypothesisHash === "string" && HEX256.test(row.hypothesisHash),
    "hypothesisHash must be a sha256 hex",
  );
  assert(typeof row.objective === "string" && row.objective.length > 0, "objective required");
  validateScores(row.scores);
  validateCost(row.cost);
  assert(Array.isArray(row.guards), "guards must be an array");
  for (const guard of row.guards) {
    assert(
      isPlainObject(guard) && typeof guard.id === "string" && typeof guard.status === "string",
      "guard entries need string id/status",
    );
  }
  assert(
    isPlainObject(row.critic) && typeof row.critic.verdict === "string" && Array.isArray(row.critic.rules),
    "critic {verdict, rules} required",
  );
  assert(
    isPlainObject(row.verdict) && VERDICTS.includes(row.verdict.decision),
    `verdict.decision must be one of ${VERDICTS.join("|")}`,
  );
  assert(Array.isArray(row.verdict.reasons), "verdict.reasons must be an array");
  for (const reason of row.verdict.reasons) {
    assert(typeof reason === "string" && reason.length > 0, "verdict.reasons entries must be non-empty strings");
  }
  if (row.forcedExploration !== undefined) {
    assert(typeof row.forcedExploration === "boolean", "forcedExploration must be boolean");
  }
  if (row.labels !== undefined) {
    assert(
      Array.isArray(row.labels) && row.labels.every((label) => typeof label === "string" && label.length > 0),
      "labels must be an array of non-empty strings when present",
    );
  }
  assert(typeof row.createdAt === "string" && row.createdAt.length > 0, "createdAt required");
}

export function validateAdoptionRow(row) {
  assert(isPlainObject(row), "adoption row must be an object");
  assert(row.kind === "adoption", "adoption row kind must be adoption");
  assert(row.schema === LEDGER_SCHEMA, `adoption row schema must be ${LEDGER_SCHEMA}`);
  assert(typeof row.cycleId === "string" && row.cycleId.length > 0, "cycleId required");
  assert(typeof row.commit === "string" && HEX_REVISION.test(row.commit), "commit must be a hex revision");
  assert(INSTALL_STATES.includes(row.install), `install must be one of ${INSTALL_STATES.join("|")}`);
  assert(typeof row.createdAt === "string" && row.createdAt.length > 0, "createdAt required");
}

export function validatePolicyRow(row) {
  assert(isPlainObject(row), "policy row must be an object");
  assert(row.kind === "policy", "policy row kind must be policy");
  assert(row.schema === LEDGER_SCHEMA, `policy row schema must be ${LEDGER_SCHEMA}`);
  assert(
    typeof row.policyId === "string" && /^[a-z0-9][a-z0-9-]{2,63}$/.test(row.policyId),
    "policyId must be a lowercase slug (3-64 chars)",
  );
  assert(POLICY_DECISIONS.includes(row.decision), `decision must be one of ${POLICY_DECISIONS.join("|")}`);
  assert(Number.isInteger(row.seed), "seed must be an integer");
  assert(typeof row.configHash === "string" && HEX256.test(row.configHash), "configHash must be a sha256 hex");
  assert(isPlainObject(row.artifact), "artifact {path, sha256} required");
  assert(typeof row.artifact.path === "string" && row.artifact.path.length > 0, "artifact.path required");
  assert(typeof row.artifact.sha256 === "string" && HEX256.test(row.artifact.sha256), "artifact.sha256 must be a sha256 hex");
  assert(typeof row.createdAt === "string" && row.createdAt.length > 0, "createdAt required");
}

// ---- inlined from self-improve/lib/ledger.mjs (Dream-RSI core, keyless plain ESM) ----
/**
 * Append-only JSONL ledger with a sha256 prev-hash chain.
 * Rows are the committed proof stream for self-improve cycles.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

function parseEntries(rawText) {
  const entries = [];
  const lines = rawText.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    entries.push({ row, raw: line, hash: sha256Hex(line) });
  }
  return entries;
}

function loadEntries(filePath) {
  if (!existsSync(filePath)) return [];
  return parseEntries(readFileSync(filePath, "utf8"));
}

export function readLedger(filePath) {
  return loadEntries(filePath).map((entry) => entry.row);
}

export function verifyChain(filePath) {
  const entries = loadEntries(filePath);
  let previousHash = null;
  for (let i = 0; i < entries.length; i += 1) {
    const { row, hash } = entries[i];
    const expectedSeq = i + 1;
    if (row.seq !== expectedSeq) {
      return { ok: false, count: entries.length, brokenAt: expectedSeq, reason: "seq_mismatch" };
    }
    if ((row.prev ?? null) !== previousHash) {
      return { ok: false, count: entries.length, brokenAt: expectedSeq, reason: "prev_mismatch" };
    }
    previousHash = hash;
  }
  return { ok: true, count: entries.length, brokenAt: null, reason: null };
}

export function appendRow(filePath, rowData) {
  const entries = loadEntries(filePath);
  const last = entries.length > 0 ? entries[entries.length - 1] : null;
  const row = {
    schema: LEDGER_SCHEMA,
    ...rowData,
    seq: entries.length + 1,
    prev: last ? last.hash : null,
  };
  if (row.kind === "cycle") {
    validateCycleRow(row);
    const duplicate = entries.find((entry) => entry.row.kind === "cycle" && entry.row.cycleId === row.cycleId);
    if (duplicate) {
      throw new Error(`duplicate_cycle: cycleId ${row.cycleId} already recorded at seq ${duplicate.row.seq}`);
    }
  } else if (row.kind === "adoption") {
    validateAdoptionRow(row);
    const duplicate = entries.find((entry) => entry.row.kind === "adoption" && entry.row.cycleId === row.cycleId);
    if (duplicate) {
      throw new Error(`duplicate_adoption: cycleId ${row.cycleId} already recorded at seq ${duplicate.row.seq}`);
    }
  } else if (row.kind === "policy") {
    validatePolicyRow(row);
    const duplicate = entries.find((entry) => entry.row.kind === "policy" && entry.row.policyId === row.policyId);
    if (duplicate) {
      throw new Error(`duplicate_policy: policyId ${row.policyId} already recorded at seq ${duplicate.row.seq}`);
    }
  } else {
    throw new Error(`unknown ledger row kind: ${String(row.kind)}`);
  }
  const line = JSON.stringify(row);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_LEDGER_ROW_BYTES) {
    throw new Error(`ledger_row_too_large: ${bytes} bytes exceeds ${MAX_LEDGER_ROW_BYTES}`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${line}\n`);
  return { seq: row.seq, hash: sha256Hex(line), bytes };
}

export function ledgerCounts(filePath) {
  const entries = loadEntries(filePath);
  const byKind = { cycle: 0, adoption: 0, policy: 0 };
  const byVerdict = { adopt: 0, reject: 0, inconclusive: 0 };
  const cost = { cycleRows: 0, wallMsMeasured: 0, bytesMeasured: 0, tokensMeasured: 0, tokensNull: 0 };
  for (const { row } of entries) {
    if (byKind[row.kind] !== undefined) byKind[row.kind] += 1;
    if (row.kind !== "cycle") continue;
    cost.cycleRows += 1;
    if (typeof row.cost?.wallMs === "number") cost.wallMsMeasured += 1;
    if (typeof row.cost?.bytes === "number") cost.bytesMeasured += 1;
    if (row.cost?.tokens === null || row.cost?.tokens === undefined) cost.tokensNull += 1;
    else if (typeof row.cost.tokens === "number") cost.tokensMeasured += 1;
    if (byVerdict[row.verdict?.decision] !== undefined) {
      byVerdict[row.verdict.decision] += 1;
    }
  }
  return { total: entries.length, byKind, byVerdict, cost, chain: verifyChain(filePath) };
}

// ---- inlined from self-improve/lib/replay.mjs (Dream-RSI core, keyless plain ESM) ----
/**
 * Deterministic epoch-partitioned replay simulator (Dream-RSI "replay worlds").
 *
 * Epoch validity rule (plan §4.3, [F3]): an attempt may be replayed only at the
 * code state at which it was recorded. The authoritative boundary is the
 * editable-surface digest, which only adoptions change — ledger-only `chore`
 * commits move HEAD without changing the graded surface, so `baseCommit` is
 * recorded as provenance, never as the epoch key. Observable consequence: an
 * adoption closes its epoch (the next epoch's attempts were recorded on the new
 * surface), reject-only attempts inside an epoch are freely reorderable, and
 * adoption order is preserved in every replay. Cross-epoch replay of an attempt
 * is impossible because later epochs only become available after the adoption
 * that opened them has been played.
 *
 * Reveal protocol: selection may use only ex-ante features (objective/gap id,
 * attempt index within the branch, hypothesis-novelty flag, files/hunks, prior
 * REVEALED outcomes of the same branch, prior guard-failure classes, budget
 * rung). An attempt's recorded outcome is revealed only after it is selected;
 * verdicts, deltas and ledger order of unplayed attempts are sealed.
 *
 * No I/O beyond reading the ledger; no timers; no randomness.
 */

export const REPLAY_SCHEMA = "gjc.self-improve.replay.v1";
export const POLICY_ORDERS = Object.freeze(["fixed", "round_robin", "success_greedy", "failure_greedy", "novelty_first"]);
export const POLICY_STOP_RULES = Object.freeze(["first_adoption", "exhaustive"]);
export const DEFAULT_POLICY_CONFIG = Object.freeze({
  order: "fixed",
  batchSize: 1,
  stopRule: "first_adoption",
  stallRedirect: false,
  stallK: 3,
});
export const DEFAULT_BETAS = Object.freeze({ beta1: 0.01, beta2: 0.005 });
export const BASELINE_IDS = Object.freeze(["B0", "B1"]);

/** The two fixed baselines of the plan: recorded order (B0), round-robin (B1). */
export const BASELINE_POLICIES = Object.freeze({
  B0: { id: "B0", config: { ...DEFAULT_POLICY_CONFIG, order: "fixed", batchSize: 1, stopRule: "first_adoption" } },
  B1: { id: "B1", config: { ...DEFAULT_POLICY_CONFIG, order: "round_robin", batchSize: 1, stopRule: "first_adoption" } },
});

function buildAttempt(row, adoptionRow) {
  return {
    seq: row.seq,
    cycleId: row.cycleId,
    objective: row.objective,
    hypothesisHash: row.hypothesisHash,
    baseCommit: row.baseCommit,
    budgetRung: row.budgetRung,
    files: [...(row.proposal?.files ?? [])],
    hunks: row.proposal?.hunks ?? 0,
    wallMs: typeof row.cost?.wallMs === "number" ? row.cost.wallMs : null,
    guardFailures: (row.guards ?? []).filter((guard) => guard.status !== "pass").map((guard) => guard.id),
    decision: row.verdict?.decision ?? "inconclusive",
    delta: row.scores?.delta ?? null,
    adoption: adoptionRow ? { commit: adoptionRow.commit, install: adoptionRow.install } : null,
    createdAt: row.createdAt,
  };
}

/**
 * Build a replay corpus from already-shaped attempts (journal/store callers),
 * partitioning epochs by recorded adoptions exactly like the ledger path.
 */
export function corpusFromAttempts(attempts) {
  const sorted = [...attempts].sort((left, right) => left.seq - right.seq);
  const epochs = [];
  let current = { index: 0, attempts: [] };
  for (const attempt of sorted) {
    current.attempts.push(attempt);
    if (attempt.adoption) {
      epochs.push(current);
      current = { index: epochs.length, attempts: [] };
    }
  }
  if (current.attempts.length > 0) {
    current.index = epochs.length;
    epochs.push(current);
  }
  return {
    rows: [],
    attempts: sorted,
    epochs,
    adoptionCount: sorted.filter((attempt) => attempt.adoption).length,
    ledgerSha256: sha256Hex(sorted.map((attempt) => JSON.stringify(attempt)).join("\n")),
  };
}

/**
 * Load the recorded corpus: attempts in ledger order, partitioned into epochs by
 * adoption boundaries. Trailing attempts after the last adoption form the open
 * epoch (the pool can keep growing, M4).
 */
export function loadCorpus({ ledgerPath }) {
  const rows = readLedger(ledgerPath);
  const adoptionsByCycle = new Map();
  for (const row of rows) {
    if (row.kind === "adoption") adoptionsByCycle.set(row.cycleId, row);
  }
  const attempts = rows
    .filter((row) => row.kind === "cycle")
    .map((row) => buildAttempt(row, adoptionsByCycle.get(row.cycleId) ?? null));
  const corpus = corpusFromAttempts(attempts);
  corpus.rows = rows;
  return { ...corpus, ledgerSha256: sha256Hex(rows.map((row) => JSON.stringify(row)).join("\n")) };
}

function branchAttemptsBefore(corpus, attempt, history = []) {
  return [...history, ...corpus.attempts]
    .filter((other) => other.objective === attempt.objective && other.seq < attempt.seq)
    .sort((left, right) => left.seq - right.seq);
}

/**
 * Ex-ante feature view for one attempt. Everything here is knowable before the
 * attempt is played; sealed fields (verdict, delta, unplayed ordering) are not
 * included. `revealed` holds the seqs whose outcomes were already revealed;
 * `history` holds attempts recorded before the replayed slice — they happened
 * earlier, so they are prior knowledge (their branch entries count as
 * revealed by the caller pre-seeding `revealed`).
 */
export function exAnteFeatures({ corpus, attempt, revealed, history = [] }) {
  const branch = branchAttemptsBefore(corpus, attempt, history);
  return {
    objective: attempt.objective,
    gapId: attempt.objective,
    attemptIndexWithinBranch: branch.length,
    hypothesisNovelty: !branch.some((other) => other.hypothesisHash === attempt.hypothesisHash),
    files: [...attempt.files],
    hunks: attempt.hunks,
    priorRevealedOutcomes: branch.filter((other) => revealed.has(other.seq)).map((other) => other.decision),
    priorGuardFailureClasses: [...new Set(branch.flatMap((other) => other.guardFailures))].sort(),
    budgetRung: attempt.budgetRung,
  };
}

function revealedState({ corpus, revealed, attempt, history = [] }) {
  const branch = branchAttemptsBefore(corpus, attempt, history).filter((other) => revealed.has(other.seq));
  let consecutiveRejects = 0;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index].decision === "reject") consecutiveRejects += 1;
    else break;
  }
  return {
    revealedRejects: branch.filter((other) => other.decision === "reject").length,
    hasRevealedAdoption: branch.some((other) => other.decision === "adopt"),
    consecutiveRejects,
  };
}

function rotationFor({ corpus, adapter, rounds }) {
  const objectives = adapter?.objectives ?? [...new Set(corpus.attempts.map((attempt) => attempt.objective))];
  if (objectives.length === 0) return [];
  const offset = rounds % objectives.length;
  return [...objectives.slice(offset), ...objectives.slice(0, offset)];
}

function orderAvailable({ config, corpus, adapter, available, revealed, rounds, history = [] }) {
  const decorated = available.map((attempt, index) => ({
    attempt,
    index,
    features: exAnteFeatures({ corpus, attempt, revealed, history }),
    state: revealedState({ corpus, revealed, attempt, history }),
  }));
  const objectiveOrder = new Map((adapter?.objectives ?? []).map((objective, index) => [objective, index]));
  const objectiveIndex = (entry) => objectiveOrder.get(entry.attempt.objective) ?? Number.MAX_SAFE_INTEGER;
  const bySeq = (left, right) => left.attempt.seq - right.attempt.seq;
  const rotation = rotationFor({ corpus, adapter, rounds });
  const rotationIndex = (entry) => {
    const position = rotation.indexOf(entry.attempt.objective);
    return position === -1 ? Number.MAX_SAFE_INTEGER : position;
  };
  let ordered;
  switch (config.order) {
    case "round_robin":
      ordered = [...decorated].sort((left, right) => rotationIndex(left) - rotationIndex(right) || objectiveIndex(left) - objectiveIndex(right) || bySeq(left, right));
      break;
    case "success_greedy":
      ordered = [...decorated].sort(
        (left, right) =>
          Number(right.state.hasRevealedAdoption) - Number(left.state.hasRevealedAdoption) ||
          left.state.consecutiveRejects - right.state.consecutiveRejects ||
          objectiveIndex(left) - objectiveIndex(right) ||
          bySeq(left, right),
      );
      break;
    case "failure_greedy":
      ordered = [...decorated].sort(
        (left, right) =>
          right.state.revealedRejects - left.state.revealedRejects || objectiveIndex(left) - objectiveIndex(right) || bySeq(left, right),
      );
      break;
    case "novelty_first":
      ordered = [...decorated].sort(
        (left, right) =>
          Number(right.features.hypothesisNovelty) - Number(left.features.hypothesisNovelty) ||
          left.features.attemptIndexWithinBranch - right.features.attemptIndexWithinBranch ||
          bySeq(left, right),
      );
      break;
    default:
      ordered = [...decorated].sort(bySeq);
      break;
  }
  if (config.stallRedirect !== true) return ordered;
  // Switch rule: an objective with >= stallK consecutive revealed rejects is
  // pushed behind objectives that are not stalled, preserving the order above.
  return [...ordered].sort(
    (left, right) =>
      Number(left.state.consecutiveRejects >= config.stallK) - Number(right.state.consecutiveRejects >= config.stallK) ||
      ordered.indexOf(left) - ordered.indexOf(right),
  );
}

/**
 * Play one policy over the corpus. Returns the recorded metrics plus a per-world
 * breakdown; outcomes are revealed strictly after selection.
 */
export function scorePolicy({ corpus, policy, adapter, betas = DEFAULT_BETAS, history = [] }) {
  const config = { ...DEFAULT_POLICY_CONFIG, ...(policy?.config ?? {}) };
  if (!POLICY_ORDERS.includes(config.order)) throw new Error(`unknown_policy_order: ${config.order}`);
  if (!POLICY_STOP_RULES.includes(config.stopRule)) throw new Error(`unknown_stop_rule: ${config.stopRule}`);
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1) throw new Error("policy_batch_size_must_be_positive");
  // Attempts recorded before the replayed slice are prior knowledge.
  const revealed = new Set(history.map((attempt) => attempt.seq));
  const played = [];
  const worlds = [];
  let rounds = 0;
  let costMs = 0;
  let costMsToFirstAdoption = null;
  let attemptsToFirstAdoption = null;
  let stopped = false;
  for (const epoch of corpus.epochs) {
    const world = { epoch: epoch.index, attempts: epoch.attempts.length, played: [], attemptsToFirstAdoption: null, costMs: 0 };
    while (!stopped) {
      const available = epoch.attempts.filter((attempt) => !revealed.has(attempt.seq));
      if (available.length === 0) break;
      const ordered = orderAvailable({ config, corpus, adapter, available, revealed, rounds, history });
      const batch = ordered.slice(0, config.batchSize).map((entry) => entry.attempt);
      if (batch.length === 0) break;
      rounds += 1;
      for (const attempt of batch) {
        revealed.add(attempt.seq);
        played.push(attempt.seq);
        world.played.push(attempt.seq);
        const wallMs = typeof attempt.wallMs === "number" ? attempt.wallMs : 0;
        costMs += wallMs;
        world.costMs += wallMs;
        if (attempt.adoption && attemptsToFirstAdoption === null) {
          attemptsToFirstAdoption = played.length;
          costMsToFirstAdoption = costMs;
          world.attemptsToFirstAdoption = attemptsToFirstAdoption;
          stopped = config.stopRule === "first_adoption";
          break;
        }
      }
      if (attemptsToFirstAdoption !== null && config.stopRule === "first_adoption") break;
    }
    worlds.push(world);
    if (attemptsToFirstAdoption !== null && config.stopRule === "first_adoption") break;
  }
  const parallelism = played.length === 0 ? 0 : played.length / Math.max(1, rounds);
  const score = {
    schema: REPLAY_SCHEMA,
    policyId: policy?.id ?? "inline",
    config,
    played,
    rounds,
    attemptsPlayed: played.length,
    adoptionReached: attemptsToFirstAdoption !== null,
    attemptsToFirstAdoption,
    costMsToFirstAdoption,
    costMs,
    parallelism,
    worlds,
    historySeqs: history.map((attempt) => attempt.seq),
  };
  score.value = replayValue({ score, betas });
  score.scoreHash = sha256Hex(JSON.stringify(score));
  return score;
}

/**
 * Paper-shaped replay objective reported for reference: V = s - beta1*N +
 * beta2*N/max(1,k) with s = adoption reached, N = attempts played to the first
 * adoption (or all played attempts when none is reached), k = parallelism.
 * Ranking in `dream.mjs` uses the plan's primary metrics; V is reported.
 */
export function replayValue({ score, betas = DEFAULT_BETAS }) {
  const attempts = score.attemptsToFirstAdoption ?? score.attemptsPlayed;
  const parallelism = Math.max(1, score.parallelism);
  const raw = (score.adoptionReached ? 1 : 0) - betas.beta1 * attempts + betas.beta2 * (attempts / parallelism);
  return Number(raw.toFixed(6));
}

/** Evaluate a set of policies over the same recorded worlds (identical set). */
export function scorePolicies({ corpus, policies, adapter, betas = DEFAULT_BETAS }) {
  return policies.map((policy) => scorePolicy({ corpus, policy, adapter, betas }));
}

// ---- inlined from self-improve/lib/dream.mjs (Dream-RSI core, keyless plain ESM) ----
/**
 * Dreaming: deterministic candidate-policy generation and selection against the
 * replay simulator, plus the frozen P2 threshold evaluation.
 *
 * Determinism: candidate enumeration and every replay score are pure functions
 * of (corpus, config); the receipt carries no timestamps or randomness, so the
 * same seed yields a byte-identical receipt (AC §4.3). The seed is recorded and
 * namespaces candidate ids; it never influences ordering.
 *
 * Selection happens on the TRAIN split only (first `trainN` recorded attempts).
 * The validation split (last `validationN` attempts, which must contain >=1
 * adoption) is used only to evaluate the frozen thresholds — never to choose π*.
 */

export const DREAM_SCHEMA = "gjc.self-improve.dream.v1";
export const DEFAULT_MAX_CANDIDATES = 48;
export const INSUFFICIENT_EVIDENCE_VERDICT = "insufficient evidence at pass-gate size — thresholds not evaluated";
export const PINNED_CAVEAT =
  "All P2 comparisons are off-policy replays over ONE realized corpus of fewer than ~24 recorded attempts; no statistical significance is claimed; effect sizes are reported with n and are not confidence-interval estimates of future performance; the cost proxy is load-dependent recorded wallMs, not a fresh measurement.";
export const THRESHOLD_STATEMENTS = Object.freeze({
  validationAttempts: "pi* attempts-to-first-adoption <= min(B0, B1) - 1",
  validationCost: "pi* cost-to-first-adoption <= 0.7 x B0 cost-to-first-adoption",
  antiFluke: "full-corpus pi* cost-to-first-adoption <= B0 cost-to-first-adoption",
  determinism: "same seed => byte-identical receipt hash",
});

/**
 * Deterministic candidate enumeration (plan: <=48 candidates). The grid covers
 * every order rule, batch size 1-3 and both stall-switch settings with the
 * frozen first-adoption stop rule, plus the exhaustive stopping variants for
 * batch 1: 5 orders x (3 x 2 + 2) = 40 candidates by construction — never a
 * truncation, so no order rule can silently fall out of the space.
 */
export function enumerateCandidates({ maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
  const candidates = [];
  for (const order of POLICY_ORDERS) {
    for (const batchSize of [1, 2, 3]) {
      for (const stallRedirect of [false, true]) {
        candidates.push({ order, batchSize, stopRule: "first_adoption", stallRedirect, stallK: 3 });
      }
    }
    for (const stallRedirect of [false, true]) {
      candidates.push({ order, batchSize: 1, stopRule: "exhaustive", stallRedirect, stallK: 3 });
    }
  }
  return candidates.slice(0, maxCandidates);
}

export function candidatePolicies({ seed, maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
  return enumerateCandidates({ maxCandidates }).map((config, index) => ({
    id: `pi-${seed}-${String(index + 1).padStart(2, "0")}`,
    config,
  }));
}

/** Re-partition any attempt subset into epochs by its own adoption boundaries. */
export function sliceCorpus({ corpus, attempts }) {
  const seqs = new Set(attempts.map((attempt) => attempt.seq));
  const slice = { attempts: [], epochs: [], rows: corpus.rows, adoptionCount: 0, ledgerSha256: corpus.ledgerSha256 };
  let current = { index: 0, attempts: [] };
  for (const attempt of corpus.attempts) {
    if (!seqs.has(attempt.seq)) continue;
    slice.attempts.push(attempt);
    current.attempts.push(attempt);
    if (attempt.adoption) {
      slice.adoptionCount += 1;
      slice.epochs.push(current);
      current = { index: slice.epochs.length, attempts: [] };
    }
  }
  current.index = slice.epochs.length;
  slice.epochs.push(current);
  return slice;
}

export function splitCorpus({ corpus, trainN, validationN }) {
  const total = corpus.attempts.length;
  const train = sliceCorpus({ corpus, attempts: corpus.attempts.slice(0, trainN) });
  const validation = sliceCorpus({ corpus, attempts: corpus.attempts.slice(Math.max(0, total - validationN)) });
  return { train, validation, full: corpus };
}

export function summarizeScore(score) {
  return {
    policyId: score.policyId,
    attemptsToFirstAdoption: score.attemptsToFirstAdoption,
    costMsToFirstAdoption: score.costMsToFirstAdoption,
    adoptionReached: score.adoptionReached,
    attemptsPlayed: score.attemptsPlayed,
    costMs: score.costMs,
    rounds: score.rounds,
    parallelism: score.parallelism,
    value: score.value,
    scoreHash: score.scoreHash,
  };
}

const scoreSlice = ({ corpus, policy, adapter, betas, history }) => scorePolicy({ corpus, policy, adapter, betas, history });

const infinity = Number.POSITIVE_INFINITY;
const attemptsOf = (score) => (score.attemptsToFirstAdoption === null ? infinity : score.attemptsToFirstAdoption);
const costOf = (score) => (score.costMsToFirstAdoption === null ? infinity : score.costMsToFirstAdoption);

/** Plan ranking: adoption reached first, then attempts, then recorded cost, then enumeration index. */
export function rankResults(results) {
  return [...results].sort(
    (left, right) =>
      Number(right.score.adoptionReached) - Number(left.score.adoptionReached) ||
      attemptsOf(left.score) - attemptsOf(right.score) ||
      costOf(left.score) - costOf(right.score) ||
      left.index - right.index,
  );
}

/**
 * Dream over a recorded corpus. Returns the full receipt; when the pass gate is
 * not met (n < passGateN, validation < validationN, or a validation slice
 * without an adoption) the measured scores are still reported, but the verdict
 * is the frozen insufficient-evidence string and no thresholds are evaluated.
 */
export function runDream({
  corpus,
  adapter,
  seed = 1,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  passGateN = 20,
  trainN = 14,
  validationN = 6,
  betas = DEFAULT_BETAS,
}) {
  const total = corpus.attempts.length;
  const { train, validation, full } = splitCorpus({ corpus, trainN, validationN });
  // The validation slice is scored with the pre-slice attempts as ex-ante history
  // (they were recorded earlier and are therefore legitimately known), exactly
  // like the live loop knows the whole ledger when it authors the next request.
  const validationHistory = corpus.attempts.slice(0, Math.max(0, total - validation.attempts.length));
  const gate = {
    ok: total >= passGateN && validation.attempts.length >= validationN && validation.adoptionCount >= 1,
    total,
    passGateN,
    trainN: train.attempts.length,
    validationN: validation.attempts.length,
    validationAdoptions: validation.adoptionCount,
  };
  if (total < passGateN) gate.reason = "corpus_below_pass_gate";
  else if (validation.attempts.length < validationN) gate.reason = "validation_below_minimum";
  else if (validation.adoptionCount < 1) gate.reason = "validation_without_adoption";
  else gate.reason = null;

  const policies = candidatePolicies({ seed, maxCandidates });
  const evaluated = policies.map((policy, index) => {
    const trainScore = scoreSlice({ corpus: train, policy, adapter, betas, history: [] });
    const validationScore = scoreSlice({ corpus: validation, policy, adapter, betas, history: validationHistory });
    const fullScore = scoreSlice({ corpus: full, policy, adapter, betas, history: [] });
    return {
      index,
      id: policy.id,
      config: policy.config,
      score: trainScore,
      train: summarizeScore(trainScore),
      validation: summarizeScore(validationScore),
      full: summarizeScore(fullScore),
      fullScore,
      validationScore,
    };
  });
  const ranked = rankResults(evaluated);
  const selected = ranked[0];
  const baselineResults = Object.fromEntries(
    Object.entries(BASELINE_POLICIES).map(([key, policy]) => {
      const trainScore = scoreSlice({ corpus: train, policy, adapter, betas, history: [] });
      const validationScore = scoreSlice({ corpus: validation, policy, adapter, betas, history: validationHistory });
      const fullScore = scoreSlice({ corpus: full, policy, adapter, betas, history: [] });
      return [key, { train: summarizeScore(trainScore), validation: summarizeScore(validationScore), full: summarizeScore(fullScore), fullScore, validationScore }];
    }),
  );

  const thresholdEvaluation = evaluateThresholds({ selected, baselines: baselineResults });
  const validationNumbers = {
    attemptsPlayed: validation.attempts.length,
    adoptions: validation.adoptionCount,
    trainAttempts: train.attempts.length,
  };
  const thresholds = gate.ok
    ? { evaluated: true, reason: null, ...thresholdEvaluation, statements: THRESHOLD_STATEMENTS, validationNumbers }
    : {
        evaluated: false,
        reason: gate.reason,
        advisory: thresholdEvaluation,
        statements: THRESHOLD_STATEMENTS,
        validationNumbers,
        passGateSituation: `attempts (${total}) < passGateN (${passGateN})`,
        downgradeNote:
          "plan 4.3 / M3 brief: a corpus in [12,19] attempts yields the frozen insufficient-evidence verdict with the downgrade recorded explicitly - no silent downgrade, no threshold relaxation",
      };
  const verdict = gate.ok
    ? thresholdEvaluation.attemptsOk && thresholdEvaluation.costOk && thresholdEvaluation.antiFlukeOk
      ? "met"
      : "unmet"
    : INSUFFICIENT_EVIDENCE_VERDICT;
  const receipt = {
    schema: DREAM_SCHEMA,
    seed,
    betas,
    corpus: {
      ledgerSha256: corpus.ledgerSha256,
      attempts: total,
      adoptions: corpus.adoptionCount,
      epochs: corpus.epochs.length,
      trainN: train.attempts.length,
      validationN: validation.attempts.length,
    },
    candidateCount: policies.length,
    candidates: evaluated.map((entry) => ({ id: entry.id, config: entry.config, train: entry.train, validation: entry.validation, full: entry.full })),
    rankings: ranked.map((entry) => entry.id),
    selected: { id: selected.id, config: selected.config },
    baselines: { B0: { train: baselineResults.B0.train, validation: baselineResults.B0.validation, full: baselineResults.B0.full }, B1: { train: baselineResults.B1.train, validation: baselineResults.B1.validation, full: baselineResults.B1.full } },
    thresholds,
    gate,
    calibration: [
      {
        policyId: selected.id,
        predicted: { attemptsToFirstAdoption: selected.train.attemptsToFirstAdoption, costMsToFirstAdoption: selected.train.costMsToFirstAdoption },
        realized: { attemptsToFirstAdoption: selected.validation.attemptsToFirstAdoption, costMsToFirstAdoption: selected.validation.costMsToFirstAdoption },
      },
      ...Object.entries(baselineResults).map(([key, entry]) => ({
        policyId: key,
        predicted: { attemptsToFirstAdoption: entry.train.attemptsToFirstAdoption, costMsToFirstAdoption: entry.train.costMsToFirstAdoption },
        realized: { attemptsToFirstAdoption: entry.validation.attemptsToFirstAdoption, costMsToFirstAdoption: entry.validation.costMsToFirstAdoption },
      })),
    ],
    caveat: PINNED_CAVEAT,
    verdict,
  };
  receipt.receiptHash = sha256Hex(JSON.stringify(receipt));
  return receipt;
}

function evaluateThresholds({ selected, baselines }) {
  const b0 = baselines.B0.validationScore;
  const b1 = baselines.B1.validationScore;
  const pi = selected.validationScore;
  const b0Full = baselines.B0.fullScore;
  const targetAttempts = Math.min(attemptsOf(b0), attemptsOf(b1)) - 1;
  const attemptsOk = attemptsOf(pi) <= targetAttempts;
  const costOk = costOf(pi) <= 0.7 * costOf(b0);
  const antiFlukeOk = costOf(selected.fullScore) <= costOf(b0Full);
  return {
    attemptsOk,
    costOk,
    antiFlukeOk,
    determinismOk: true,
    targets: {
      maxAttempts: Number.isFinite(targetAttempts) ? targetAttempts : null,
      maxCostMs: Number.isFinite(costOf(b0)) ? 0.7 * costOf(b0) : null,
    },
    measured: {
      pi: { attemptsToFirstAdoption: pi.attemptsToFirstAdoption, costMsToFirstAdoption: pi.costMsToFirstAdoption },
      B0: { attemptsToFirstAdoption: b0.attemptsToFirstAdoption, costMsToFirstAdoption: b0.costMsToFirstAdoption },
      B1: { attemptsToFirstAdoption: b1.attemptsToFirstAdoption, costMsToFirstAdoption: b1.costMsToFirstAdoption },
    },
  };
}

// ---- inlined from self-improve/lib/policy.mjs (Dream-RSI core, keyless plain ESM) ----
/**
 * Policy artifact model and deploy bookkeeping.
 *
 * A policy is a committed artifact (`self-improve/policies/<id>.json`) plus a
 * `current.json` pointer, and every deploy records a `kind:"policy"` ledger row
 * (<=2 KiB) so the chain carries the selection decision. Rendering is pure;
 * `applyPolicyDeploy` performs the writes and the single ledger append.
 */
import * as fs from "node:fs";
import path from "node:path";

export const POLICY_SCHEMA = "gjc.self-improve.policy.v1";
export const DEFAULT_POLICY_DIR = path.join("self-improve", "policies");

export function validatePolicyShape(policy) {
  const errors = [];
  if (!isPlainObject(policy)) return { ok: false, errors: ["policy must be an object"] };
  if (policy.schema !== POLICY_SCHEMA) errors.push(`policy.schema must be ${POLICY_SCHEMA}`);
  if (typeof policy.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(policy.id)) {
    errors.push("policy.id must be a lowercase slug (3-64 chars)");
  }
  if (!Number.isInteger(policy.seed)) errors.push("policy.seed must be an integer");
  if (!isPlainObject(policy.config)) errors.push("policy.config must be an object");
  else {
    if (!POLICY_ORDERS.includes(policy.config.order)) errors.push(`policy.config.order must be one of ${POLICY_ORDERS.join("|")}`);
    if (!POLICY_STOP_RULES.includes(policy.config.stopRule)) {
      errors.push(`policy.config.stopRule must be one of ${POLICY_STOP_RULES.join("|")}`);
    }
    if (!Number.isInteger(policy.config.batchSize) || policy.config.batchSize < 1) {
      errors.push("policy.config.batchSize must be a positive integer");
    }
    if (typeof policy.config.stallRedirect !== "boolean") errors.push("policy.config.stallRedirect must be boolean");
    if (!Number.isInteger(policy.config.stallK) || policy.config.stallK < 1) errors.push("policy.config.stallK must be a positive integer");
  }
  if (typeof policy.createdAt !== "string" || policy.createdAt.length === 0) errors.push("policy.createdAt required");
  return { ok: errors.length === 0, errors };
}

export function policyArtifactPath({ policyDir = DEFAULT_POLICY_DIR, id }) {
  return path.join(policyDir, `${id}.json`);
}

export function policyCurrentPath({ policyDir = DEFAULT_POLICY_DIR }) {
  return path.join(policyDir, "current.json");
}

export function buildPolicyArtifact({ id, seed, config, createdAt, source = null }) {
  return {
    schema: POLICY_SCHEMA,
    id,
    seed,
    config: { ...config },
    ...(source ? { source } : {}),
    createdAt,
  };
}

export function readPolicyArtifact(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const policy = JSON.parse(raw);
  const validation = validatePolicyShape(policy);
  if (!validation.ok) throw new Error(`invalid_policy_artifact: ${validation.errors.join("; ")}`);
  return { policy, sha256: sha256Hex(raw), text: raw };
}

export function listPolicyArtifacts({ policyDir = DEFAULT_POLICY_DIR } = {}) {
  if (!fs.existsSync(policyDir)) return [];
  return fs
    .readdirSync(policyDir)
    .filter((name) => name.endsWith(".json") && name !== "current.json")
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

export function readCurrentPolicy({ policyDir = DEFAULT_POLICY_DIR } = {}) {
  const filePath = policyCurrentPath({ policyDir });
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function buildPolicyRow({ policy, decision, artifactPath, artifactText, createdAt }) {
  return {
    kind: "policy",
    policyId: policy.id,
    decision,
    seed: policy.seed,
    configHash: sha256Hex(JSON.stringify(policy.config)),
    artifact: { path: artifactPath, sha256: sha256Hex(artifactText) },
    createdAt,
  };
}

/**
 * Pure deploy plan: artifact text, current pointer text, the ledger row and the
 * conventional commit message. No writes happen here.
 */
export function planPolicyDeploy({ policyDir = DEFAULT_POLICY_DIR, policy, decision = "deploy", createdAt }) {
  const validation = validatePolicyShape(policy);
  if (!validation.ok) throw new Error(`invalid_policy: ${validation.errors.join("; ")}`);
  if (!POLICY_DECISIONS.includes(decision)) throw new Error(`unknown_policy_decision: ${decision}`);
  const artifactPath = policyArtifactPath({ policyDir, id: policy.id });
  const artifactText = `${JSON.stringify(policy, null, 2)}\n`;
  const currentPath = policyCurrentPath({ policyDir });
  const currentText = `${JSON.stringify({ id: policy.id, file: path.basename(artifactPath), sha256: sha256Hex(artifactText), decision }, null, 2)}\n`;
  const row = buildPolicyRow({ policy, decision, artifactPath, artifactText, createdAt });
  return {
    artifactPath,
    artifactText,
    currentPath,
    currentText,
    row,
    commitMessage: `chore(self-improve): policy ${policy.id} ${decision}`,
  };
}

/** Apply a deploy plan: write both artifacts, then append exactly one policy row. */
export function applyPolicyDeploy({ plan, ledgerPath }) {
  fs.mkdirSync(path.dirname(plan.artifactPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(plan.artifactPath, plan.artifactText);
  fs.mkdirSync(path.dirname(plan.currentPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(plan.currentPath, plan.currentText);
  const receipt = appendRow(ledgerPath, plan.row);
  return { artifactPath: plan.artifactPath, currentPath: plan.currentPath, rowSeq: receipt.seq, commitMessage: plan.commitMessage };
}

/**
 * rrsi plugin core: a bounded, private exploration-episode store, read-only
 * projections of the jev-advisor journal and this repository's self-improve
 * ledger, and dreaming over the store through the bundled Dream-RSI core
 * (inlined at build time from self-improve/lib/{types,ledger,replay,dream,policy}.mjs).
 *
 * Scope: functional acceptance only. The performance proof (P1-P3) applies to
 * the self-improve loop and its frozen corpus, not to this plugin; no accuracy,
 * savings or routing claim is made here.
 *
 * Keyless and offline: no network, no credentials, no timer process. The
 * only automatic invocation is the due-gated `session_start` refresh in
 * `lib/periodic.ts`. The store lives at `~/.gjc-plugin/rrsi/store.json`
 * (0700 dir, 0600 file) and is never committed.
 */
import os from "node:os";

export const RRSI_STORE_SCHEMA = "gjc.rrsi.store.v1";

export const RRSI_SCOPE_SENTENCE =
  "Functional acceptance only: rrsi captures exploration episodes, projects journals into attempt records and replays them through the bundled Dream-RSI core. The performance proof (P1-P3) applies to the self-improve loop and its frozen corpus, not to this plugin; no accuracy, savings or routing claim is made.";

export const RRSI_LIMITS = Object.freeze({
  maxEpisodes: 128,
  maxAttemptsPerEpisode: 40,
  maxStoreBytes: 512 * 1024,
  maxJournalSegments: 8,
  maxJournalRecordsPerSegment: 4096,
  maxLedgerRows: 4096,
  maxReadBytes: 4 * 1024 * 1024,
  maxTextChars: 280,
  maxIdChars: 64,
});

const RRSI_ACTIONS = ["capture", "import", "dream", "status"];
const RRSI_DECISIONS = ["adopt", "reject", "inconclusive"];
const RRSI_SOURCES = ["capture", "jev-journal", "self-improve-ledger"];

export function rrsiRoot(env = process.env) {
  const home = (env && env.HOME) || os.homedir();
  return path.join(home, ".gjc-plugin", "rrsi");
}

export function rrsiStorePath(env = process.env) {
  return path.join(rrsiRoot(env), "store.json");
}

export function rrsiJournalDir(env = process.env) {
  return path.join(rrsiRoot(env), "..", "jev-advisor", "journal", "v1");
}

// Shared store-lock bounds: stale takeover after 2 × the 12 s periodic inline
// budget so a crashed writer cannot hold the lock forever; the contended wait
// is bounded at 100 ms (bounded result, no throw).
export const RRSI_STORE_LOCK_STALE_MS = 24_000;
export const RRSI_STORE_LOCK_WAIT_MS = 100;

/**
 * Walk the private directory chain from the `.gjc-plugin` boundary down to
 * `target`: every existing component must be a real, owned 0700 directory (no
 * symlinks); missing components are created with 0700 when `create` is true.
 * Returns false at the first unsafe component — callers translate that into a
 * bounded `unsafe_path` result and never write through a symlinked root.
 */
export function privateDirSafe(target, { create = false } = {}) {
  if (typeof target !== "string" || target.length === 0) return false;
  const absolute = path.resolve(target);
  const marker = `${path.sep}.gjc-plugin`;
  const boundary = absolute.indexOf(marker);
  if (boundary < 0) return false;
  const root = absolute.slice(0, boundary + marker.length);
  const rest = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of [null, ...rest]) {
    if (part !== null) current = path.join(current, part);
    let info;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if (!error || error.code !== "ENOENT" || !create) return false;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch {
        return false;
      }
      try {
        info = fs.lstatSync(current);
      } catch {
        return false;
      }
    }
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700) return false;
  }
  return true;
}

function projectionDigestHex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function boundedText(value, max = RRSI_LIMITS.maxTextChars) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedInteger(value, max = Number.MAX_SAFE_INTEGER, fallback = 0) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
}

export function emptyStore(now = new Date().toISOString()) {
  return { schema: RRSI_STORE_SCHEMA, updatedAt: now, episodes: [] };
}

/** Flatten one exploration attempt into the bounded core-shaped record. */
export function normalizeAttempt(raw, index) {
  const objective = boundedText(raw?.objective ?? raw?.goal ?? "unlabeled", 120) || "unlabeled";
  const decision = RRSI_DECISIONS.includes(raw?.decision) ? raw.decision : "inconclusive";
  const guardFailures = Array.isArray(raw?.guardFailures)
    ? raw.guardFailures.filter((value) => typeof value === "string" && value.length > 0).slice(0, 16).map((value) => value.slice(0, 40))
    : [];
  return {
    index: boundedInteger(index, RRSI_LIMITS.maxAttemptsPerEpisode),
    objective,
    hypothesisNovelty: raw?.hypothesisNovelty !== false,
    decision,
    wallMs: boundedInteger(raw?.wallMs, 86_400_000),
    guardFailures,
    budgetRung: boundedInteger(raw?.budgetRung, 16),
    files: boundedInteger(raw?.files, 512),
    hunks: boundedInteger(raw?.hunks, 4096),
    ...(typeof raw?.provenance === "string" && raw.provenance.length > 0
      ? { provenance: raw.provenance.slice(0, RRSI_LIMITS.maxIdChars) }
      : {}),
  };
}

export function normalizeEpisode(raw, now = new Date().toISOString()) {
  const source = RRSI_SOURCES.includes(raw?.source) ? raw.source : "capture";
  const attempts = Array.isArray(raw?.attempts)
    ? raw.attempts.slice(0, RRSI_LIMITS.maxAttemptsPerEpisode).map((attempt, index) => normalizeAttempt(attempt, index))
    : [];
  const goal = boundedText(raw?.goal, 200) || `episode ${now}`;
  return {
    id: `ep-${sha256Hex(`${source}|${goal}|${now}|${attempts.length}`).slice(0, 12)}`,
    source,
    goal,
    createdAt: boundedText(raw?.createdAt, 32) || now,
    attempts,
  };
}

export function storeCounts(store) {
  const episodes = Array.isArray(store?.episodes) ? store.episodes : [];
  const attempts = episodes.flatMap((episode) => episode.attempts ?? []);
  return {
    episodes: episodes.length,
    attempts: attempts.length,
    adoptions: attempts.filter((attempt) => attempt.decision === "adopt").length,
  };
}

export function captureEpisode({ store, goal, attempts, now }) {
  const base = store && store.schema === RRSI_STORE_SCHEMA ? store : emptyStore(now);
  const episode = normalizeEpisode({ source: "capture", goal, attempts }, now);
  const episodes = [...base.episodes, episode].slice(-RRSI_LIMITS.maxEpisodes);
  return { store: { schema: RRSI_STORE_SCHEMA, updatedAt: now, episodes }, episode };
}

/** Read the private store: absent/invalid/unavailable are reported, never repaired. */
export function readStore(env = process.env) {
  const file = rrsiStorePath(env);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return error && error.code === "ENOENT" ? { status: "missing", store: emptyStore(), reason: null } : { status: "unavailable", store: emptyStore(), reason: "io_error" };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RRSI_LIMITS.maxStoreBytes) {
    return { status: "invalid", store: emptyStore(), reason: stat.size > RRSI_LIMITS.maxStoreBytes ? "oversized" : "unsafe_path" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.schema !== RRSI_STORE_SCHEMA || !Array.isArray(parsed.episodes)) {
      return { status: "invalid", store: emptyStore(), reason: "corrupt" };
    }
    return { status: "ok", store: { schema: RRSI_STORE_SCHEMA, updatedAt: boundedText(parsed.updatedAt, 32), episodes: parsed.episodes.slice(-RRSI_LIMITS.maxEpisodes) }, reason: null };
  } catch {
    return { status: "invalid", store: emptyStore(), reason: "corrupt" };
  }
}

/** Write the store atomically (temp file + rename), 0700 dir / 0600 file, bounded. */
export function writeStore({ store, env = process.env }) {
  const body = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > RRSI_LIMITS.maxStoreBytes) return { persisted: false, reason: "resource_limit" };
  const root = rrsiRoot(env);
  if (!privateDirSafe(root, { create: true })) return { persisted: false, reason: "unsafe_path" };
  const file = rrsiStorePath(env);
  const temp = `${file}.tmp`;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, body, { mode: 0o600 });
    fs.renameSync(temp, file);
    return { persisted: true, reason: "stored", bytes: Buffer.byteLength(body, "utf8") };
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    return { persisted: false, reason: "store_unavailable" };
  }
}

/**
 * Read-only projection of the jev-advisor journal segments. Records are read in
 * segment order and never modified; the caller decides what to persist.
 */
export function readJournalRecords({ journalDir, maxSegments = RRSI_LIMITS.maxJournalSegments } = {}) {
  const dir = journalDir ?? rrsiJournalDir();
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return { status: "missing", records: [], segments: 0, reason: "no_journal" };
  }
  const segments = names.slice(-maxSegments);
  const records = [];
  for (const name of segments) {
    let text;
    try {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RRSI_LIMITS.maxReadBytes) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let count = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      count += 1;
      if (count > RRSI_LIMITS.maxJournalRecordsPerSegment) break;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* a malformed line is skipped, never repaired */
      }
    }
  }
  return { status: records.length > 0 ? "ok" : "missing", records, segments: segments.length, reason: records.length > 0 ? null : "no_records" };
}

/**
 * Journal record -> attempt projection (bounded, flattened for the replay core):
 *   branch objective = "<operation>:<tier|advice-status>"
 *   hypothesisNovelty = first record of that branch in the read order
 *   priorFailures = count of earlier records of that branch whose advice was not a decision
 *   decision = "adopt" when the record carries a decision else "reject"
 *   wallMs = durationMs; provenance = the journal record id
 */
export function projectJournalRecords(records, { limit = 4000 } = {}) {
  const seen = new Map();
  const attempts = [];
  for (const record of records) {
    if (attempts.length >= limit) break;
    if (!record || typeof record !== "object") continue;
    const operation = boundedText(record.operation, 40) || "unknown";
    const status = boundedText(record.advice?.status ?? record.assessment?.status ?? "unknown", 40) || "unknown";
    const tier = boundedText(record.advice?.tier, 16) || status;
    const objective = `${operation}:${tier}`;
    const branch = seen.get(objective) ?? { records: 0, failures: 0 };
    attempts.push(
      normalizeAttempt(
        {
          objective,
          hypothesisNovelty: branch.records === 0,
          decision: record.advice?.status === "decision" ? "adopt" : "reject",
          wallMs: boundedInteger(record.durationMs, 86_400_000),
          guardFailures: [],
          budgetRung: 0,
          files: 0,
          hunks: 0,
          provenance: boundedText(record.id, RRSI_LIMITS.maxIdChars),
        },
        attempts.length,
      ),
    );
    seen.set(objective, { records: branch.records + 1, failures: branch.failures + (record.advice?.status === "decision" ? 0 : 1) });
  }
  return { attempts, branches: seen.size };
}

/** Ledger cycle rows -> attempts (read-only summary of the repo search history). */
export function projectLedgerRows(rows, { limit = 4000 } = {}) {
  const attempts = [];
  for (const row of rows) {
    if (attempts.length >= limit) break;
    if (!row || row.kind !== "cycle") continue;
    attempts.push(
      normalizeAttempt(
        {
          objective: boundedText(row.objective, 120) || "unlabeled",
          hypothesisNovelty: true,
          decision: row.verdict?.decision === "adopt" ? "adopt" : row.verdict?.decision === "reject" ? "reject" : "inconclusive",
          wallMs: boundedInteger(row.cost?.wallMs, 86_400_000),
          guardFailures: Array.isArray(row.guards) ? row.guards.filter((guard) => guard.status !== "pass").map((guard) => guard.id) : [],
          budgetRung: boundedInteger(row.budgetRung, 16),
          files: Array.isArray(row.proposal?.files) ? row.proposal.files.length : 0,
          hunks: boundedInteger(row.proposal?.hunks, 4096),
          provenance: boundedText(row.cycleId, RRSI_LIMITS.maxIdChars),
        },
        attempts.length,
      ),
    );
  }
  return { attempts };
}

export function readLedgerRows({ ledgerPath } = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return { status: "missing", rows: [], reason: "no_ledger" };
  try {
    const stat = fs.lstatSync(ledgerPath);
    if (!stat.isFile() || stat.size > RRSI_LIMITS.maxReadBytes) return { status: "invalid", rows: [], reason: "unsafe_or_oversized" };
    const rows = [];
    for (const line of fs.readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      if (rows.length >= RRSI_LIMITS.maxLedgerRows) break;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip malformed rows, never repair */
      }
    }
    return { status: "ok", rows, reason: null };
  } catch {
    return { status: "missing", rows: [], reason: "no_ledger" };
  }
}

/** Merge imported episodes into the store (bounded, newest-last). */
export function mergeEpisodes({ store, episodes, now }) {
  const base = store && store.schema === RRSI_STORE_SCHEMA ? store : emptyStore(now);
  const merged = [...base.episodes, ...episodes].slice(-RRSI_LIMITS.maxEpisodes);
  return { schema: RRSI_STORE_SCHEMA, updatedAt: now, episodes: merged };
}

/** Content-keyed digest of one bounded projection (read order + applied limit). */
export function projectionDigestFor(attempts, limit) {
  const bounded = Array.isArray(attempts) ? attempts.slice(0, 4000) : [];
  return projectionDigestHex(JSON.stringify({ limit, attempts: bounded }));
}

/**
 * Chunked derived episode set for one source class (no clock value enters any
 * episode, so identical content yields a byte-identical set). Ids:
 * `ep-jev-<digest12>-<n>` for `jev-journal`, `ep-ledger-<digest12>-<n>` for
 * the self-improve ledger.
 */
export function derivedEpisodeSetFor({ digest, attempts, source = "jev-journal", maxPerEpisode = RRSI_LIMITS.maxAttemptsPerEpisode, goalPrefix = "periodic projection" }) {
  const digest12 = String(digest ?? "").slice(0, 12);
  const idPrefix = source === "self-improve-ledger" ? "ep-ledger" : "ep-jev";
  const input = Array.isArray(attempts) ? attempts : [];
  const episodes = [];
  for (let k = 0, n = 0; k < input.length; k += maxPerEpisode, n += 1) {
    const chunk = input.slice(k, k + maxPerEpisode).map((attempt, index) => normalizeAttempt(attempt, index));
    episodes.push({
      id: `${idPrefix}-${digest12}-${n}`,
      source,
      goal: boundedText(`${goalPrefix} ${digest12} chunk ${n}`, 200),
      createdAt: `derived:${digest12}`,
      attempts: chunk,
    });
  }
  return { episodes, digest12 };
}

/**
 * One slot per source class: replace the whole derived set for `sourceClass`
 * (never accumulate), or skip the write entirely when the existing set for
 * that class is byte-identical to the newly derived set. User `capture`
 * episodes are never selected by the filter. Returns a bounded result; never
 * throws.
 */
export function replaceDerivedSet({ store, sourceClass, derivedSet }) {
  const base = store && store.schema === RRSI_STORE_SCHEMA ? store : emptyStore();
  const set = Array.isArray(derivedSet) ? derivedSet : [];
  const prior = base.episodes.filter((episode) => episode && episode.source === sourceClass);
  const identical = prior.length === set.length && prior.every((episode, index) => JSON.stringify(episode) === JSON.stringify(set[index]));
  const priorAttempts = prior.reduce((sum, episode) => sum + (Array.isArray(episode.attempts) ? episode.attempts.length : 0), 0);
  const nextAttempts = set.reduce((sum, episode) => sum + (Array.isArray(episode.attempts) ? episode.attempts.length : 0), 0);
  if (identical) {
    return { store: base, storeWrite: "unchanged", episodesDelta: 0, attemptsDelta: 0 };
  }
  const episodes = [...base.episodes.filter((episode) => episode && episode.source !== sourceClass), ...set].slice(-RRSI_LIMITS.maxEpisodes);
  return {
    store: { schema: RRSI_STORE_SCHEMA, updatedAt: base.updatedAt, episodes },
    storeWrite: prior.length === 0 ? "added" : "replaced",
    episodesDelta: episodes.length - base.episodes.length,
    attemptsDelta: nextAttempts - priorAttempts,
  };
}

/**
 * Exclusive plugin-local store lock used by `capture`, `import` and the
 * periodic writer to serialize their read-modify-write sequences (not a
 * cross-process guarantee for foreign writers). Bounded 100 ms wait; stale
 * takeover by age; released in `finally`. Contended wait returns
 * `{ ok:false, reason:"store_busy" }` — no throw, no retry, no partial write.
 */
export function withStoreLock(env, fn) {
  const root = rrsiRoot(env);
  if (!privateDirSafe(root, { create: true })) return { ok: false, reason: "unsafe_path" };
  const file = path.join(root, "store.lock");
  const deadline = Date.now() + RRSI_STORE_LOCK_WAIT_MS;
  const tryAcquire = () => {
    try {
      fs.mkdirSync(rrsiRoot(env), { recursive: true, mode: 0o700 });
    } catch {
      /* reported by the write path */
    }
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error && error.code !== "EEXIST") return false;
      try {
        const stat = fs.lstatSync(file);
        if (Date.now() - stat.mtimeMs > RRSI_STORE_LOCK_STALE_MS) {
          fs.unlinkSync(file);
          return tryAcquire();
        }
      } catch {
        /* raced */
      }
      return false;
    }
  };
  while (Date.now() < deadline) {
    if (tryAcquire()) {
      try {
        return { ok: true, result: fn() };
      } finally {
        try {
          fs.unlinkSync(file);
        } catch {
          /* best effort */
        }
      }
    }
    const until = Date.now() + 10;
    while (Date.now() < until) {
      /* bounded wait */
    }
  }
  return { ok: false, reason: "store_busy" };
}

/** Store attempts -> the replay corpus (epochs partition at adopted attempts). */
export function corpusFromStore(store) {
  const attempts = [];
  for (const episode of store?.episodes ?? []) {
    for (const attempt of episode.attempts ?? []) {
      const seq = attempts.length + 1;
      const novelty = attempt.hypothesisNovelty !== false;
      attempts.push({
        seq,
        cycleId: `${episode.id}-${attempt.index}`,
        objective: attempt.objective,
        hypothesisHash: sha256Hex(novelty ? `novel|${episode.id}|${attempt.index}` : `shared|${attempt.objective}`),
        baseCommit: null,
        budgetRung: attempt.budgetRung ?? 0,
        files: [],
        hunks: attempt.hunks ?? 0,
        wallMs: attempt.wallMs ?? null,
        guardFailures: attempt.guardFailures ?? [],
        decision: attempt.decision ?? "inconclusive",
        delta: null,
        adoption: attempt.decision === "adopt" ? { commit: episode.id.slice(0, 7), install: "not_attempted" } : null,
        createdAt: episode.createdAt,
      });
    }
  }
  return corpusFromAttempts(attempts);
}

/**
 * Dream over the store with the bundled core. The synthetic adapter keeps the
 * store's branch order as the policy objective order (documented; the store is
 * not a domain adapter).
 */
export function dreamOverStore({ store, seed = 1, maxCandidates = 48, passGateN = 20, trainN = 14, validationN = 6 }) {
  const corpus = corpusFromStore(store);
  const objectives = [...new Set(corpus.attempts.map((attempt) => attempt.objective))];
  const receipt = runDream({
    corpus,
    adapter: { objectives },
    seed,
    maxCandidates,
    passGateN,
    trainN,
    validationN,
  });
  return { corpus, receipt };
}

/** Bounded tool-facing summary of a dream receipt (the full receipt stays in memory). */
export function summarizeReceipt(receipt) {
  return {
    schema: receipt.schema,
    seed: receipt.seed,
    corpus: receipt.corpus,
    candidateCount: receipt.candidateCount,
    selected: receipt.selected,
    baselines: {
      B0: receipt.baselines.B0.validation,
      B1: receipt.baselines.B1.validation,
    },
    thresholds: {
      evaluated: receipt.thresholds.evaluated,
      reason: receipt.thresholds.reason ?? null,
      ...(receipt.thresholds.evaluated
        ? { attemptsOk: receipt.thresholds.attemptsOk, costOk: receipt.thresholds.costOk, antiFlukeOk: receipt.thresholds.antiFlukeOk }
        : { advisory: receipt.thresholds.advisory ? { attemptsOk: receipt.thresholds.advisory.attemptsOk, costOk: receipt.thresholds.advisory.costOk } : null, downgradeNote: receipt.thresholds.downgradeNote ?? null }),
    },
    gate: receipt.gate,
    verdict: receipt.verdict,
    caveat: receipt.caveat,
    receiptHash: receipt.receiptHash,
    ranking: receipt.rankings.slice(0, 8),
  };
}

export const RRSI_ACTION_LIST = Object.freeze([...RRSI_ACTIONS]);

/**
 * rrsi periodic runner: a due-gated, bounded session-start refresh of the
 * exploration store. NO timer process: the only trigger is the plugin's
 * `session_start` hook (src/periodic.adapter.ts), which awaits one bounded
 * inline attempt; large corpora are completed by a detached worker that
 * executes this same module through the generated hook file
 * (`RRSI_PERIODIC_WORKER=1 bun <plugin>/hooks/rrsi-periodic.ts`).
 *
 * Scope: functional acceptance only (see RRSI_SCOPE_SENTENCE); no accuracy,
 * savings or routing claim. Keyless and offline: no network, no credentials,
 * no model calls. Every failure path is a bounded result — this module never
 * throws. The store and its lock are shared with capture/import through
 * `withStoreLock`; the periodic lock is this module's own.
 *
 * Measured basis (M0, 2026-10-15): dream replay cost is super-linear in corpus
 * size (40 attempts ≈ 59 ms; 160 ≈ 0.8 s; 480 ≈ 18.6 s), so the inline fast
 * path dreams only when the corpus is at or below INLINE_DREAM_MAX_ATTEMPTS;
 * larger corpora take the detached-worker path (plan A1b fallback).
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

export const RRSI_PERIODIC_SCHEMA = "gjc.rrsi.periodic.v1";
export const RRSI_PERIODIC_RECEIPT_SCHEMA = "gjc.rrsi.periodic.run.v1";

export const RRSI_PERIODIC_DEFAULTS = Object.freeze({
  intervalMs: 24 * 60 * 60 * 1000,
  minRetryMs: 15 * 60 * 1000,
  maxWallMs: 12_000,
  inlineDreamMaxAttempts: 160,
  projectionLimit: 40,
  receiptMaxCount: 60,
  receiptMaxBytes: 64 * 1024,
  clockSkewMaxMs: 5 * 60 * 1000,
});

function bounded(value, max = 200) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function rrsiPeriodicStatePath(env = process.env) {
  return path.join(rrsiRoot(env), "periodic.json");
}

export function rrsiPeriodicLockPath(env = process.env) {
  return path.join(rrsiRoot(env), "periodic.lock");
}

export function rrsiReceiptsDir(env = process.env) {
  return path.join(rrsiRoot(env), "runs", "v1");
}

export function resolveIntervalMs(env = process.env) {
  const raw = env && env.RRSI_PERIODIC_INTERVAL_MS;
  const parsed = typeof raw === "string" && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 60_000) return RRSI_PERIODIC_DEFAULTS.intervalMs;
  return Math.min(parsed, 30 * 24 * 60 * 60 * 1000);
}

/** Read the periodic state: absent/invalid/unavailable reported, never repaired. */
export function readPeriodicState(env = process.env) {
  const file = rrsiPeriodicStatePath(env);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return { status: "invalid", state: null, reason: "unsafe_or_oversized" };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.schema !== RRSI_PERIODIC_SCHEMA) return { status: "invalid", state: null, reason: "corrupt" };
    return { status: "ok", state: parsed, reason: null };
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "missing", state: null, reason: null };
    return { status: "unavailable", state: null, reason: "io_error" };
  }
}

export function writePeriodicState({ state, env = process.env }) {
  const file = rrsiPeriodicStatePath(env);
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const root = rrsiRoot(env);
  if (!privateDirSafe(root, { create: true })) return { persisted: false, reason: "unsafe_path" };
  const temp = path.join(root, `.periodic.json.tmp-${process.pid}`);
  try {
    fs.mkdirSync(rrsiRoot(env), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, body, { mode: 0o600 });
    fs.renameSync(temp, file);
    return { persisted: true, reason: "stored" };
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    return { persisted: false, reason: "state_unavailable" };
  }
}

/**
 * Pure due decision. Returns { due, status, clockSkew } where status is the
 * taxonomy value when not due. `skipped_locked` is decided by the caller.
 */
export function dueForRun({ state, now, env = process.env }) {
  if (env && env.RRSI_PERIODIC === "off") return { due: false, status: "skipped_disabled", clockSkew: false };
  const intervalMs = resolveIntervalMs(env);
  const nowMs = Date.parse(now);
  let clockSkew = false;
  const readStamp = (value) => {
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms)) return null;
    if (ms > nowMs + RRSI_PERIODIC_DEFAULTS.clockSkewMaxMs) {
      clockSkew = true;
      return nowMs;
    }
    return ms;
  };
  const lastAttempt = state ? readStamp(state.lastAttemptAt) : null;
  if (state && state.nextRetryAt) {
    const retry = readStamp(state.nextRetryAt);
    if (retry !== null && nowMs < retry) return { due: false, status: "skipped_due", clockSkew, reason: "backoff", intervalMs };
  }
  if (lastAttempt !== null && nowMs - lastAttempt < intervalMs) {
    return { due: false, status: "skipped_due", clockSkew, intervalMs };
  }
  return { due: true, status: null, clockSkew, intervalMs };
}

/**
 * Acquire the periodic lock (0600, `wx`, stale takeover by age = 2 × maxWallMs
 * once). Returns { ok:true, release, takeover } or { ok:false, reason }.
 */
export function acquirePeriodicLock({ env = process.env, now }) {
  const file = rrsiPeriodicLockPath(env);
  const staleMs = 2 * RRSI_PERIODIC_DEFAULTS.maxWallMs;
  if (!privateDirSafe(rrsiRoot(env), { create: true })) return { ok: false, reason: "unsafe_path" };
  const attempt = (allowTakeover) => {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }));
      fs.closeSync(fd);
      return { ok: true };
    } catch (error) {
      if (error && error.code !== "EEXIST") return { ok: false, reason: "lock_unavailable" };
      if (!allowTakeover) return { ok: false, reason: "locked" };
      try {
        const stat = fs.lstatSync(file);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(file);
          const retry = attempt(false);
          return retry.ok ? { ok: true, takeover: true } : retry;
        }
      } catch {
        const retry = attempt(false);
        return retry.ok ? { ok: true, takeover: true } : retry;
      }
      return { ok: false, reason: "locked" };
    }
  };
  const acquired = attempt(true);
  if (!acquired.ok) return acquired;
  return {
    ok: true,
    takeover: acquired.takeover === true,
    release: () => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* best effort */
      }
    },
  };
}

/** Keep at most `maxCount` receipts (oldest by mtime pruned on write). */
export function pruneReceipts({ env = process.env, maxCount = RRSI_PERIODIC_DEFAULTS.receiptMaxCount } = {}) {
  const dir = rrsiReceiptsDir(env);
  if (!privateDirSafe(dir, { create: false })) return { pruned: 0, skipped: "unsafe_path" };
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
        } catch {
          /* raced */
        }
        return { name, mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const extra = entries.length - maxCount;
    for (let i = 0; i < extra; i += 1) {
      try {
        fs.unlinkSync(path.join(dir, entries[i].name));
      } catch {
        /* best effort */
      }
    }
    return { pruned: Math.max(0, extra) };
  } catch {
    return { pruned: 0 };
  }
}

export function countReceipts(env = process.env) {
  try {
    return fs.readdirSync(rrsiReceiptsDir(env)).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function writeReceipt({ env, receipt }) {
  const dir = rrsiReceiptsDir(env);
  if (!privateDirSafe(dir, { create: true })) return { persisted: false, reason: "unsafe_path", receiptId: receipt.receiptId };
  const file = path.join(dir, `${receipt.receiptId}.json`);
  let body = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > RRSI_PERIODIC_DEFAULTS.receiptMaxBytes) {
    const trimmed = { ...receipt, limits: undefined };
    body = `${JSON.stringify(trimmed, null, 2)}\n`;
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, body, { mode: 0o600 });
    return { persisted: true, reason: "stored", receiptId: receipt.receiptId };
  } catch {
    return { persisted: false, reason: "receipt_unavailable", receiptId: receipt.receiptId };
  }
}

function receiptIdFor(now, tag) {
  const compact = now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${compact}-${tag}-${randomBytes(3).toString("hex")}`;
}

/** Default detached worker spawn: `bun <installed hook file>` with the worker flag. */
export async function defaultSpawnWorker({ env = process.env } = {}) {
  try {
    const hookFile = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "hooks", "rrsi-periodic.ts");
    const child = spawn("bun", [hookFile], { env: { ...env, RRSI_PERIODIC_WORKER: "1" }, detached: true, stdio: "ignore" });
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: true, pid: child.pid ?? null }), 250);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: bounded(error && (error.code || error.message) ? String(error.code ?? error.message) : "spawn_failed", 80) });
      });
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve({ ok: true, pid: child.pid ?? null });
      });
    });
    if (outcome.ok) child.unref();
    return outcome;
  } catch (error) {
    return { ok: false, reason: bounded(error && error.message ? error.message : "spawn_failed", 80) };
  }
}

async function appendPeriodicRecord({ env, startedMs, summary, storage }) {
  try {
    return await appendPluginOutcome("rrsi", {
      operation: "dream",
      durationMs: Date.now() - startedMs,
      rrsi: {
        action: "dream",
        episodes: summary.episodes ?? 0,
        attempts: summary.attempts ?? 0,
        imported: summary.imported ?? 0,
        policies: summary.policies ?? 0,
        storage,
      },
    });
  } catch {
    return { persisted: false, reason: "store_unavailable" };
  }
}

/**
 * One periodic attempt. `mode:"inline"` is the hook path (bounded; may hand a
 * large dream to the detached worker); `mode:"worker"` is the detached path
 * (skips the due gate — it was spawned because a due run imported — and
 * dreams over the full bounded store). Never throws.
 */
export async function runPeriodic({ env = process.env, now = new Date().toISOString(), mode = "inline", spawnWorker = defaultSpawnWorker } = {}) {
  const startedMs = Date.now();
  const intervalMs = resolveIntervalMs(env);
  let lock = null;
  let clockSkew = false;
  const finish = async (result) => {
    if (lock && lock.ok) lock.release();
    return result;
  };
  try {
    if (env && env.RRSI_PERIODIC === "off") return await finish({ status: "skipped_disabled", mode, receipt: false, journal: false, stateWrite: false });

    const stateRead = readPeriodicState(env);
    const state = stateRead.status === "ok" ? stateRead.state : null;
    if (!state && stateRead.status === "unavailable") return await finish({ status: "error", mode, reason: "state_unavailable", receipt: false, journal: false, stateWrite: false });

    if (mode !== "worker") {
      const due = dueForRun({ state, now, env });
      if (!due.due) return await finish({ status: due.status, mode, reason: due.reason ?? null, receipt: false, journal: false, stateWrite: false });
      clockSkew = due.clockSkew === true;
    }

    const acquired = acquirePeriodicLock({ env, now });
    if (!acquired.ok) {
      if (acquired.reason === "locked") return await finish({ status: "skipped_locked", mode, receipt: false, journal: false, stateWrite: false });
      return await finish({ status: "error", mode, reason: acquired.reason, receipt: false, journal: false, stateWrite: false });
    }
    lock = acquired;
    const takeover = acquired.takeover === true;

    // Re-check due under the lock (another session may have completed a run).
    if (mode !== "worker") {
      const recheck = dueForRun({ state: readPeriodicState(env).state, now, env });
      if (!recheck.due) return await finish({ status: recheck.status, mode, receipt: false, journal: false, stateWrite: false });
    }

    const journal = readJournalRecords({ journalDir: rrsiJournalDir(env) });
    const baseState = stateRead.status === "ok" ? stateRead.state : null;
    const writeState = (patch) => {
      const next = {
        schema: RRSI_PERIODIC_SCHEMA,
        intervalMs,
        lastAttemptAt: now,
        lastSuccessAt: baseState?.lastSuccessAt ?? null,
        lastStatus: null,
        lastReason: null,
        nextRetryAt: null,
        consecutiveFailures: baseState?.consecutiveFailures ?? 0,
        lastReceiptId: baseState?.lastReceiptId ?? null,
        lastProjectionDigest: baseState?.lastProjectionDigest ?? null,
        storeWrite: baseState?.storeWrite ?? null,
        derivedChunks: baseState?.derivedChunks ?? null,
        clockSkew: false,
        updatedAt: now,
        ...patch,
      };
      return writePeriodicState({ state: next, env });
    };

    if (journal.status !== "ok" || journal.records.length === 0) {
      const reason = journal.reason ?? "no_records";
      const stateWrite = writeState({ lastStatus: "empty", lastReason: reason, nextRetryAt: new Date(Date.parse(now) + intervalMs).toISOString(), consecutiveFailures: 0 });
		const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: 0, attempts: 0, imported: 0, policies: 0 }, storage: "missing" });
		return await finish({ status: "no_input", mode, reason, receipt: false, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage) });
    }

    const projected = projectJournalRecordsSafe(journal.records, RRSI_PERIODIC_DEFAULTS.projectionLimit);
    if (projected.failed) {
      const failures = (baseState?.consecutiveFailures ?? 0) + 1;
      const stateWrite = writeState({ lastStatus: "error", lastReason: "projection_failed", consecutiveFailures: failures, nextRetryAt: new Date(Date.parse(now) + backoffMs(failures, intervalMs)).toISOString() });
      const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: 0, attempts: 0, imported: 0, policies: 0 }, storage: "missing" });
      return await finish({ status: "error", mode, reason: "projection_failed", receipt: false, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage) });
    }
    const digest = projectionDigestFor(projected.attempts, RRSI_PERIODIC_DEFAULTS.projectionLimit);
    const { episodes: derivedSet } = derivedEpisodeSetFor({ digest, attempts: projected.attempts });

    const loaded = readStore(env);
    if (loaded.status === "invalid" || loaded.status === "unavailable") {
      const reason = loaded.status === "invalid" ? `store_${loaded.reason ?? "invalid"}` : "store_unavailable";
      const failures = (baseState?.consecutiveFailures ?? 0) + 1;
      const stateWrite = writeState({ lastStatus: "error", lastReason: reason, storeWrite: "rejected", lastProjectionDigest: digest, derivedChunks: derivedSet.length, consecutiveFailures: failures, nextRetryAt: new Date(Date.parse(now) + backoffMs(failures, intervalMs)).toISOString() });
      const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: 0, attempts: 0, imported: projected.attempts.length, policies: 0 }, storage: loaded.status });
      return await finish({ status: "error", mode, reason, receipt: false, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage) });
    }

    const lockResult = withStoreLock(env, () => {
      const current = readStore(env);
      const replaced = replaceDerivedSet({ store: current.store, sourceClass: "jev-journal", derivedSet });
      if (replaced.storeWrite === "unchanged") {
        return { store: current.store, replaced, written: { persisted: true, reason: "unchanged", bytes: 0 } };
      }
      const written = writeStore({ store: replaced.store, env });
      return { store: written.persisted ? replaced.store : current.store, replaced, written };
    });
    if (!lockResult.ok) {
      const stateWrite = writeState({ lastStatus: "error", lastReason: "store_busy", storeWrite: "rejected", lastProjectionDigest: digest, derivedChunks: derivedSet.length });
      return await finish({ status: "error", mode, reason: "store_busy", receipt: false, journal: false, stateWrite: stateWrite.persisted });
    }

    const { store, replaced, written } = lockResult.result;
    const counts = storeCounts(store);
    if (!written.persisted && written.reason !== "unchanged") {
      const failures = (baseState?.consecutiveFailures ?? 0) + 1;
      const reason = written.reason;
      const stateWrite = writeState({ lastStatus: "error", lastReason: reason, storeWrite: "rejected", lastProjectionDigest: digest, derivedChunks: derivedSet.length, consecutiveFailures: failures, nextRetryAt: new Date(Date.parse(now) + backoffMs(failures, intervalMs)).toISOString() });
      const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: counts.episodes, attempts: counts.attempts, imported: projected.attempts.length, policies: 0 }, storage: loaded.status });
      const receiptWrite = writeReceipt({
        env,
        receipt: {
          schema: RRSI_PERIODIC_RECEIPT_SCHEMA,
          receiptId: receiptIdFor(now.replace(/\.\d+Z$/, "Z"), "er"),
          trigger: "session_start",
          startedAt: new Date(startedMs).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
          status: "error",
          reason,
          persisted: false,
          mode,
          projectionDigest: digest,
          storeWrite: "rejected",
          derivedChunks: derivedSet.length,
          episodes: counts.episodes,
          attempts: counts.attempts,
          imported: projected.attempts.length,
          policies: 0,
          attemptsOmitted: Math.max(0, journal.records.length - projected.attempts.length),
          limits: appliedLimits(),
          storage: { store: loaded.status, journalStorage: mapStorage(journalStorage) },
          clockSkew: false,
        },
      });
      if (receiptWrite.persisted) pruneReceipts({ env });
      return await finish({ status: "error", mode, reason, receipt: receiptWrite.persisted, journal: true, stateWrite: stateWrite.persisted });
    }

    const status = replaced.storeWrite === "unchanged" ? "unchanged" : "ran";
    const corpusAttempts = counts.attempts;

    if (mode === "inline" && corpusAttempts > RRSI_PERIODIC_DEFAULTS.inlineDreamMaxAttempts) {
      const spawned = await spawnWorker({ env, mode: "worker" });
      if (!spawned || !spawned.ok) {
        const failures = (baseState?.consecutiveFailures ?? 0) + 1;
        const stateWrite = writeState({ lastStatus: "error", lastReason: "worker_spawn_failed", storeWrite: replaced.storeWrite, lastProjectionDigest: digest, derivedChunks: derivedSet.length, consecutiveFailures: failures, nextRetryAt: new Date(Date.parse(now) + backoffMs(failures, intervalMs)).toISOString(), clockSkew });
        const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: counts.episodes, attempts: counts.attempts, imported: projected.attempts.length, policies: 0 }, storage: "ok" });
        return await finish({ status: "error", mode, reason: "worker_spawn_failed", receipt: false, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage) });
      }
      const stateWrite = writeState({ lastStatus: "deferred", lastReason: "dream_deferred", storeWrite: replaced.storeWrite, lastProjectionDigest: digest, derivedChunks: derivedSet.length, nextRetryAt: null, consecutiveFailures: 0, clockSkew });
      const deferredReceipt = writeReceipt({
        env,
        receipt: {
          schema: RRSI_PERIODIC_RECEIPT_SCHEMA,
          receiptId: receiptIdFor(now.replace(/\.\d+Z$/, "Z"), "df"),
          trigger: "session_start",
          startedAt: new Date(startedMs).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
          status: "deferred",
          reason: "dream_deferred",
          persisted: true,
          mode,
          projectionDigest: digest,
          storeWrite: replaced.storeWrite,
          derivedChunks: derivedSet.length,
          episodes: counts.episodes,
          attempts: counts.attempts,
          imported: projected.attempts.length,
          policies: 0,
          attemptsOmitted: Math.max(0, journal.records.length - projected.attempts.length),
          limits: appliedLimits(intervalMs),
          storage: { store: loaded.status, journalStorage: null },
          clockSkew,
          lockTakeover: takeover,
        },
      });
      if (deferredReceipt.persisted) pruneReceipts({ env });
      return await finish({ status: "deferred", mode, spawned: true, storeWrite: replaced.storeWrite, receipt: deferredReceipt.persisted, stateWrite: stateWrite.persisted });
    }

    let dream = null;
    try {
      const dreamed = dreamOverStore({ store, seed: 1 });
      const summary = summarizeReceipt(dreamed.receipt);
      dream = { ran: true, verdict: summary.verdict, receiptHash: summary.receiptHash, policies: dreamed.receipt.candidateCount };
    } catch {
      dream = { ran: false, reason: "dream_failed" };
    }

    const journalStorage = await appendPeriodicRecord({
      env,
      startedMs,
      summary: { episodes: counts.episodes, attempts: counts.attempts, imported: projected.attempts.length, policies: dream?.policies ?? 0 },
      storage: "ok",
    });
    const receiptId = receiptIdFor(now.replace(/\.\d+Z$/, "Z"), mode === "worker" ? "wk" : "in");
    const receiptWrite = writeReceipt({
      env,
      receipt: {
        schema: RRSI_PERIODIC_RECEIPT_SCHEMA,
        receiptId,
        trigger: "session_start",
        startedAt: new Date(startedMs).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        status,
        reason: null,
        persisted: true,
        mode,
        projectionDigest: digest,
        storeWrite: replaced.storeWrite,
        derivedChunks: derivedSet.length,
        episodes: counts.episodes,
        attempts: counts.attempts,
        imported: projected.attempts.length,
        policies: dream?.policies ?? 0,
        corpusAttempts,
        receiptHash: dream?.receiptHash ?? null,
        verdict: dream?.verdict ?? null,
        attemptsOmitted: Math.max(0, journal.records.length - projected.attempts.length),
        limits: appliedLimits(intervalMs),
        storage: { store: loaded.status, journalStorage: mapStorage(journalStorage) },
        clockSkew: false,
        lockTakeover: takeover,
      },
    });
    if (receiptWrite.persisted) pruneReceipts({ env });
    const stateWrite = writeState({
      lastStatus: status,
      lastReason: null,
      lastSuccessAt: now,
      lastReceiptId: receiptWrite.persisted ? receiptId : null,
      lastProjectionDigest: digest,
      storeWrite: replaced.storeWrite,
      derivedChunks: derivedSet.length,
      nextRetryAt: new Date(Date.parse(now) + intervalMs).toISOString(),
      consecutiveFailures: 0,
      clockSkew,
    });
		return await finish({ status, mode, storeWrite: replaced.storeWrite, episodesDelta: replaced.episodesDelta, attemptsDelta: replaced.attemptsDelta, receipt: receiptWrite.persisted, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage), durationMs: Date.now() - startedMs });
  } catch (error) {
    return await finish({ status: "error", mode, reason: bounded(error && error.message ? error.message : "periodic_failed", 120), receipt: false, journal: false, stateWrite: false });
  }
}

function projectJournalRecordsSafe(records, limit) {
  try {
    return projectJournalRecords(records, { limit });
  } catch {
    return { attempts: [], failed: true };
  }
}

function backoffMs(failures, intervalMs) {
  const base = RRSI_PERIODIC_DEFAULTS.minRetryMs;
  const scaled = base * Math.pow(2, Math.max(0, failures - 1));
  return Math.min(scaled, intervalMs);
}

function appliedLimits(intervalMs = RRSI_PERIODIC_DEFAULTS.intervalMs) {
  return {
    limit: RRSI_PERIODIC_DEFAULTS.projectionLimit,
    maxAttemptsPerEpisode: RRSI_LIMITS.maxAttemptsPerEpisode,
    maxEpisodes: RRSI_LIMITS.maxEpisodes,
    maxStoreBytes: RRSI_LIMITS.maxStoreBytes,
    inlineDreamMaxAttempts: RRSI_PERIODIC_DEFAULTS.inlineDreamMaxAttempts,
    intervalMs,
  };
}

function mapStorage(storage) {
  return storage && typeof storage === "object" ? { persisted: storage.persisted === true, reason: bounded(storage.reason, 40) } : { persisted: false, reason: "unknown" };
}

/** Bounded summary for the `rrsi status` tool action. */
export function summarizePeriodicState({ state, env = process.env, now = new Date().toISOString() }) {
  const due = dueForRun({ state: state ?? null, now, env });
  return {
    lastAttemptAt: state?.lastAttemptAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastStatus: state?.lastStatus ?? null,
    lastReason: state?.lastReason ?? null,
    nextRetryAt: state?.nextRetryAt ?? null,
    storeWrite: state?.storeWrite ?? null,
    lastProjectionDigest: state?.lastProjectionDigest ?? null,
    due: due.due,
    dueStatus: due.status ?? null,
    receiptCount: countReceipts(env),
    intervalMs: resolveIntervalMs(env),
    disabled: env && env.RRSI_PERIODIC === "off",
  };
}

/** Worker entry used by the generated hook file when executed directly. */
export async function runPeriodicWorker({ env = process.env, now = new Date().toISOString() } = {}) {
  return await runPeriodic({ env, now, mode: "worker" });
}

// session_start hook adapter: exactly one registration; awaits one bounded
// inline periodic attempt inside try/catch; silent except one bounded logger
// line on failure; returns undefined. No timers: this hook is the only
// automatic invocation of the rrsi plugin. The generated, committed surface
// (hooks/rrsi-periodic.ts) is this file plus the inlined cores; the same file
// doubles as the detached worker CLI when executed with RRSI_PERIODIC_WORKER=1.

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	logger?: { warn?: (message: string) => void };
}) {
	api.on('session_start', async () => {
		try {
			const result = await runPeriodic({ env: process.env, mode: 'inline' });
			if (result && result.status === 'error' && api.logger && typeof api.logger.warn === 'function') {
				api.logger.warn(`rrsi-periodic: ${String(result.reason ?? 'error').slice(0, 80)}`);
			}
		} catch {
			/* isolate: a broken periodic run never blocks or fails a session */
		}
		return undefined;
	});
}


// Worker entry: executed directly (`RRSI_PERIODIC_WORKER=1 bun hooks/rrsi-periodic.ts`) for
// the detached large-corpus dream; imported by the plugin loader it stays inert.
if (import.meta.main && process.env.RRSI_PERIODIC_WORKER === "1") {
  const result = await runPeriodicWorker({ env: process.env });
  process.stdout.write(`${JSON.stringify({ worker: true, status: result?.status ?? "error", reason: result?.reason ?? null, durationMs: result?.durationMs ?? null })}\n`);
  process.exit(result && (result.status === "ran" || result.status === "unchanged") ? 0 : 1);
}
