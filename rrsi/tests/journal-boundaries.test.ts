#!/usr/bin/env bun
/**
 * Hermetic journal projection and freshness regressions, part of test:rrsi.
 * Real-journal diagnostics live separately in real-journal.test.ts.
 */
import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { journalWindowCoverage, projectJournalRecords, readJournalRecords } from "../lib/rrsi";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the producer's taskAdvice[] batch projects a real label, not unknown/reject", () => {
	const records = [
		// Real jev-advisor producer shape: a compact batch with full-precision entries.
		{ schemaVersion: 1, plugin: "jev-advisor", id: "rec-batch", observedAt: "2026-10-24T00:00:00.000Z", operation: "task_advice", durationMs: 700, taskAdvice: [{ index: 0, status: "decision", tier: "strong", confidence: 0.95, basis: "provider_choice" }] },
		// Older single-answer field: read only because taskAdvice is absent.
		{ schemaVersion: 1, plugin: "jev-advisor", id: "rec-advice", observedAt: "2026-10-24T00:00:01.000Z", operation: "advise", durationMs: 900, advice: { status: "decision", tier: "balanced" } },
		// A batch with no decision: a real (negative) label, not "unknown".
		{ schemaVersion: 1, plugin: "jev-advisor", id: "rec-none", observedAt: "2026-10-24T00:00:02.000Z", operation: "task_advice", durationMs: 12, taskAdvice: [{ index: 0, status: "no_decision", tier: "fast", reason: "disabled" }] },
	];
	const projected = projectJournalRecords(records);
	expect(projected.headOmitted).toBe(0);
	expect(projected.scanned).toBe(3);
	expect(projected.attempts.map((attempt) => attempt.objective)).toEqual(["task_advice:strong", "advise:balanced", "task_advice:fast"]);
	expect(projected.attempts.map((attempt) => attempt.decision)).toEqual(["adopt", "adopt", "reject"]);
	expect(projected.attempts[0].provenance).toBe("rec-batch");
	// One record is one attempt: multi-entry batches do not inflate the corpus.
	expect(projected.attempts).toHaveLength(records.length);
	expect(projected.novelty).toMatchObject({ retained: 3, novel: 3, shared: 0, density: 1 });
});

test("a bounded projection keeps the newest window and reports the head it dropped", () => {
	const records = [
		{ id: "rec-1", operation: "task_advice", taskAdvice: [{ index: 0, status: "decision", tier: "strong" }] },
		{ id: "rec-2", operation: "task_advice", taskAdvice: [{ index: 0, status: "decision", tier: "strong" }] },
	];
	const projected = projectJournalRecords(records, { limit: 1 });
	expect(projected.attempts).toHaveLength(1);
	expect(projected.attempts[0].provenance).toBe("rec-2");
	expect(projected.scanned).toBe(2);
	expect(projected.headOmitted).toBe(1);
	// Novelty keeps the journal read order: the retained record shares a branch
	// whose first occurrence is in the dropped head, so it is not novel.
	expect(projected.novelty).toMatchObject({ retained: 1, novel: 0, shared: 1, density: 0 });
	expect(projectJournalRecords(records, { limit: 2 }).headOmitted).toBe(0);
});

const seedStamp = "2026-01-01T00:00:00.000Z";

function seedPeriodicState(home) {
	const root = path.join(home, ".gjc-plugin", "rrsi");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const state = {
		schema: "gjc.rrsi.periodic.v1",
		intervalMs: 24 * 60 * 60 * 1000,
		lastAttemptAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
		lastSuccessAt: seedStamp,
		lastStatus: "ran",
		lastReason: null,
		nextRetryAt: null,
		consecutiveFailures: 0,
		lastReceiptId: null,
		lastProjectionDigest: null,
		lastProjection: null,
		storeWrite: null,
		derivedChunks: null,
		clockSkew: false,
		updatedAt: seedStamp,
	};
	writeFileSync(path.join(root, "periodic.json"), `${JSON.stringify(state, null, 2)}\n`);
	return path.join(root, "periodic.json");
}

function seedTaskAdviceJournal(home, count) {
	const journalDir = path.join(home, ".gjc-plugin", "jev-advisor", "journal", "v1");
	mkdirSync(journalDir, { recursive: true, mode: 0o700 });
	const lines = Array.from({ length: count }, (_, index) =>
		JSON.stringify({
			schemaVersion: 1,
			plugin: "jev-advisor",
			id: `rec-${String(index).padStart(4, "0")}`,
			observedAt: new Date(Date.UTC(2026, 9, 24, 0, 0, index)).toISOString(),
			operation: "task_advice",
			durationMs: 10 + index,
			taskAdvice: [{ index: 0, status: index % 2 === 0 ? "decision" : "no_decision", tier: "strong", confidence: 0.95 }],
		}),
	);
	writeFileSync(path.join(journalDir, "seg-1.jsonl"), `${lines.join("\n")}\n`);
}

