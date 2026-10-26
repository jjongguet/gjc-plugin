#!/usr/bin/env node
// Harness² M1 — cost-0 guard-ablation runner.
//
// One cell = one frozen task × one arm. The task is a planted defect (or a clean
// control); the arm is a guard set. Each cell runs in an isolated snapshot of
// `sourceHead` extracted with `git archive`, so no working-tree state leaks in and
// no cell can touch the real store, HOME or repository.
//
// Every step is a local, keyless repository command. There is no model call, no
// network path, no credential read and no paid execution. The output is a measured
// cost/detection matrix for the declared guard sets. It is NOT a
// `gjc.quality_trial.v2` receipt and does not support an agent-efficacy claim.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

export const MANIFEST_SCHEMA = 'harness2.m1.manifest.v1';
export const RESULT_SCHEMA = 'harness2.m1.result.v1';
export const SNAPSHOT_PATHS = Object.freeze(['rrsi', 'shared', 'self-improve', 'package.json']);
const MAX_BUFFER = 32 * 1024 * 1024;
const EXCERPT_CHARS = 4000;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function invalid(reason) {
	throw new Error(`invalid_manifest: ${reason}`);
}

/** A plant target must be a repository-relative path inside the snapshot. */
function assertRepoRelative(file) {
	if (typeof file !== 'string' || file.length === 0) invalid('plant.file must be a non-empty string');
	if (isAbsolute(file) || file.split('/').includes('..') || file.startsWith('../')) invalid(`plant.file escapes the snapshot: ${file}`);
}

function validatePlanStep(step, armId, index) {
	const where = `arms[${armId}].plan[${index}]`;
	if (step === null || typeof step !== 'object') invalid(`${where} must be an object`);
	if (typeof step.id !== 'string' || step.id.length === 0) invalid(`${where}.id must be a non-empty string`);
	if (!Array.isArray(step.argv) || step.argv.length === 0 || step.argv.some((arg) => typeof arg !== 'string' || arg.length === 0)) {
		invalid(`${where}.argv must be a non-empty array of non-empty strings`);
	}
	if (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs <= 0) invalid(`${where}.timeoutMs must be a positive integer`);
}

function validateTask(task, index, { planted }) {
	const where = `tasks[${index}]`;
	if (task === null || typeof task !== 'object') invalid(`${where} must be an object`);
	if (typeof task.id !== 'string' || task.id.length === 0) invalid(`${where}.id must be a non-empty string`);
	if (typeof task.class !== 'string' || task.class.length === 0) invalid(`${where}.class must be a non-empty string`);
	if (planted) {
		const plant = task.plant;
		if (plant === null || typeof plant !== 'object') invalid(`${where}.plant must be an object for a defect task`);
		assertRepoRelative(plant.file);
		if (plant.op === 'append') {
			if (typeof plant.text !== 'string' || plant.text.length === 0) invalid(`${where}.plant.text must be a non-empty string`);
		} else if (plant.op === 'replace') {
			if (typeof plant.find !== 'string' || plant.find.length === 0) invalid(`${where}.plant.find must be a non-empty string`);
			if (typeof plant.text !== 'string') invalid(`${where}.plant.text must be a string`);
		} else {
			invalid(`${where}.plant.op must be append or replace`);
		}
		if (task.oracle === null || typeof task.oracle !== 'object' || task.oracle.caught !== 'exit_nonzero') {
			invalid(`${where}.oracle.caught must be exit_nonzero`);
		}
	}
}

/**
 * Validate a frozen M1 manifest. Fails closed: an M1 matrix needs at least two
 * defect tasks and two arms, every arm needs at least one step, and a task whose
 * plant target or oracle cannot be honoured is rejected instead of faked.
 */
