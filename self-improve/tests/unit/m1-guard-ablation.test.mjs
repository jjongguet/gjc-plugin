import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MANIFEST_SCHEMA,
	manifestDigest,
	plantDefect,
	rrsiAttempts,
	runMatrix,
	scoreCell,
	summaryTable,
	validateManifest,
} from "../../m1/run-m1.mjs";

const MANIFEST_PATH = new URL("../../m1/manifest.json", import.meta.url);
const frozenManifest = () => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

function withTempDir(fn) {
	const root = mkdtempSync(join(tmpdir(), "m1-test-"));
	try {
		return fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const step = (exitCode, output) => ({ id: "s", output, exitCode, timedOut: false, spawnError: null });
const defectTask = { id: "t", class: "small-repo-task", plant: { op: "append", file: "x", text: "y" }, oracle: { caught: "exit_nonzero", locate: "marker" } };
const controlTask = { id: "c", class: "small-repo-task", plant: null, oracle: { caught: "none" } };

test("the frozen manifest validates and pins a digest", () => {
	const manifest = validateManifest(frozenManifest());
	assert.equal(manifest.schema, MANIFEST_SCHEMA);
	assert.equal(manifest.arms.length >= 2, true);
	assert.equal(manifest.tasks.length >= 2, true, "M1 needs at least two planted-defect tasks");
	assert.match(manifestDigest(manifest), /^[a-f0-9]{64}$/);
});

test("manifest validation fails closed on a shrunk matrix, unknown ops and path escapes", () => {
	const oneArm = frozenManifest();
	oneArm.arms = oneArm.arms.slice(0, 1);
	assert.throws(() => validateManifest(oneArm), /at least two arms/);

	const noTargets = frozenManifest();
	noTargets.tasks = [];
	assert.throws(() => validateManifest(noTargets), /at least two planted-defect tasks/);

	const badOp = frozenManifest();
	badOp.tasks[0].plant.op = "mutate";
	assert.throws(() => validateManifest(badOp), /append or replace/);

	const escape = frozenManifest();
	escape.tasks[0].plant.file = "../../etc/passwd";
	assert.throws(() => validateManifest(escape), /escapes the snapshot/);

	const badOracle = frozenManifest();
	badOracle.tasks[0].oracle.caught = "exit_zero";
	assert.throws(() => validateManifest(badOracle), /exit_nonzero/);

	const unknownSchema = frozenManifest();
	unknownSchema.schema = "harness2.m1.manifest.v0";
	assert.throws(() => validateManifest(unknownSchema), new RegExp(MANIFEST_SCHEMA));
});

test("a measurement run with zero tasks prevents any cell from being planned", () => {
	withTempDir((repoRoot) => {
		mkdirSync(join(repoRoot, "rrsi"), { recursive: true });
		const empty = { ...frozenManifest(), tasks: [], controls: [] };
		assert.throws(() => runMatrix({ repoRoot, manifest: empty }), /at least two planted-defect tasks/);
	});
});

test("planting a defect fails closed when the anchor is missing", () => {
	withTempDir((root) => {
		mkdirSync(join(root, "rrsi"), { recursive: true });
		writeFileSync(join(root, "rrsi", "file.txt"), "alpha beta\n");
		assert.throws(
			() => plantDefect(root, { op: "replace", file: "rrsi/file.txt", find: "gamma", text: "delta" }),
			/anchor_missing/,
		);
		assert.throws(() => plantDefect(root, { op: "append", file: "rrsi/absent.txt", text: "x" }), /target_missing/);
		assert.throws(() => plantDefect(root, { op: "replace", file: "rrsi/file.txt", find: "alpha", text: "alpha" }), /no_change/);
	});
});

test("planting an append and a replace lands exactly one defect", () => {
	withTempDir((root) => {
		mkdirSync(join(root, "rrsi"), { recursive: true });
		writeFileSync(join(root, "rrsi", "file.txt"), "alpha beta\n");
		plantDefect(root, { op: "replace", file: "rrsi/file.txt", find: "beta", text: "beta-gamma" });
		plantDefect(root, { op: "append", file: "rrsi/file.txt", text: "tail\n" });
		assert.equal(readFileSync(join(root, "rrsi", "file.txt"), "utf8"), "alpha beta-gamma\ntail\n");
	});
});

test("the rubric separates located, caught-not-located, missed, false-positive and error cells", () => {
	assert.equal(scoreCell({ task: defectTask, steps: [step(1, "generated_out_of_sync:x marker")] }).score, 5);
	const caught = scoreCell({ task: defectTask, steps: [step(1, "assertion failed")] });
	assert.equal(caught.score, 3);
	assert.equal(caught.reason, "defect_caught_not_located");
	const missed = scoreCell({ task: defectTask, steps: [step(0, "all good")] });
	assert.equal(missed.score, 0);
	assert.equal(missed.reason, "defect_missed");
	const falsePositive = scoreCell({ task: controlTask, steps: [step(1, "boom")] });
	assert.equal(falsePositive.score, 0);
	assert.equal(falsePositive.reason, "control_false_positive");
	assert.equal(scoreCell({ task: controlTask, steps: [step(0, "clean")] }).score, 5);
	const timeout = scoreCell({ task: defectTask, steps: [{ ...step(null, ""), timedOut: true }] });
	assert.equal(timeout.outcome, "error");
	assert.equal(timeout.score, 0);
	const spawnError = scoreCell({ task: defectTask, steps: [{ ...step(null, ""), spawnError: "ENOENT" }] });
	assert.equal(spawnError.outcome, "error");
	assert.match(spawnError.reason, /spawn_error/);
});

test("a caught defect stops earning the located score when the marker is absent", () => {
	const partial = scoreCell({ task: defectTask, steps: [step(0, "clean"), step(1, "FAIL something else")] });
	assert.equal(partial.score, 3);
	assert.deepEqual(partial.failedSteps, ["s"]);
});

test("rrs attempts carry one adopt per detected cell and mark the first of each branch novel", () => {
	const result = {
		cells: [
			{ armId: "B0", taskId: "drift", score: 5, wallMs: 12 },
			{ armId: "B0", taskId: "manifest", score: 0, wallMs: 9 },
			{ armId: "B1", taskId: "drift", score: 5, wallMs: 2800 },
		],
	};
	const attempts = rrsiAttempts(result);
	assert.deepEqual(attempts.map((attempt) => attempt.decision), ["adopt", "reject", "adopt"]);
	assert.deepEqual(attempts.map((attempt) => attempt.hypothesisNovelty), [true, true, true]);
	assert.deepEqual(attempts[1].guardFailures, ["manifest"]);
	assert.equal(attempts[0].objective, "B0:drift");
});

test("the summary table carries one row per measured cell and control", () => {
	const cell = { taskId: "t", armId: "B0", armLabel: "drift-only", wallMs: 12, toolCalls: 1, artifactBytes: 40, score: 5, outcome: "passed", reason: "defect_located" };
	const result = { runId: "m1-abc", cells: [cell], controls: [{ ...cell, taskId: "clean-control" }] };
	const table = summaryTable(result);
	assert.equal(table.split("\n").length, 4, "header + divider + two rows");
	assert.match(table, /\| t \| B0 \(drift-only\) \|/);
	assert.match(table, /clean-control/);
});