test("a newest-window projection renews freshness over a mature journal", async () => {
	const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rrsi-newest-window-")));
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		expect(existsSync(path.join(home, ".gjc-plugin"))).toBe(false);
		seedTaskAdviceJournal(home, 200);
		const statePath = seedPeriodicState(home);
		const hook = await import(pathToFileURL(path.join(plugin, "hooks/rrsi-periodic.ts")).href);
		const run = await hook.runPeriodic({ env: process.env, mode: "inline" });
		expect(run.status).toBe("ran");
		expect(run.newest_covered).toBe(true);
		expect(run.head_omitted).toBe(40);
		const receipts = readdirSync(path.join(home, ".gjc-plugin", "rrsi", "runs", "v1"));
		expect(receipts.length).toBe(1);
		const receipt = JSON.parse(readFileSync(path.join(home, ".gjc-plugin", "rrsi", "runs", "v1", receipts[0]), "utf8"));
		expect(receipt.newest_covered).toBe(true);
		expect(receipt.head_omitted).toBe(40);
		expect(receipt.projection).toMatchObject({ records: 200, projected: 160, omitted: 40, limited: true });
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		expect(state.newest_covered).toBe(true);
		expect(state.lastSuccessAt).not.toBe(seedStamp);
		expect(Date.parse(state.nextRetryAt) - Date.parse(state.lastAttemptAt)).toBe(24 * 60 * 60 * 1000);
		const status = await hook.summarizePeriodicState({ state, env: process.env });
		expect(status.newest_covered).toBe(true);
	} finally {
		process.env.HOME = previous;
		rmSync(home, { recursive: true, force: true });
	}
});

test("a torn tail is reported and does not block freshness", async () => {
	const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rrsi-torn-tail-")));
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		seedTaskAdviceJournal(home, 12);
		const journalDir = path.join(home, ".gjc-plugin", "jev-advisor", "journal", "v1");
		appendFileSync(path.join(journalDir, "seg-1.jsonl"), '{"schemaVersion":1,"plugin":"jev-advisor","id":"rec-torn","operation":"task_advice","taskAdvice":[');
		const report = readJournalRecords({ journalDir });
		expect(report.newestSegment.tornTail).toBe(true);
		expect(report.records.length).toBe(12);
		expect(journalWindowCoverage(report.segmentReport, 160).covered).toBe(true);
		const statePath = seedPeriodicState(home);
		const hook = await import(pathToFileURL(path.join(plugin, "hooks/rrsi-periodic.ts")).href);
		const run = await hook.runPeriodic({ env: process.env, mode: "inline" });
		expect(run.status).toBe("ran");
		expect(run.newest_covered).toBe(true);
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		expect(state.lastSuccessAt).not.toBe(seedStamp);
	} finally {
		process.env.HOME = previous;
		rmSync(home, { recursive: true, force: true });
	}
});

test("an unproven segment inside the window holds the store and never renews freshness", async () => {
	const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rrsi-unproven-segment-")));
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		seedTaskAdviceJournal(home, 12);
		const journalDir = path.join(home, ".gjc-plugin", "jev-advisor", "journal", "v1");
		renameSync(path.join(journalDir, "seg-1.jsonl"), path.join(journalDir, "journal-a.jsonl"));
		const report = readJournalRecords({ journalDir });
		expect(report.ordering).toBe("unproven");
		expect(journalWindowCoverage(report.segmentReport, 160).covered).toBe(false);
		const statePath = seedPeriodicState(home);
		const hook = await import(pathToFileURL(path.join(plugin, "hooks/rrsi-periodic.ts")).href);
		const run = await hook.runPeriodic({ env: process.env, mode: "inline" });
		expect(run.status).toBe("uncovered");
		expect(run.newest_covered).toBe(false);
		expect(run.storeWrite).toBe("held");
		expect(existsSync(path.join(home, ".gjc-plugin", "rrsi", "store.json"))).toBe(false);
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		expect(state.newest_covered).toBe(false);
		expect(state.lastSuccessAt).toBe(seedStamp);
		expect(Date.parse(state.nextRetryAt) - Date.parse(state.lastAttemptAt)).toBe(24 * 60 * 60 * 1000);
	} finally {
		process.env.HOME = previous;
		rmSync(home, { recursive: true, force: true });
	}
});