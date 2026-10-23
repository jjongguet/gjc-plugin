// GENERATED FILE — do not edit by hand.
// Core: lib/backplan.ts + adapter: src/check.adapter.ts
// Rebuild with: bun scripts/build.mjs

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
  'missing_binary', 'not_a_repository', 'invalid_repository', 'repository_outside_session_cwd',
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
function resultsPrivateFile(info: ResultsStats, allowReleased = false): void {
  const links = info.nlink === 1 || (allowReleased && info.nlink === 0);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600 || !links) resultsFail('unsafe_path');
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
// Read-only probe of a foreign lock during the bounded wait. A generation change
// between observations is ordinary contention — the holder released and the next
// waiter recreated the lock — so this probe never re-validates the live path:
// it adopts and mutates nothing, and identity is enforced strictly only once this
// process actually holds the lock. A link count of zero is the same contention:
// the holder unlinked its lock while this probe observed it. Unsafe plants
// (symlink, foreign owner, wrong mode, extra links) still fail closed.
async function resultsProbeBusyLock(file: string): Promise<void> {
  resultsPrivateFile(await resultsFs.lstat(file), true);
  const handle = await resultsFs.open(file, resultsConstants.O_RDONLY | resultsConstants.O_NOFOLLOW);
  try { resultsPrivateFile(await handle.stat(), true); }
  finally { await handle.close(); }
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
        try { await resultsProbeBusyLock(lockPath); }
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
// backplan plugin core — deterministic contract validation and Linear-payload
// rendering for backward-derived work plans. Pure and hermetic: no network, no
// filesystem access, no credentials. Linear registration itself stays with the
// agent's Linear MCP tooling; this module only grades the draft and renders the
// exact project/issue text plus a stable content digest.
import { createHash as backplanHash } from "node:crypto";

export const BACKPLAN_PLAN_BYTES = 262144;
export const BACKPLAN_OUTPUT_LIMIT = 131072;
export const BACKPLAN_ISSUE_LIMIT = 24;
export const BACKPLAN_CRITERIA_LIMIT = 12;
export const BACKPLAN_ARRAY_LIMIT = 48;
export const BACKPLAN_STRING_LIMIT = 2000;
export const BACKPLAN_TITLE_LIMIT = 160;
export const BACKPLAN_ERROR_LIMIT = 64;

export type BackplanRenderContext = { session?: string; worktree?: string; branch?: string };

export type BackplanIssue = {
	title: string;
	objective: string;
	context: string;
	scopeIn: string[];
	scopeOut: string[];
	completionCriteria: string[];
	delivery: string;
	dependencies: string[];
	labels: string[] | null;
};

export type BackplanPolicyDecision = {
	topic: string;
	needsUserDecision: boolean;
	options: string[];
	recordLocation: string;
};

export type BackplanAutomationCandidate = {
	candidate: string;
	disposition: "backlog" | "out_of_scope";
};

export type BackplanPlan = {
	request: string | null;
	goal: string;
	endState: string;
	successCriteria: string[];
	project: { name: string; mode: "reuse" | "create"; reason: string; boundaries: string[] | null };
	issues: BackplanIssue[];
	policyDecisions: BackplanPolicyDecision[];
	automationCandidates: BackplanAutomationCandidate[];
};

export type BackplanReport = {
	status: "ok" | "invalid";
	errors: string[];
	warnings: string[];
	digest: string | null;
	linear: null | {
		project: { mode: "reuse" | "create"; name: string; reason: string; description: string | null };
		issues: { title: string; description: string; labels: string[] | null }[];
		notes: string | null;
	};
};

const rootKeys = ["request", "goal", "end_state", "success_criteria", "project", "issues", "policy_decisions", "automation_candidates"];
const issueKeys = ["title", "objective", "context", "scope_in", "scope_out", "completion_criteria", "delivery", "dependencies", "labels"];
const projectKeys = ["name", "mode", "reason", "boundaries"];
const decisionKeys = ["topic", "needs_user_decision", "options", "record_location"];
const candidateKeys = ["candidate", "disposition"];
const genericCriterion = /^(완료|완성|됨|정상|동작|동작함|잘\s*됨|잘됨|끝|done|complete|completed|works|working|ok|n\/a|없음)\.?$/i;
const labelPattern = /^[a-z0-9][a-z0-9:._-]*$/i;

function plainObject(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
	return value as Record<string, unknown>;
}

function collectObject(value: unknown, path: string, keys: string[], required: string[], errors: string[]): Record<string, unknown> {
	const record = plainObject(value);
	if (!record) {
		errors.push(`${path}: expected an object`);
		return {};
	}
	for (const key of Object.keys(record)) if (!keys.includes(key)) errors.push(`${path}.${key}: unknown key`);
	for (const key of required) if (!Object.hasOwn(record, key)) errors.push(`${path}.${key}: required`);
	return record;
}

function collectString(value: unknown, path: string, errors: string[], limit: number, required = true): string {
	if (value === undefined) {
		if (required) errors.push(`${path}: required string missing`);
		return "";
	}
	if (typeof value !== "string") {
		errors.push(`${path}: expected a string`);
		return "";
	}
	const text = value.trim();
	if (!text) {
		errors.push(`${path}: must not be empty`);
		return "";
	}
	if (text.length > limit) {
		errors.push(`${path}: exceeds the ${limit}-character limit`);
		return text.slice(0, limit);
	}
	return text;
}

function collectBoolean(value: unknown, path: string, errors: string[]): boolean {
	if (typeof value !== "boolean") {
		errors.push(`${path}: expected true or false`);
		return false;
	}
	return value;
}

function asArray(value: unknown, path: string, errors: string[]): unknown[] {
	if (!Array.isArray(value)) {
		errors.push(`${path}: expected an array`);
		return [];
	}
	if (value.length > BACKPLAN_ARRAY_LIMIT) errors.push(`${path}: exceeds the ${BACKPLAN_ARRAY_LIMIT}-item limit`);
	return value;
}

function collectStringArray(value: unknown, path: string, errors: string[], itemLimit: number, minimum: number): string[] {
	const list = asArray(value, path, errors);
	if (list.length < minimum) errors.push(`${path}: needs at least ${minimum} item(s)`);
	const out: string[] = [];
	list.slice(0, BACKPLAN_ARRAY_LIMIT).forEach((entry, index) => {
		const text = collectString(entry, `${path}[${index}]`, errors, itemLimit);
		if (text) out.push(text);
	});
	return out;
}

function collectCriteria(value: unknown, path: string, errors: string[], warnings: string[]): string[] {
	const list = asArray(value, path, errors);
	if (list.length < 1) errors.push(`${path}: needs at least one criterion`);
	if (list.length > BACKPLAN_CRITERIA_LIMIT) errors.push(`${path}: exceeds the ${BACKPLAN_CRITERIA_LIMIT}-criterion limit`);
	const out: string[] = [];
	const seen = new Map<string, number>();
	list.slice(0, BACKPLAN_CRITERIA_LIMIT).forEach((entry, index) => {
		const itemPath = `${path}[${index}]`;
		const text = collectString(entry, itemPath, errors, BACKPLAN_STRING_LIMIT);
		if (!text) return;
		if (text.length < 8) errors.push(`${itemPath}: too short to be observable (${text.length} characters)`);
		if (genericCriterion.test(text)) errors.push(`${itemPath}: generic phrase; state the observable check (command, artifact or observed result)`);
		const key = text.toLowerCase().replace(/\s+/g, " ");
		const first = seen.get(key);
		if (first !== undefined) warnings.push(`${itemPath}: duplicates ${path}[${first}]`);
		else seen.set(key, index);
		out.push(text);
	});
	return out;
}

function normalizePlan(raw: unknown, errors: string[], warnings: string[]): BackplanPlan {
	const root = collectObject(raw, "plan", rootKeys, ["goal", "end_state", "success_criteria", "project", "issues", "policy_decisions", "automation_candidates"], errors);

	let request: string | null = null;
	if (root.request !== undefined) request = collectString(root.request, "request", errors, BACKPLAN_STRING_LIMIT) || null;

	const goal = collectString(root.goal, "goal", errors, BACKPLAN_STRING_LIMIT);
	const endState = collectString(root.end_state, "end_state", errors, BACKPLAN_STRING_LIMIT);
	const successCriteria = collectCriteria(root.success_criteria, "success_criteria", errors, warnings);

	const projectRecord = collectObject(root.project, "project", projectKeys, ["name", "mode", "reason"], errors);
	let projectMode: "reuse" | "create" = "reuse";
	// A missing mode is reported once by collectObject.
	if (projectRecord.mode === "reuse" || projectRecord.mode === "create") projectMode = projectRecord.mode;
	else if (projectRecord.mode !== undefined) errors.push("project.mode: expected reuse or create");
	const project = {
		name: collectString(projectRecord.name, "project.name", errors, BACKPLAN_TITLE_LIMIT),
		mode: projectMode,
		reason: collectString(projectRecord.reason, "project.reason", errors, BACKPLAN_STRING_LIMIT),
		boundaries: projectRecord.boundaries === undefined ? null : collectStringArray(projectRecord.boundaries, "project.boundaries", errors, BACKPLAN_STRING_LIMIT, 0),
	};

	const issuesRaw = asArray(root.issues, "issues", errors);
	if (issuesRaw.length < 1) errors.push("issues: needs at least one issue");
	if (issuesRaw.length > BACKPLAN_ISSUE_LIMIT) errors.push(`issues: exceeds the ${BACKPLAN_ISSUE_LIMIT}-issue limit`);
	const issues = issuesRaw.slice(0, BACKPLAN_ISSUE_LIMIT).map((entry, index) => {
		const path = `issues[${index}]`;
		const record = collectObject(entry, path, issueKeys, ["title", "objective", "context", "scope_in", "scope_out", "completion_criteria", "delivery"], errors);
		return {
			title: collectString(record.title, `${path}.title`, errors, BACKPLAN_TITLE_LIMIT),
			objective: collectString(record.objective, `${path}.objective`, errors, BACKPLAN_STRING_LIMIT),
			context: collectString(record.context, `${path}.context`, errors, BACKPLAN_STRING_LIMIT),
			scopeIn: collectStringArray(record.scope_in, `${path}.scope_in`, errors, BACKPLAN_STRING_LIMIT, 1),
			scopeOut: collectStringArray(record.scope_out, `${path}.scope_out`, errors, BACKPLAN_STRING_LIMIT, 1),
			completionCriteria: collectCriteria(record.completion_criteria, `${path}.completion_criteria`, errors, warnings),
			delivery: collectString(record.delivery, `${path}.delivery`, errors, BACKPLAN_STRING_LIMIT),
			dependencies: record.dependencies === undefined ? [] : collectStringArray(record.dependencies, `${path}.dependencies`, errors, BACKPLAN_STRING_LIMIT, 0),
			labels: record.labels === undefined ? null : collectStringArray(record.labels, `${path}.labels`, errors, 64, 0),
		} satisfies BackplanIssue;
	});
	const titleSeen = new Map<string, number>();
	issues.forEach((issue, index) => {
		if (!issue.title) return;
		const key = issue.title.toLowerCase().replace(/\s+/g, " ");
		const first = titleSeen.get(key);
		if (first !== undefined) errors.push(`issues[${index}].title: duplicates issues[${first}].title`);
		else titleSeen.set(key, index);
		if (issue.labels) issue.labels.forEach((label, labelIndex) => {
			if (!labelPattern.test(label)) errors.push(`issues[${index}].labels[${labelIndex}]: expected a label like repo:gjc-plugin`);
		});
	});

	const decisionsRaw = asArray(root.policy_decisions, "policy_decisions", errors);
	const policyDecisions = decisionsRaw.slice(0, BACKPLAN_ARRAY_LIMIT).map((entry, index) => {
		const path = `policy_decisions[${index}]`;
		const record = collectObject(entry, path, decisionKeys, decisionKeys, errors);
		const needsUserDecision = collectBoolean(record.needs_user_decision, `${path}.needs_user_decision`, errors);
		const options = record.options === undefined ? [] : collectStringArray(record.options, `${path}.options`, errors, 500, 0);
		if (needsUserDecision && options.length === 0) errors.push(`${path}.options: a user-decision entry needs at least one option`);
		return {
			topic: collectString(record.topic, `${path}.topic`, errors, 200),
			needsUserDecision,
			options,
			recordLocation: collectString(record.record_location, `${path}.record_location`, errors, 500),
		} satisfies BackplanPolicyDecision;
	});

	const candidatesRaw = asArray(root.automation_candidates, "automation_candidates", errors);
	const automationCandidates = candidatesRaw.slice(0, BACKPLAN_ARRAY_LIMIT).map((entry, index) => {
		const path = `automation_candidates[${index}]`;
		const record = collectObject(entry, path, candidateKeys, candidateKeys, errors);
		let disposition: "backlog" | "out_of_scope" = "backlog";
		// A missing disposition is reported once by collectObject.
		if (record.disposition === "backlog" || record.disposition === "out_of_scope") disposition = record.disposition;
		else if (record.disposition !== undefined) errors.push(`${path}.disposition: must be backlog or out_of_scope — promote in-scope automation to an issue instead`);
		return {
			candidate: collectString(record.candidate, `${path}.candidate`, errors, BACKPLAN_STRING_LIMIT),
			disposition,
		} satisfies BackplanAutomationCandidate;
	});

	return { request, goal, endState, successCriteria, project, issues, policyDecisions, automationCandidates };
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = sortValue((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function renderProjectDescription(plan: BackplanPlan, digest: string): string {
	const lines = ["## 목표", "", plan.goal, "", "## 성공 기준", ""];
	for (const item of plan.successCriteria) lines.push(`* ${item}`);
	if (plan.project.boundaries && plan.project.boundaries.length > 0) {
		lines.push("", "## 비범위", "");
		for (const item of plan.project.boundaries) lines.push(`* ${item}`);
	}
	lines.push("", "## 참조", "", `* backplan digest: sha256:${digest}`);
	return lines.join("\n");
}

function renderIssueDescription(issue: BackplanIssue, project: BackplanPlan["project"], context: BackplanRenderContext): string {
	const lines = [
		"목적·상위 목표",
		"",
		`- 해결할 문제와 기대 결과: ${issue.objective}`,
		`- 연결 프로젝트: ${project.name} (${project.mode === "reuse" ? "기존 재사용" : "신규"})`,
		"",
		"대상·근거",
		"",
		`- ${issue.context}`,
		"",
		"범위",
		"",
		"- 이번에 할 것:",
	];
	for (const item of issue.scopeIn) lines.push(`  - ${item}`);
	lines.push("- 하지 않을 것:");
	for (const item of issue.scopeOut) lines.push(`  - ${item}`);
	lines.push("", "완료 조건", "");
	for (const item of issue.completionCriteria) lines.push(`- [ ] ${item}`);
	lines.push(
		"",
		"의존성·실행 경계",
		"",
		`- 선행 티켓 / 미결정 사항 / 재개 조건: ${issue.dependencies.length > 0 ? issue.dependencies.join(" / ") : "해당 없음"}`,
		"",
		"실행·Git 연결 — 주요 전환점마다 댓글로 기록",
		"",
		`- 착수: 세션 ${context.session ?? "<세션 ID>"} / 워크트리 ${context.worktree ?? "<작업 경로>"} / 브랜치 ${context.branch ?? "<브랜치>"}`,
	);
	return lines.join("\n");
}

function renderNotes(plan: BackplanPlan): string | null {
	const lines: string[] = [];
	if (plan.policyDecisions.length > 0) {
		lines.push("### 정책·결정", "");
		for (const decision of plan.policyDecisions) {
			const options = decision.options.length > 0 ? ` (옵션: ${decision.options.join(" / ")})` : "";
			const owner = decision.needsUserDecision ? "사용자 결정 필요" : "에이전트 결정 가능";
			lines.push(`* ${decision.topic} — ${owner}${options} — 기록 위치: ${decision.recordLocation}`);
		}
	}
	if (plan.automationCandidates.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("### 자동화 후보 (비범위)", "");
		for (const candidate of plan.automationCandidates) lines.push(`* ${candidate.candidate} — ${candidate.disposition}`);
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

// A missing required key is reported once by collectObject; the per-field
// collectors would otherwise repeat it ("required string missing", "expected an
// array", nested "required") and crowd real errors out of the bounded list.
function dropMissingKeyEchoes(errors: string[]): string[] {
	const pathOf = (error: string) => error.slice(0, error.indexOf(": ")).replace(/^plan\./, "");
	const missing = new Set(errors.filter(error => error.endsWith(": required")).map(pathOf));
	const under = (path: string, parent: string) => path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`);
	return errors.filter(error => {
		const path = pathOf(error);
		for (const parent of missing) {
			if (under(path, parent)) return false;
			if (path === parent && !error.endsWith(": required")) return false;
		}
		return true;
	});
}

export function checkBackplanPlan(raw: unknown, context: BackplanRenderContext = {}): BackplanReport {
	const collected: string[] = [];
	const warnings: string[] = [];
	const plan = normalizePlan(raw, collected, warnings);
	const errors = dropMissingKeyEchoes(collected);
	if (errors.length > 0) {
		const shown = errors.slice(0, BACKPLAN_ERROR_LIMIT);
		if (errors.length > BACKPLAN_ERROR_LIMIT) shown.push(`... ${errors.length - BACKPLAN_ERROR_LIMIT} more error(s) omitted`);
		return { status: "invalid", errors: shown, warnings: warnings.slice(0, BACKPLAN_ERROR_LIMIT), digest: null, linear: null };
	}
	const digest = backplanHash("sha256").update(stableJson(plan)).digest("hex");
	const report: BackplanReport = {
		status: "ok",
		errors: [],
		warnings: warnings.slice(0, BACKPLAN_ERROR_LIMIT),
		digest,
		linear: {
			project: {
				mode: plan.project.mode,
				name: plan.project.name,
				reason: plan.project.reason,
				description: plan.project.mode === "create" ? renderProjectDescription(plan, digest) : null,
			},
			issues: plan.issues.map(issue => ({
				title: issue.title,
				description: renderIssueDescription(issue, plan.project, context),
				labels: issue.labels,
			})),
			notes: renderNotes(plan),
		},
	};
	if (JSON.stringify(report).length > BACKPLAN_OUTPUT_LIMIT) {
		return { status: "invalid", errors: ["rendered output exceeds the bounded limit; split the plan into smaller issues"], warnings: [], digest: null, linear: null };
	}
	return report;
}

// Keyless build. No credentials are read; backplan_check validates and renders locally — no network path exists.

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

// Validation gate and Linear-payload renderer for backward-derived work plans.
// Deterministic, offline and keyless: this tool never writes to Linear, reads
// credentials, or contacts any network service — registration stays with the
// agent's Linear MCP tooling.
export default function backplanCheck(pi: {
	typebox: { Type: { Object: (fields: Record<string, unknown>) => unknown; String: (options?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };
}) {
	return {
		name: "backplan_check",
		label: "Backplan Check",
		description: "Validate a backward-derived work plan (end state, success criteria, per-issue objective/scope/completion criteria, Linear project mapping, policy decisions, automation candidates) against the fixed contract and render Linear-ready project/issue payloads plus a stable content digest. Deterministic, offline and keyless: it never writes to Linear or touches the network; registration stays with the agent's Linear MCP or linear-trace.py path.",
		parameters: pi.typebox.Type.Object({
			plan: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Inline plan JSON (mutually exclusive with plan_path)" })),
			plan_path: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Path to a JSON file containing the plan (mutually exclusive with plan)" })),
			session: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Session ID rendered into each issue's execution line" })),
			worktree: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Owned worktree path rendered into each issue's execution line" })),
			branch: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Branch rendered into each issue's execution line" })),
		}),
		async execute(_toolCallId: string, params: { plan?: string; plan_path?: string; session?: string; worktree?: string; branch?: string }) {
			const finish = async (text: string, isError: boolean, execution?: { status: string; reason: string }) => {
				let journalStorage;
				try {
					journalStorage = await appendPluginOutcome("backplan", {
						operation: "backplan_check",
						toolCallDigest: createHash("sha256").update(_toolCallId).digest("hex"),
						...(execution ? { execution } : {}),
					});
				} catch { journalStorage = { persisted: false, reason: "store_unavailable" }; }
				return { content: [{ type: "text", text: `${text}\n${JSON.stringify({ journalStorage })}` }], ...(isError ? { isError: true } : {}) };
			};
			const context: { session?: string; worktree?: string; branch?: string } = {};
			for (const key of ["session", "worktree", "branch"] as const) {
				const value = (params?.[key] ?? "").trim();
				if (value.length > 500) return finish(`backplan_check: invalid_input — ${key} must be at most 500 characters.`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
				if (value) context[key] = value;
			}
			const inline = (params?.plan ?? "").trim();
			const planPath = (params?.plan_path ?? "").trim();
			if (inline && planPath) return finish("backplan_check: invalid_input — provide exactly one of plan or plan_path.", true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			if (!inline && !planPath) return finish("backplan_check: invalid_input — provide plan (inline JSON) or plan_path (JSON file).", true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			let text = inline;
			if (planPath) {
				let info;
				try { info = await lstat(planPath); }
				catch { return finish(`backplan_check: invalid_input — plan_path is not readable: ${planPath}`, true, { status: "not_run", reason: "invalid_or_unavailable_input" }); }
				if (!info.isFile() || info.isSymbolicLink()) return finish(`backplan_check: invalid_input — plan_path must be a regular file (no symlinks): ${planPath}`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
				if (info.size > BACKPLAN_PLAN_BYTES) return finish(`backplan_check: invalid_input — plan file exceeds the ${BACKPLAN_PLAN_BYTES}-byte limit.`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
				try { text = await readFile(planPath, "utf8"); }
				catch { return finish(`backplan_check: invalid_input — plan_path could not be read: ${planPath}`, true, { status: "not_run", reason: "invalid_or_unavailable_input" }); }
			} else if (Buffer.byteLength(text, "utf8") > BACKPLAN_PLAN_BYTES) {
				return finish(`backplan_check: invalid_input — plan exceeds the ${BACKPLAN_PLAN_BYTES}-byte limit.`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			}
			let raw: unknown;
			try { raw = JSON.parse(text); }
			catch (error) {
				const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
				return finish(`backplan_check: invalid_input — plan is not valid JSON: ${message}`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			}
			const report = checkBackplanPlan(raw, context);
			if (report.status === "ok") return finish(`backplan_check: ok\n${JSON.stringify(report)}`, false, { status: "passed", reason: "complete" });
			return finish(`backplan_check: invalid\n${JSON.stringify(report)}`, true, { status: "failed", reason: "assertion_failed" });
		},
	};
}
