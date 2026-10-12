// Delegation verification loop core: private per-session state, bounded git
// facts, receipt-coverage evaluation and the deterministic gate text. Hook and
// tool surfaces consume these primitives; every path is fail-open for hooks and
// bounded for the tool. State files are writer-owned: this module only ever
// writes the current session's file and reads every other session file.
import * as loopFs from 'node:fs/promises';
import { constants as loopConstants } from 'node:fs';
import * as loopPath from 'node:path';
import { createHash as loopHash, randomUUID as loopUUID } from 'node:crypto';
import { execFile as loopExecFile } from 'node:child_process';
import { promisify as loopPromisify } from 'node:util';
import { performance as loopClock } from 'node:perf_hooks';
import { pluginResultsRoot, ensurePrivateResultDirectory, readPrivateResultFile } from '../../shared/lib/results';
import { loadReceipt, loadReceiptInputs, currentReceiptFreshness, receiptStoreBase } from './receipts';

const loopExec = loopPromisify(loopExecFile);
const loopDigest = (data: string | Uint8Array) => loopHash('sha256').update(data).digest('hex');
const loopHex = /^[a-f0-9]{64}$/;
const loopGitSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const loopIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const loopChildEnv = () => ({ PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' });

export const LOOP_BUDGET_MS = 15000;
export const BEFORE_BUDGET_MS = 3000;
export const LOCK_WAIT_MS = 100;
export const GATE_TEXT_MAX = 1600;
export const MAX_BASELINES = 8;
export const MAX_PENDING = 8;
export const MAX_GATES = 32;
export const MAX_DIRTY_STORED = 32;
export const MAX_STATE_BYTES = 32 * 1024;
export const MAX_RECEIPT_CANDIDATES = 8;
export const MAX_SCAN_SESSION_FILES = 16;
const LOOP_GAP_KINDS = ['no_receipt_after_gate', 'receipt_not_passed', 'receipt_no_tests', 'receipt_incomplete', 'receipt_stale', 'receipt_changed_during_run', 'receipt_freshness_unavailable', 'changed_test_uncovered', 'state_unavailable', 'not_a_repository'] as const;
export type LoopGapKindName = (typeof LOOP_GAP_KINDS)[number];
export type LoopGateTrigger = 'task' | 'task_async' | 'subagent_terminal' | 'job_terminal';
export type LoopBindingEvidence = 'present' | 'absent' | 'unknown';
export type LoopGateFactState = 'available' | 'partial' | 'unavailable';
export type LoopReceiptState = 'none' | 'present' | 'fresh_passed' | 'unavailable';

export type LoopBaseline = { toolCallId: string; head: string; porcelainDigest: string; dirtyFiles: string[]; capturedAt: string };
export type LoopPendingAsync = { jobId: string; baselineToolCallId: string | null; recordedAt: string; consumedAtGateId: string | null; consumedAt: string | null };
export type LoopGate = {
 toolCallId?: string; jobId?: string;
 id: string; trigger: LoopGateTrigger; dedupKey: string; dedupKeyDigest: string;
 baselineToolCallId: string | null; emittedAt: string;
 facts: LoopGateFactState; bindingEvidence: LoopBindingEvidence; persistence?: 'applied' | 'no_changes' | 'recovery_available';
 boundRoot?: string; boundBaseline?: string;
 changedFiles: number; commits: number | null; receiptState: LoopReceiptState; stateWrite: 'ok' | 'drop';
 resolvedAt: string | null; resolution: 'no_change' | 'receipt' | null; resolvedReceiptId: string | null; loopRuns: number;
};
export type LoopState = {
 schemaVersion: 1; sessionDigest: string; repoDigest: string; repoRoot: string; updatedAt: string;
 baselines: LoopBaseline[]; pendingAsync: LoopPendingAsync[]; gates: LoopGate[];
};
export type LoopGitFacts = { available: boolean; head: string | null; treeClean: boolean; dirtyFiles: string[]; changedFiles: number; changedTestFiles: string[]; commits: number | null; changedNames: string[]; namesOverflow: boolean };
export type LoopReceiptSummary = { state: LoopReceiptState; id: string | null; observedAt: string | null; status: string | null; freshness: string | null };
export type LoopCandidate = { id: string; observedAt: string; status: string; files: string[]; freshness: string; root: string };
export type LoopGap = { gateId: string; trigger: LoopGateTrigger; kind: LoopGapKindName; detail: string };
export type LoopEvaluation = {
 status: 'clean' | 'gaps' | 'blocked'; repositoryDigest: string | null; gaps: LoopGap[];
 openGates: number; resolvedGates: number; scannedSessionFiles: number; scanTruncated: boolean; silentPending: number; gapKinds: LoopGapKindName[]; stateWritten: boolean; budgetExceeded: boolean;
};

export function sessionDigestOf(sessionId: string): string { return loopDigest(String(sessionId)); }
export function loopStateRoot(): string { return loopPath.join(pluginResultsRoot(), 'verification-receipts', 'loop', 'v1'); }
export function loopRepoDir(repoDigest: string): string { return loopPath.join(loopStateRoot(), repoDigest); }
export function loopStateFile(repoDigest: string, sessionDigest: string): string { return loopPath.join(loopRepoDir(repoDigest), sessionDigest + '.json'); }
function loopLockPath(repoDigest: string): string { return loopPath.join(loopRepoDir(repoDigest), '.loop.lock'); }

export function emptyLoopState(sessionDigest: string, repoDigest: string, repoRoot: string): LoopState {
 return { schemaVersion: 1, sessionDigest, repoDigest, repoRoot, updatedAt: new Date().toISOString(), baselines: [], pendingAsync: [], gates: [] };
}

function loopPlain(value: unknown, depth = 0): boolean {
 if (depth > 6) return false;
 if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
 if (typeof value === 'number') return Number.isFinite(value);
 if (!value || typeof value !== 'object') return false;
 if (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
 return true;
}
export function validLoopState(value: unknown, repoDigest: string, sessionDigest: string): value is LoopState {
 if (!loopPlain(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
 const state = value as LoopState;
 if (Object.keys(state).length !== 8 || Object.keys(state).some(k => !['schemaVersion', 'sessionDigest', 'repoDigest', 'repoRoot', 'updatedAt', 'baselines', 'pendingAsync', 'gates'].includes(k))) return false;
 if (state.schemaVersion !== 1 || state.sessionDigest !== sessionDigest || state.repoDigest !== repoDigest) return false;
 if (typeof state.repoRoot !== 'string' || !state.repoRoot || state.repoRoot.length > 4096 || typeof state.updatedAt !== 'string') return false;
 if (!Array.isArray(state.baselines) || state.baselines.length > MAX_BASELINES || !Array.isArray(state.pendingAsync) || state.pendingAsync.length > MAX_PENDING || !Array.isArray(state.gates) || state.gates.length > MAX_GATES) return false;
 for (const b of state.baselines) {
  if (!loopPlain(b) || !b || Object.keys(b).length !== 5 || Object.keys(b).some(k => !['toolCallId', 'head', 'porcelainDigest', 'dirtyFiles', 'capturedAt'].includes(k))) return false;
  if (typeof b.toolCallId !== 'string' || b.toolCallId.length > 512 || !loopGitSha.test(b.head) || !loopHex.test(b.porcelainDigest)) return false;
  if (!Array.isArray(b.dirtyFiles) || b.dirtyFiles.length > MAX_DIRTY_STORED || b.dirtyFiles.some(n => typeof n !== 'string' || n.length > 1024)) return false;
  if (typeof b.capturedAt !== 'string') return false;
 }
 for (const p of state.pendingAsync) {
  if (!loopPlain(p) || !p || Object.keys(p).length !== 5 || Object.keys(p).some(k => !['jobId', 'baselineToolCallId', 'recordedAt', 'consumedAtGateId', 'consumedAt'].includes(k))) return false;
  if (typeof p.jobId !== 'string' || !p.jobId || p.jobId.length > 512) return false;
  if (!(p.baselineToolCallId === null || (typeof p.baselineToolCallId === 'string' && p.baselineToolCallId.length <= 512))) return false;
  if (!(p.consumedAtGateId === null || (typeof p.consumedAtGateId === 'string' && p.consumedAtGateId.length <= 64))) return false;
  if (!(p.consumedAt === null || typeof p.consumedAt === 'string')) return false;
  if (typeof p.recordedAt !== 'string') return false;
 }
 for (const g of state.gates) {
  if (!loopPlain(g) || !g || Object.keys(g).some(k => !['id', 'trigger', 'dedupKey', 'dedupKeyDigest', 'toolCallId', 'jobId', 'baselineToolCallId', 'emittedAt', 'facts', 'bindingEvidence', 'persistence', 'boundRoot', 'boundBaseline', 'changedFiles', 'commits', 'receiptState', 'stateWrite', 'resolvedAt', 'resolution', 'resolvedReceiptId', 'loopRuns'].includes(k))) return false;
  if (!loopIdPattern.test(g.id) || !['task', 'task_async', 'subagent_terminal', 'job_terminal'].includes(g.trigger)) return false;
  if (typeof g.dedupKey !== 'string' || !g.dedupKey || g.dedupKey.length > 600 || !loopHex.test(g.dedupKeyDigest)) return false;
  if (!(g.toolCallId === undefined || (typeof g.toolCallId === 'string' && g.toolCallId.length <= 512))) return false;
  if (!(g.jobId === undefined || (typeof g.jobId === 'string' && g.jobId.length <= 512))) return false;
  if (!(g.baselineToolCallId === null || (typeof g.baselineToolCallId === 'string' && g.baselineToolCallId.length <= 512))) return false;
  if (typeof g.emittedAt !== 'string') return false;
  if (!['available', 'partial', 'unavailable'].includes(g.facts) || !['present', 'absent', 'unknown'].includes(g.bindingEvidence)) return false;
  if (!(g.persistence === undefined || ['applied', 'no_changes', 'recovery_available'].includes(g.persistence))) return false;
  if (!(g.boundRoot === undefined || (typeof g.boundRoot === 'string' && g.boundRoot.length <= 4096))) return false;
  if (!(g.boundBaseline === undefined || (typeof g.boundBaseline === 'string' && g.boundBaseline.length <= 4096))) return false;
  if (!Number.isSafeInteger(g.changedFiles) || g.changedFiles < 0 || !(g.commits === null || (Number.isSafeInteger(g.commits) && g.commits >= 0))) return false;
  if (!['none', 'present', 'fresh_passed', 'unavailable'].includes(g.receiptState) || !['ok', 'drop'].includes(g.stateWrite)) return false;
  if (!(g.resolvedAt === null || typeof g.resolvedAt === 'string')) return false;
  if (!(g.resolution === null || g.resolution === 'no_change' || g.resolution === 'receipt')) return false;
  if (!(g.resolvedReceiptId === null || (typeof g.resolvedReceiptId === 'string' && loopIdPattern.test(g.resolvedReceiptId)))) return false;
  if (!Number.isSafeInteger(g.loopRuns) || g.loopRuns < 0) return false;
 }
 return true;
}

export function pruneLoopState(state: LoopState): void {
 while (state.baselines.length > MAX_BASELINES) state.baselines.shift();
 while (state.pendingAsync.length > MAX_PENDING) state.pendingAsync.shift();
 for (const b of state.baselines) if (b.dirtyFiles.length > MAX_DIRTY_STORED) b.dirtyFiles = b.dirtyFiles.slice(0, MAX_DIRTY_STORED);
 while (state.gates.length > MAX_GATES) {
  const index = state.gates.findIndex(g => g.resolvedAt !== null);
  if (index < 0) break;
  state.gates.splice(index, 1);
 }
 for (const g of state.gates) if (g.loopRuns > 1000000) g.loopRuns = 1000000;
}

export function serializeLoopState(state: LoopState): string | null {
 pruneLoopState(state);
 if (state.gates.length > MAX_GATES || state.baselines.length > MAX_BASELINES || state.pendingAsync.length > MAX_PENDING) return null;
 const body = JSON.stringify(state);
 return Buffer.byteLength(body) <= MAX_STATE_BYTES ? body : null;
}

export async function readLoopState(repoDigest: string, sessionDigest: string): Promise<{ status: 'ok' | 'missing' | 'unavailable'; state: LoopState | null }> {
 const file = loopStateFile(repoDigest, sessionDigest);
 let body: Buffer;
 try { body = await readPrivateResultFile(file, MAX_STATE_BYTES); }
 catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', state: null };
  return { status: 'unavailable', state: null };
 }
 try {
  const parsed = JSON.parse(body.toString('utf8'));
  if (!validLoopState(parsed, repoDigest, sessionDigest)) return { status: 'unavailable', state: null };
  return { status: 'ok', state: parsed };
 } catch { return { status: 'unavailable', state: null }; }
}

/** Locked read-modify-write for the current session's own file. Never touches other sessions. */
export async function withLoopStateWrite(repoDigest: string, sessionDigest: string, repoRoot: string, mutate: (state: LoopState) => void): Promise<'ok' | 'drop'> {
 const dir = loopRepoDir(repoDigest);
 try { await ensurePrivateResultDirectory(dir, true); } catch { return 'drop'; }
 const lockFile = loopLockPath(repoDigest);
 let lock: loopFs.FileHandle | undefined;
 const deadline = loopClock.now() + LOCK_WAIT_MS;
 try {
  while (!lock) {
   try { lock = await loopFs.open(lockFile, loopConstants.O_WRONLY | loopConstants.O_CREAT | loopConstants.O_EXCL | loopConstants.O_NOFOLLOW, 0o600); }
   catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'drop';
    if (loopClock.now() >= deadline) return 'drop';
    await new Promise(resolve => setTimeout(resolve, 5));
   }
  }
  const lockStat = await lock.stat();
  if (!lockStat.isFile() || lockStat.nlink !== 1 || (lockStat.mode & 0o7777) !== 0o600 || lockStat.uid !== process.getuid?.()) return 'drop';
  const file = loopStateFile(repoDigest, sessionDigest);
  const existing = await readLoopState(repoDigest, sessionDigest);
  if (existing.status === 'unavailable') {
   // A corrupt own file is never repaired in place: fall back to a fresh file only when the
   // corrupt bytes cannot be trusted; the caller journals the drop instead of overwriting.
   return 'drop';
  }
  const state = existing.state ?? emptyLoopState(sessionDigest, repoDigest, repoRoot);
  state.repoRoot = repoRoot;
  mutate(state);
  state.updatedAt = new Date().toISOString();
  const body = serializeLoopState(state);
  if (body === null) return 'drop';
  const temp = loopPath.join(dir, '.' + loopUUID() + '.tmp');
  const handle = await loopFs.open(temp, loopConstants.O_WRONLY | loopConstants.O_CREAT | loopConstants.O_EXCL | loopConstants.O_NOFOLLOW, 0o600);
  try {
   const stat = await handle.stat();
   if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.()) return 'drop';
   await handle.writeFile(body);
   await handle.sync();
  } finally { await handle.close(); }
  const staged = await readPrivateResultFile(temp, MAX_STATE_BYTES);
  if (staged.toString('utf8') !== body) { await loopFs.unlink(temp).catch(() => {}); return 'drop'; }
  await loopFs.rename(temp, file);
  return 'ok';
 } catch { return 'drop'; }
 finally {
  if (lock) {
   try { await lock.close(); } catch {}
   try { const stat = await loopFs.lstat(lockFile); if (stat.isFile() && stat.uid === process.getuid?.()) await loopFs.unlink(lockFile); } catch {}
  }
 }
}

async function loopRunGit(root: string, args: string[], deadlineMs: number): Promise<{ bytes: Buffer } | null> {
 const remaining = deadlineMs - loopClock.now();
 if (remaining <= 0) return null;
 try {
  const { stdout } = await loopExec('git', args, { cwd: root, env: loopChildEnv(), timeout: Math.max(1, Math.min(BEFORE_BUDGET_MS, Math.ceil(remaining))), maxBuffer: 1024 * 1024, encoding: 'buffer' });
  return { bytes: stdout };
 } catch { return null; }
}

export async function resolveRepoRoot(cwd: string, budgetMs = BEFORE_BUDGET_MS): Promise<string | null> {
 const deadline = loopClock.now() + budgetMs;
 const head = await loopRunGit(cwd, ['rev-parse', '--show-toplevel'], deadline);
 if (!head) return null;
 const top = head.bytes.toString('utf8').trim();
 if (!top || top.includes('\0')) return null;
 try { return await loopFs.realpath(top); } catch { return null; }
}

function splitPorcelain(bytes: Buffer): { entries: string[]; deleted: string[]; digest: string } {
 const text = bytes.toString('utf8');
 const parts = text.split('\0').filter(Boolean);
 const entries: string[] = [];
 const deleted: string[] = [];
 for (const part of parts) {
  const status = part.slice(0, 2);
  const name = part.length > 3 ? part.slice(3) : part;
  if (!name || name.includes('\u0000')) continue;
  if (status.includes('D')) deleted.push(name); else entries.push(name);
 }
 return { entries, deleted, digest: loopDigest(bytes) };
}

export async function captureBaseline(root: string, budgetMs = BEFORE_BUDGET_MS): Promise<LoopBaseline | null> {
 const deadline = loopClock.now() + budgetMs;
 const head = await loopRunGit(root, ['rev-parse', 'HEAD'], deadline);
 const status = await loopRunGit(root, ['status', '--porcelain=v1', '-z'], deadline);
 if (!head || !status) return null;
 const headText = head.bytes.toString('utf8').trim();
 if (!loopGitSha.test(headText)) return null;
 const porcelain = splitPorcelain(status.bytes);
 return { toolCallId: '', head: headText, porcelainDigest: porcelain.digest, dirtyFiles: porcelain.entries.slice(0, MAX_DIRTY_STORED), capturedAt: new Date().toISOString() };
}

export async function gitDeltaFacts(root: string, baselineHead: string | null, budgetMs = BEFORE_BUDGET_MS): Promise<LoopGitFacts> {
 const deadline = loopClock.now() + budgetMs;
 const head = await loopRunGit(root, ['rev-parse', 'HEAD'], deadline);
 const status = await loopRunGit(root, ['status', '--porcelain=v1', '-z'], deadline);
 if (!head || !status) return { available: false, head: null, treeClean: false, dirtyFiles: [], changedFiles: 0, changedTestFiles: [], commits: null, changedNames: [], namesOverflow: false };
 const headText = head.bytes.toString('utf8').trim();
 const porcelain = splitPorcelain(status.bytes);
 const names = new Set<string>([...porcelain.entries, ...porcelain.deleted]);
 const deletedNames = new Set<string>(porcelain.deleted);
 let namesOverflow = false;
 let commits: number | null = null;
 if (baselineHead && loopGitSha.test(baselineHead)) {
  if (baselineHead === headText) commits = 0;
  else {
   const rev = await loopRunGit(root, ['rev-list', '--count', baselineHead + '..HEAD'], deadline);
   if (rev) { const parsed = Number.parseInt(rev.bytes.toString('utf8').trim(), 10); if (Number.isSafeInteger(parsed) && parsed >= 0) commits = parsed; }
   const diff = await loopRunGit(root, ['diff', '--name-only', '-z', baselineHead, 'HEAD'], deadline);
   if (diff) for (const name of diff.bytes.toString('utf8').split('\0')) if (name) names.add(name);
   const deletedDiff = await loopRunGit(root, ['diff', '--diff-filter=D', '--name-only', '-z', baselineHead, 'HEAD'], deadline);
   if (deletedDiff) for (const name of deletedDiff.bytes.toString('utf8').split('\0')) if (name) deletedNames.add(name);
  }
 }
 const changedNames: string[] = [];
 for (const name of [...names].sort()) {
  if (changedNames.length >= 50) { namesOverflow = true; break; }
  changedNames.push(name);
 }
 // Deleted files are changes but can never be covered by a receipt run; they are excluded from the coverage demand.
 const changedTestFiles = changedNames.filter(name => /\.(?:js|mjs|cjs)$/.test(name) && !deletedNames.has(name));
 return { available: true, head: headText, treeClean: porcelain.entries.length === 0 && porcelain.deleted.length === 0, dirtyFiles: porcelain.entries.slice(0, MAX_DIRTY_STORED), changedFiles: namesOverflow ? 50 : names.size, changedTestFiles, commits, changedNames, namesOverflow };
}

export function taskDedupKey(toolCallId: string): string { return 'task:' + toolCallId; }
export function jobDedupKey(jobId: string): string { return 'job:' + jobId; }
export function dedupDigest(dedupKey: string): string { return loopDigest(dedupKey); }
export function toolCallDigestFor(trigger: string, dedupKey: string): string { return loopDigest(trigger + '|' + dedupKey); }

export type LoopGateEmission = {
 trigger: LoopGateTrigger; dedupKey: string; toolCallId?: string; jobId?: string;
 baselineToolCallId: string | null; facts: LoopGateFactState; bindingEvidence: LoopBindingEvidence;
 boundRoot?: string; boundBaseline?: string; changedFiles: number; commits: number | null; receiptState: LoopReceiptState;
 noChange: boolean;
};
/** Record one gate with dedup. Returns the canonical gate id (existing on dedup) or null on state drop. */
export async function recordGate(repoDigest: string, sessionDigest: string, repoRoot: string, emission: LoopGateEmission): Promise<{ gateId: string | null; duplicate: boolean; stateWrite: 'ok' | 'drop' }> {
 let result: { gateId: string | null; duplicate: boolean; stateWrite: 'ok' | 'drop' } = { gateId: null, duplicate: false, stateWrite: 'drop' };
 const status = await withLoopStateWrite(repoDigest, sessionDigest, repoRoot, state => {
  const existing = state.gates.find(g => g.dedupKey === emission.dedupKey);
  if (existing) {
   if (emission.jobId !== undefined) consumePending(state, emission.jobId, existing.id);
   result = { gateId: existing.id, duplicate: true, stateWrite: 'ok' };
   return;
  }
  const gate: LoopGate = {
   id: loopUUID(), trigger: emission.trigger, dedupKey: emission.dedupKey, dedupKeyDigest: dedupDigest(emission.dedupKey),
   ...(emission.toolCallId !== undefined ? { toolCallId: emission.toolCallId } : {}),
   ...(emission.jobId !== undefined ? { jobId: emission.jobId } : {}),
   baselineToolCallId: emission.baselineToolCallId, emittedAt: new Date().toISOString(),
   facts: emission.facts, bindingEvidence: emission.bindingEvidence,
   ...(emission.bindingEvidence !== 'absent' ? { persistence: 'recovery_available' as const } : emission.noChange ? { persistence: 'no_changes' as const } : { persistence: 'applied' as const }),
   ...(emission.boundRoot !== undefined ? { boundRoot: emission.boundRoot } : {}),
   ...(emission.boundBaseline !== undefined ? { boundBaseline: emission.boundBaseline } : {}),
   changedFiles: emission.changedFiles, commits: emission.commits, receiptState: emission.receiptState, stateWrite: 'ok',
   resolvedAt: null, resolution: null, resolvedReceiptId: null, loopRuns: 0,
  };
  if (emission.noChange) { gate.resolvedAt = gate.emittedAt; gate.resolution = 'no_change'; }
  state.gates.push(gate);
  if (emission.jobId !== undefined) consumePending(state, emission.jobId, gate.id);
  result = { gateId: gate.id, duplicate: false, stateWrite: 'ok' };
 });
 if (status === 'drop') result = { gateId: null, duplicate: false, stateWrite: 'drop' };
 return result;
}

function consumePending(state: LoopState, jobId: string, gateId: string): void {
 const pending = state.pendingAsync.find(p => p.jobId === jobId);
 if (pending && pending.consumedAtGateId === null) { pending.consumedAtGateId = gateId; pending.consumedAt = new Date().toISOString(); }
}

export async function recordTaskBaseline(repoDigest: string, sessionDigest: string, repoRoot: string, toolCallId: string, baseline: LoopBaseline): Promise<'ok' | 'drop'> {
 return await withLoopStateWrite(repoDigest, sessionDigest, repoRoot, state => {
  const existing = state.baselines.find(b => b.toolCallId === toolCallId);
  if (existing) return;
  state.baselines.push({ ...baseline, toolCallId });
 });
}

export async function recordPendingAsync(repoDigest: string, sessionDigest: string, repoRoot: string, jobId: string, baselineToolCallId: string | null): Promise<'ok' | 'drop'> {
 return await withLoopStateWrite(repoDigest, sessionDigest, repoRoot, state => {
  if (state.pendingAsync.some(p => p.jobId === jobId)) return;
  state.pendingAsync.push({ jobId, baselineToolCallId, recordedAt: new Date().toISOString(), consumedAtGateId: null, consumedAt: null });
 });
}

async function listReceiptEntries(root: string, base: string): Promise<{ ids: { id: string; mtimeMs: number }[]; error: boolean }> {
 let repoDigest: string;
 try { repoDigest = await repositoryDigestOf(root); } catch { return { ids: [], error: false }; }
 const dir = loopPath.join(base, repoDigest);
 let names: string[];
 try { names = await loopFs.readdir(dir); }
 catch (error) { return { ids: [], error: (error as NodeJS.ErrnoException).code !== 'ENOENT' }; }
 const entries: { id: string; mtimeMs: number }[] = [];
 for (const name of names) {
  if (name === '.admission.lock' || !name.endsWith('.json')) continue;
  const id = name.slice(0, -5);
  if (!loopIdPattern.test(id)) continue;
  try { const stat = await loopFs.lstat(loopPath.join(dir, name)); if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ id, mtimeMs: stat.mtimeMs }); }
  catch { /* skip unreadable candidates; bounded scan */ }
 }
 entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
 return { ids: entries, error: false };
}

