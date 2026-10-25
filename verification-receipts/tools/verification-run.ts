// GENERATED — edit lib/ and src/, then bun scripts/build.mjs. Keyless standalone tool.
import * as receiptFs from 'node:fs/promises';
import { constants as receiptConstants } from 'node:fs';
import * as receiptPath from 'node:path';
import { createHash as receiptHash, randomUUID as receiptUUID } from 'node:crypto';
import { execFile as receiptExecFile } from 'node:child_process';
import { promisify as receiptPromisify } from 'node:util';
import { homedir as receiptHome } from 'node:os';

const receiptExec = receiptPromisify(receiptExecFile);
export const RECEIPT_EXCLUSIONS = ['.git', '.gjc', 'node_modules', '.next', 'dist', 'coverage', '.env*', '*credentials*', '*.pem', '*.key', '*secret*', '*cookie*', '*private*'];
const receiptDigest = (data: string | Uint8Array) => receiptHash('sha256').update(data).digest('hex');
const receiptHex = /^[a-f0-9]{64}$/;
const receiptIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const receiptChildEnv = () => ({ PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' });
export type SourceFingerprint = { status: 'available' | 'unavailable'; digest: string | null; reason: string; files: number; bytes: number; exclusions: string[] };
export type ReceiptFreshness = 'fresh' | 'stale' | 'changed_during_run' | 'unavailable';
export type VerificationReceipt = {
 schemaVersion: 1; plugin: 'verification-receipts' | 'ui-regression'; pluginVersion: '0.0.1'; id: string;
 toolCallDigest: string; sessionId: string | null; repositoryDigest: string; observedAt: string; durationMs: number;
 specDigest: string; before: SourceFingerprint; after: SourceFingerprint; freshness: ReceiptFreshness;
 execution: Record<string, unknown>; advisoryOnly: true; warnings: string[]; limitations: string[];
};
export async function actualRepository(cwd: string): Promise<string> {
 const { stdout } = await receiptExec('git', ['rev-parse', '--show-toplevel'], { cwd, env: receiptChildEnv(), timeout: 5000, maxBuffer: 8192 });
 return receiptFs.realpath(stdout.trim());
}
export async function repositoryDigest(root: string): Promise<string> { return receiptDigest(await receiptFs.realpath(root)); }
function excludedReceiptPath(name: string): boolean {
 return name.split('/').some(p => ['.git', '.gjc', 'node_modules', '.next', 'dist', 'coverage'].includes(p) || /^\.env(?:\.|$)/i.test(p) || /credentials|secret|cookie|private/i.test(p) || /\.(pem|key)$/i.test(p));
}
export async function fingerprintSource(root: string, specDigest: string): Promise<SourceFingerprint> {
 const unavailable = (reason: string): SourceFingerprint => ({ status: 'unavailable', digest: null, reason, files: 0, bytes: 0, exclusions: RECEIPT_EXCLUSIONS });
 try {
  if (!receiptHex.test(specDigest)) return unavailable('invalid_spec_digest');
  const options = { cwd: root, env: receiptChildEnv(), timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' as const };
  const head = (await receiptExec('git', ['rev-parse', 'HEAD'], options)).stdout;
  const index = (await receiptExec('git', ['ls-files', '--stage', '-z'], options)).stdout;
  const names = (await receiptExec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], options)).stdout;
  const paths = [...new Set(names.toString('utf8').split('\0').filter(Boolean))].filter(n => !excludedReceiptPath(n)).sort();
  if (paths.length > 20000) return unavailable('file_limit');
  const h = receiptHash('sha256');
  const add = (x: string | Uint8Array) => { h.update(String(Buffer.byteLength(x))); h.update(':'); h.update(x); };
  add(specDigest); add(head);
  // Include only non-private index entries; secret content/paths are explicitly excluded.
  for (const item of index.toString('utf8').split('\0').filter(Boolean)) {
   const split = item.indexOf('\t');
   if (split < 0) return unavailable('invalid_index');
   const name = item.slice(split + 1);
   if (excludedReceiptPath(name)) continue;
   if (item.startsWith('160000 ')) return unavailable('unsupported_submodule');
   add(item);
  }
  let bytes = 0;
  for (const name of paths) {
   if (receiptPath.isAbsolute(name) || name.split('/').some(p => p === '..' || !p)) return unavailable('unsafe_path');
   const file = receiptPath.join(root, name);
   // Do not follow symlinked parent directories into unrelated source.
   let parent = root;
   for (const part of name.split('/').slice(0, -1)) {
    parent = receiptPath.join(parent, part);
    try { if ((await receiptFs.lstat(parent)).isSymbolicLink()) return unavailable('symlink_parent'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
   }
   add(name);
   let st;
   try { st = await receiptFs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { add('deleted'); continue; } throw error; }
   add(String(st.mode & 0o777));
   if (!st.isFile() && !st.isSymbolicLink()) return unavailable('unsupported_file');
   if (bytes + st.size > 128 * 1024 * 1024) return unavailable('byte_limit');
   let data: Buffer;
   if (st.isSymbolicLink()) data = Buffer.from(await receiptFs.readlink(file));
   else {
    const handle = await receiptFs.open(file, receiptConstants.O_RDONLY | receiptConstants.O_NOFOLLOW);
    try { const current = await handle.stat(); if (current.ino !== st.ino || current.size !== st.size || !current.isFile()) return unavailable('changed_while_hashing'); data = await handle.readFile(); const last = await handle.stat(); if (current.size !== last.size || current.mtimeMs !== last.mtimeMs || current.ctimeMs !== last.ctimeMs) return unavailable('changed_while_hashing'); } finally { await handle.close(); }
   }
   bytes += data.length;
   if (bytes > 128 * 1024 * 1024) return unavailable('byte_limit');
   add(data);
  }
  return { status: 'available', digest: h.digest('hex'), reason: 'observed_source', files: paths.length, bytes, exclusions: RECEIPT_EXCLUSIONS };
 } catch { return unavailable('source_unavailable'); }
}
export function specFingerprint(spec: unknown): string { return receiptDigest(JSON.stringify(spec)); }
export function freshnessFor(before: SourceFingerprint, after: SourceFingerprint): ReceiptFreshness {
 return !before.digest || !after.digest ? 'unavailable' : before.digest === after.digest ? 'fresh' : 'changed_during_run';
}
export function createReceipt(input: Omit<VerificationReceipt, 'schemaVersion' | 'pluginVersion' | 'id' | 'observedAt' | 'advisoryOnly' | 'toolCallDigest' | 'sessionId'> & {toolCallId: string}): VerificationReceipt {
 const { toolCallId, ...rest } = input;
 return { ...rest, schemaVersion: 1, pluginVersion: '0.0.1', id: receiptUUID(), observedAt: new Date().toISOString(), toolCallDigest: receiptDigest(toolCallId), sessionId: null, advisoryOnly: true };
}
export function staticReceiptGuidance(execution: Record<string, unknown>, freshness: ReceiptFreshness, assessment?: {status: string; answers?: Record<string, {choice:string;confidence?:number;probabilities?:Record<string,number|undefined>}>}) {
 const warnings: string[] = [], recommendedNextActions: string[] = [];
 if (execution.status !== 'passed') { warnings.push('execution_not_passed'); recommendedNextActions.push('Inspect the relevant failing or incomplete tests locally.'); }
 if (freshness !== 'fresh') { warnings.push('source_not_fresh'); recommendedNextActions.push('Run verification again against the current source.'); }
 if (assessment && (assessment.status !== 'scored' || Object.values(assessment.answers ?? {}).some(a => a.confidence === undefined || a.confidence < 0.8 || a.probabilities?.[a.choice] === undefined || Number(a.probabilities[a.choice]) < 0.8))) { warnings.push('adequacy_unknown'); recommendedNextActions.push('Inspect coverage and boundary evidence; no confident adequacy claim is available.'); }
 else if (assessment && Object.values(assessment.answers ?? {}).some(a => ['gap', 'missing'].includes(a.choice))) { warnings.push('adequacy_gap'); recommendedNextActions.push('Inspect changed behavior and add relevant boundary tests.'); }
 return { warnings, recommendedNextActions: recommendedNextActions.slice(0, 3), advisoryOnly: true };
}

export function receiptStoreBase(): string { return receiptPath.join(receiptHome(), '.gjc', 'agent', 'verification-receipts', 'receipts', 'v1'); }
async function safeReceiptDirectory(dir: string, create: boolean): Promise<void> {
 const absolute = receiptPath.resolve(dir); const parts = absolute.split(receiptPath.sep).filter(Boolean); let current = receiptPath.parse(absolute).root;
 for (const part of parts) {
  current = receiptPath.join(current, part);
  let st;
  try { st = await receiptFs.lstat(current); } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
   try { await receiptFs.mkdir(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
   st = await receiptFs.lstat(current);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('unsafe_store');
 }
 const st = await receiptFs.lstat(absolute);
 if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error('unsafe_store_mode');
}
async function readPrivateReceiptFile(file: string): Promise<Buffer> {
 const handle = await receiptFs.open(file, receiptConstants.O_RDONLY | receiptConstants.O_NOFOLLOW);
 try { const st = await handle.stat(); if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || st.size > 32768) throw new Error('unsafe_receipt'); return await handle.readFile(); } finally { await handle.close(); }
}
export function validReceiptMetadata(value: unknown, repo: string): value is VerificationReceipt {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const r = value as VerificationReceipt;
 const allowed = ['schemaVersion','plugin','pluginVersion','id','toolCallDigest','sessionId','repositoryDigest','observedAt','durationMs','specDigest','before','after','freshness','execution','advisoryOnly','warnings','limitations'];
 if (Object.keys(r).some(k => !allowed.includes(k))) return false;
 if (r.schemaVersion !== 1 || r.pluginVersion !== '0.0.1' || !['verification-receipts','ui-regression'].includes(r.plugin) || !receiptIdPattern.test(r.id) || r.repositoryDigest !== repo || !receiptHex.test(r.toolCallDigest) || r.sessionId !== null || !receiptHex.test(r.specDigest) || r.advisoryOnly !== true || !Number.isFinite(r.durationMs) || r.durationMs < 0 || !Number.isFinite(Date.parse(r.observedAt))) return false;
 if (!['fresh','stale','changed_during_run','unavailable'].includes(r.freshness)) return false;
 for (const fp of [r.before, r.after]) {
  if (!fp || typeof fp !== 'object' || Array.isArray(fp) || Object.keys(fp).length !== 6 || Object.keys(fp).some(k => !['status','digest','reason','files','bytes','exclusions'].includes(k)) || !['available','unavailable'].includes(fp.status) || !Number.isSafeInteger(fp.files) || fp.files < 0 || fp.files > 20000 || !Number.isSafeInteger(fp.bytes) || fp.bytes < 0 || fp.bytes > 128 * 1024 * 1024 || JSON.stringify(fp.exclusions) !== JSON.stringify(RECEIPT_EXCLUSIONS) || typeof fp.reason !== 'string' || !/^[a-z_]+$/.test(fp.reason)) return false;
  if (fp.status === 'available' ? typeof fp.digest !== 'string' || !receiptHex.test(fp.digest) : fp.digest !== null || fp.files !== 0 || fp.bytes !== 0) return false;
 }
 if (![r.warnings,r.limitations].every(a => Array.isArray(a) && a.length <= 20 && a.every(s => typeof s === 'string' && s.length <= 300))) return false;
 const ex = r.execution;
 if (!ex || typeof ex !== 'object' || Array.isArray(ex) || !['passed','failed','no_tests','incomplete','not_run','unavailable'].includes(String(ex.status)) || typeof ex.reason !== 'string' || !/^[a-z_]+$/.test(ex.reason)) return false;
 const exKeys = ['status','reason','exitCode','signal','runnerVersion','counts',...(r.plugin === 'ui-regression' ? ['assertions','steps','cleanup','currentUiState','browserBuildBinding','scenarioDigest'] : [])];
 if (Object.keys(ex).length !== exKeys.length || Object.keys(ex).some(k => !exKeys.includes(k))) return false;
 if (!(ex.exitCode === null || (Number.isSafeInteger(ex.exitCode) && Number(ex.exitCode) >= 0 && Number(ex.exitCode) <= 255)) || !(ex.signal === null || (typeof ex.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(ex.signal))) || !(ex.runnerVersion === null || (typeof ex.runnerVersion === 'string' && /^v?\d+\.\d+\.\d+(?:\.\d+)?$/.test(ex.runnerVersion)))) return false;
 if (r.plugin === 'ui-regression') {
  if (ex.counts !== null || !['confirmed','unconfirmed'].includes(String(ex.cleanup)) || ex.currentUiState !== 'not_reobserved' || ex.browserBuildBinding !== 'unverified' || !receiptHex.test(String(ex.scenarioDigest)) || !Array.isArray(ex.assertions) || ex.assertions.length > 20) return false;
  if (!Array.isArray(ex.steps) || ex.steps.length > 20 || ex.steps.some((s,i) => !s || typeof s !== 'object' || Object.keys(s).length !== 3 || Object.keys(s).some(k => !['step','action','status'].includes(k)) || s.step !== i || !['goto','click','fill','assert'].includes(s.action) || !['passed','failed'].includes(s.status))) return false;
  const seen = new Set<number>();
  for (const item of ex.assertions) {
   if (!item || typeof item !== 'object' || Object.keys(item).length !== 4 || Object.keys(item).some(k => !['step','id','kind','status'].includes(k)) || !Number.isSafeInteger(item.step) || item.step < 0 || item.step >= 20 || item.id !== 'step-'+item.step || !['visible','text_exact','text_substring'].includes(item.kind) || seen.has(item.step) || !['passed','failed'].includes(item.status)) return false;
   seen.add(item.step);
   const step=ex.steps[item.step];
   if (!step || step.action !== 'assert' || step.status !== item.status) return false;
  }
  if (ex.steps.filter(s => s.action === 'assert').length !== ex.assertions.length) return false;
  if (ex.status === 'passed' && (ex.exitCode !== 0 || ex.signal !== null || ex.cleanup !== 'confirmed' || ex.assertions.length === 0 || ex.steps.some(s => s.status !== 'passed') || ex.assertions.some(a => a.status !== 'passed'))) return false;
 }
 if (ex.counts !== null) {
  if (!ex.counts || typeof ex.counts !== 'object' || Array.isArray(ex.counts)) return false;
  const counts = ex.counts as Record<string,unknown>;
  if (Object.keys(counts).length !== 8 || Object.keys(counts).some(k => !['tests','suites','topLevel','passed','failed','skipped','todo','cancelled'].includes(k)) || Object.values(counts).some(n => !Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > 10000)) return false;
 }
 if (r.plugin === 'verification-receipts' && ex.status === 'passed') {
  const counts = ex.counts as Record<string,number> | null;
  if (ex.exitCode !== 0 || ex.signal !== null || !counts || counts.tests <= 0 || counts.topLevel <= 0 || counts.passed <= 0 || counts.failed !== 0 || counts.cancelled !== 0) return false;
 }
 return true;
}
export async function persistReceipt(receipt: VerificationReceipt, base = receiptStoreBase()): Promise<{persisted: boolean; reason: string}> {
 let lock: receiptFs.FileHandle | undefined; let lockFile = ''; let temp = '';
 try {
  if (!validReceiptMetadata(receipt, receipt.repositoryDigest) || !receiptHex.test(receipt.repositoryDigest)) return { persisted:false, reason:'invalid_metadata' };
  await safeReceiptDirectory(base, true);
  const dir = receiptPath.join(base, receipt.repositoryDigest); await safeReceiptDirectory(dir, true);
  lockFile = receiptPath.join(dir, '.admission.lock');
  try { lock = await receiptFs.open(lockFile, receiptConstants.O_WRONLY | receiptConstants.O_CREAT | receiptConstants.O_EXCL | receiptConstants.O_NOFOLLOW, 0o600); } catch { return { persisted:false, reason:'store_busy' }; }
  const entries = await receiptFs.readdir(dir); let count = 0, bytes = 0;
  for (const name of entries) {
   if (name === '.admission.lock') continue;
   if (!receiptIdPattern.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) return { persisted:false, reason:'store_corrupt' };
   const data = await readPrivateReceiptFile(receiptPath.join(dir, name));
   const prior = JSON.parse(data.toString()); if (!validReceiptMetadata(prior, receipt.repositoryDigest) || prior.id + '.json' !== name) return { persisted:false, reason:'store_corrupt' };
   count++; bytes += data.length;
  }
  const body = JSON.stringify(receipt);
  if (Buffer.byteLength(body) > 32768 || count >= 200 || bytes + Buffer.byteLength(body) > 2 * 1024 * 1024) return {persisted:false, reason:'store_full'};
  temp = receiptPath.join(dir, '.' + receiptUUID() + '.tmp');
  const handle = await receiptFs.open(temp, receiptConstants.O_WRONLY | receiptConstants.O_CREAT | receiptConstants.O_EXCL | receiptConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  // link publishes atomically without replacing an existing receipt.
  await receiptFs.link(temp, receiptPath.join(dir, receipt.id + '.json')); await receiptFs.unlink(temp); temp = '';
  return { persisted:true, reason:'stored' };
 } catch { return { persisted:false, reason:'store_unavailable' }; }
 finally { if (temp) await receiptFs.unlink(temp).catch(() => {}); if (lock) { await lock.close(); await receiptFs.unlink(lockFile).catch(() => {}); } }
}
export async function loadReceipt(root: string, id: string, base = receiptStoreBase()): Promise<VerificationReceipt | null> {
 try {
  if (!receiptIdPattern.test(id)) return null;
  const repo = await repositoryDigest(root); const dir = receiptPath.join(base, repo);
  await safeReceiptDirectory(base, false); await safeReceiptDirectory(dir, false);
  const data = await readPrivateReceiptFile(receiptPath.join(dir, id + '.json')); const result = JSON.parse(data.toString());
  return validReceiptMetadata(result, repo) && result.id === id ? result : null;
 } catch { return null; }
}
export async function currentReceiptFreshness(root: string, receipt: VerificationReceipt): Promise<ReceiptFreshness> {
 const now = await fingerprintSource(root, receipt.specDigest);
 if (!now.digest || !receipt.after.digest || !receipt.before.digest) return 'unavailable';
 if (now.digest !== receipt.after.digest) return 'stale';
 return receipt.freshness === 'changed_during_run' ? 'changed_during_run' : 'fresh';
}

import { spawn as vrNodeSpawn } from 'node:child_process';
import { lstatSync as vrNodeLstat, realpathSync as vrNodeRealpath, mkdtempSync as vrNodeMkdtemp, writeFileSync as vrNodeWrite, rmSync as vrNodeRemove } from 'node:fs';
import { resolve as vrNodeResolve, relative as vrNodeRelative, isAbsolute as vrNodeAbsolute, join as vrNodeJoin, delimiter as vrNodeDelimiter, sep as vrNodeSep } from 'node:path';
import { tmpdir as vrNodeTmpdir } from 'node:os';
import { randomBytes as vrNodeRandom } from 'node:crypto';

export type NodeExecution = {
  status: 'passed' | 'failed' | 'no_tests' | 'incomplete' | 'not_run' | 'unavailable';
  reason: string;
  exitCode: number | null;
  signal: string | null;
  runnerVersion: string | null;
  counts: null | { tests: number; suites: number; topLevel: number; passed: number; failed: number; skipped: number; todo: number; cancelled: number };
};

export function validateTestFiles(root: string, files: string[]): string[] {
  const reject = (code: string): never => { throw new Error(code); };
  if (!Array.isArray(files) || files.length < 1 || files.length > 32) reject('invalid_file_count');
  let base: string;
  try { if (vrNodeLstat(root).isSymbolicLink()) reject('invalid_root'); base = vrNodeRealpath(root); if (!vrNodeLstat(base).isDirectory()) reject('invalid_root'); }
  catch { return reject('invalid_root'); }
  const result: string[] = [];
  for (const file of files) {
    if (typeof file !== 'string' || file.length > 4096 || !file || file.includes('\0') || vrNodeAbsolute(file) || file.includes('\\') || file.split('/').some(p => p === '..' || p.startsWith('-')) || !/\.(?:js|mjs|cjs)$/.test(file)) reject('invalid_test_path');
    const target = vrNodeResolve(base, file);
    const rel = vrNodeRelative(base, target);
    if (!rel || rel.startsWith(`..${vrNodeSep}`) || vrNodeAbsolute(rel)) reject('path_escape');
    try {
      let cursor = base;
      for (const part of rel.split(vrNodeSep)) {
        cursor = vrNodeJoin(cursor, part);
        if (vrNodeLstat(cursor).isSymbolicLink()) reject('symlink_test_path');
      }
      if (!vrNodeLstat(target).isFile()) reject('invalid_test_file');
      if (vrNodeRealpath(target) !== target) reject('path_escape');
    } catch (error) {
      if (error instanceof Error && ['symlink_test_path', 'invalid_test_file', 'path_escape'].includes(error.message)) throw error;
      reject('missing_test_file');
    }
    if (result.includes(target)) reject('duplicate_test_file');
    result.push(target);
  }
  return result;
}

// This reporter forwards only the final native cumulative summary, never names or diagnostics.
const vrNodeReporterSource = `
export default async function* (source) {
  let summary = null, bytes = 0, overflow = false, actualPassed = false;
  for await (const event of source) {
    if (event.type === 'test:stdout' || event.type === 'test:stderr' || event.type === 'test:diagnostic') {
      bytes += Buffer.byteLength(String(event.data?.message ?? ''));
      if (bytes > 1048576) { overflow = true; yield 'VR_OVERFLOW\\n'; }
    }
    if (event.type === 'test:summary' && event.data?.file !== undefined && event.data.counts?.tests > 0 && event.data.counts?.passed > 0) actualPassed = true;
    if (event.type === 'test:summary' && event.data?.file === undefined) {
      if (summary !== null) { summary = { malformed: true }; continue; }
      const d = event.data;
      summary = { success: d.success, counts: d.counts };
    }
  }
  yield 'VR_FRAME_' + NONCE + ':' + JSON.stringify({ summary, overflow, actualPassed }) + '\\n';
}
`;

type VrNodeProcessResult = { code: number | null; signal: string | null; output: string; issue: string | null };
async function vrNodeProcess(executable: string, args: string[], cwd: string, timeout: number, abort?: AbortSignal): Promise<VrNodeProcessResult> {
  if (abort?.aborted) return { code: null, signal: null, output: '', issue: 'cancelled' };
  return new Promise(resolve => {
    let output = '', bytes = 0, issue: string | null = null, settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const child = vrNodeSpawn(executable, args, { cwd, env: { LANG: 'C', TZ: 'UTC' }, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = (sig: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') issue = 'cleanup_unresolved'; }
    };
    const finish = (code: number | null, sig: string | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(reapTimer);
      abort?.removeEventListener('abort', cancel);
      // Close confirms leader termination, not disappearance of its owned group.
      kill('SIGKILL');
      const cleanupDeadline = Date.now() + 1000;
      const confirmCleanup = () => {
        if (process.platform === 'win32' || !child.pid) {
          resolve({ code, signal: sig, output, issue });
          return;
        }
        try { process.kill(-child.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') issue = 'cleanup_unconfirmed';
          resolve({ code, signal: sig, output, issue });
          return;
        }
        if (Date.now() >= cleanupDeadline) {
          issue = 'cleanup_unconfirmed';
          resolve({ code, signal: sig, output, issue });
          return;
        }
        setTimeout(confirmCleanup, 25);
      };
      confirmCleanup();
    };
    const stop = (why: string) => {
      if (issue) return;
      issue = why; kill('SIGTERM');
      forceTimer = setTimeout(() => kill('SIGKILL'), 150);
      reapTimer = setTimeout(() => { issue = 'cleanup_unresolved'; child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null, null); }, 2500);
    };
    const cancel = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeout);
    abort?.addEventListener('abort', cancel, { once: true });
    if (abort?.aborted) cancel();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1048576) stop('output_limit');
      else { output += chunk.toString('utf8'); if (output.includes('VR_OVERFLOW\n')) stop('output_limit'); }
    });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1048576) stop('output_limit'); });
    child.on('error', () => { issue = 'spawn_unavailable'; finish(null, null); });
    child.on('close', finish);
  });
}

