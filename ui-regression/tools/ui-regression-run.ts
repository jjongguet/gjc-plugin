// GENERATED — shared source embedded at build time; no installed sibling imports. Keyless.
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

import { createHash as uiScenarioCreateHash } from 'node:crypto';

export type UiStep =
  | { action: 'goto'; url: string }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'assert'; selector: string; kind: 'visible' }
  | { action: 'assert'; selector: string; kind: 'text'; match: 'exact' | 'substring'; expected: string };

export type UiScenario = { id: string; expectedBehavior: string; steps: UiStep[] };

function uiScenarioFail(code: string): never {
  throw new Error(`UI_SCENARIO_${code}`);
}

function uiScenarioObject(input: unknown, keys: string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) uiScenarioFail('OBJECT');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) uiScenarioFail('OBJECT');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))) uiScenarioFail('FIELDS');
  if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) uiScenarioFail('FIELDS');
  return input as Record<string, unknown>;
}

function uiScenarioSensitive(value: string): boolean {
  return /[\x00-\x1f\x7f-\x9f]/.test(value)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
    || /\b(?:password|passwd|credential|authorization|bearer|cookie|session[_-]?token|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)\b/i.test(value)
    || /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+\b/.test(value)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /\b(?:\d[ -]?){13,19}\b/.test(value)
    || /\b(?:account|email|username)\s*[:=]\s*\S+/i.test(value);
}

function uiScenarioString(input: unknown, maximum: number, code: string, nonempty = true): string {
  if (typeof input !== 'string' || input.length > maximum || (nonempty && input.trim().length === 0)) uiScenarioFail(code);
  if (uiScenarioSensitive(input)) uiScenarioFail('SENSITIVE');
  return input;
}