export async function repositoryDigestOf(root: string): Promise<string> { return loopDigest(await loopFs.realpath(root)); }

/** Cheap gate-time summary: newest stored verification receipt only; stored freshness, never a recompute. */
export async function latestReceiptSummary(root: string, base = receiptStoreBase()): Promise<LoopReceiptSummary> {
 const listed = await listReceiptEntries(root, base);
 if (listed.error) return { state: 'unavailable', id: null, observedAt: null, status: null, freshness: null };
 if (!listed.ids.length) return { state: 'none', id: null, observedAt: null, status: null, freshness: null };
 let sawInvalid = false;
 let firstCandidate = true;
 for (const entry of listed.ids.slice(0, MAX_RECEIPT_CANDIDATES)) {
  const receipt = await loadReceipt(root, entry.id, base);
  if (!receipt) {
   if (firstCandidate) return { state: 'unavailable', id: null, observedAt: null, status: null, freshness: null };
   sawInvalid = true;
   continue;
  }
  if (receipt.plugin !== 'verification-receipts') { firstCandidate = false; continue; }
  const status = typeof receipt.execution.status === 'string' ? receipt.execution.status : 'unavailable';
  const freshPassed = status === 'passed' && receipt.freshness === 'fresh';
  return { state: freshPassed ? 'fresh_passed' : 'present', id: receipt.id, observedAt: receipt.observedAt, status, freshness: receipt.freshness };
 }
 return sawInvalid ? { state: 'unavailable', id: null, observedAt: null, status: null, freshness: null } : { state: 'none', id: null, observedAt: null, status: null, freshness: null };
}

