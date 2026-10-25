import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import registerBaseline from '../src/gate-baseline.adapter';
import registerGate from '../src/gate-result.adapter';
import verificationLoop from '../src/loop.adapter';
import verificationRun from '../src/run.adapter';
import { loopStateFile, readLoopState, sessionDigestOf } from '../lib/loop';
import { repositoryDigest } from '../lib/receipts';

const Type = new Proxy({}, { get: () => (...args: unknown[]) => ({ args }) });
const owned: string[] = [];
const originalHome = process.env.HOME;
const originalProvider = process.env.JEV_ADVISOR_PROVIDER;
afterEach(async () => {
	process.env.HOME = originalHome;
	if (originalProvider === undefined) delete process.env.JEV_ADVISOR_PROVIDER; else process.env.JEV_ADVISOR_PROVIDER = originalProvider;
	for (const dir of owned.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8' }).trim();
}
async function makeRepo(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-repo-')));
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
	const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-home-')));
	owned.push(home);
	process.env.HOME = home;
	return home;
}
function collector() {
	const handlers: { event: string; handler: (event: unknown, ctx: unknown) => unknown }[] = [];
	return { handlers, api: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.push({ event, handler }); } } };
}
function ctxFor(sessionId: string, cwd: string, aborted = false) {
	return { cwd, signal: { aborted }, sessionManager: { getSessionId: () => sessionId } };
}
function textsOf(result: any): string[] {
	return Array.isArray(result?.content) ? result.content.filter((entry: any) => entry?.type === 'text').map((entry: any) => String(entry.text)) : [];
}
async function journal(home: string): Promise<Record<string, any>[]> {
	const dir = path.join(home, '.gjc-plugin', 'verification-receipts', 'journal', 'v1');
	let names: string[] = [];
	try { names = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl')).sort(); } catch { return []; }
	const rows: Record<string, any>[] = [];
	for (const name of names) {
		for (const line of (await fs.readFile(path.join(dir, name), 'utf8')).trimEnd().split('\n')) if (line) rows.push(JSON.parse(line));
	}
	return rows;
}

test('hooks gate only observed completions, dedup repeats and never leak the original content', async () => {
	const home = await makeHome();
	const root = await makeRepo();
	process.env.JEV_ADVISOR_PROVIDER = 'off';
	const baseline = collector();
	registerBaseline(baseline.api as never);
	const gate = collector();
	registerGate(gate.api as never);
	const ctx = ctxFor('session-hooks', root);
	expect(await baseline.handlers[0].handler({ type: 'tool_call', toolName: 'task', toolCallId: 'call-1' }, ctx)).toBeUndefined();
	expect(await baseline.handlers[0].handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'call-x' }, ctx)).toBeUndefined();
	const repoDigest = await repositoryDigest(root);
	const stateFile = loopStateFile(repoDigest, sessionDigestOf('session-hooks'));
	const stateAfterBaseline = (await readLoopState(repoDigest, sessionDigestOf('session-hooks'))).state!;
	expect(stateAfterBaseline.baselines.map(entry => entry.toolCallId)).toEqual(['call-1']);
	const original = [{ type: 'text', text: 'ORIGINAL RESULT BODY' }];
	const compact = await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-1', input: { tasks: [{ assignment: 'x' }] }, details: { results: [{ status: 'completed' }] }, content: original }, ctx) as any;
	const compactTexts = textsOf(compact);
	expect(compactTexts.length).toBe(2);
	expect(compactTexts[0]).toBe('ORIGINAL RESULT BODY');
	expect(compactTexts[1]).toContain('[delegation-verification-gate]');
	expect(compactTexts[1]).toContain('machine-checked no repo change');
	expect(compactTexts[1]).not.toContain(root);
	await baseline.handlers[0].handler({ type: 'tool_call', toolName: 'task', toolCallId: 'call-5' }, ctx);
	await fs.writeFile(path.join(root, 'b.txt'), 'delegated change\n');
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'delegated change');
	const gated = await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-5', input: { tasks: [{ assignment: 'x' }] }, details: { results: [{ status: 'completed' }] }, content: original }, ctx) as any;
	const gatedTexts = textsOf(gated);
	expect(gatedTexts.length).toBe(2);
	expect(gatedTexts[1]).toContain('[delegation-verification-gate]');
	expect(gatedTexts[1]).toContain('REQUIRED: call verification_loop now');
	expect(gatedTexts[1]).not.toContain(root);
	const stateAfterGates = (await readLoopState(repoDigest, sessionDigestOf('session-hooks'))).state!;
	expect(stateAfterGates.baselines.map(entry => entry.toolCallId)).toEqual(['call-1', 'call-5']);
	expect(stateAfterGates.gates.length).toBe(2);
	expect(stateAfterGates.gates[0].dedupKey).toBe('task:call-1');
	expect(stateAfterGates.gates[0].resolution).toBe('no_change');
	expect(stateAfterGates.gates[1].dedupKey).toBe('task:call-5');
	expect(stateAfterGates.gates[1].changedFiles).toBe(1);
	expect(await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-5', input: { tasks: [{}] }, details: { results: [{ status: 'completed' }] }, content: original }, ctx)).toBeUndefined();
	expect(await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-1', isError: true, details: {}, content: original }, ctx)).toBeUndefined();
	expect(await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-1', input: { tasks: [{}] }, details: { results: [{ status: 'completed' }] }, content: original }, ctxFor('session-hooks', root, true))).toBeUndefined();
	expect(await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-2', input: { tasks: [{}] }, details: { async: { jobId: 'job-1', state: 'running' } }, content: original }, ctx)).toBeUndefined();
	expect(await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-3', input: { tasks: [{}] }, details: { results: [{ status: 'failed' }] }, content: original }, ctx)).toBeUndefined();
	expect(await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-4', input: { tasks: [{}] }, details: { results: [{ status: 'completed' }] }, content: original }, { cwd: root, sessionManager: { getSessionId: () => null } })).toBeUndefined();
	const stateFinal = (await readLoopState(repoDigest, sessionDigestOf('session-hooks'))).state!;
	expect(stateFinal.pendingAsync.map(entry => entry.jobId)).toEqual(['job-1']);
	expect(stateFinal.pendingAsync[0].baselineToolCallId).toBe('call-2');
	expect(stateFinal.gates.length).toBe(2);
	const rows = await journal(home);
	expect(rows.map(row => row.operation)).toEqual(['gate_emitted', 'gate_emitted']);
	expect(rows[0].gate.trigger).toBe('task');
	expect(rows[0].gate.baselinePresent).toBe(true);
	expect(rows[0].gate.binding).toBe('none');
	expect(stateFile.startsWith(home)).toBe(true);
});

test('terminal gates dedup across job and subagent polling and skip failed entries', async () => {
	await makeHome();
	const root = await makeRepo();
	const baseline = collector();
	registerBaseline(baseline.api as never);
	const gate = collector();
	registerGate(gate.api as never);
	const ctx = ctxFor('session-terminal', root);
	await baseline.handlers[0].handler({ type: 'tool_call', toolName: 'task', toolCallId: 'call-t' }, ctx);
	const original = [{ type: 'text', text: 'ENVELOPE' }];
	expect(await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-t', input: { tasks: [{}] }, details: { async: { jobId: 'job-9', state: 'running' } }, content: original }, ctx)).toBeUndefined();
	const first = await gate.handlers[0].handler({ type: 'tool_result', toolName: 'subagent', toolCallId: 'poll-1', input: {}, details: { subagents: [{ jobId: 'job-9', status: 'completed' }, { jobId: 'job-8', status: 'failed' }, { jobId: 'job-7', status: 'cancelled' }] }, content: original }, ctx) as any;
	expect(textsOf(first).length).toBe(2);
	expect(textsOf(first)[1]).toContain('[delegation-verification-gate]');
	expect(await gate.handlers[0].handler({ type: 'tool_result', toolName: 'job', toolCallId: 'poll-2', input: {}, details: { jobs: [{ jobId: 'job-9', status: 'completed', type: 'task' }] }, content: original }, ctx)).toBeUndefined();
	expect(await gate.handlers[0].handler({ type: 'tool_result', toolName: 'subagent', toolCallId: 'poll-3', input: {}, details: { subagents: [{ jobId: 'job-9', status: 'completed' }] }, content: original }, ctx)).toBeUndefined();
	const repoDigest = await repositoryDigest(root);
	const state = (await readLoopState(repoDigest, sessionDigestOf('session-terminal'))).state!;
	expect(state.gates.length).toBe(1);
	expect(state.gates[0].dedupKey).toBe('job:job-9');
	expect(state.gates[0].trigger).toBe('subagent_terminal');
	expect(state.gates[0].bindingEvidence).toBe('unknown');
	expect(state.gates[0].facts).toBe('partial');
	expect(state.pendingAsync[0].consumedAtGateId).toBe(state.gates[0].id);
});

test('compact no-change gates resolve immediately and state drops stay factual and fail-open', async () => {
	const home = await makeHome();
	const root = await makeRepo();
	const baseline = collector();
	registerBaseline(baseline.api as never);
	const gate = collector();
	registerGate(gate.api as never);
	const ctx = ctxFor('session-compact', root);
	await baseline.handlers[0].handler({ type: 'tool_call', toolName: 'task', toolCallId: 'call-c' }, ctx);
	const compact = await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-c', input: { tasks: [{}] }, details: { results: [{ status: 'completed' }] }, content: [{ type: 'text', text: 'X' }] }, ctx) as any;
	const compactText = textsOf(compact)[1];
	expect(compactText).toContain('machine-checked no repo change at ' + path.basename(root));
	const repoDigest = await repositoryDigest(root);
	const resolved = (await readLoopState(repoDigest, sessionDigestOf('session-compact'))).state!.gates[0];
	expect(resolved.resolution).toBe('no_change');
	expect(resolved.bindingEvidence).toBe('absent');
	// corrupt state: the append still happens and the drop is journaled instead of throwing.
	await fs.writeFile(loopStateFile(repoDigest, sessionDigestOf('session-compact')), '{"broken":true}', { mode: 0o600 });
	const dropped = await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-d', input: { tasks: [{}] }, details: { results: [{ status: 'completed' }] }, content: [{ type: 'text', text: 'Y' }] }, ctx) as any;
	expect(textsOf(dropped).length).toBe(2);
	expect(textsOf(dropped)[1]).toContain('[delegation-verification-gate]');
	const rows = await journal(home);
	const drops = rows.filter(row => row.operation === 'gate_emitted' && row.gate?.stateWrite === 'drop');
	expect(drops.length).toBe(1);
	expect(rows.filter(row => row.operation === 'gate_emitted').length).toBe(2);
});

test('loop tool blocks outside a repository, rejects parameters and keeps a bounded honest contract', async () => {
	const nonGit = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-nongit-')));
	owned.push(nonGit);
	const home = await makeHome();
	const tool = verificationLoop({ cwd: nonGit, typebox: { Type } });
	const description = String((tool as any).description);
	expect(description).toContain('not proof of correctness or coverage');
	expect(description).toContain('≤15s');
	expect(description).toContain('no network');
	const blocked = JSON.parse(textsOf(await (tool as any).execute('loop-1', {}, undefined, ctxFor('s', nonGit)))[0]);
	expect(blocked.status).toBe('blocked');
	expect(blocked.gapKinds).toEqual(['not_a_repository']);
	expect(blocked.notes[0]).toContain('clean is a mechanical recheck');
	const invalid = JSON.parse(textsOf(await (tool as any).execute('loop-2', { extra: true }))[0]);
	expect(invalid.warnings).toEqual(['invalid_input']);
	const rows = await journal(home);
	expect(rows.filter(row => row.operation === 'loop_run').length).toBe(1);
	expect(rows.find(row => row.operation === 'loop_run')!.loop.status).toBe('blocked');
});

test('loop accepts an explicit repository and never reports an ungated non-Git session clean', async () => {
	const home = await makeHome();
	const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-loop-workspace-')));
	owned.push(workspace);
	const repo = path.join(workspace, 'lanes', 'repo');
	const outside = path.join(workspace, '..', `gate-loop-outside-${process.pid}`);
	await fs.mkdir(path.join(workspace, 'lanes'), { recursive: true });
	await fs.mkdir(repo);
	await fs.mkdir(outside);
	owned.push(outside);
	git(repo, 'init', '-q');
	git(outside, 'init', '-q');
	const tool = verificationLoop({ cwd: workspace, typebox: { Type } });
	const ctx = ctxFor('session-ungated', workspace);
	const scoped = JSON.parse(textsOf(await (tool as any).execute('loop-repo', { repository: 'lanes/repo' }, undefined, ctx))[0]);
	expect(scoped.status).toBe('blocked');
	expect(scoped.reason).toBe('not_a_repository');
	expect(scoped.gapKinds).toContain('not_a_repository');
	expect(scoped.gaps[0].detail).toContain('session cwd is not inside a Git work tree');
	expect(scoped.warnings).toContain('ungated_session_cwd');
	expect(scoped.requiredActions.join(' ')).toContain('ungated');
	const invalid = JSON.parse(textsOf(await (tool as any).execute('loop-bad', { repository: 'lanes/missing' }, undefined, ctx))[0]);
	expect(invalid.status).toBe('blocked');
	expect(invalid.reason).toBe('invalid_repository');
	expect(invalid.warnings).toEqual(['invalid_repository']);
	const escaped = JSON.parse(textsOf(await (tool as any).execute('loop-outside', { repository: outside }, undefined, ctx))[0]);
	expect(escaped.status).toBe('blocked');
	expect(escaped.reason).toBe('repository_outside_session_cwd');
	expect(escaped.warnings).toEqual(['repository_outside_session_cwd']);
	const rows = await journal(home);
	expect(rows.filter(row => row.operation === 'loop_run').map(row => row.loop.status)).toEqual(['blocked', 'blocked', 'blocked']);
});

test('before hook stays within its wall-clock budget under a hanging git', async () => {
	const home = await makeHome();
	const root = await makeRepo();
	const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
	const shim = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-shim-')));
	owned.push(shim);
	await fs.writeFile(path.join(shim, 'git'), '#!/bin/sh\nsleep 6\nexec ' + real + ' "$@"\n', { mode: 0o700 });
	const originalPath = process.env.PATH;
	process.env.PATH = shim + ':' + (originalPath ?? '');
	try {
		const baseline = collector();
		registerBaseline(baseline.api as never);
		const started = performance.now();
		const result = await baseline.handlers[0].handler({ type: 'tool_call', toolName: 'task', toolCallId: 'hang-1' }, ctxFor('session-hang', root));
		const elapsed = performance.now() - started;
		expect(result).toBeUndefined();
		expect(elapsed).toBeLessThan(3500);
		const repoDigest = await repositoryDigest(root);
		const state = await readLoopState(repoDigest, sessionDigestOf('session-hang'));
		expect(state.status === 'ok' ? state.state!.baselines.length : 0).toBe(0);
	} finally { process.env.PATH = originalPath; }
	expect(home.startsWith('/')).toBe(true);
});

test('loop tool drives a real gate to clean through verification_run and stamps the receipt', async () => {
	const home = await makeHome();
	const root = await makeRepo();
	process.env.JEV_ADVISOR_PROVIDER = 'off';
	await fs.writeFile(path.join(root, 'pass.mjs'), "import test from 'node:test';\ntest('passes',()=>{});\n");
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'test file');
	const baseline = collector();
	registerBaseline(baseline.api as never);
	const gate = collector();
	registerGate(gate.api as never);
	const ctx = ctxFor('session-e2e', root);
	await baseline.handlers[0].handler({ type: 'tool_call', toolName: 'task', toolCallId: 'call-e2e' }, ctx);
	await fs.writeFile(path.join(root, 'pass.mjs'), "import test from 'node:test';\ntest('passes twice',()=>{});\n");
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'delegated change');
	const gated = await gate.handlers[0].handler({ type: 'tool_result', toolName: 'task', toolCallId: 'call-e2e', input: { tasks: [{}] }, details: { results: [{ status: 'completed' }] }, content: [{ type: 'text', text: 'X' }] }, ctx) as any;
	expect(textsOf(gated).length).toBe(2);
	const tool = verificationLoop({ cwd: root, typebox: { Type } });
	const gaps = JSON.parse(textsOf(await (tool as any).execute('loop-a', {}, undefined, ctx))[0]);
	expect(gaps.status).toBe('gaps');
	expect(gaps.openGates).toBe(1);
	expect(gaps.requiredActions.length).toBeGreaterThan(0);
	expect((gaps.warnings ?? []).includes('state_write_dropped')).toBe(false);
	expect(gaps.budgetExceeded).toBe(false);
	const run = verificationRun({ cwd: root, typebox: { Type } });
	const receipt = JSON.parse(textsOf(await (run as any).execute('run-e2e', { files: ['pass.mjs'] }))[0]);
	expect(receipt.receipt.execution.status).toBe('passed');
	expect(receipt.persisted).toBe(true);
	const clean = JSON.parse(textsOf(await (tool as any).execute('loop-b', {}, undefined, ctx))[0]);
	expect(clean.status).toBe('clean');
	expect(clean.openGates).toBe(0);
	expect(clean.resolvedGates).toBeGreaterThanOrEqual(1);
	const repoDigest = await repositoryDigest(root);
	const stamped = (await readLoopState(repoDigest, sessionDigestOf('session-e2e'))).state!.gates[0];
	expect(stamped.resolution).toBe('receipt');
	expect(stamped.resolvedReceiptId).toBe(receipt.receipt.id);
	const rows = await journal(home);
	expect(rows.map(row => row.operation)).toEqual(['gate_emitted', 'loop_run', 'run', 'loop_run']);
	expect(rows[3].loop.status).toBe('clean');
	const scope = JSON.stringify(clean) + JSON.stringify(rows);
	expect(scope).not.toContain('passes twice');
});
