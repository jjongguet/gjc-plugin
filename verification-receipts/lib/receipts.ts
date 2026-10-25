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