export function validateManifest(manifest) {
	if (manifest === null || typeof manifest !== 'object') invalid('manifest must be an object');
	if (manifest.schema !== MANIFEST_SCHEMA) invalid(`schema must be ${MANIFEST_SCHEMA}`);
	if (typeof manifest.id !== 'string' || manifest.id.length === 0) invalid('id must be a non-empty string');
	if (!Array.isArray(manifest.arms) || manifest.arms.length < 2) invalid('arms must hold at least two arms');
	const armIds = new Set();
	for (const arm of manifest.arms) {
		if (arm === null || typeof arm !== 'object') invalid('each arm must be an object');
		if (typeof arm.id !== 'string' || !/^[A-Z][0-9]$/.test(arm.id)) invalid(`arm id must match B<digit>: ${String(arm.id)}`);
		if (armIds.has(arm.id)) invalid(`duplicate arm id: ${arm.id}`);
		armIds.add(arm.id);
		if (!Array.isArray(arm.plan) || arm.plan.length === 0) invalid(`arms[${arm.id}].plan must hold at least one step`);
		arm.plan.forEach((step, index) => validatePlanStep(step, arm.id, index));
	}
	if (!Array.isArray(manifest.tasks) || manifest.tasks.length < 2) invalid('tasks must hold at least two planted-defect tasks');
	const taskIds = new Set();
	manifest.tasks.forEach((task, index) => {
		validateTask(task, index, { planted: true });
		if (taskIds.has(task.id)) invalid(`duplicate task id: ${task.id}`);
		taskIds.add(task.id);
	});
	const controls = manifest.controls ?? [];
	if (!Array.isArray(controls) || controls.length > 1) invalid('controls must be zero or one clean control');
	controls.forEach((task, index) => {
		validateTask(task, index, { planted: false });
		if (taskIds.has(task.id)) invalid(`duplicate task id: ${task.id}`);
		taskIds.add(task.id);
	});
	return manifest;
}

export function manifestDigest(manifest) {
	return sha256(JSON.stringify(manifest));
}

/** Apply one plant. A `replace` whose anchor is missing fails closed. */
export function plantDefect(root, plant) {
	const target = join(root, plant.file);
	if (!existsSync(target)) throw new Error(`plant_target_missing: ${plant.file}`);
	const before = readFileSync(target, 'utf8');
	let after;
	if (plant.op === 'append') {
		after = `${before}${plant.text}`;
	} else {
		const at = before.indexOf(plant.find);
		if (at < 0) throw new Error(`plant_anchor_missing: ${plant.file}`);
		after = `${before.slice(0, at)}${plant.text}${before.slice(at + plant.find.length)}`;
	}
	if (after === before) throw new Error(`plant_no_change: ${plant.file}`);
	writeFileSync(target, after);
	return { file: plant.file, op: plant.op, bytes: Buffer.byteLength(after) - Buffer.byteLength(before) };
}

/** Run one arm's plan in a cell root and measure it. */
export function runPlan({ root, arm, env }) {
	const steps = [];
	const started = performance.now();
	for (const step of arm.plan) {
		const stepStart = performance.now();
		const result = spawnSync(step.argv[0], step.argv.slice(1), {
			cwd: root,
			env,
			encoding: 'utf8',
			timeout: step.timeoutMs,
			maxBuffer: MAX_BUFFER,
		});
		const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
		steps.push({
			id: step.id,
			argv: step.argv,
			wallMs: Math.round(performance.now() - stepStart),
			exitCode: result.status,
			signal: result.signal ?? null,
			timedOut: result.error?.code === 'ETIMEDOUT' || (result.status === null && result.signal === 'SIGTERM'),
			spawnError: result.error && result.error.code !== 'ETIMEDOUT' ? result.error.code ?? 'spawn_error' : null,
			bytes: Buffer.byteLength(output),
			outputDigest: sha256(output).slice(0, 16),
			output,
		});
	}
	return { steps, wallMs: Math.round(performance.now() - started) };
}

/**
 * Rubric from `manifest.rubric`, applied mechanically. A control turns red on any
 * non-zero exit (false positive). A defect task that no guard flags is a miss.
 */
export function scoreCell({ task, steps }) {
	const excerpt = steps
		.map((step) => step.output)
		.join('\n')
		.slice(-EXCERPT_CHARS);
	const timedOut = steps.find((step) => step.timedOut);
	const spawnError = steps.find((step) => step.spawnError);
	const failed = steps.filter((step) => step.exitCode !== 0);
	const base = { excerpt, failedSteps: failed.map((step) => step.id) };
	if (timedOut) return { ...base, outcome: 'error', score: 0, reason: `timeout:${timedOut.id}` };
	if (spawnError) return { ...base, outcome: 'error', score: 0, reason: `spawn_error:${spawnError.id}:${spawnError.spawnError}` };
	if (task.plant === null || task.plant === undefined) {
		if (failed.length > 0) return { ...base, outcome: 'failed', score: 0, reason: 'control_false_positive' };
		return { ...base, outcome: 'passed', score: 5, reason: 'control_clean' };
	}
	if (failed.length === 0) return { ...base, outcome: 'failed', score: 0, reason: 'defect_missed' };
	const located = task.oracle?.locate ? failed.some((step) => step.output.includes(task.oracle.locate)) : false;
	if (located) return { ...base, outcome: 'passed', score: 5, reason: 'defect_located' };
	return { ...base, outcome: 'passed', score: 3, reason: 'defect_caught_not_located' };
}