/** R1 candidate collection: newest receipts for the roots, freshness recomputed only for the bounded set. */
export async function collectReceiptCandidates(roots: string[], gateEmittedAtMs: number, base = receiptStoreBase(), cache?: { freshness: Map<string, string> }, deadlineMs?: number): Promise<LoopCandidate[]> {
 const candidates: LoopCandidate[] = [];
 const seen = new Set<string>();
 for (const root of roots) {
  const listed = await listReceiptEntries(root, base);
  if (listed.error) throw new Error('store_unavailable');
  for (const entry of listed.ids) {
   if (deadlineMs !== undefined && loopClock.now() >= deadlineMs) return candidates;
   const key = root + '\n' + entry.id;
   if (seen.has(key)) continue;
   seen.add(key);
   if (candidates.length >= MAX_RECEIPT_CANDIDATES) break;
   const receipt = await loadReceipt(root, entry.id, base);
   if (!receipt || receipt.plugin !== 'verification-receipts') continue;
   const observedAtMs = Date.parse(receipt.observedAt);
   if (!Number.isFinite(observedAtMs) || observedAtMs < gateEmittedAtMs) continue;
   let freshness: string;
   if (cache?.freshness.has(key)) freshness = cache.freshness.get(key)!;
   else { freshness = await currentReceiptFreshness(root, receipt, base); cache?.freshness.set(key, freshness); }
   const files = (await loadReceiptInputs(root, entry.id, base)) ?? [];
   const status = typeof receipt.execution.status === 'string' ? receipt.execution.status : 'unavailable';
   candidates.push({ id: receipt.id, observedAt: receipt.observedAt, status, files, freshness, root });
   if (candidates.length >= MAX_RECEIPT_CANDIDATES) break;
  }
 }
 return candidates;
}