export async function runNodeTests(root: string, files: string[], timeoutMs = 30000, signal?: AbortSignal): Promise<NodeExecution> {
  const receipt: NodeExecution = { status: 'not_run', reason: 'not_run', exitCode: null, signal: null, runnerVersion: null, counts: null };
  let paths: string[];
  try { paths = validateTestFiles(root, files); }
  catch (error) { receipt.reason = error instanceof Error ? error.message : 'invalid_test_path'; return receipt; }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return { ...receipt, reason: 'invalid_timeout' };
  if (signal?.aborted) return { ...receipt, reason: 'cancelled' };
  if (process.platform === 'win32') return { ...receipt, status: 'unavailable', reason: 'process_groups_unavailable' };
  let executable: string | null = null;
  for (const directory of (process.env.PATH ?? '').split(vrNodeDelimiter)) {
    if (!directory || !vrNodeAbsolute(directory)) continue;
    try { const candidate = vrNodeRealpath(vrNodeJoin(directory, 'node')); if (vrNodeLstat(candidate).isFile()) { executable = candidate; break; } } catch { /* Try the next explicit PATH directory. */ }
  }
  if (!executable) return { ...receipt, status: 'unavailable', reason: 'node_unavailable' };
  const base = vrNodeRealpath(root);
  const probe = await vrNodeProcess(executable, ['--version'], base, Math.min(timeoutMs, 5000), signal);
  const version = probe.output.trim();
  if (probe.issue || probe.code !== 0 || !/^v\d+\.\d+\.\d+$/.test(version)) return { ...receipt, status: 'unavailable', reason: probe.issue ?? 'invalid_node_version' };
  receipt.runnerVersion = version;
  if (Number(version.split('.')[0].slice(1)) < 22) return { ...receipt, status: 'unavailable', reason: 'unsupported_node_version' };
  let directory: string | null = null;
  try {
    directory = vrNodeMkdtemp(vrNodeJoin(vrNodeTmpdir(), 'verification-node-'));
    const reporter = vrNodeJoin(directory, 'reporter.mjs');
    const nonce = vrNodeRandom(24).toString('hex');
    vrNodeWrite(reporter, `const NONCE = ${JSON.stringify(nonce)};\n${vrNodeReporterSource}`, { mode: 0o600, flag: 'wx' });
    const execution = await vrNodeProcess(executable, ['--test', `--test-reporter=${reporter}`, '--', ...paths], base, timeoutMs, signal);
    receipt.exitCode = execution.code; receipt.signal = execution.signal;
    receipt.status = 'incomplete'; receipt.reason = execution.issue ?? 'missing_summary';
    if (!execution.issue) {
      const prefix = `VR_FRAME_${nonce}:`;
      const frames = execution.output.split('\n').filter(line => line.startsWith(prefix));
      if (frames.length !== 1 || Buffer.byteLength(frames[0]) > 65536) receipt.reason = 'invalid_summary_frame';
      else {
        try {
          const frame = JSON.parse(frames[0].slice(prefix.length));
          const counts = frame.summary?.counts;
          const keys = ['tests', 'suites', 'topLevel', 'passed', 'failed', 'skipped', 'todo', 'cancelled'] as const;
          if (frame.overflow || typeof frame.actualPassed !== 'boolean' || typeof frame.summary?.success !== 'boolean' || !counts || !keys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0 && counts[key] <= 10000)) throw new Error('invalid');
          receipt.counts = Object.fromEntries(keys.map(key => [key, counts[key]])) as NonNullable<NodeExecution['counts']>;
          if (execution.signal || execution.code === null) receipt.reason = 'runner_crash';
          else if (!frame.summary.success || counts.failed > 0 || counts.cancelled > 0 || execution.code !== 0) { receipt.status = 'failed'; receipt.reason = 'native_failure'; }
          else if (!frame.actualPassed || counts.tests === 0 || counts.passed === 0) { receipt.status = 'no_tests'; receipt.reason = 'no_actual_passes'; }
          else { receipt.status = 'passed'; receipt.reason = 'native_success'; }
        } catch { receipt.reason = 'invalid_summary_frame'; }
      }
    }
  } catch { receipt.status = 'incomplete'; receipt.reason = 'runner_setup_failed'; }
  finally {
    if (directory) try { vrNodeRemove(directory, { recursive: true, force: true }); }
    catch { receipt.status = 'incomplete'; receipt.reason = 'cleanup_unresolved'; }
  }
  return receipt;
}