function cellEnv(cellRoot) {
	const home = join(cellRoot, 'home');
	const scratch = join(cellRoot, 'tmp');
	mkdirSync(home, { recursive: true, mode: 0o700 });
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	return {
		...process.env,
		HOME: home,
		TMPDIR: scratch,
		XDG_CONFIG_HOME: join(cellRoot, 'config'),
		XDG_CACHE_HOME: join(cellRoot, 'cache'),
		RRSI_PERIODIC: 'off',
		RRSI_VERIFY_CHILD: '',
	};
}

/** Extract `head` (rrsi, shared, self-improve, package.json) into dest. */
export function snapshot({ repoRoot, head, dest }) {
	mkdirSync(dest, { recursive: true });
	const tarPath = join(dest, '.snapshot.tar');
	const archive = spawnSync('git', ['archive', '--format=tar', '-o', tarPath, head, '--', ...SNAPSHOT_PATHS], {
		cwd: repoRoot,
		encoding: 'utf8',
	});
	try {
		if (archive.status !== 0) throw new Error(`snapshot_failed: ${(archive.stderr ?? '').trim() || archive.status}`);
		const extract = spawnSync('tar', ['-xf', tarPath, '-C', dest], { cwd: repoRoot, encoding: 'utf8' });
		if (extract.status !== 0) throw new Error(`snapshot_extract_failed: ${(extract.stderr ?? '').trim() || extract.status}`);
	} finally {
		rmSync(tarPath, { force: true });
	}
	return dest;
}

function resolveHead(repoRoot, rev) {
	const result = spawnSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], { cwd: repoRoot, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`unknown_revision: ${rev}`);
	return result.stdout.trim();
}

function cellRecord({ task, arm, steps, wallMs, defect }) {
	const verdict = scoreCell({ task, steps });
	return {
		taskId: task.id,
		taskClass: task.class,
		armId: arm.id,
		armLabel: arm.label ?? arm.id,
		planned: arm.plan.length,
		executed: steps.length,
		toolCalls: steps.length,
		retries: 0,
		wallMs,
		artifactBytes: steps.reduce((sum, step) => sum + step.bytes, 0),
		exitCodes: steps.map((step) => step.exitCode),
		stepWallMs: Object.fromEntries(steps.map((step) => [step.id, step.wallMs])),
		outputDigest: sha256(steps.map((step) => step.outputDigest).join(':')).slice(0, 16),
		defect,
		...verdict,
	};
}

/**
 * Run the full matrix. Cells are independent: a fresh snapshot, a fresh HOME and a
 * fresh TMPDIR per cell, removed afterwards unless `keepWorkdirs` is set.
 */
export function runMatrix({ repoRoot, manifest, head = 'HEAD', keepWorkdirs = false }) {
	validateManifest(manifest);
	const sourceHead = resolveHead(repoRoot, head);
	const cells = [];
	const controls = [];
	const runCell = (task, arm) => {
		const cellRoot = mkdtempSync(join(tmpdir(), 'h2m1-'));
		try {
			const root = snapshot({ repoRoot, head: sourceHead, dest: join(cellRoot, 'root') });
			const defect = task.plant ? plantDefect(root, task.plant) : null;
			const { steps, wallMs } = runPlan({ root, arm, env: cellEnv(cellRoot) });
			return cellRecord({ task, arm, steps, wallMs, defect });
		} finally {
			if (!keepWorkdirs) rmSync(cellRoot, { recursive: true, force: true });
		}
	};
	for (const task of manifest.tasks) for (const arm of manifest.arms) cells.push(runCell(task, arm));
	for (const task of manifest.controls ?? []) for (const arm of manifest.arms) controls.push(runCell(task, arm));
	const totals = {
		planned: cells.length,
		passed: cells.filter((cell) => cell.outcome === 'passed').length,
		failed: cells.filter((cell) => cell.outcome === 'failed').length,
		error: cells.filter((cell) => cell.outcome === 'error').length,
		skipped: 0,
	};
	return { sourceHead, cells, controls, totals };
}

export function buildResult({ manifest, matrix, head, revision, host }) {
	return {
		schema: RESULT_SCHEMA,
		runId: `m1-${head.slice(0, 7)}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z')}`,
		manifestId: manifest.id,
		manifestDigest: manifestDigest(manifest),
		sourceHead: head,
		sourceRevision: revision,
		scope: manifest.scope,
		immutability: manifest.immutability,
		metricDefinitions: manifest.metricDefinitions,
		rubric: manifest.rubric,
		exclusions: manifest.exclusions,
		host,
		matrix: { tasks: manifest.tasks.length, arms: manifest.arms.length, cells: matrix.cells.length },
		totals: matrix.totals,
		cells: matrix.cells,
		controls: matrix.controls,
	};
}