export function gapKindForCandidate(candidate: LoopCandidate | undefined, changedTestFiles: string[]): LoopGapKindName {
 if (!candidate) return 'no_receipt_after_gate';
 if (candidate.status === 'failed') return 'receipt_not_passed';
 if (candidate.status === 'no_tests') return 'receipt_no_tests';
 if (candidate.status === 'incomplete' || candidate.status === 'not_run') return 'receipt_incomplete';
 if (candidate.status === 'unavailable') return 'receipt_freshness_unavailable';
 if (candidate.status !== 'passed') return 'receipt_not_passed';
 if (candidate.freshness === 'stale') return 'receipt_stale';
 if (candidate.freshness === 'changed_during_run') return 'receipt_changed_during_run';
 if (candidate.freshness !== 'fresh') return 'receipt_freshness_unavailable';
 const covered = changedTestFiles.every(file => candidate.files.includes(file));
 return covered ? 'no_receipt_after_gate' : 'changed_test_uncovered';
}

export function isCoveringCandidate(candidate: LoopCandidate, changedTestFiles: string[]): boolean {
 return candidate.status === 'passed' && candidate.freshness === 'fresh' && changedTestFiles.every(file => candidate.files.includes(file));
}

type ScannedSession = { sessionDigest: string; state: LoopState; own: boolean };

