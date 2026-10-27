#!/usr/bin/env bun
/**
 * Capture -> import -> dream round trip over >=10 REAL jev-advisor journal
 * attempts (M5 acceptance [F06]).
 *
 * The real journal is read READ-ONLY and copied into a temporary isolated HOME;
 * the plugin store is written only under that temporary HOME (the user's real
 * store is never touched). If the real journal is unavailable the test reports
 * the measured count (0) instead of substituting synthetic data.
 */
import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { journalWindowCoverage, projectJournalRecords, readJournalRecords } from "../lib/rrsi";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realJournalDir = path.join(os.homedir(), ".gjc-plugin", "jev-advisor", "journal", "v1");

function realJournalRecords() {
	if (!existsSync(realJournalDir)) return { records: [], segments: 0 };
	const segments = readdirSync(realJournalDir).filter((name) => name.endsWith(".jsonl")).sort();
	const records = [];
	for (const name of segments.slice(-8)) {
		for (const line of readFileSync(path.join(realJournalDir, name), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				/* malformed source lines are skipped, never repaired */
			}
		}
	}
	return { records, segments: segments.length };
}

test("capture -> import -> dream over >=10 real jev-advisor journal attempts (hermetic store)", async () => {
	const { records, segments } = realJournalRecords();
	console.log(`measured real jev-advisor journal: segments=${segments} records=${records.length}`);
	expect(records.length >= 10).toBe(true);

	const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rrsi-real-")));
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		// copy a bounded slice of REAL records into the isolated journal path (read-only source)
		const journalDir = path.join(home, ".gjc-plugin", "jev-advisor", "journal", "v1");
		mkdirSync(journalDir, { recursive: true, mode: 0o700 });
		const slice = records.slice(-40);
		writeFileSync(path.join(journalDir, "seg-1.jsonl"), `${slice.map((record) => JSON.stringify(record)).join("\n")}\n`);

		const fakePi = { typebox: { Type: { Object: (fields) => fields, String: (options) => options ?? {}, Optional: (schema) => schema } } };
		const tool = (await import(pathToFileURL(path.join(plugin, "tools/rrsi.ts")).href)).default(fakePi);
		const call = async (params) => JSON.parse((await tool.execute("real", params)).content[0].text);

		const imported = await call({ action: "import", limit: "40" });
		expect(imported.imported).toBe(slice.length);
		expect(imported.journal.status).toBe("ok");

		// capture a real-shaped episode (a goal with an adopted attempt) so the store
		// carries a decision branch, then dream over the whole store
		const captured = await call({
			action: "capture",
			goal: "real-journal round trip",
			attempts: JSON.stringify([{ objective: "round-trip:adopt", decision: "adopt", wallMs: 5 }]),
		});
		expect(captured.counts.attempts).toBe(slice.length + 1);

		const dreamed = await call({ action: "dream", seed: "11" });
		expect(dreamed.corpusAttempts).toBe(slice.length + 1);
		expect(dreamed.policies).toBe(40);
		expect(typeof dreamed.summary.verdict).toBe("string");
		expect(dreamed.summary.receiptHash.length).toBe(64);
		const again = await call({ action: "dream", seed: "11" });
		expect(again.summary.receiptHash).toBe(dreamed.summary.receiptHash);
		console.log(`round trip: imported=${imported.imported} attempts=${dreamed.corpusAttempts} policies=${dreamed.policies} verdict=${dreamed.summary.verdict}`);
	} finally {
		process.env.HOME = previous;
		rmSync(home, { recursive: true, force: true });
	}
});

test("periodic refresh over the real-journal slice: one derived set per source, unchanged rerun keeps bytes and receiptHash identical (hermetic store)", async () => {
	const { records } = realJournalRecords();
	expect(records.length >= 10).toBe(true);

	const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rrsi-periodic-real-")));
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		const journalDir = path.join(home, ".gjc-plugin", "jev-advisor", "journal", "v1");
		mkdirSync(journalDir, { recursive: true, mode: 0o700 });
		const slice = records.slice(-40);
		writeFileSync(path.join(journalDir, "seg-1.jsonl"), `${slice.map((record) => JSON.stringify(record)).join("\n")}\n`);

		const hook = await import(pathToFileURL(path.join(plugin, "hooks/rrsi-periodic.ts")).href);
		const root = path.join(home, ".gjc-plugin", "rrsi");
		const storePath = path.join(root, "store.json");
		const first = await hook.runPeriodic({ env: process.env, mode: "inline" });
		expect(first.status).toBe("ran");
		expect(first.storeWrite).toBe("added");
		const receiptsA = readdirSync(path.join(root, "runs", "v1"));
		expect(receiptsA.length).toBe(1);
		const receiptA = JSON.parse(readFileSync(path.join(root, "runs", "v1", receiptsA[0]), "utf8"));
		expect(receiptA.projectionDigest.length).toBe(64);
		expect(typeof receiptA.receiptHash).toBe("string");
		const storeA = JSON.parse(readFileSync(storePath, "utf8"));
		expect(storeA.episodes.filter((episode) => episode.source === "jev-journal").length).toBe(1);
		expect(storeA.episodes.filter((episode) => episode.id.startsWith("ep-jev-")).length).toBe(1);

		const state = JSON.parse(readFileSync(path.join(root, "periodic.json"), "utf8"));
		state.lastAttemptAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		state.nextRetryAt = null;
		writeFileSync(path.join(root, "periodic.json"), `${JSON.stringify(state, null, 2)}\n`);
		const bytesBefore = readFileSync(storePath, "utf8");
		const second = await hook.runPeriodic({ env: process.env, mode: "inline" });
		expect(second.status).toBe("unchanged");
		expect(readFileSync(storePath, "utf8")).toBe(bytesBefore);
		const receiptsB = readdirSync(path.join(root, "runs", "v1")).filter((name) => !receiptsA.includes(name));
		expect(receiptsB.length).toBe(1);
		const receiptB = JSON.parse(readFileSync(path.join(root, "runs", "v1", receiptsB[0]), "utf8"));
		expect(receiptB.projectionDigest).toBe(receiptA.projectionDigest);
		expect(receiptB.receiptHash).toBe(receiptA.receiptHash);
		console.log(`periodic real-journal slice: records=${slice.length} storeWrite=${first.storeWrite} rerun=${second.status} digest=${receiptA.projectionDigest.slice(0, 12)}`);
	} finally {
		process.env.HOME = previous;
		rmSync(home, { recursive: true, force: true });
	}
});

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