import { readFileSync as adequacyReadFileSync } from "node:fs";
import { homedir as adequacyHomedir } from "node:os";
import { join as adequacyJoin } from "node:path";

export type AssessmentInput = { changeSummary: string; expectedBehavior: string; caseNotes?: { id: string; note: string }[] };
export type AdequacyChoice<L extends string> = { type: "choice"; choice: L; confidence?: number; probabilities?: Partial<Record<L, number>> };
export type AssessmentResult = {
 status: "scored" | "unscored" | "unknown" | "unavailable" | "invalid_input" | "invalid_response";
 reason: "scored" | "optional_scores_missing" | "unknown_choice" | "missing_context" | "insufficient_evidence" | "invalid_context" | "invalid_facts" | "off" | "missing_key" | "request_cap" | "response_cap" | "invalid_answer" | "http_auth" | "http_credit" | "http_rate" | "http_server" | "http_error" | "redirect" | "timeout" | "transport";
 answers?: { coverage_alignment: AdequacyChoice<"aligned" | "gap" | "none" | "unknown">; boundary_evidence: AdequacyChoice<"present" | "missing" | "none" | "unknown"> };
};
const adequacyLabels = { coverage_alignment: ["aligned", "gap", "none", "unknown"], boundary_evidence: ["present", "missing", "none", "unknown"] } as const;
function adequacyObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function adequacySafeText(value: unknown, limit: number): value is string {
 return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\x00-\x08\x0b-\x1f]|(?:bearer\s|sk-[\w-]+|-----BEGIN|(?:api[_ -]?key|password|secret|token|cookie|authorization|account[_ -]?id|fill|raw[_ -]?(?:source|logs?|diff)|snapshot)\s*[:=]|https?:\/\/|(?:\/(?:Users|home|tmp|var|etc)\/|[A-Z]:\\)|(?:^|\n)(?:diff --git|@@|\+\+\+|--- |\s*at .*:\d+|\s*(?:export |import |function\s|const\s+\w+\s*=|console\.|\[?(?:INFO|DEBUG|ERROR)\]?\s))|```|[a-f0-9]{40,}|[A-Za-z0-9+/=_-]{48,})/i.test(value);
}
function adequacyInput(value: unknown, caseIds: string[] = []): value is AssessmentInput {
 if (!adequacyObject(value) || Object.keys(value).some(k => !["changeSummary", "expectedBehavior", "caseNotes"].includes(k)) || !adequacySafeText(value.changeSummary, 2000) || !adequacySafeText(value.expectedBehavior, 2000)) return false;
 if (value.caseNotes === undefined) return true;
 if (!Array.isArray(value.caseNotes) || value.caseNotes.length > 8) return false;
 const seen = new Set<string>();
 return value.caseNotes.every(n => {
  if (!adequacyObject(n) || Object.keys(n).some(k => !["id", "note"].includes(k)) || typeof n.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(n.id) || !adequacySafeText(n.id, 64) || !adequacySafeText(n.note, 300) || seen.has(n.id) || !caseIds.includes(n.id)) return false;
  seen.add(n.id); return true;
 });
}
function adequacyFacts(facts: unknown): { status: string; freshness: string; counts: Record<string, number> | null; assertions?: {step:number;id:string;kind:string;status:string}[] } | undefined {
 if (!adequacyObject(facts) || typeof facts.status !== "string" || typeof facts.freshness !== "string" || !["passed", "failed", "no_tests", "incomplete", "not_run", "unavailable"].includes(facts.status) || !["fresh", "stale", "changed_during_run", "unavailable"].includes(facts.freshness)) return;
 if (facts.caseIds !== undefined && (!Array.isArray(facts.caseIds) || facts.caseIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)))) return;
 let counts: Record<string, number> | null = null;
 if (facts.counts !== null) {
  if (!adequacyObject(facts.counts)) return;
  counts = {};
  for (const key of ["tests", "suites", "topLevel", "passed", "failed", "skipped", "todo", "cancelled"]) {
   const number = facts.counts[key];
   if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return;
   counts[key] = number;
  }
 }
 let assertions: {step:number;id:string;kind:string;status:string}[] | undefined;
 if (facts.assertions !== undefined) {
  if (!Array.isArray(facts.assertions) || facts.assertions.length > 20 || facts.assertions.some(a => !adequacyObject(a) || !Number.isSafeInteger(a.step) || Number(a.step) < 0 || Number(a.step) >= 20 || a.id !== 'step-'+a.step || !['visible','text_exact','text_substring'].includes(String(a.kind)) || !['passed','failed'].includes(String(a.status))) || new Set(facts.assertions.map(a => a.step)).size !== facts.assertions.length) return;
  assertions = facts.assertions.map(a => ({step:a.step,id:a.id,kind:a.kind,status:a.status}));
 }
 return { status: facts.status as string, freshness: facts.freshness as string, counts, ...(assertions ? {assertions} : {}) };
}
function adequacyEnv(file: string): Record<string, string> {
 const result: Record<string, string> = {};
 try {
  const text = adequacyReadFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
   const match = /^\s*(JEV_ADVISOR_PROVIDER|JEV_ADVISOR_API_KEY|OPENROUTER_API_KEY)\s*=\s*(.*?)\s*$/.exec(line);
   if (match) result[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
 } catch { /* Missing existing credential file is not an error receipt. */ }
 return result;
}
function adequacyScore(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function adequacyAnswer(value: unknown, labels: readonly string[]): AdequacyChoice<string> | undefined {
 if (!adequacyObject(value) || value.type !== "choice" || typeof value.choice !== "string" || !labels.includes(value.choice)) return;
 const result: AdequacyChoice<string> = { type: "choice", choice: value.choice };
 if (value.confidence !== undefined) { if (!adequacyScore(value.confidence)) return; result.confidence = value.confidence; }
 if (value.probabilities !== undefined) {
  if (!adequacyObject(value.probabilities)) return;
  result.probabilities = {};
  for (const [label, number] of Object.entries(value.probabilities)) { if (!labels.includes(label) || !adequacyScore(number)) return; result.probabilities[label] = number; }
 }
 return result;
}
export async function assessAdequacy(input: unknown, facts: { status: string; counts: unknown; freshness: string; caseIds?: string[]; assertions?:{step:number;id:string;kind:'visible'|'text_exact'|'text_substring';status:string}[] }, deps: { fetch?: typeof fetch; env?: Record<string, string | undefined>; envFile?: string } = {}): Promise<AssessmentResult> {
 const observed = adequacyFacts(facts);
 if (!observed) return { status: "invalid_input", reason: "invalid_facts" };
 if (input !== undefined && !adequacyInput(input, facts.caseIds)) return { status: "invalid_input", reason: "invalid_context" };
 const evidenceIncomplete = observed.status !== 'passed' || observed.freshness !== 'fresh' || (observed.counts === null && !observed.assertions?.length) || (observed.counts !== null && (observed.counts.passed < 1 || observed.counts.failed > 0 || observed.counts.cancelled > 0)) || observed.assertions?.some(a => a.status !== 'passed');
 const environment = deps.env ?? process.env;
 // Explicit off needs neither file access nor credentials.
 if (environment.JEV_ADVISOR_PROVIDER?.trim().toLowerCase() === "off") return { status: "unavailable", reason: "off" };
 const file = adequacyEnv(deps.envFile ?? adequacyJoin(adequacyHomedir(), ".gjc", "agent", "jev-advisor", ".env"));
 const variable = (name: string) => environment[name] ?? file[name];
 if (variable("JEV_ADVISOR_PROVIDER")?.trim().toLowerCase() === "off") return { status: "unavailable", reason: "off" };
 const key = variable("JEV_ADVISOR_API_KEY")?.trim() || variable("OPENROUTER_API_KEY")?.trim();
 if (!key) return { status: "unavailable", reason: "missing_key" };
 const explicitContext = input === undefined ? { authorship: "not_supplied" } : { authorship: "caller_authored", ...(input as AssessmentInput) };
 const body = JSON.stringify({ model: "typesafe/jev-1.13", state: { explicitContext, observed }, questions: {
  coverage_alignment: { type: "choice", instructions: "Assess whether caller-authored expected behavior and case notes align with the change. Counts are execution evidence, not proof of quality. If context is not_supplied, choose unknown. Failed, absent or stale execution is never a current passing verification.", criteria: { aligned: "Evidence aligns with expected behavior.", gap: "A coverage gap is evident.", none: "No applicable coverage evidence.", unknown: "Insufficient information." } },
  boundary_evidence: { type: "choice", instructions: "Assess boundary and failure evidence only from supplied context; never infer it from counts. If context is not_supplied, choose unknown. Empty observations cannot establish boundary coverage.", criteria: { present: "Relevant boundary or failure evidence is supplied.", missing: "Relevant boundary evidence is missing.", none: "No applicable boundary behavior.", unknown: "Insufficient information." } }
 } });
 if (Buffer.byteLength(body) > 16 * 1024) return { status: "invalid_input", reason: "request_cap" };
 const controller = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined;
 const timeout = new Promise<AssessmentResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: "unavailable", reason: "timeout" }); }, 8000); });
 const request = async (): Promise<AssessmentResult> => {
  try {
   const response = await (deps.fetch ?? fetch)("https://openrouter.ai/api/alpha/decisions", { method: "POST", redirect: "manual", signal: controller.signal, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body });
   if (controller.signal.aborted) return { status: "unavailable", reason: "timeout" };
   if (response.status >= 300 && response.status < 400 || response.redirected) { await response.body?.cancel(); return { status: "unavailable", reason: "redirect" }; }
   if (!response.ok) { await response.body?.cancel(); return { status: "unavailable", reason: response.status === 401 ? "http_auth" : response.status === 402 ? "http_credit" : response.status === 429 ? "http_rate" : response.status >= 500 ? "http_server" : "http_error" }; }
   if (Number(response.headers.get("content-length")) > 65536) { await response.body?.cancel(); return { status: "invalid_response", reason: "response_cap" }; }
   if (!response.body) return { status: "invalid_response", reason: "invalid_answer" };
   const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
   try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) { await reader.cancel(); return { status: "invalid_response", reason: "response_cap" }; } chunks.push(part.value); } } finally { reader.releaseLock(); }
   let parsed: unknown;
   try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return { status: "invalid_response", reason: "invalid_answer" }; }
   if (!adequacyObject(parsed) || !adequacyObject(parsed.answers)) return { status: "invalid_response", reason: "invalid_answer" };
   const coverage = adequacyAnswer(parsed.answers.coverage_alignment, adequacyLabels.coverage_alignment);
   const boundary = adequacyAnswer(parsed.answers.boundary_evidence, adequacyLabels.boundary_evidence);
   if (!coverage || !boundary) return { status: "invalid_response", reason: "invalid_answer" };
   const answers = { coverage_alignment: coverage, boundary_evidence: boundary } as NonNullable<AssessmentResult["answers"]>;
   if (evidenceIncomplete) return { status: "unknown", reason: "insufficient_evidence", answers };
   if (input === undefined) return { status: "unknown", reason: "missing_context", answers };
   if ([coverage.choice, boundary.choice].some(choice => choice === "none" || choice === "unknown")) return { status: "unknown", reason: "unknown_choice", answers };
   const scored = [coverage, boundary].every(answer => answer.confidence !== undefined && answer.probabilities !== undefined && Object.keys(answer.probabilities).length === 4);
   return { status: scored ? "scored" : "unscored", reason: scored ? "scored" : "optional_scores_missing", answers };
  } catch { return { status: "unavailable", reason: controller.signal.aborted ? "timeout" : "transport" }; }
 };
 try { return await Promise.race([request(), timeout]); } finally { clearTimeout(timer); }
}


export default function verificationRun(pi: {cwd: string; typebox: {Type: any}}) {
 const T = pi.typebox.Type;
 return {
  name: 'verification_run', label: 'Verification Run',
  description: 'Execute explicitly authorized non-sensitive JavaScript node:test files with a fixed native reporter. This is not a sandbox: inspect test effects first. Actual execution/counts and source fingerprints are advisory evidence, not coverage proof. No arbitrary commands, result imports or repair loops. Automatically attempt Jev adequacy on every invocation at https://openrouter.ai/api/alpha/decisions (typesafe/jev-1.13). Supply assessment context when known: selected non-sensitive changeSummary, expectedBehavior and caseNotes improve the automatic judgment; omission does not disable it. Only bounded host facts and validated supplied context leave; no raw logs/source/paths/keys. Missing context or unavailable assessment is not a pass.',
  parameters: T.Object({
   files: T.Array(T.String(), {minItems:1,maxItems:32,description:'Explicit repository-relative .js/.mjs/.cjs test files; no globs, symlinks, custom flags or loaders.'}),
   timeoutMs: T.Optional(T.Number({minimum:1,maximum:120000})),
   assessment: T.Optional(T.Object({changeSummary:T.String({maxLength:2000}),expectedBehavior:T.String({maxLength:2000}),caseNotes:T.Optional(T.Array(T.Object({id:T.String(),note:T.String({maxLength:300})}),{maxItems:8}))},{additionalProperties:false}))
  }, {additionalProperties:false}),
  async execute(toolCallId: string, params: {files:string[];timeoutMs?:number;assessment?:unknown}, _update?:unknown, _ctx?:unknown, signal?:AbortSignal) {
   const started = performance.now();
   const text = (value: unknown) => ({content:[{type:'text',text:JSON.stringify(value)}]});
   try {
    if (!params || Object.keys(params).some(k => !['files','timeoutMs','assessment'].includes(k)) || (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > 120000))) throw new Error('invalid_input');
    const root = await actualRepository(pi.cwd);
    await validateTestFiles(root, params.files);
    const specDigest = specFingerprint({runner:'node:test',files:params.files,timeoutMs:params.timeoutMs ?? 30000});
    const before = await fingerprintSource(root,specDigest);
    const execution = await runNodeTests(root,params.files,params.timeoutMs ?? 30000,signal);
    const after = await fingerprintSource(root,specDigest); const freshness = freshnessFor(before,after);
    const receipt = createReceipt({plugin:'verification-receipts',toolCallId,repositoryDigest:await repositoryDigest(root),durationMs:Math.round(performance.now()-started),specDigest,before,after,freshness,execution,warnings:[],limitations:['Native counts are not assertion counts or coverage proof.','Excluded credential and cache paths are not freshness-covered.','Local test code is not sandboxed; timestamps are descriptive.']});
    const storage = await persistReceipt(receipt);
    const assessment = await assessAdequacy(params.assessment,{status:execution.status,counts:execution.counts,freshness,caseIds:['run']});
    return text({receipt,...storage,assessment,...staticReceiptGuidance(execution,freshness,assessment)});
   } catch {
    const execution={status:'not_run',reason:'invalid_or_unavailable_input'};
    const assessment=await assessAdequacy(undefined,{status:execution.status,counts:null,freshness:'unavailable'});
    return text({execution,assessment,...staticReceiptGuidance(execution,'unavailable',assessment)});
   }
  }
 };
}