async function scanSessionFiles(repoDigest: string, sessionDigest: string): Promise<{ sessions: ScannedSession[]; scanned: number; truncated: boolean; ownCorrupt: boolean }> {
 const dir = loopRepoDir(repoDigest);
 let names: string[];
 try { names = await loopFs.readdir(dir); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [], scanned: 0, truncated: false, ownCorrupt: false }; throw error; }
 const files = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
 const truncated = files.length > MAX_SCAN_SESSION_FILES;
 const ownName = sessionDigest + '.json';
 const others: { name: string; mtimeMs: number }[] = [];
 for (const name of files) {
  if (name === ownName) continue;
  try { const stat = await loopFs.lstat(loopPath.join(dir, name)); if (stat.isFile() && !stat.isSymbolicLink()) others.push({ name, mtimeMs: stat.mtimeMs }); }
  catch { /* skip unreadable candidates; bounded scan */ }
 }
 others.sort((a, b) => b.mtimeMs - a.mtimeMs);
 const ownIncluded = files.includes(ownName);
 const limit = MAX_SCAN_SESSION_FILES - (ownIncluded ? 1 : 0);
 const ordered = [...(ownIncluded ? [ownName] : []), ...others.slice(0, Math.max(0, limit)).map(entry => entry.name)];
 const sessions: ScannedSession[] = [];
 let ownCorrupt = false;
 for (const name of ordered) {
  const digest = name.slice(0, -5);
  const read = await readLoopState(repoDigest, digest);
  if (read.status === 'ok' && read.state) { sessions.push({ sessionDigest: digest, state: read.state, own: digest === sessionDigest }); continue; }
  if (read.status === 'unavailable' && digest === sessionDigest) ownCorrupt = true;
 }
 return { sessions, scanned: ordered.length, truncated, ownCorrupt };
}