/** Attempt records for the RRSI store: one per measured cell. */
export function rrsiAttempts(result) {
	const seen = new Set();
	return result.cells.map((cell) => {
		const objective = `${cell.armId}:${cell.taskId}`.slice(0, 120);
		const novelty = !seen.has(objective);
		seen.add(objective);
		return {
			objective,
			hypothesisNovelty: novelty,
			decision: cell.score >= 3 ? 'adopt' : 'reject',
			wallMs: Math.min(cell.wallMs, 86_400_000),
			guardFailures: cell.score >= 3 ? [] : [cell.taskId.slice(0, 40)],
			budgetRung: 0,
			files: 0,
			hunks: 0,
		};
	});
}

export function summaryTable(result) {
	const rows = [...result.cells, ...result.controls];
	const header = '| task | arm | wallMs | toolCalls | artifactBytes | score | outcome | reason |';
	const divider = '| --- | --- | --- | --- | --- | --- | --- | --- |';
	const body = rows.map(
		(cell) => `| ${cell.taskId} | ${cell.armId} (${cell.armLabel}) | ${cell.wallMs} | ${cell.toolCalls} | ${cell.artifactBytes} | ${cell.score} | ${cell.outcome} | ${cell.reason} |`,
	);
	return [header, divider, ...body].join('\n');
}

function writeOutputs({ outDir, result, attempts }) {
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, 'm1-result.json'), `${JSON.stringify(result, null, 2)}\n`);
	writeFileSync(join(outDir, 'rrsi-attempts.json'), `${JSON.stringify(attempts, null, 2)}\n`);
	const lines = [
		`# Harness² M1 — ${result.runId}`,
		'',
		`- sourceHead: \`${result.sourceHead}\` (${result.sourceRevision})`,
		`- manifest: \`${result.manifestId}\` digest \`${result.manifestDigest.slice(0, 16)}\``,
		`- matrix: ${result.matrix.tasks} tasks × ${result.matrix.arms} arms = ${result.matrix.cells} cells; totals ${JSON.stringify(result.totals)}`,
		`- host: ${result.host.platform}/${result.host.arch} ${result.host.cpuCount} cores, node ${result.host.node}, bun ${result.host.bun}`,
		'',
		result.scope,
		'',
		summaryTable(result),
		'',
		`Rubric: ${JSON.stringify(result.rubric)}`,
		'',
		`Exclusions: ${result.exclusions}`,
		'',
	].join('\n');
	writeFileSync(join(outDir, 'm1-summary.md'), lines);
	return lines;
}

function hostFacts() {
	const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
	return {
		platform: process.platform,
		arch: process.arch,
		cpuCount: hostCpuCount(),
		node: process.versions.node,
		bun: (bun.stdout ?? '').trim() || null,
	};
}

function hostCpuCount() {
	return (globalThis.navigator?.hardwareConcurrency ?? null) ?? process.env.NUMBER_OF_PROCESSORS ?? null;
}

function parseArgs(argv) {
	const args = { out: null, head: 'HEAD', manifest: join(dirname(fileURLToPath(import.meta.url)), 'manifest.json'), keep: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === '--out') args.out = argv[++index];
		else if (arg === '--head') args.head = argv[++index];
		else if (arg === '--manifest') args.manifest = argv[++index];
		else if (arg === '--keep') args.keep = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	return args;
}

function main(argv) {
	const args = parseArgs(argv);
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
	const manifest = validateManifest(JSON.parse(readFileSync(args.manifest, 'utf8')));
	const head = resolveHead(repoRoot, args.head);
	const revision = spawnSync('git', ['rev-parse', '--abbrev-ref', args.head], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim() || args.head;
	const matrix = runMatrix({ repoRoot, manifest, head, keepWorkdirs: args.keep });
	const result = buildResult({ manifest, matrix, head, revision, host: hostFacts() });
	const outDir = args.out ? resolve(args.out) : join(repoRoot, 'artifacts', `harness2-m1-${result.runId}`);
	const table = writeOutputs({ outDir, result, attempts: rrsiAttempts(result) });
	process.stdout.write(`${table}\n\nwrote ${outDir}\n`);
	if (result.totals.error > 0) {
		process.stderr.write(`m1: ${result.totals.error} cell(s) errored; see m1-result.json\n`);
		process.exitCode = 1;
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
