import * as receiptFs from 'node:fs/promises';
import { constants as receiptConstants } from 'node:fs';
import * as receiptPath from 'node:path';
import { createHash as receiptHash, randomUUID as receiptUUID } from 'node:crypto';
import { execFile as receiptExecFile } from 'node:child_process';
import { promisify as receiptPromisify } from 'node:util';
import { pluginResultsRoot, ensurePrivateResultDirectory, readPrivateResultFile } from '../../shared/lib/results';

const receiptExec = receiptPromisify(receiptExecFile);
// Test files a receipt can actually execute: Node's own runner with a fixed reporter, no loaders and no
// custom flags. TypeScript is in the list because Node >= 22.18 strips types natively for .ts/.mts/.cts;
// JSX/TSX needs a transform and stays out, so a file the runner cannot execute is never admitted or
// demanded as coverage (JJO-1161 P2). The run admission and the changed-test coverage demand both read
// this one rule, so they can never disagree about which changed tests a receipt must cover.
export const RECEIPT_TEST_FILE = /\.(?:js|mjs|cjs|ts|mts|cts)$/;
const RECEIPT_TYPESCRIPT_TEST_FILE = /\.(?:ts|mts|cts)$/;
export const receiptIsTypeScriptTestFile = (file: string): boolean => RECEIPT_TYPESCRIPT_TEST_FILE.test(file);
export const receiptSupportsTypeScriptTests = (version: string | null): boolean => {
 const match = /^v(\d+)\.(\d+)\.\d+$/.exec(version ?? '');
 if (!match) return false;
 const major = Number(match[1]);
 return major > 22 || (major === 22 && Number(match[2]) >= 18);
};
export const RECEIPT_EXCLUSIONS = ['.git', '.gjc', '.gjc-plugin', 'node_modules', '.next', 'dist', 'coverage', '.env*', '*credentials*', '*.pem', '*.key', '*secret*', '*cookie*', '*private*'];
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
export const RECEIPT_REPOSITORY_REASONS = ['not_a_repository', 'invalid_repository', 'repository_outside_session_cwd'] as const;
function receiptWithin(parent: string, child: string): boolean {
 const rel = receiptPath.relative(parent, child);
 return rel === '' || (rel !== '..' && !rel.startsWith(`..${receiptPath.sep}`) && !receiptPath.isAbsolute(rel));
}
// Without `repository` the session directory must sit inside a Git work tree. An explicit
// `repository` (absolute or relative to the session directory) must be a work-tree root that is
// the session's own repository or lies inside the session directory; nothing outside it is reachable.
export async function resolveReceiptRepository(cwd: string, repository?: unknown): Promise<string> {
 const fail = (reason: (typeof RECEIPT_REPOSITORY_REASONS)[number]): never => { throw new Error(reason); };
 if (repository === undefined) {
  try { return await actualRepository(cwd); } catch { return fail('not_a_repository'); }
 }
 if (typeof repository !== 'string' || !repository || repository.length > 4096 || repository.includes('\0')) return fail('invalid_repository');
 let session = '', target = '';
 try {
  session = await receiptFs.realpath(cwd);
  target = await receiptFs.realpath(receiptPath.resolve(cwd, repository));
  if (!(await receiptFs.stat(target)).isDirectory()) throw new Error('not_directory');
 } catch { return fail('invalid_repository'); }
 let root = '';
 try { root = await actualRepository(target); } catch { return fail('not_a_repository'); }
 if (root !== target) return fail('invalid_repository');
 if (!receiptWithin(session, root) && !receiptWithin(root, session)) return fail('repository_outside_session_cwd');
 return root;
}
export async function repositoryDigest(root: string): Promise<string> { return receiptDigest(await receiptFs.realpath(root)); }
function excludedReceiptPath(name: string): boolean {
 return name.split('/').some(p => ['.git', '.gjc', '.gjc-plugin', 'node_modules', '.next', 'dist', 'coverage'].includes(p) || /^\.env/i.test(p) || /credentials|secret|cookie|private/i.test(p) || /\.(pem|key)$/i.test(p));
}
function receiptPlainData(value: unknown, depth = 0): boolean {
 if (depth > 8) return false;
 if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
 if (typeof value === 'number') return Number.isFinite(value);
 if (!value || typeof value !== 'object') return false;
 const array = Array.isArray(value);
 if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
 const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
 if (keys.length > 65 || (array && value.length > 64)) return false;
 for (const key of keys) {
  if (array && key === 'length') continue;
  if (typeof key !== 'string' || (array && !/^(?:0|[1-9]\d*)$/.test(key))) return false;
  const descriptor = descriptors[key];
  if (!descriptor.enumerable || !('value' in descriptor) || !receiptPlainData(descriptor.value, depth + 1)) return false;
 }
 return !array || keys.length === value.length + 1;
}
function normalizedReceiptInputs(files: unknown): string[] | null {
 if (!receiptPlainData(files) || !Array.isArray(files) || files.length > 32) return null;
 const normalized: string[] = [];
 for (const file of files) {
  if (typeof file !== 'string' || !file || file.length > 4096 || /[\x00-\x1f\x7f\\]/.test(file) || receiptPath.posix.isAbsolute(file) || receiptPath.win32.isAbsolute(file) || file.split('/').some(p => p === '..' || p.startsWith('-')) || !RECEIPT_TEST_FILE.test(file)) return null;
  const name = receiptPath.posix.normalize(file);
  if (excludedReceiptPath(name) || normalized.includes(name)) return null;
  normalized.push(name);
 }
 return normalized.sort();
}
export async function fingerprintSource(root: string, specDigest: string, files: string[] = []): Promise<SourceFingerprint> {
 const unavailable = (reason: string): SourceFingerprint => ({ status: 'unavailable', digest: null, reason, files: 0, bytes: 0, exclusions: RECEIPT_EXCLUSIONS });
 try {
  if (!receiptHex.test(specDigest)) return unavailable('invalid_spec_digest');
  const selected = normalizedReceiptInputs(files);
  if (!selected) return unavailable('invalid_selected_inputs');
  const selectedSet = new Set(selected);
  const rootStat = await receiptFs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await receiptFs.realpath(root) !== receiptPath.resolve(root)) return unavailable('unsafe_root');
  const options = { cwd: root, env: receiptChildEnv(), timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' as const };
  const head = (await receiptExec('git', ['rev-parse', 'HEAD'], options)).stdout;
  const index = (await receiptExec('git', ['ls-files', '--stage', '-z'], options)).stdout;
  const names = (await receiptExec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], options)).stdout;
  const paths = [...new Set([...names.toString('utf8').split('\0').filter(n => n && !excludedReceiptPath(n)), ...selected])].sort();
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
   if (receiptPath.isAbsolute(name) || name.split('/').some(p => p === '..' || p === '.' || !p)) return unavailable('unsafe_path');
   const file = receiptPath.join(root, name);
   // Do not follow symlinked parent directories into unrelated source.
   let parent = root;
   const parents = [{ path: root, stat: rootStat }];
   for (const part of name.split('/').slice(0, -1)) {
    parent = receiptPath.join(parent, part);
    try {
     const stat = await receiptFs.lstat(parent);
     if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable('symlink_parent');
     parents.push({ path: parent, stat });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || selectedSet.has(name)) return unavailable('selected_input_unavailable'); }
   }
   add(name);
   let st;
   try { st = await receiptFs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (selectedSet.has(name)) return unavailable('selected_input_unavailable'); add('deleted'); continue; } throw error; }
   add(String(st.mode & 0o777));
   if (selectedSet.has(name) && !st.isFile()) return unavailable('unsafe_selected_input');
   if (!st.isFile() && !st.isSymbolicLink()) return unavailable('unsupported_file');
   if (bytes + st.size > 128 * 1024 * 1024) return unavailable('byte_limit');
   let data: Buffer;
   if (st.isSymbolicLink()) data = Buffer.from(await receiptFs.readlink(file));
   else {
    const handle = await receiptFs.open(file, receiptConstants.O_RDONLY | receiptConstants.O_NOFOLLOW);
    try {
     const current = await handle.stat();
     if (current.dev !== st.dev || current.ino !== st.ino || current.size !== st.size || current.mtimeMs !== st.mtimeMs || current.ctimeMs !== st.ctimeMs || !current.isFile()) return unavailable('changed_while_hashing');
     data = Buffer.alloc(current.size);
     let offset = 0;
     while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, offset);
      if (!read.bytesRead) return unavailable('changed_while_hashing');
      offset += read.bytesRead;
     }
     if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) return unavailable('changed_while_hashing');
     const last = await handle.stat();
     if (current.size !== last.size || current.mtimeMs !== last.mtimeMs || current.ctimeMs !== last.ctimeMs) return unavailable('changed_while_hashing');
    } finally { await handle.close(); }
   }
   const lastPath = await receiptFs.lstat(file);
   if (lastPath.dev !== st.dev || lastPath.ino !== st.ino || lastPath.mode !== st.mode || lastPath.size !== st.size || lastPath.mtimeMs !== st.mtimeMs || lastPath.ctimeMs !== st.ctimeMs) return unavailable('changed_while_hashing');
   for (const entry of parents) {
    const last = await receiptFs.lstat(entry.path);
    if (!last.isDirectory() || last.isSymbolicLink() || last.dev !== entry.stat.dev || last.ino !== entry.stat.ino) return unavailable('changed_while_hashing');
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
const RECEIPT_INPUT_ACTIONS: Record<string, string> = {
 not_a_repository: 'The directory is not inside a Git work tree; pass `repository` with the root of a repository inside the session directory.',
 invalid_repository: '`repository` must name an existing Git work-tree root, absolute or relative to the session directory.',
 repository_outside_session_cwd: '`repository` must be the session repository or a repository inside the session directory.',
};
// Rejections raised by validateTestFiles before any test runs.
export const RECEIPT_TEST_PATH_REASONS = ['invalid_file_count', 'invalid_root', 'invalid_test_path', 'path_escape', 'symlink_test_path', 'invalid_test_file', 'missing_test_file', 'duplicate_test_file'];
const RECEIPT_UI_INPUT_ACTIONS: Record<string, string> = {
 scenario_object: 'Provide a plain scenario object with id, expectedBehavior and steps.',
 scenario_fields: 'Use exactly the documented fields for each scenario step; imported results and extra fields are unsupported.',
 scenario_id: 'Use a non-sensitive scenario id of 1-64 letters, digits, underscores or hyphens, beginning with a letter or digit.',
 scenario_expected_behavior: 'Describe the non-sensitive expected behavior in 1-2000 characters.',
 scenario_steps: 'Provide 1-20 explicit supported steps.',
 scenario_step: 'Provide each step as a plain object with a supported action.',
 scenario_first_goto: 'Start the scenario with goto on an inspected, owned non-sensitive loopback fixture.',
 scenario_origin: 'Keep all navigation on the same inspected loopback origin.',
 scenario_url: 'Use a valid explicit HTTP or HTTPS loopback URL without sensitive content.',
 scenario_url_scheme: 'Use HTTP or HTTPS for an inspected loopback fixture, not another URL scheme.',
 scenario_url_host: 'This tool only supports explicit localhost, 127.0.0.1 or [::1]. Use the separately authorized browser workflow for real or deployed sites.',
 scenario_url_unsafe: 'Use an inspected loopback URL without credentials, query, fragment or backslashes; do not disguise sensitive destinations.',
 scenario_url_sensitive: 'Authentication, account, payment and other sensitive routes are unsupported. Use a separate authorized browser workflow for those paths; do not rename them to evade the guard.',
 scenario_selector: 'Use a current visible CSS selector of 1-256 characters for the owned fixture.',
 scenario_selector_unsafe: 'Use only non-sensitive supported visible controls and current CSS selectors. Authentication, uploads, payment, script expressions and snapshot references are unsupported.',
 scenario_value: 'Use only non-sensitive fixture text within the documented fill limit.',
 scenario_assert_kind: 'Use a visible or text DOM assertion; screenshots and arbitrary JavaScript are unsupported.',
 scenario_match: 'Choose exact or substring for a literal text assertion.',
 scenario_expected: 'Use bounded non-sensitive literal expected text; substring assertions must not be empty.',
 scenario_no_assertion: 'Include at least one visible or literal text assertion on the owned fixture.',
 scenario_action: 'Use only goto, click, fill or assert. Arbitrary JavaScript, screenshots and result imports are unsupported.',
 scenario_sensitive: 'Remove sensitive data from the fixture scenario. Real sensitive workflows require a separate authorized browser workflow; do not encode data to evade screening.',
};
export function staticReceiptGuidance(execution: Record<string, unknown>, freshness: ReceiptFreshness, assessment?: {status: string; reason?: string; answers?: Record<string, {choice:string;confidence?:number;probabilities?:Record<string,number|undefined>}>}, receiptWarnings: string[] = [], context: {tool?: 'verification' | 'ui'; allowedCaseIds?: string[]} = {}) {
 const warnings: string[] = [], recommendedNextActions: string[] = [];
 const missingBinaries = receiptWarnings.filter(w => w.startsWith('missing_binary:')).map(w => w.slice('missing_binary:'.length));
 const reason = String(execution.reason);
 if (assessment?.reason === 'invalid_case_id') {
  warnings.push('assessment_case_id_rejected');
  const allowed = [...new Set((context.allowedCaseIds ?? []).filter(id => /^(?:run|step-(?:0|[1-9]|1[0-9]))$/.test(id)))].slice(0,20);
  recommendedNextActions.push(allowed.length
   ? `Use unique assessment.caseNotes ids from this invocation: ${allowed.join(', ')}.${context.tool === 'ui' ? ' UI ids refer only to observed assertions, not planned coverage.' : ''}`
   : 'This invocation has no observed eligible case ids. Omit caseNotes; do not invent ids or infer coverage from planned assertions.');
 } else if (assessment?.reason === 'invalid_context') {
  warnings.push('assessment_context_rejected');
  recommendedNextActions.push('Provide only non-sensitive changeSummary and expectedBehavior (1-2000 characters), with at most 8 unique case notes of 1-300 characters and documented ids. Do not include URLs, paths, credentials or raw source.');
 }
 if (context.tool === 'ui' && execution.status === 'not_run') {
  warnings.push('execution_not_passed');
  if (Object.hasOwn(RECEIPT_UI_INPUT_ACTIONS, reason)) {
   warnings.push('scenario_rejected');
   recommendedNextActions.push(`${reason}: ${RECEIPT_UI_INPUT_ACTIONS[reason]}`);
  } else if (Object.hasOwn(RECEIPT_INPUT_ACTIONS, reason)) recommendedNextActions.push(RECEIPT_INPUT_ACTIONS[reason]);
  else if (!recommendedNextActions.length) recommendedNextActions.push('Correct the documented account routing, timeout and scenario input shape. Use an inspected owned non-sensitive loopback fixture; unsupported workflows need a separate authorized browser entry point.');
  return {warnings, recommendedNextActions:recommendedNextActions.slice(0,3), advisoryOnly:true};
 }
 if (execution.status !== 'passed') {
  warnings.push('execution_not_passed');
  if (missingBinaries.length) { warnings.push('missing_binary'); recommendedNextActions.push(`Tests could not start ${missingBinaries.join(', ')}: the runner passes the host PATH without HOME. Install it on PATH or select tests that do not spawn it.`); }
  else if (Object.hasOwn(RECEIPT_INPUT_ACTIONS, reason)) recommendedNextActions.push(RECEIPT_INPUT_ACTIONS[reason]);
  else if (RECEIPT_TEST_PATH_REASONS.includes(reason)) recommendedNextActions.push('Pass 1-32 existing repository-relative .js/.mjs/.cjs/.ts/.mts/.cts test files: no absolute paths, .., symlinks or duplicates.');
  else recommendedNextActions.push(context.tool === 'ui' ? 'Inspect the owned fixture and the failed or incomplete DOM assertion; use current visible selectors and literal expectations.' : 'Inspect the relevant failing or incomplete tests locally.');
 }
 if (freshness !== 'fresh') { warnings.push('source_not_fresh'); recommendedNextActions.push(context.tool === 'ui' ? 'Stored browser observations do not establish current UI state. Reobserve only an allowed, authorized non-sensitive loopback scenario.' : 'Run verification again against the current source.'); }
 if (assessment && (assessment.status !== 'scored' || Object.values(assessment.answers ?? {}).some(a => a.confidence === undefined || a.confidence < 0.8 || a.probabilities?.[a.choice] === undefined || Number(a.probabilities[a.choice]) < 0.8))) { warnings.push('adequacy_unknown'); recommendedNextActions.push('Inspect coverage and boundary evidence; no confident adequacy claim is available.'); }
 else if (assessment && Object.values(assessment.answers ?? {}).some(a => ['gap', 'missing'].includes(a.choice))) { warnings.push('adequacy_gap'); recommendedNextActions.push(context.tool === 'ui' ? 'Inspect changed behavior and add relevant allowed DOM boundary assertions.' : 'Inspect changed behavior and add relevant boundary tests.'); }
 return { warnings, recommendedNextActions: recommendedNextActions.slice(0, 3), advisoryOnly: true };
}

export function receiptStoreBase(): string { return receiptPath.join(pluginResultsRoot(), 'verification-receipts', 'receipts', 'v1'); }
async function readPrivateReceiptFile(file: string): Promise<Buffer> {
 return readPrivateResultFile(file, 32768);
}
export function validReceiptMetadata(value: unknown, repo: string): value is VerificationReceipt {
 if (!receiptPlainData(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
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
type ReceiptInputManifest = { receiptId: string; repositoryDigest: string; specDigest: string; files: string[]; digest: string };
type ReceiptEnvelope = { storageSchemaVersion: 1; receipt: VerificationReceipt; selectedInputs: ReceiptInputManifest };
export type ReceiptPersistence = { persisted: boolean; reason: string; count?: number; bytes?: number; nearCapacity?: boolean };
function receiptInputDigest(receipt: VerificationReceipt, files: string[]): string {
 return receiptDigest(JSON.stringify([receipt.id, receipt.repositoryDigest, receipt.specDigest, files]));
}
function validReceiptEnvelope(value: unknown, repo: string): value is ReceiptEnvelope {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const envelope = value as ReceiptEnvelope;
 if (Object.keys(envelope).length !== 3 || Object.keys(envelope).some(k => !['storageSchemaVersion','receipt','selectedInputs'].includes(k)) || envelope.storageSchemaVersion !== 1 || !validReceiptMetadata(envelope.receipt, repo)) return false;
 const manifest = envelope.selectedInputs;
 if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).length !== 5 || Object.keys(manifest).some(k => !['receiptId','repositoryDigest','specDigest','files','digest'].includes(k))) return false;
 const files = normalizedReceiptInputs(manifest.files);
 return files !== null && JSON.stringify(files) === JSON.stringify(manifest.files) && manifest.receiptId === envelope.receipt.id && manifest.repositoryDigest === repo && manifest.specDigest === envelope.receipt.specDigest && manifest.digest === receiptInputDigest(envelope.receipt, files);
}
export async function persistReceipt(receipt: VerificationReceipt, base = receiptStoreBase(), files: string[] = []): Promise<ReceiptPersistence> {
 let lock: receiptFs.FileHandle | undefined; let lockFile = ''; let temp = '';
 let lockIdentity: {dev: number; ino: number} | undefined; let tempIdentity: {dev: number; ino: number} | undefined;
 let count: number | null = null, bytes: number | null = null;
 const result = (persisted: boolean, reason: string): ReceiptPersistence => count === null || bytes === null ? { persisted, reason } : { persisted, reason, count, bytes, nearCapacity: count >= 180 || bytes >= 2 * 1024 * 1024 * 0.9 };
 const removeOwned = async (file: string, identity: {dev: number; ino: number} | undefined) => {
  if (!identity) return;
  try {
   await ensurePrivateResultDirectory(receiptPath.dirname(file), false);
   const stat = await receiptFs.lstat(file);
   if (stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino && stat.uid === process.getuid?.()) await receiptFs.unlink(file);
  } catch {}
 };
 try {
  if (!receiptPlainData(receipt) || !receipt || !validReceiptMetadata(receipt, receipt.repositoryDigest) || !receiptHex.test(receipt.repositoryDigest)) return result(false, 'invalid_metadata');
  receipt = JSON.parse(JSON.stringify(receipt));
  const normalized = normalizedReceiptInputs(files);
  if (!normalized) return result(false, 'invalid_metadata');
  const envelope: ReceiptEnvelope = { storageSchemaVersion: 1, receipt, selectedInputs: { receiptId: receipt.id, repositoryDigest: receipt.repositoryDigest, specDigest: receipt.specDigest, files: normalized, digest: receiptInputDigest(receipt, normalized) } };
  const body = JSON.stringify(envelope), bodyBytes = Buffer.byteLength(body);
  await ensurePrivateResultDirectory(base, true);
  const dir = receiptPath.join(base, receipt.repositoryDigest); await ensurePrivateResultDirectory(dir, true);
  const directoryIdentity = await receiptFs.lstat(dir);
  const checkDirectory = async () => {
   await ensurePrivateResultDirectory(base, false); await ensurePrivateResultDirectory(dir, false);
   const current = await receiptFs.lstat(dir);
   if (current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino) throw new Error('changed_store');
  };
  lockFile = receiptPath.join(dir, '.admission.lock');
  try { lock = await receiptFs.open(lockFile, receiptConstants.O_WRONLY | receiptConstants.O_CREAT | receiptConstants.O_EXCL | receiptConstants.O_NOFOLLOW, 0o600); } catch (error) { return result(false, (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'store_busy' : 'store_unavailable'); }
  const lockStat = await lock.stat(); lockIdentity = lockStat;
  if (!lockStat.isFile() || lockStat.nlink !== 1 || (lockStat.mode & 0o7777) !== 0o600 || lockStat.uid !== process.getuid?.()) return result(false, 'store_unavailable');
  await checkDirectory();
  const entries = await receiptFs.readdir(dir); count = 0; bytes = 0;
  if (entries.length > 201) { count = null; bytes = null; return result(false, 'store_full'); }
  for (const name of entries) {
   if (name === '.admission.lock') continue;
   if (!receiptIdPattern.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) { count = null; bytes = null; return result(false, 'store_corrupt'); }
   try {
    const data = await readPrivateReceiptFile(receiptPath.join(dir, name));
    const prior = JSON.parse(data.toString());
    if (!validReceiptEnvelope(prior, receipt.repositoryDigest) || prior.receipt.id + '.json' !== name) throw new Error('invalid_envelope');
    count++; bytes += data.length;
   } catch { count = null; bytes = null; return result(false, 'store_corrupt'); }
  }
  if (bodyBytes > 32768 || count >= 200 || bytes + bodyBytes > 2 * 1024 * 1024) return result(false, 'store_full');
  await checkDirectory();
  temp = receiptPath.join(dir, '.' + receiptUUID() + '.tmp');
  const handle = await receiptFs.open(temp, receiptConstants.O_WRONLY | receiptConstants.O_CREAT | receiptConstants.O_EXCL | receiptConstants.O_NOFOLLOW, 0o600);
  try {
   const stat = await handle.stat(); tempIdentity = stat;
   if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('unsafe_store_file');
   await handle.writeFile(body); await handle.sync();
  } finally { await handle.close(); }
  await checkDirectory();
  const staged = await readPrivateReceiptFile(temp);
  if (staged.toString() !== body) throw new Error('changed_store_file');
  const stagedStat = await receiptFs.lstat(temp);
  if (stagedStat.dev !== tempIdentity.dev || stagedStat.ino !== tempIdentity.ino) throw new Error('changed_store_file');
  // link publishes atomically without replacing an existing receipt.
  const published = receiptPath.join(dir, receipt.id + '.json');
  await receiptFs.link(temp, published); await receiptFs.unlink(temp); temp = '';
  await checkDirectory();
  if ((await readPrivateReceiptFile(published)).toString() !== body) throw new Error('changed_store_file');
  const directory = await receiptFs.open(dir, receiptConstants.O_RDONLY | receiptConstants.O_DIRECTORY | receiptConstants.O_NOFOLLOW);
  try {
   const current = await directory.stat();
   if (current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino) throw new Error('changed_store');
   await directory.sync();
  } finally { await directory.close(); }
  await checkDirectory();
  count++; bytes += bodyBytes;
  return result(true, 'stored');
 } catch { count = null; bytes = null; return result(false, 'store_unavailable'); }
 finally { if (temp) await removeOwned(temp, tempIdentity); if (lock) { await lock.close().catch(() => {}); await removeOwned(lockFile, lockIdentity); } }
}
async function loadReceiptEnvelope(root: string, id: string, base: string): Promise<ReceiptEnvelope | null> {
 try {
  if (!receiptIdPattern.test(id)) return null;
  const repo = await repositoryDigest(root); const dir = receiptPath.join(base, repo);
  await ensurePrivateResultDirectory(base, false); await ensurePrivateResultDirectory(dir, false);
  const data = await readPrivateReceiptFile(receiptPath.join(dir, id + '.json')); const result = JSON.parse(data.toString());
  return validReceiptEnvelope(result, repo) && result.receipt.id === id ? result : null;
 } catch { return null; }
}
export async function loadReceipt(root: string, id: string, base = receiptStoreBase()): Promise<VerificationReceipt | null> {
 return (await loadReceiptEnvelope(root, id, base))?.receipt ?? null;
}
export async function loadReceiptInputs(root: string, id: string, base = receiptStoreBase()): Promise<string[] | null> {
 return (await loadReceiptEnvelope(root, id, base))?.selectedInputs.files ?? null;
}
export async function currentReceiptFreshness(root: string, receipt: VerificationReceipt, base = receiptStoreBase()): Promise<ReceiptFreshness> {
 try {
  if (!receiptPlainData(receipt) || !receipt || !validReceiptMetadata(receipt, receipt.repositoryDigest)) return 'unavailable';
  const snapshot = JSON.stringify(receipt);
  const envelope = await loadReceiptEnvelope(root, receipt.id, base);
  if (!envelope || JSON.stringify(envelope.receipt) !== snapshot) return 'unavailable';
  const stored = envelope.receipt;
  const now = await fingerprintSource(root, stored.specDigest, envelope.selectedInputs.files);
  if (!now.digest || !stored.after.digest || !stored.before.digest) return 'unavailable';
  if (now.digest !== stored.after.digest) return 'stale';
  return stored.freshness === 'changed_during_run' ? 'changed_during_run' : 'fresh';
 } catch { return 'unavailable'; }
}