export type LoopEvaluationDeps = { base?: string; now?: number; budgetMs?: number };

export async function evaluateRepoGates(root: string, repoDigest: string, sessionDigest: string, deps: LoopEvaluationDeps = {}): Promise<LoopEvaluation> {
 const now = deps.now ?? Date.now();
 const deadlineMs = loopClock.now() + Math.max(1, deps.budgetMs ?? LOOP_BUDGET_MS);
 let sessions: ScannedSession[];
 let scanned = 0;
 let truncated = false;
 try {
  const scan = await scanSessionFiles(repoDigest, sessionDigest);
  if (scan.ownCorrupt) return { status: 'blocked', repositoryDigest: repoDigest, gaps: [{ gateId: '', trigger: 'task', kind: 'state_unavailable', detail: 'own session state is unreadable' }], openGates: 0, resolvedGates: 0, scannedSessionFiles: scan.scanned, scanTruncated: scan.truncated, silentPending: 0, gapKinds: ['state_unavailable'], stateWritten: false, budgetExceeded: false };
  sessions = scan.sessions; scanned = scan.scanned; truncated = scan.truncated;
 } catch {
  return { status: 'blocked', repositoryDigest: repoDigest, gaps: [{ gateId: '', trigger: 'task', kind: 'state_unavailable', detail: 'loop state directory is unreadable' }], openGates: 0, resolvedGates: 0, scannedSessionFiles: 0, scanTruncated: false, silentPending: 0, gapKinds: ['state_unavailable'], stateWritten: false, budgetExceeded: false };
 }
 const factsCache = new Map<string, LoopGitFacts>();
 const gateFacts = async (baselineHead: string | null): Promise<LoopGitFacts> => {
  const key = baselineHead ?? 'none';
  if (!factsCache.has(key)) factsCache.set(key, await gitDeltaFacts(root, baselineHead, Math.min(BEFORE_BUDGET_MS, Math.max(1, deadlineMs - loopClock.now()))));
  return factsCache.get(key)!;
 };
 const freshnessCache = { freshness: new Map<string, string>() };
 const gaps: LoopGap[] = [];
 const resolutionsToStamp: { gateId: string; resolution: 'no_change' | 'receipt'; resolvedReceiptId: string | null; at: string }[] = [];
 let openGates = 0;
 let resolvedGates = 0;
 let silentPending = 0;
 let budgetExceeded = false;
 let skippedGates = 0;
 const gapKinds: LoopGapKindName[] = [];
 for (const session of sessions) {
  for (const pending of session.state.pendingAsync) if (pending.consumedAtGateId === null) silentPending++;
  for (const gate of session.state.gates) {
   if (gate.resolvedAt !== null) { resolvedGates++; continue; }
   if (budgetExceeded || loopClock.now() >= deadlineMs) { budgetExceeded = true; skippedGates++; continue; }
   const baseline = session.state.baselines.find(b => b.toolCallId === gate.baselineToolCallId) ?? null;
   const roots = [root];
   if (gate.boundRoot && gate.boundRoot !== root) roots.push(gate.boundRoot);
   const gateDeadline = Math.max(1, deadlineMs - loopClock.now());
   let candidates: LoopCandidate[];
   try { candidates = await collectReceiptCandidates(roots, Date.parse(gate.emittedAt) || 0, deps.base, freshnessCache, loopClock.now() + gateDeadline); }
   catch {
    openGates++; gaps.push({ gateId: gate.id, trigger: gate.trigger, kind: 'state_unavailable', detail: 'receipt store is unreadable' });
    if (!gapKinds.includes('state_unavailable')) gapKinds.push('state_unavailable');
    continue;
   }
   const sameRoot = gate.boundRoot === undefined || gate.boundRoot === root;
   const current = await gateFacts(baseline?.head ?? null);
   const noChange = gate.changedFiles === 0 && (gate.commits === 0 || gate.commits === null) && gate.bindingEvidence === 'absent' && sameRoot && baseline !== null && current.available && current.treeClean && current.changedFiles === 0 && current.commits === 0;
   if (noChange) {
    resolvedGates++;
    if (session.own) resolutionsToStamp.push({ gateId: gate.id, resolution: 'no_change', resolvedReceiptId: null, at: new Date(now).toISOString() });
    continue;
   }
   const changedTests = current.available ? current.changedTestFiles : [];
   const covering = candidates.find(candidate => isCoveringCandidate(candidate, changedTests));
   if (covering) {
    resolvedGates++;
    if (session.own) resolutionsToStamp.push({ gateId: gate.id, resolution: 'receipt', resolvedReceiptId: covering.id, at: new Date(now).toISOString() });
    continue;
   }
   const kind = gapKindForCandidate(candidates[0], changedTests);
   openGates++;
   gaps.push({ gateId: gate.id, trigger: gate.trigger, kind, detail: kind === 'changed_test_uncovered' ? 'qualifying receipt does not cover changed test files' : 'no covering fresh passed receipt after gate' });
   if (!gapKinds.includes(kind)) gapKinds.push(kind);
  }
 }
 const ownSession = sessions.find(session => session.own);
 let stateWritten = false;
 if (ownSession && resolutionsToStamp.length) {
  const status = await withLoopStateWrite(repoDigest, sessionDigest, ownSession.state.repoRoot ?? root, state => {
   for (const stamp of resolutionsToStamp) {
    const gate = state.gates.find(g => g.id === stamp.gateId);
    if (gate && gate.resolvedAt === null) { gate.resolvedAt = stamp.at; gate.resolution = stamp.resolution; gate.resolvedReceiptId = stamp.resolvedReceiptId; }
   }
   for (const gate of state.gates) gate.loopRuns++;
  });
  stateWritten = status === 'ok';
 }
 const boundedGaps = gaps.slice(0, 16);
 if (budgetExceeded) {
  if (!gapKinds.includes('state_unavailable')) gapKinds.push('state_unavailable');
  boundedGaps.push({ gateId: '', trigger: 'task', kind: 'state_unavailable', detail: `evaluation budget reached; ${skippedGates} gate(s) unevaluated` });
 }
 return { status: openGates > 0 || budgetExceeded ? 'gaps' : 'clean', repositoryDigest: repoDigest, gaps: boundedGaps.slice(0, 16), openGates, resolvedGates, scannedSessionFiles: scanned, scanTruncated: truncated, silentPending, gapKinds: gapKinds.slice(0, 10), stateWritten, budgetExceeded };
}

