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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
		writeFileSync(path.join(journalDir, "seg-real.jsonl"), `${slice.map((record) => JSON.stringify(record)).join("\n")}\n`);

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