function uiScenarioSelector(input: unknown): string {
  const selector = uiScenarioString(input, 256, 'SELECTOR');
  if (/javascript\s*:|expression\s*\(|(?:eval|Function|require|import)\s*\(|\$\{|=>|<\/?script\b/i.test(selector)
    || /(?:^|[\s\["'])(?:ref|snapshot[_-]?ref|backendNodeId)\s*[:=]|\b(?:aria-ref|data-(?:snapshot-)?ref)\b|^@|^\[?e\d+\]?$/i.test(selector)
    || /\b(?:password|file|hidden|submit|upload|payment|checkout|billing|account|login|logout|sign-in|sign-up|credential)\b/i.test(selector)) uiScenarioFail('SELECTOR_UNSAFE');
  return selector;
}

function uiScenarioUrl(input: unknown): URL {
  const raw = uiScenarioString(input, 2048, 'URL');
  let url: URL;
  try { url = new URL(raw); } catch { return uiScenarioFail('URL'); }
  if (!/^https?:\/\//i.test(raw) || !['http:', 'https:'].includes(url.protocol)) uiScenarioFail('URL_SCHEME');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) uiScenarioFail('URL_HOST');
  if (url.username || url.password || raw.includes('?') || raw.includes('#') || raw.includes('\\')) uiScenarioFail('URL_UNSAFE');
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return uiScenarioFail('URL'); }
  if (uiScenarioSensitive(path) || /(?:^|[^a-z0-9])(?:accounts?|payments?|checkout|billing|credentials?|login|logout|signin|signup|sign-in|sign-up|auth|oauth|admin|upload|submit)(?:$|[^a-z0-9])/i.test(path)) uiScenarioFail('URL_SENSITIVE');
  // URL parsing canonicalizes alternate numeric hosts; require an explicit loopback spelling.
  const authority = raw.match(/^https?:\/\/([^/]+)/i)?.[1];
  if (!authority || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority)) uiScenarioFail('URL_HOST');
  return url;
}

export function validateScenario(input: unknown): UiScenario {
  const object = uiScenarioObject(input, ['id', 'expectedBehavior', 'steps']);
  const id = uiScenarioString(object.id, 64, 'ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) uiScenarioFail('ID');
  const expectedBehavior = uiScenarioString(object.expectedBehavior, 2000, 'EXPECTED_BEHAVIOR');
  if (!Array.isArray(object.steps) || object.steps.length < 1 || object.steps.length > 20) uiScenarioFail('STEPS');
  for (let index = 0; index < object.steps.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(object.steps, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) uiScenarioFail('STEPS');
  }
  let origin: string | undefined;
  let assertions = 0;
  const steps: UiStep[] = object.steps.map((inputStep: unknown, index: number): UiStep => {
    if (inputStep === null || typeof inputStep !== 'object' || Array.isArray(inputStep)) uiScenarioFail('STEP');
    const actionDescriptor = Object.getOwnPropertyDescriptor(inputStep, 'action');
    if (!actionDescriptor || !Object.hasOwn(actionDescriptor, 'value')) uiScenarioFail('FIELDS');
    const action = actionDescriptor.value;
    if (index === 0 && action !== 'goto') uiScenarioFail('FIRST_GOTO');
    if (action === 'goto') {
      const step = uiScenarioObject(inputStep, ['action', 'url']);
      const url = uiScenarioUrl(step.url);
      if (origin !== undefined && url.origin !== origin) uiScenarioFail('ORIGIN');
      origin = url.origin;
      return { action, url: step.url as string };
    }
    if (action === 'click' || action === 'fill') {
      const step = uiScenarioObject(inputStep, action === 'click' ? ['action', 'selector'] : ['action', 'selector', 'value']);
      const selector = uiScenarioSelector(step.selector);
      return action === 'click' ? { action, selector } : { action, selector, value: uiScenarioString(step.value, 1000, 'VALUE', false) };
    }
    if (action === 'assert') {
      const kindDescriptor = Object.getOwnPropertyDescriptor(inputStep, 'kind');
      if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) uiScenarioFail('FIELDS');
      const kind = kindDescriptor.value;
      if (kind !== 'visible' && kind !== 'text') uiScenarioFail('ASSERT_KIND');
      const step = uiScenarioObject(inputStep, kind === 'visible' ? ['action', 'selector', 'kind'] : ['action', 'selector', 'kind', 'match', 'expected']);
      const selector = uiScenarioSelector(step.selector);
      assertions++;
      if (kind === 'visible') return { action, selector, kind };
      if (step.match !== 'exact' && step.match !== 'substring') uiScenarioFail('MATCH');
      return { action, selector, kind, match: step.match, expected: uiScenarioString(step.expected, 2000, 'EXPECTED', false) };
    }
    return uiScenarioFail('ACTION');
  });
  if (assertions === 0) uiScenarioFail('NO_ASSERTION');
  return { id, expectedBehavior, steps };
}

export function normalizeUiText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

export function uiTextMatches(actual: string, expected: string, match: 'exact' | 'substring'): boolean {
  const normalizedActual = normalizeUiText(actual);
  const normalizedExpected = normalizeUiText(expected);
  return match === 'exact' ? normalizedActual === normalizedExpected : normalizedActual.includes(normalizedExpected);
}

export function uiScenarioDigest(scenario: UiScenario): string {
  return uiScenarioCreateHash('sha256').update(JSON.stringify(scenario)).digest('hex');
}

import { spawn as uiAsideSpawn } from 'node:child_process';
import { constants as uiAsideFsConstants } from 'node:fs';
import { createHash as uiAsideHash, randomBytes as uiAsideRandom } from 'node:crypto';
import { mkdir as uiAsideMkdir, lstat as uiAsideLstat, open as uiAsideOpen, unlink as uiAsideUnlink } from 'node:fs/promises';
import { homedir as uiAsideHome } from 'node:os';
import { join as uiAsideJoin, resolve as uiAsideResolve, parse as uiAsideParse } from 'node:path';

export type UiExecution = {
  status: 'passed' | 'failed' | 'incomplete' | 'not_run' | 'unavailable';
  reason: string; exitCode: number | null; signal: string | null;
  runnerVersion: string | null; counts: null;
  assertions: { step: number; id: string; kind: 'visible' | 'text_exact' | 'text_substring'; status: 'passed' | 'failed' }[];
  steps: {step:number;action:'goto'|'click'|'fill'|'assert';status:'passed'|'failed'}[];
  cleanup: 'confirmed' | 'unconfirmed'; currentUiState: 'not_reobserved';
  browserBuildBinding: 'unverified'; scenarioDigest: string;
};
type UiAsideOutput = { exitCode: number | null; signal: string | null; stdout: string; stderr: string };
const uiAsideLimit = 1024 * 1024;
const uiAsideReasons = new Set(['complete', 'origin_drift', 'missing_target', 'ambiguous_target', 'hidden_target', 'assertion_failed', 'unsupported_control', 'runtime_error']);
function uiAsideResult(scenario: UiScenario, reason: string, status: UiExecution['status'] = 'incomplete'): UiExecution {
  return { status, reason, exitCode: null, signal: null, runnerVersion: null, counts: null, assertions: [], steps:[], cleanup: 'unconfirmed', currentUiState: 'not_reobserved', browserBuildBinding: 'unverified', scenarioDigest: uiAsideHash('sha256').update(JSON.stringify(scenario)).digest('hex') };
}

export function buildAsideCode(scenario: UiScenario, nonce: string): string {
  const clean = validateScenario(scenario);
  return `await (async function () {
const scenario = ${JSON.stringify(clean)};
const nonce = ${JSON.stringify(nonce)};
let owned = null, completed = 0, reason = 'complete';
const emit = frame => console.log('UI_ASIDE_FRAME ' + JSON.stringify({version:1,nonce,...frame}));
const norm = text => String(text).replace(/\\r\\n?/g,'\\n').trim();
const origin = new URL(scenario.steps[0].url).origin;
const check = () => { if (!owned || new URL(owned.url()).origin !== origin) throw 'origin_drift'; };
try {
for (let i = 0; i < scenario.steps.length; i++) {
const step = scenario.steps[i];
if (step.action === 'goto') {
if (!owned) { owned = await openTab(step.url); check(); console.log((await snapshot(owned)).tree); check(); }
else { await owned.goto(step.url,{timeout:5000}); check(); console.log((await snapshot(owned)).diff); check(); }
} else {
check(); console.log((await snapshot(owned,{selector:step.selector})).tree); check();
const locator = owned.locator(step.selector);
const count = await locator.count();
if (count === 0) throw 'missing_target';
if (count !== 1) throw 'ambiguous_target';
if (!await locator.isVisible()) throw 'hidden_target';
check();
if (step.action === 'click' || step.action === 'fill') {
const control = await locator.evaluate(el => ({tag:el.tagName.toLowerCase(),type:el.getAttribute('type'),target:el.getAttribute('target'),name:el.getAttribute('name') || '',id:el.id || '',autocomplete:el.getAttribute('autocomplete') || '',href:el.getAttribute('href'),text:el.textContent || ''}));
const sensitive = /password|credential|token|secret|payment|credit|account|login|sign.?in|checkout|billing|email|address|phone/i;
if (sensitive.test([control.name,control.id,control.autocomplete,control.text].join(' ')) || control.target || ['submit','file','password','hidden','image'].includes(control.type)) throw 'unsupported_control';
if (step.action === 'click') {
if (control.tag !== 'button' || control.type !== 'button') throw 'unsupported_control';
await locator.click({timeout:5000});
} else {
if (!(control.tag === 'textarea' || (control.tag === 'input' && (!control.type || control.type === 'text')))) throw 'unsupported_control';
await locator.fill(step.value,{timeout:5000});
}
check(); console.log((await snapshot(owned,{selector:step.selector})).diff); check();
} else if (step.kind === 'text') {
const actual = norm(await locator.innerText({timeout:5000})), expected = norm(step.expected);
if (!(step.match === 'exact' ? actual === expected : actual.includes(expected))) { emit({type:'step',step:i,status:'failed',assertion:true}); throw 'assertion_failed'; }
}
}
check(); completed++; emit({type:'step',step:i,status:'passed',assertion:step.action === 'assert'});
}
} catch (error) { reason = ${JSON.stringify([...uiAsideReasons])}.includes(error) ? error : 'runtime_error'; }
finally {
let cleanup = 'unconfirmed';
if (owned) { try { await closeTab(owned); cleanup = 'confirmed'; } catch {} }
emit({type:'terminal',completed,reason}); emit({type:'cleanup',status:cleanup});
}
})();`;
}

export function parseAsideObservations(stdout: string, nonce: string, scenario: UiScenario, exitCode: number | null): UiExecution {
  const result = uiAsideResult(scenario, 'missing_observations');
  result.exitCode = exitCode;
  if (Buffer.byteLength(stdout) > uiAsideLimit) { result.reason = 'output_overflow'; return result; }
  let completed = 0, terminal = false, cleanup = false, failed = false;
  try {
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('UI_ASIDE_FRAME ')) continue;
      if (Buffer.byteLength(line) > 65536) throw new Error();
      const frame = JSON.parse(line.slice(15));
      if (frame.version !== 1 || frame.nonce !== nonce) throw new Error();
      const keys = Object.keys(frame).sort().join(',');
      if (frame.type === 'step') {
        if (terminal || failed || keys !== 'assertion,nonce,status,step,type,version' || frame.step !== completed || !['passed','failed'].includes(frame.status) || frame.assertion !== (scenario.steps[completed]?.action === 'assert') || completed >= scenario.steps.length) throw new Error();
        result.steps.push({step:completed,action:scenario.steps[completed].action,status:frame.status});
        if (frame.assertion) {
          const assertion = scenario.steps[completed];
          if (assertion.action !== 'assert') throw new Error();
          result.assertions.push({step:completed,id:'step-'+completed,kind:assertion.kind === 'visible' ? 'visible' : assertion.match === 'exact' ? 'text_exact' : 'text_substring',status:frame.status});
        }
        if (frame.status === 'failed') failed = true; else completed++;
      } else if (frame.type === 'terminal') {
        if (terminal || keys !== 'completed,nonce,reason,type,version' || frame.completed !== completed || !uiAsideReasons.has(frame.reason)) throw new Error();
        terminal = true; result.reason = frame.reason;
      } else if (frame.type === 'cleanup') {
        if (!terminal || cleanup || keys !== 'nonce,status,type,version' || !['confirmed','unconfirmed'].includes(frame.status)) throw new Error();
        cleanup = true; result.cleanup = frame.status;
      } else throw new Error();
    }
  } catch { result.reason = 'malformed_observations'; return result; }
  if (!terminal || !cleanup) { result.reason = 'missing_observations'; return result; }
  if (result.cleanup !== 'confirmed') { result.reason = 'cleanup_unconfirmed'; return result; }
  if (exitCode !== 0) { result.reason = 'runner_exit'; return result; }
  if (result.reason !== 'complete' || failed) { result.status = 'failed'; return result; }
  if (completed !== scenario.steps.length || result.assertions.length < 1) { result.reason = 'partial_observations'; return result; }
  result.status = 'passed'; return result;
}

async function uiAsideInvoke(args: string[], signal: AbortSignal): Promise<UiAsideOutput> {
  return new Promise((resolve, reject) => {
    const env: Record<string,string> = {};
    for (const key of ['HOME','PATH','TMPDIR']) if (process.env[key]) env[key] = process.env[key]!;
    const child = uiAsideSpawn('aside', args, { env, shell:false, detached:true, stdio:['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', bytes = 0, overflow = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const groupGone = () => {
      if (!child.pid) return true;
      try { process.kill(-child.pid,0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    const finish = (error?: Error, output?: UiAsideOutput) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort',terminate);
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      if (error) reject(error); else resolve(output!);
    };
    const terminate = () => {
      if (child.pid) { try { process.kill(-child.pid,'SIGTERM'); } catch {} }
      killTimer ??= setTimeout(() => { if (child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch {} } }, 250);
      reapTimer ??= setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(Object.assign(new Error('cleanup_unconfirmed'),{retainLock:!groupGone()}));
      },2500);
    };
    const collect = (chunk: Buffer, error: boolean) => {
      bytes += chunk.length;
      if (bytes > uiAsideLimit) { overflow = true; terminate(); return; }
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stdout.on('data', chunk => collect(chunk,false)); child.stderr.on('data', chunk => collect(chunk,true));
    signal.addEventListener('abort',terminate,{once:true});
    if (signal.aborted) terminate();
    child.once('error', error => { if (!child.pid) finish(error); else terminate(); });
    child.once('close',(exitCode, exitSignal) => {
      if (!groupGone()) { terminate(); return; }
      if (overflow) finish(new Error('output_overflow'));
      else finish(undefined,{exitCode,signal:exitSignal,stdout,stderr});
    });
  });
}

async function uiAsidePrepareLockDir(dir: string): Promise<void> {
  const absolute = uiAsideResolve(dir);
  let current = uiAsideParse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = uiAsideJoin(current,part);
    let created = false;
    try { await uiAsideMkdir(current,{mode:0o700}); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await uiAsideLstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_lock');
    const descriptor = await uiAsideOpen(current,uiAsideFsConstants.O_RDONLY | uiAsideFsConstants.O_DIRECTORY | uiAsideFsConstants.O_NOFOLLOW);
    try {
      const opened = await descriptor.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('unsafe_lock');
    } finally { await descriptor.close(); }
    if ((created || current === absolute || part === '.gjc') && ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.())) throw new Error('unsafe_lock');
  }
}

export async function runAsideScenario(scenario: UiScenario, account: string, timeoutMs = 60000, signal?: AbortSignal, deps?: { invoke?: (args:string[],signal:AbortSignal)=>Promise<UiAsideOutput>; lockDir?:string }): Promise<UiExecution> {
  const clean = validateScenario(scenario);
  if (!account || account.length > 256 || /[\x00-\x1f\x7f]/.test(account)) return uiAsideResult(clean,'missing_account','not_run');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 90000) return uiAsideResult(clean,'invalid_timeout','not_run');
  if (signal?.aborted) return uiAsideResult(clean,'cancelled','not_run');
  const dir = deps?.lockDir ?? uiAsideJoin(uiAsideHome(),'.gjc','ui-regression-lock');
  const path = uiAsideJoin(dir,'run.lock');
  let lock: Awaited<ReturnType<typeof uiAsideOpen>>;
  try {
    await uiAsidePrepareLockDir(dir);
    const info = await uiAsideLstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) return uiAsideResult(clean,'unsafe_lock','not_run');
    lock = await uiAsideOpen(path,uiAsideFsConstants.O_WRONLY | uiAsideFsConstants.O_CREAT | uiAsideFsConstants.O_EXCL | uiAsideFsConstants.O_NOFOLLOW,0o600);
    const after = await uiAsideLstat(dir);
    if (after.dev !== info.dev || after.ino !== info.ino || after.isSymbolicLink()) {
      await lock.close();
      return uiAsideResult(clean,'unsafe_lock','not_run');
    }
  } catch (error) { return uiAsideResult(clean,(error as NodeJS.ErrnoException).code === 'EEXIST' ? 'busy' : 'lock_unavailable','not_run'); }
  const controller = new AbortController();
  let retainLock = false;
  let mockTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort',cancel,{once:true});
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); },timeoutMs);
  try {
    const nonce = uiAsideRandom(24).toString('hex');
    const invocation = (deps?.invoke ?? uiAsideInvoke)(['repl','--account',account,buildAsideCode(clean,nonce)],controller.signal);
    const output = deps?.invoke ? await Promise.race([invocation,new Promise<never>((_resolve,reject) => {
      const abort = () => { mockTimer = setTimeout(() => reject(new Error('cleanup_unconfirmed')),100); };
      if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort',abort,{once:true});
    })]) : await invocation;
    const result = parseAsideObservations(output.stdout,nonce,clean,output.exitCode);
    result.signal = output.signal;
    if (output.signal) { result.status = 'incomplete'; result.reason = 'runner_signal'; }
    if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > uiAsideLimit) { result.status = 'incomplete'; result.reason = 'output_overflow'; }
    if (controller.signal.aborted) { result.status = 'incomplete'; result.reason = timedOut ? 'timeout' : 'cancelled'; result.cleanup = 'unconfirmed'; }
    return result;
  } catch (error) {
    retainLock = (error as Error & {retainLock?:boolean}).retainLock === true;
    const code = (error as NodeJS.ErrnoException).code;
    return uiAsideResult(clean,(error as Error).message === 'cleanup_unconfirmed' ? 'cleanup_unconfirmed' : controller.signal.aborted ? (timedOut ? 'timeout' : 'cancelled') : (error as Error).message === 'output_overflow' ? 'output_overflow' : code === 'ENOENT' ? 'missing_cli' : 'runner_unavailable',code === 'ENOENT' ? 'unavailable' : 'incomplete');
  } finally { clearTimeout(timer); if (mockTimer) clearTimeout(mockTimer); signal?.removeEventListener('abort',cancel); await lock.close(); if (!retainLock) await uiAsideUnlink(path); }
}