export type GateTextView = {
 tool: string; idShort: string; facts: LoopGateFactState; root: string | null; baselinePresent: boolean; baselineAt: string | null;
 treeClean: boolean; effectsClean: boolean; changedFiles: number; changedNames: string[]; namesOverflow: boolean; commits: number | null;
 binding: LoopBindingEvidence; receipt: LoopReceiptSummary; partial: { completed: number; total: number } | null; noChange: boolean;
};
export function buildGateText(view: GateTextView): string {
 if (view.noChange) {
  const label = view.root ? loopPath.basename(view.root) : 'unknown-root';
  const line = `[delegation-verification-gate] ${view.tool} ${view.idShort} completed; machine-checked no repo change at ${label} since baseline ${view.baselineAt ?? 'unknown'} (no binding evidence). Run verification_loop to confirm (expected: clean/no_change).`;
  return line.slice(0, GATE_TEXT_MAX);
 }
 const lines: string[] = [];
 lines.push(`[delegation-verification-gate] ${view.tool} ${view.idShort} completed.`);
 const facts: string[] = [];
 if (view.facts === 'unavailable') facts.push('repo facts unavailable');
 else {
  const names = view.changedNames.slice(0, 8).join(', ');
  const more = view.changedFiles > view.changedNames.slice(0, 8).length || view.namesOverflow;
  facts.push(`changed files: ${view.changedFiles === 0 ? 'none observed' : names + (more ? ', +more' : '')}`);
  if (view.commits !== null) facts.push(`commits since baseline: ${view.commits}`);
  facts.push(`tree ${view.treeClean ? 'clean' : 'dirty'}`);
 }
 facts.push(`binding: ${view.binding}`);
 if (view.receipt.state === 'none') facts.push('receipt: none');
 else if (view.receipt.state === 'unavailable') facts.push('receipt: store unavailable');
 else facts.push(`receipt ${view.receipt.id?.slice(0, 8) ?? 'unknown'} (${view.receipt.status ?? 'unknown'}, freshness ${view.receipt.freshness ?? 'unknown'})`);
 if (view.partial) facts.push(`partial batch: ${view.partial.completed}/${view.partial.total} completed`);
 lines.push('Machine facts: ' + facts.join('; ') + '.');
 lines.push('REQUIRED: call verification_loop now; resolve every reported gap (verification_run for tests; fix the underlying work); re-run verification_loop; do not claim completion until status is "clean" or you report an explicit blocker with remaining gaps.');
 lines.push('Sweep (judgment, not machine-checked): sibling tests? docs/README/examples? callers/consumers? deleted-file references? commit/branch state?');
 lines.push('If verification_loop is unavailable in this context, do these checks and report them in your final message.');
 return lines.join('\n').slice(0, GATE_TEXT_MAX);
}

