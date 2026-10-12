import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
 buildGateText, captureBaseline, collectReceiptCandidates, evaluateRepoGates, gitDeltaFacts, isCoveringCandidate, jobDedupKey,
 latestReceiptSummary, loopStateFile, pruneLoopState, readLoopState, recordGate, recordPendingAsync, recordTaskBaseline,
 requiredActionsFor, resolveRepoRoot, serializeLoopState, sessionDigestOf, taskDedupKey, toolCallDigestFor, withLoopStateWrite,
 emptyLoopState, MAX_GATES, MAX_STATE_BYTES, type LoopGateEmission, type LoopState,
} from '../lib/loop';
import { createReceipt, fingerprintSource, freshnessFor, persistReceipt, receiptStoreBase, repositoryDigest, specFingerprint, type VerificationReceipt } from '../lib/receipts';

const owned: string[] = [];
const originalHome = process.env.HOME;
afterEach(async () => {
 process.env.HOME = originalHome;
 for (const dir of owned.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
 return execFileSync('git', args, { cwd, env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8' }).trim();
}
async function makeRepo(): Promise<string> {
 const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-repo-')));
 owned.push(root);
 git(root, 'init', '-q');
 git(root, 'config', 'user.email', 't@example.com');
 git(root, 'config', 'user.name', 'T');
 await fs.writeFile(path.join(root, 'a.txt'), 'one\n');
 git(root, 'add', '.');
 git(root, 'commit', '-q', '-m', 'init');
 return root;
}
async function makeHome(): Promise<string> {
 const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-home-')));
 owned.push(home);
 process.env.HOME = home;
 return home;
}
type ReceiptStatus = 'passed' | 'failed' | 'no_tests' | 'incomplete';
async function makeReceipt(root: string, files: string[], status: ReceiptStatus, mutateDuring?: () => Promise<void>): Promise<VerificationReceipt> {
 const specDigest = specFingerprint({ runner: 'node:test', files });
 const before = await fingerprintSource(root, specDigest, files);
 if (mutateDuring) await mutateDuring();
 const after = mutateDuring ? await fingerprintSource(root, specDigest, files) : before;
 const execution = status === 'passed'
  ? { status, reason: 'complete', exitCode: 0, signal: null, runnerVersion: null, counts: { tests: 1, suites: 0, topLevel: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 } }
  : status === 'failed'
   ? { status, reason: 'native_failure', exitCode: 1, signal: null, runnerVersion: null, counts: { tests: 1, suites: 0, topLevel: 1, passed: 0, failed: 1, skipped: 0, todo: 0, cancelled: 0 } }
   : { status, reason: 'complete', exitCode: null, signal: null, runnerVersion: null, counts: null };
 const receipt = createReceipt({ plugin: 'verification-receipts', toolCallId: 'tool-' + Math.random().toString(16).slice(2), repositoryDigest: await repositoryDigest(root), durationMs: 5, specDigest, before, after, freshness: freshnessFor(before, after), execution, warnings: [], limitations: ['test fixture'] });
 const persisted = await persistReceipt(receipt, receiptStoreBase(), files);
 expect(persisted.persisted).toBe(true);
 return receipt;
}
async function gateEmission(overrides: Partial<LoopGateEmission> = {}): Promise<LoopGateEmission> {
 return { trigger: 'task', dedupKey: taskDedupKey('call-' + Math.random().toString(16).slice(2)), facts: 'available', bindingEvidence: 'absent', baselineToolCallId: null, changedFiles: 0, commits: 0, receiptState: 'none', noChange: false, ...overrides };
}

test('gate text full and compact stay bounded, deterministic and free of absolute paths', async () => {
 const root = await makeRepo();
 const base = await captureBaseline(root);
 expect(base).not.toBeNull();
 const names = Array.from({ length: 12 }, (_, index) => 'dir/file-' + index + '.ts');
 const view = {
  tool: 'task', idShort: 'abcdef12', facts: 'available' as const, root, baselinePresent: true, baselineAt: base!.capturedAt,
  treeClean: false, effectsClean: false, changedFiles: 12, changedNames: names, namesOverflow: false, commits: 2,
  binding: 'absent' as const, receipt: { state: 'present' as const, id: 'deadbeef-0000-4000-8000-000000000000', observedAt: null, status: 'failed', freshness: 'stale' }, partial: { completed: 2, total: 3 }, noChange: false,
 };
 const full = buildGateText(view);
 expect(full).toBe(buildGateText(view));
 expect(full.length).toBeLessThanOrEqual(1600);
 expect(full.startsWith('[delegation-verification-gate] task abcdef12 completed.')).toBe(true);
 expect(full).toContain('changed files: ');
 expect(full).toContain('+more');
 expect(full).toContain('partial batch: 2/3 completed');
 expect(full).toContain('REQUIRED: call verification_loop now;');
 expect(full).toContain('Sweep (judgment, not machine-checked)');
 expect(full.includes(root)).toBe(false);
 const compact = buildGateText({ ...view, noChange: true, changedFiles: 0, changedNames: [], commits: 0, partial: null });
 expect(compact.length).toBeLessThanOrEqual(1600);
 expect(compact).toContain('machine-checked no repo change at ' + path.basename(root));
 expect(compact.includes(root)).toBe(false);
});

test('git delta facts cover dirty, commit, mixed, missing-baseline and non-repository fixtures', async () => {
 const root = await makeRepo();
 expect(await resolveRepoRoot(root)).toBe(root);
 const base = await captureBaseline(root);
 expect(base).not.toBeNull();
 const clean = await gitDeltaFacts(root, base!.head);
 expect(clean).toMatchObject({ available: true, treeClean: true, changedFiles: 0, commits: 0 });
 await fs.writeFile(path.join(root, 'a.txt'), 'two\n');
 const dirty = await gitDeltaFacts(root, base!.head);
 expect(dirty.available).toBe(true);
 expect(dirty.treeClean).toBe(false);
 expect(dirty.changedFiles).toBeGreaterThanOrEqual(1);
 expect(dirty.commits).toBe(0);
 git(root, 'add', '.');
 git(root, 'commit', '-q', '-m', 'change');
 const committed = await gitDeltaFacts(root, base!.head);
 expect(committed.treeClean).toBe(true);
 expect(committed.commits).toBe(1);
 expect(committed.changedFiles).toBeGreaterThanOrEqual(1);
 await fs.writeFile(path.join(root, 'b.txt'), 'extra\n');
 const mixed = await gitDeltaFacts(root, base!.head);
 expect(mixed.treeClean).toBe(false);
 expect(mixed.commits).toBe(1);
 expect(mixed.changedFiles).toBeGreaterThanOrEqual(2);
 const missing = await gitDeltaFacts(root, null);
 expect(missing.available).toBe(true);
 expect(missing.commits).toBeNull();
 expect(missing.changedFiles).toBeGreaterThanOrEqual(1);
 const nonGit = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-nongit-')));
 owned.push(nonGit);
 expect(await resolveRepoRoot(nonGit)).toBeNull();
 const nonGitFacts = await gitDeltaFacts(nonGit, base!.head);
 expect(nonGitFacts.available).toBe(false);
 const started = performance.now();
 expect(await resolveRepoRoot(root, 1)).toBeNull();
 expect(await captureBaseline(root, 1)).toBeNull();
 expect(performance.now() - started).toBeLessThan(1000);
});

test('state files are private, writer-owned, cap-bounded and fail open on corruption', async () => {
 await makeHome();
 const root = await makeRepo();
 const repoDigest = await repositoryDigest(root);
 const sessionDigest = sessionDigestOf('session-a');
 const status = await recordTaskBaseline(repoDigest, sessionDigest, root, 'call-1', { toolCallId: '', head: 'a'.repeat(64), porcelainDigest: 'b'.repeat(64), dirtyFiles: [], capturedAt: new Date().toISOString() });
 expect(status).toBe('ok');
 const file = loopStateFile(repoDigest, sessionDigest);
 const stat = await fs.lstat(file);
 expect(stat.mode & 0o7777).toBe(0o600);
 expect((await fs.lstat(path.dirname(file))).mode & 0o7777).toBe(0o700);
 const read = await readLoopState(repoDigest, sessionDigest);
 expect(read.status).toBe('ok');
 expect(read.state!.baselines[0].toolCallId).toBe('call-1');
 // writer-only retention: another session's file is never touched by our writes.
 const foreignDigest = sessionDigestOf('session-b');
 await withLoopStateWrite(repoDigest, foreignDigest, root, state => { state.pendingAsync.push({ jobId: 'foreign-job', baselineToolCallId: null, recordedAt: new Date().toISOString(), consumedAtGateId: null, consumedAt: null }); });
 const foreignFile = loopStateFile(repoDigest, foreignDigest);
 const foreignBefore = await fs.readFile(foreignFile);
 await recordTaskBaseline(repoDigest, sessionDigest, root, 'call-2', { toolCallId: '', head: 'a'.repeat(64), porcelainDigest: 'b'.repeat(64), dirtyFiles: [], capturedAt: new Date().toISOString() });
 expect((await fs.readFile(foreignFile)).equals(foreignBefore)).toBe(true);
 // corrupt own file: reads fail open, writes drop, evaluation blocks.
 await fs.writeFile(file, '{"broken":true}', { mode: 0o600 });
 expect((await readLoopState(repoDigest, sessionDigest)).status).toBe('unavailable');
 expect(await recordTaskBaseline(repoDigest, sessionDigest, root, 'call-3', { toolCallId: '', head: 'a'.repeat(64), porcelainDigest: 'b'.repeat(64), dirtyFiles: [], capturedAt: new Date().toISOString() })).toBe('drop');
 const blocked = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(blocked.status).toBe('blocked');
 expect(blocked.gapKinds).toContain('state_unavailable');
 // lock contention drops within the bounded wait without stealing the lock.
 await fs.rm(file);
 await fs.writeFile(path.join(path.dirname(file), '.loop.lock'), '', { mode: 0o600 });
 const waitStart = performance.now();
 expect(await withLoopStateWrite(repoDigest, sessionDigest, root, state => { state.gates.push({} as never); })).toBe('drop');
 expect(performance.now() - waitStart).toBeLessThan(1000);
 expect((await fs.lstat(path.join(path.dirname(file), '.loop.lock'))).isFile()).toBe(true);
 await fs.rm(path.join(path.dirname(file), '.loop.lock'));
 // caps: gate count is bounded and an over-budget state refuses to serialize.
 for (let index = 0; index < MAX_GATES + 6; index++) {
  const emission = await gateEmission({ dedupKey: taskDedupKey('cap-' + index) });
  await recordGate(repoDigest, sessionDigest, root, emission);
 }
 const capped = await readLoopState(repoDigest, sessionDigest);
 expect(capped.state!.gates.length).toBeLessThanOrEqual(MAX_GATES);
 const oversized = emptyLoopState(sessionDigest, repoDigest, root);
 for (let index = 0; index < MAX_GATES; index++) oversized.gates.push({ id: '00000000-0000-4000-8000-' + String(index).padStart(12, '0'), trigger: 'task', dedupKey: 'k'.repeat(600) + index, dedupKeyDigest: 'c'.repeat(64), baselineToolCallId: null, emittedAt: new Date().toISOString(), facts: 'available', bindingEvidence: 'absent', changedFiles: 0, commits: 0, receiptState: 'none', stateWrite: 'ok', resolvedAt: null, resolution: null, resolvedReceiptId: null, loopRuns: 0 });
 expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_STATE_BYTES);
 expect(serializeLoopState(oversized)).toBeNull();
 pruneLoopState(oversized);
 expect(oversized.gates.length).toBeLessThanOrEqual(MAX_GATES);
});

test('dedup keys canonicalize across job and subagent terminals and pending launches are consumed once', async () => {
 await makeHome();
 const root = await makeRepo();
 const repoDigest = await repositoryDigest(root);
 const sessionDigest = sessionDigestOf('session-dedup');
 expect(taskDedupKey('x')).toBe('task:x');
 expect(jobDedupKey('y')).toBe('job:y');
 expect(toolCallDigestFor('job_terminal', 'job:y')).not.toBe(toolCallDigestFor('subagent_terminal', 'job:y'));
 await recordPendingAsync(repoDigest, sessionDigest, root, 'job-77', 'call-77');
 const first = await recordGate(repoDigest, sessionDigest, root, await gateEmission({ trigger: 'job_terminal', dedupKey: jobDedupKey('job-77'), jobId: 'job-77', changedFiles: 1, commits: 1 }));
 expect(first.stateWrite).toBe('ok');
 expect(first.duplicate).toBe(false);
 const second = await recordGate(repoDigest, sessionDigest, root, await gateEmission({ trigger: 'subagent_terminal', dedupKey: jobDedupKey('job-77'), jobId: 'job-77', changedFiles: 1, commits: 1 }));
 expect(second.duplicate).toBe(true);
 expect(second.gateId).toBe(first.gateId);
 const state = (await readLoopState(repoDigest, sessionDigest)).state!;
 expect(state.gates.length).toBe(1);
 expect(state.pendingAsync[0].consumedAtGateId).toBe(first.gateId);
 expect(state.pendingAsync[0].consumedAt).not.toBeNull();
 const evaluation = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(evaluation.silentPending).toBe(0);
});

 test('evaluation classifies every receipt gap kind and resolves covering receipts', async () => {
 await makeHome();
 const root = await makeRepo();
 const repoDigest = await repositoryDigest(root);
 const sessionDigest = sessionDigestOf('session-eval');
 const base = await captureBaseline(root);
 await fs.writeFile(path.join(root, 'feature.test.mjs'), 'export const t = 1;\n');
 git(root, 'add', '.');
 git(root, 'commit', '-q', '-m', 'add test file');
 await recordTaskBaseline(repoDigest, sessionDigest, root, 'call-eval', { ...base!, toolCallId: '' });
 const emission = (overrides: Partial<LoopGateEmission>) => gateEmission({ baselineToolCallId: 'call-eval', changedFiles: 1, commits: 1, ...overrides });
 const first = await recordGate(repoDigest, sessionDigest, root, await emission({}));
 expect((await evaluateRepoGates(root, repoDigest, sessionDigest)).gapKinds).toEqual(['no_receipt_after_gate']);
 await makeReceipt(root, ['feature.test.mjs'], 'failed');
 expect((await evaluateRepoGates(root, repoDigest, sessionDigest)).gapKinds).toEqual(['receipt_not_passed']);
 await makeReceipt(root, ['feature.test.mjs'], 'no_tests');
 expect((await evaluateRepoGates(root, repoDigest, sessionDigest)).gapKinds).toEqual(['receipt_no_tests']);
 await makeReceipt(root, ['feature.test.mjs'], 'incomplete');
 const incomplete = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(incomplete.gapKinds).toEqual(['receipt_incomplete']);
 const covering = await makeReceipt(root, ['feature.test.mjs'], 'passed');
 const clean = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(clean.status).toBe('clean');
 expect(clean.openGates).toBe(0);
 const stamped = (await readLoopState(repoDigest, sessionDigest)).state!.gates.find(g => g.id === first.gateId)!;
 expect(stamped.resolution).toBe('receipt');
 expect(stamped.resolvedReceiptId).toBe(covering.id);
 // stale: a later source change invalidates the covering receipt for a new gate.
 const emission2 = await recordGate(repoDigest, sessionDigest, root, await emission({ dedupKey: taskDedupKey('call-eval-2') }));
 expect(emission2.stateWrite).toBe('ok');
 const staleReceipt = await makeReceipt(root, ['feature.test.mjs'], 'passed');
 await fs.writeFile(path.join(root, 'feature.test.mjs'), 'export const t = 2;\n');
 const stale = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(stale.status).toBe('gaps');
 expect(stale.gapKinds).toEqual(['receipt_stale']);
 expect(stale.gaps[0].gateId).toBe(emission2.gateId);
 expect(staleReceipt.freshness).toBe('fresh');
 const afterStale = await makeReceipt(root, ['feature.test.mjs'], 'passed');
 expect((await evaluateRepoGates(root, repoDigest, sessionDigest)).status).toBe('clean');
 // changed_during_run: before/after fingerprints differ and the source stays put.
 const emission3 = await recordGate(repoDigest, sessionDigest, root, await emission({ dedupKey: taskDedupKey('call-eval-3') }));
 expect(emission3.stateWrite).toBe('ok');
 await makeReceipt(root, ['feature.test.mjs'], 'passed', async () => { await fs.writeFile(path.join(root, 'other.txt'), 'drift\n'); await fs.writeFile(path.join(root, 'feature.test.mjs'), 'export const t = 3;\n'); });
 const drifted = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(drifted.gapKinds).toEqual(['receipt_changed_during_run']);
 const resolution = await makeReceipt(root, ['feature.test.mjs'], 'passed');
 expect((await evaluateRepoGates(root, repoDigest, sessionDigest)).status).toBe('clean');
 expect(resolution.id.length).toBe(36);
});

 test('changed test files must be covered and binding evidence blocks no-change resolution', async () => {
 await makeHome();
 const root = await makeRepo();
 const repoDigest = await repositoryDigest(root);
 const sessionDigest = sessionDigestOf('session-coverage');
 const base = await captureBaseline(root);
 await fs.writeFile(path.join(root, 'one.test.mjs'), 'export const a = 1;\n');
 await fs.writeFile(path.join(root, 'two.test.mjs'), 'export const b = 1;\n');
 git(root, 'add', '.');
 git(root, 'commit', '-q', '-m', 'add tests');
 await recordTaskBaseline(repoDigest, sessionDigest, root, 'call-cov', { ...base!, toolCallId: '' });
 const emission = await recordGate(repoDigest, sessionDigest, root, await gateEmission({ baselineToolCallId: 'call-cov', changedFiles: 2, commits: 1 }));
 expect(emission.stateWrite).toBe('ok');
 await makeReceipt(root, ['one.test.mjs'], 'passed');
 const uncovered = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(uncovered.status).toBe('gaps');
 expect(uncovered.gapKinds).toEqual(['changed_test_uncovered']);
 const coveringFiles = ['one.test.mjs', 'two.test.mjs'];
 await makeReceipt(root, coveringFiles, 'passed');
 const candidates = await collectReceiptCandidates([root], 0);
 expect(candidates.length).toBeGreaterThanOrEqual(2);
 expect(isCoveringCandidate(candidates[0], coveringFiles)).toBe(true);
 expect((await evaluateRepoGates(root, repoDigest, sessionDigest)).status).toBe('clean');
 // no-change auto-resolution requires absent binding evidence and a stored baseline with zero delta.
 const ncBase = await captureBaseline(root);
 await recordTaskBaseline(repoDigest, sessionDigest, root, 'call-nc', { ...ncBase!, toolCallId: '' });
 const emission2 = await recordGate(repoDigest, sessionDigest, root, await gateEmission({ dedupKey: taskDedupKey('call-nc'), baselineToolCallId: 'call-nc', changedFiles: 0, commits: 0 }));
 expect(emission2.stateWrite).toBe('ok');
 const noChange = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(noChange.status).toBe('clean');
 const stamped = (await readLoopState(repoDigest, sessionDigest)).state!.gates.find(g => g.id === emission2.gateId)!;
 expect(stamped.resolution).toBe('no_change');
 const emission3 = await recordGate(repoDigest, sessionDigest, root, await gateEmission({ dedupKey: taskDedupKey('call-bind'), baselineToolCallId: 'call-nc', changedFiles: 0, commits: 0, bindingEvidence: 'unknown' }));
 expect(emission3.stateWrite).toBe('ok');
 const unknown = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(unknown.status).toBe('gaps');
 expect(unknown.gaps.some(gap => gap.gateId === emission3.gateId && gap.kind === 'no_receipt_after_gate')).toBe(true);
 const emission4 = await recordGate(repoDigest, sessionDigest, root, await gateEmission({ dedupKey: taskDedupKey('call-pres'), baselineToolCallId: 'call-nc', changedFiles: 0, commits: 0, bindingEvidence: 'present', boundRoot: root }));
 expect(emission4.stateWrite).toBe('ok');
 const presented = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(presented.gaps.some(gap => gap.gateId === emission4.gateId)).toBe(true);
});

test('carry-forward reads other sessions read-only and honestly flags truncated scans', async () => {
 await makeHome();
 const root = await makeRepo();
 const repoDigest = await repositoryDigest(root);
 const home = process.env.HOME!;
 const foreignDigest = sessionDigestOf('session-foreign');
 const ownDigest = sessionDigestOf('session-own');
 await withLoopStateWrite(repoDigest, foreignDigest, root, state => {
  state.gates.push({ id: '00000000-0000-4000-8000-000000000001', trigger: 'task', dedupKey: taskDedupKey('foreign-1'), dedupKeyDigest: 'd'.repeat(64), baselineToolCallId: null, emittedAt: new Date(Date.now() - 60000).toISOString(), facts: 'partial', bindingEvidence: 'unknown', changedFiles: 3, commits: null, receiptState: 'none', stateWrite: 'ok', resolvedAt: null, resolution: null, resolvedReceiptId: null, loopRuns: 0 });
  state.pendingAsync.push({ jobId: 'foreign-silent', baselineToolCallId: null, recordedAt: new Date().toISOString(), consumedAtGateId: null, consumedAt: null });
 });
 const foreignFile = loopStateFile(repoDigest, foreignDigest);
 const foreignBefore = await fs.readFile(foreignFile);
 const evaluation = await evaluateRepoGates(root, repoDigest, ownDigest);
 expect(evaluation.status).toBe('gaps');
 expect(evaluation.openGates).toBe(1);
 expect(evaluation.gaps[0].gateId).toBe('00000000-0000-4000-8000-000000000001');
 expect(evaluation.silentPending).toBe(1);
 expect((await fs.readFile(foreignFile)).equals(foreignBefore)).toBe(true);
 await fs.writeFile(path.join(root, 'covered.test.mjs'), 'export const c = 1;\n');
 await makeReceipt(root, ['covered.test.mjs'], 'passed');
 const resolved = await evaluateRepoGates(root, repoDigest, ownDigest);
 expect(resolved.status).toBe('clean');
 expect(resolved.resolvedGates).toBeGreaterThanOrEqual(1);
 expect((await fs.readFile(foreignFile)).equals(foreignBefore)).toBe(true);
 // bounded scan: additional session files beyond the cap are reported as truncated.
 for (let index = 0; index < 17; index++) {
  const digest = sessionDigestOf('filler-' + index);
  await withLoopStateWrite(repoDigest, digest, root, state => { state.gates.push({ id: '00000000-0000-4000-8000-0000000000' + String(10 + index), trigger: 'task', dedupKey: taskDedupKey('filler-' + index), dedupKeyDigest: 'e'.repeat(64), baselineToolCallId: null, emittedAt: new Date().toISOString(), facts: 'available', bindingEvidence: 'absent', changedFiles: 0, commits: 0, receiptState: 'none', stateWrite: 'ok', resolvedAt: null, resolution: null, resolvedReceiptId: null, loopRuns: 0 }); });
 }
 const truncated = await evaluateRepoGates(root, repoDigest, ownDigest);
 expect(truncated.scannedSessionFiles).toBe(16);
 expect(truncated.scanTruncated).toBe(true);
 expect((await fs.readdir(path.join(home, '.gjc-plugin', 'verification-receipts', 'loop', 'v1', repoDigest))).length).toBeGreaterThan(16);
});

test('latest receipt summary classifies none, present, fresh_passed and unavailable without leaking paths', async () => {
 await makeHome();
 const root = await makeRepo();
 expect((await latestReceiptSummary(root)).state).toBe('none');
 await makeReceipt(root, [], 'failed');
 expect((await latestReceiptSummary(root)).state).toBe('present');
 await makeReceipt(root, [], 'passed');
 const summary = await latestReceiptSummary(root);
 expect(summary.state).toBe('fresh_passed');
 expect(summary.status).toBe('passed');
 expect(summary.freshness).toBe('fresh');
 const dir = path.join(receiptStoreBase(), await repositoryDigest(root));
 await fs.writeFile(path.join(dir, '11111111-1111-4111-8111-111111111111.json'), 'not-json', { mode: 0o600 });
 expect((await latestReceiptSummary(root)).state).toBe('unavailable');
 expect(requiredActionsFor(['no_receipt_after_gate', 'state_unavailable']).length).toBe(2);
});

async function gitShimDir(sleepSeconds: string): Promise<string> {
 const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-shim-')));
 owned.push(dir);
 const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
 await fs.writeFile(path.join(dir, 'git'), '#!/bin/sh\nsleep ' + sleepSeconds + '\nexec ' + real + ' "$@"\n', { mode: 0o700 });
 return dir;
}

test('evaluation enforces its wall-clock budget and never reports a false clean', async () => {
 await makeHome();
 const root = await makeRepo();
 const repoDigest = await repositoryDigest(root);
 const sessionDigest = sessionDigestOf('session-budget');
 const base = await captureBaseline(root);
 await recordTaskBaseline(repoDigest, sessionDigest, root, 'call-b1', { ...base!, toolCallId: '' });
 const base2 = await captureBaseline(root);
 await recordTaskBaseline(repoDigest, sessionDigest, root, 'call-b2', { ...base2!, toolCallId: '' });
 await recordGate(repoDigest, sessionDigest, root, await gateEmission({ dedupKey: taskDedupKey('g1'), baselineToolCallId: 'call-b1', changedFiles: 0, commits: 0 }));
 await recordGate(repoDigest, sessionDigest, root, await gateEmission({ dedupKey: taskDedupKey('g2'), baselineToolCallId: 'call-b2', changedFiles: 0, commits: 0, bindingEvidence: 'unknown' }));
 const shim = await gitShimDir('0.6');
 const originalPath = process.env.PATH;
 process.env.PATH = shim + ':' + (originalPath ?? '');
 try {
  const started = performance.now();
  const evaluation = await evaluateRepoGates(root, repoDigest, sessionDigest, { budgetMs: 800 });
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(3000);
  expect(evaluation.budgetExceeded).toBe(true);
  expect(evaluation.status).not.toBe('clean');
  expect(evaluation.gapKinds).toContain('state_unavailable');
 } finally { process.env.PATH = originalPath; }
});

test('session scans include the own file under truncation and order by mtime', async () => {
 await makeHome();
 const root = await makeRepo();
 const repoDigest = await repositoryDigest(root);
 const ownDigest = sessionDigestOf('session-own-scan');
 for (let index = 0; index < 16; index++) {
  const digest = sessionDigestOf('filler-scan-' + index);
  await withLoopStateWrite(repoDigest, digest, root, state => { state.gates.push({ id: '00000000-0000-4000-8000-0000000000' + String(70 + index), trigger: 'task', dedupKey: taskDedupKey('filler-' + index), dedupKeyDigest: 'f'.repeat(64), baselineToolCallId: null, emittedAt: new Date().toISOString(), facts: 'available', bindingEvidence: 'absent', changedFiles: 0, commits: 0, receiptState: 'none', stateWrite: 'ok', resolvedAt: null, resolution: null, resolvedReceiptId: null, loopRuns: 0 }); });
 }
 const own = await recordGate(repoDigest, ownDigest, root, await gateEmission({ dedupKey: taskDedupKey('own-scan-gate'), changedFiles: 1, commits: 1 }));
 expect(own.stateWrite).toBe('ok');
 const evaluation = await evaluateRepoGates(root, repoDigest, ownDigest);
 expect(evaluation.scannedSessionFiles).toBe(16);
 expect(evaluation.scanTruncated).toBe(true);
 expect(evaluation.gaps.some(gap => gap.gateId === own.gateId)).toBe(true);
 const ownState = (await readLoopState(repoDigest, ownDigest)).state!;
 expect(ownState.gates.find(gate => gate.id === own.gateId)!.resolvedAt).toBeNull();
});

test('deleted test files are excluded from coverage demands', async () => {
 await makeHome();
 const root = await makeRepo();
 const repoDigest = await repositoryDigest(root);
 const sessionDigest = sessionDigestOf('session-deleted');
 await fs.writeFile(path.join(root, 'gone.test.mjs'), 'export const gone = 1;\n');
 git(root, 'add', '.');
 git(root, 'commit', '-q', '-m', 'test file');
 const base = await captureBaseline(root);
 await recordTaskBaseline(repoDigest, sessionDigest, root, 'call-del', { ...base!, toolCallId: '' });
 git(root, 'rm', '-q', 'gone.test.mjs');
 const facts = await gitDeltaFacts(root, base!.head);
 expect(facts.changedNames).toContain('gone.test.mjs');
 expect(facts.changedTestFiles).toEqual([]);
 const gate = await recordGate(repoDigest, sessionDigest, root, await gateEmission({ dedupKey: taskDedupKey('del-gate'), baselineToolCallId: 'call-del', changedFiles: 1, commits: 0 }));
 expect(gate.stateWrite).toBe('ok');
 expect((await evaluateRepoGates(root, repoDigest, sessionDigest)).gapKinds).toEqual(['no_receipt_after_gate']);
 await makeReceipt(root, [], 'passed');
 const resolved = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(resolved.status).toBe('clean');
 expect(resolved.gapKinds).not.toContain('changed_test_uncovered');
});

test('ui-regression receipts never resolve verification gates and never surface as the latest receipt', async () => {
 await makeHome();
 const root = await makeRepo();
 const repoDigest = await repositoryDigest(root);
 const sessionDigest = sessionDigestOf('session-uifilter');
 const specDigest = specFingerprint({ runner: 'ui', files: [] });
 const before = await fingerprintSource(root, specDigest, []);
 const uiReceipt = createReceipt({ plugin: 'ui-regression', toolCallId: 'ui-' + Math.random().toString(16).slice(2), repositoryDigest: repoDigest, durationMs: 5, specDigest, before, after: before, freshness: freshnessFor(before, before), execution: { status: 'passed', reason: 'complete', exitCode: 0, signal: null, runnerVersion: null, counts: null, assertions: [{ step: 0, id: 'step-0', kind: 'visible', status: 'passed' }], steps: [{ step: 0, action: 'assert', status: 'passed' }], cleanup: 'confirmed', currentUiState: 'not_reobserved', browserBuildBinding: 'unverified', scenarioDigest: 'b'.repeat(64) }, warnings: [], limitations: ['ui fixture'] });
 const persisted = await persistReceipt(uiReceipt, receiptStoreBase(), []);
 expect(persisted.persisted).toBe(true);
 expect((await latestReceiptSummary(root)).state).toBe('none');
 const gate = await recordGate(repoDigest, sessionDigest, root, await gateEmission({ dedupKey: taskDedupKey('ui-gate'), changedFiles: 1, commits: 1 }));
 expect(gate.stateWrite).toBe('ok');
 const evaluation = await evaluateRepoGates(root, repoDigest, sessionDigest);
 expect(evaluation.status).toBe('gaps');
 expect(evaluation.gapKinds).toEqual(['no_receipt_after_gate']);
 const candidates = await collectReceiptCandidates([root], 0);
 expect(candidates.some(candidate => candidate.id === uiReceipt.id)).toBe(false);
});

test('interleaved concurrent state writes never corrupt the file or lose acknowledged entries', async () => {
 await makeHome();
 const root = await makeRepo();
 const repoDigest = await repositoryDigest(root);
 const sessionDigest = sessionDigestOf('session-interleave');
 const results = await Promise.all(Array.from({ length: 8 }, (_, index) => withLoopStateWrite(repoDigest, sessionDigest, root, state => {
  state.pendingAsync.push({ jobId: 'interleave-' + index, baselineToolCallId: null, recordedAt: new Date().toISOString(), consumedAtGateId: null, consumedAt: null });
 })));
 const acknowledged = results.filter(status => status === 'ok').length;
 expect(acknowledged).toBeGreaterThan(0);
 const state = (await readLoopState(repoDigest, sessionDigest)).state;
 expect(state).not.toBeNull();
 expect(state!.pendingAsync.length).toBe(acknowledged);
 for (const entry of state!.pendingAsync) expect(entry.jobId).toMatch(/^interleave-/);
});