export default function uiRegressionRun(pi:{cwd:string;typebox:{Type:any}}) {
 const T=pi.typebox.Type;
 return {
  name:'ui_regression_run',label:'UI Regression Run',
  description:'Execute one explicitly authorized non-sensitive loopback scenario through ONE Aside REPL invocation. Inspect handlers first: loopback is not a sandbox. Open/close only the owned new tab, fresh snapshots and unique visible current CSS locators, literal exact/substring assertions; no screenshots, user tabs, result imports or arbitrary JS. Account is explicit ephemeral routing, never in receipts. Automatically attempt Jev adequacy every invocation at https://openrouter.ai/api/alpha/decisions (typesafe/jev-1.13). Supply assessment context when known; omission does not disable the call. Only validated selected summaries/notes and bounded host facts leave, not scenario text, account, inputs, selectors or snapshots. Warning-only; no repair loops or blocking. Missing context is not adequate verification. Historical browser evidence is not current/deployed UI evidence.',
  parameters:T.Object({
   account:T.String({minLength:1,maxLength:64,description:'Explicit Aside account routing only; not persisted or included in evidence.'}),
   scenario:T.Object({id:T.String({maxLength:64}),expectedBehavior:T.String({maxLength:2000}),steps:T.Array(T.Union([
    T.Object({action:T.Literal('goto'),url:T.String()},{additionalProperties:false}),
    T.Object({action:T.Literal('click'),selector:T.String({maxLength:256})},{additionalProperties:false}),
    T.Object({action:T.Literal('fill'),selector:T.String({maxLength:256}),value:T.String({maxLength:1000})},{additionalProperties:false}),
    T.Object({action:T.Literal('assert'),selector:T.String({maxLength:256}),kind:T.Literal('visible')},{additionalProperties:false}),
    T.Object({action:T.Literal('assert'),selector:T.String({maxLength:256}),kind:T.Literal('text'),match:T.Union([T.Literal('exact'),T.Literal('substring')]),expected:T.String({maxLength:2000})},{additionalProperties:false})
   ]),{minItems:1,maxItems:20})},{additionalProperties:false}),
   timeoutMs:T.Optional(T.Number({minimum:1,maximum:90000,description:'Total timeout default 60,000 ms, maximum 90,000 ms, below Aside 120 seconds.'})),
   assessment:T.Optional(T.Object({changeSummary:T.String({maxLength:2000}),expectedBehavior:T.String({maxLength:2000}),caseNotes:T.Optional(T.Array(T.Object({id:T.String(),note:T.String({maxLength:300})}),{maxItems:8}))},{additionalProperties:false}))
  },{additionalProperties:false}),
  async execute(toolCallId:string,params:{account:string;scenario:unknown;timeoutMs?:number;assessment?:unknown},_update?:unknown,_ctx?:unknown,signal?:AbortSignal) {
   const started=performance.now();const text=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value)}]});
   try {
    if(!params||Object.keys(params).some(k=>!['account','scenario','timeoutMs','assessment'].includes(k))||typeof params.account!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(params.account)||(params.timeoutMs!==undefined&&(!Number.isSafeInteger(params.timeoutMs)||params.timeoutMs<1||params.timeoutMs>90000))) throw Error('invalid_input');
    const scenario=validateScenario(params.scenario);const root=await actualRepository(pi.cwd);
    const specDigest=specFingerprint({scenario,timeoutMs:params.timeoutMs??60000});const before=await fingerprintSource(root,specDigest);
    const execution=await runAsideScenario(scenario,params.account,params.timeoutMs??60000,signal);
    const after=await fingerprintSource(root,specDigest),freshness=freshnessFor(before,after);
    const receipt=createReceipt({plugin:'ui-regression',toolCallId,repositoryDigest:await repositoryDigest(root),durationMs:Math.round(performance.now()-started),specDigest,before,after,freshness,execution,warnings:[],limitations:['Historical browser observations are not current UI observations.','Browser build/source binding is unverified; loopback is not a sandbox.','Snapshots, inputs and account routing are discarded; excluded source paths are not covered.']});
    const storage=await persistReceipt(receipt);
    const assessment=await assessAdequacy(params.assessment,{status:execution.status,counts:null,freshness,caseIds:execution.assertions.map(a=>a.id),assertions:execution.assertions});
    return text({receipt,...storage,assessment,...staticReceiptGuidance(execution,freshness,assessment)});
   }catch{
    const execution={status:'not_run',reason:'invalid_or_unavailable_input'};
    const assessment=await assessAdequacy(undefined,{status:execution.status,counts:null,freshness:'unavailable'});
    return text({execution,assessment,...staticReceiptGuidance(execution,'unavailable',assessment)});
   }
  }
 };
}