export function gateOutcomePayload(input: { repositoryDigest: string | null; trigger: LoopGateTrigger; dedupKey: string; facts: LoopGateFactState; baselinePresent: boolean; binding: 'none' | 'bound' | 'unknown'; stateWrite: 'ok' | 'drop'; persistence?: 'applied' | 'no_changes' | 'recovery_available'; changedFiles: number; commits?: number; receiptState: LoopReceiptState }) {
 return {
  operation: 'gate_emitted' as const,
  repositoryDigest: input.repositoryDigest,
  toolCallDigest: toolCallDigestFor(input.trigger, input.dedupKey),
  gate: {
   trigger: input.trigger, facts: input.facts, baselinePresent: input.baselinePresent, binding: input.binding, stateWrite: input.stateWrite,
   ...(input.persistence !== undefined ? { persistence: input.persistence } : {}),
   changedFiles: input.changedFiles, ...(input.commits !== undefined && input.commits !== null ? { commits: input.commits } : {}), receiptState: input.receiptState,
  },
 };
}

export function loopOutcomePayload(evaluation: LoopEvaluation, repositoryDigest: string | null) {
 return {
  operation: 'loop_run' as const,
  repositoryDigest: repositoryDigest ?? evaluation.repositoryDigest,
  loop: {
   status: evaluation.status, openGates: evaluation.openGates, resolvedGates: evaluation.resolvedGates,
   scannedSessionFiles: evaluation.scannedSessionFiles, scanTruncated: evaluation.scanTruncated, silentPending: evaluation.silentPending,
   gapKinds: evaluation.gapKinds,
  },
 };
}

export function requiredActionsFor(kinds: LoopGapKindName[]): string[] {
 const actions: string[] = [];
 for (const kind of kinds) {
  if (kind === 'no_receipt_after_gate' || kind === 'changed_test_uncovered') actions.push('Run verification_run over the changed test files (or explain in the final report why verification does not apply).');
  else if (kind === 'receipt_not_passed' || kind === 'receipt_no_tests' || kind === 'receipt_incomplete') actions.push('Fix the failing or incomplete verification and rerun verification_run, then re-run verification_loop.');
  else if (kind === 'receipt_stale' || kind === 'receipt_changed_during_run' || kind === 'receipt_freshness_unavailable') actions.push('Re-run verification_run against the current source, then re-run verification_loop.');
  else if (kind === 'not_a_repository') actions.push('Run verification_loop from inside the repository that received the delegated work.');
  else if (kind === 'state_unavailable') actions.push('Inspect the verification-receipts loop state store; do not claim a clean loop while it is unreadable.');
 }
 return [...new Set(actions)].slice(0, 4);
}
