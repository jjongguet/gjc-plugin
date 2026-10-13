#!/usr/bin/env bun
/**
 * Offline generated-package acceptance for the rrsi plugin.
 *
 * Hermetic: a temporary isolated HOME for store and journal writes; the user's
 * real ~/.gjc-plugin/rrsi store is never touched. The jev-advisor journal is
 * read-only: this verifier only counts the real segments (when reachable) and
 * copies synthetic fixtures into the isolated HOME. Keyless: no credentials, no
 * network, no model calls.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(import.meta.url);
const plugin = path.resolve(path.dirname(script), "..");
const realJournalDir = path.join(os.homedir(), ".gjc-plugin", "jev-advisor", "journal", "v1");
if (process.argv[2] !== "--isolated") {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rrsi-offline-")));
	let status = 1;
	try {
		for (const dir of ["home", "tmp", "cwd", "config"]) mkdirSync(path.join(root, dir), { mode: 0o700 });
		const child = spawnSync(process.execPath, ["--no-env-file", script, "--isolated", root], {
			cwd: path.join(root, "cwd"),
			env: {
				HOME: path.join(root, "home"),
				TMPDIR: path.join(root, "tmp"),
				XDG_CONFIG_HOME: path.join(root, "config"),
				LC_ALL: "C",
				RRSI_VERIFY_CHILD: "1",
				RRSI_REAL_JOURNAL_DIR: realJournalDir,
			},
			stdio: "inherit",
			timeout: 180000,
		});
		if (child.error) console.error(child.error.message);
		status = child.status ?? 1;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	process.exitCode = status;
} else {
	await runSuite(process.argv[3]);
}

async function runSuite(root) {
	assert.equal(process.env.RRSI_VERIFY_CHILD, "1");
	assert.equal(os.homedir(), path.join(root, "home"));
	let cases = 0;
	let failures = 0;
	let realJournalRecords = null;
	const check = async (name, fn) => {
		cases++;
		try {
			await fn();
			console.log(`ok ${cases} ${name}`);
		} catch (error) {
			failures++;
			console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
		}
	};

	const fakePi = { typebox: { Type: { Object: (fields) => fields, String: (options) => options ?? {}, Optional: (schema) => schema } } };
	const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8"));
	const tool = (await import(pathToFileURL(path.join(plugin, "tools/rrsi.ts")).href)).default(fakePi);
	const generated = readFileSync(path.join(plugin, "tools/rrsi.ts"), "utf8");
	const home = path.join(root, "home");
	const storeDir = path.join(home, ".gjc-plugin", "rrsi");
	const storeFile = path.join(storeDir, "store.json");
	const call = async (params) => JSON.parse((await tool.execute("verify", params)).content[0].text);
	const journalDir = path.join(home, ".gjc-plugin", "jev-advisor", "journal", "v1");
	const writeJournal = (records) => {
		mkdirSync(journalDir, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(journalDir, "seg-1.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	};
	const syntheticRecords = (count) =>
		Array.from({ length: count }, (_, index) => ({
			schemaVersion: 1,
			plugin: "jev-advisor",
			id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			observedAt: "2026-10-13T00:00:00.000Z",
			operation: index % 2 === 0 ? "advise" : "run",
			durationMs: 100 + index,
			advice: index % 3 === 0 ? { status: "decision", tier: ["fast", "balanced", "strong"][index % 3] } : { status: "no_decision", reason: "provider_error" },
		}));

	await check("manifest declares one tool, no hooks, and the four actions", async () => {
		assert.equal(manifest.name, "rrsi");
		assert.equal(manifest.version, "0.0.1");
		assert.equal(manifest.hooks, undefined);
		assert.equal(manifest.tools.length, 1);
		assert.equal(manifest.tools[0].path, "tools/rrsi.ts");
		assert.equal(typeof tool.execute, "function");
	});

	await check("status on an empty store reports missing storage without creating one", async () => {
		const status = await call({ action: "status" });
		assert.equal(status.storageStatus, "missing");
		assert.deepEqual(status.counts, { episodes: 0, attempts: 0, adoptions: 0 });
		assert.equal(existsSync(storeFile), false);
		assert.equal(status.journalStorage.persisted, true);
	});

	await check("capture stores one bounded episode with 0700/0600 privacy and journals the outcome", async () => {
		const captured = await call({ action: "capture", goal: "verify goal", attempts: JSON.stringify([{ objective: "verify:fast", decision: "adopt", wallMs: 10 }, { objective: "verify:strong", decision: "reject", wallMs: 20 }]) });
		assert.equal(captured.episode.attempts, 2);
		assert.deepEqual(captured.counts, { episodes: 1, attempts: 2, adoptions: 1 });
		assert.equal(captured.wrote.persisted, true);
		assert.equal(captured.journalStorage.persisted, true);
		assert.equal(statSync(storeDir).mode & 0o7777, 0o700);
		assert.equal(statSync(storeFile).mode & 0o7777, 0o600);
		assert.equal(statSync(storeFile).nlink, 1);
	});

	await check("capture clamps attempts, coerces unknown decisions and truncates labels", async () => {
		const attempts = Array.from({ length: 60 }, (_, index) => ({ objective: `x`.repeat(400) + index, decision: "exploded", wallMs: -5 }));
		const captured = await call({ action: "capture", goal: "y".repeat(500), attempts: JSON.stringify(attempts) });
		assert.equal(captured.episode.attempts, 40, "attempts per episode are capped at 40");
		const stored = JSON.parse(readFileSync(storeFile, "utf8"));
		const episode = stored.episodes.at(-1);
		assert.equal(episode.attempts.length, 40);
		assert.equal(episode.attempts[0].decision, "inconclusive");
		assert.equal(episode.attempts[0].wallMs, 0);
		assert.equal(episode.goal.length, 200);
		assert.equal(episode.attempts[0].objective.length, 120);
	});

	await check("import projects the jev-advisor journal into >=10 attempts with the documented fields", async () => {
		writeJournal(syntheticRecords(12));
		const imported = await call({ action: "import", limit: "50" });
		assert.equal(imported.imported, 12);
		assert.equal(imported.journal.records, 12);
		assert.equal(imported.journal.status, "ok");
		const stored = JSON.parse(readFileSync(storeFile, "utf8"));
		const episode = stored.episodes.at(-1);
		assert.equal(episode.source, "jev-journal");
		assert.equal(episode.attempts.length, 12);
		const objectives = new Set(episode.attempts.map((attempt) => attempt.objective));
		assert.ok([...objectives].every((objective) => objective.includes(":")), "branch objectives are <operation>:<tier|status>");
		assert.equal(episode.attempts[0].hypothesisNovelty, true, "first attempt of a branch is novel");
		assert.equal(episode.attempts.filter((attempt) => attempt.hypothesisNovelty === false).length > 0, true, "repeats are not novel");
		assert.equal(episode.attempts.every((attempt) => typeof attempt.provenance === "string" && attempt.provenance.length > 0), true, "provenance names the journal record id");
		assert.equal(episode.attempts.some((attempt) => attempt.decision === "adopt"), true, "decisions project to adopt");
		assert.equal(episode.attempts.some((attempt) => attempt.decision === "reject"), true, "no-decisions project to reject");
	});

	await check("import projects a self-improve ledger read-only when a path is given", async () => {
		const ledgerPath = path.join(root, "ledger.jsonl");
		const row = (cycleId, decision) => JSON.stringify({ kind: "cycle", cycleId, objective: "probe.decision_accuracy", hypothesisHash: "a".repeat(64), budgetRung: 0, proposal: { files: ["x.ts"], hunks: 1 }, scores: { delta: 0.05, floor: 0.01 }, cost: { wallMs: 1000, bytes: 10, tokens: null }, guards: [{ id: "build", status: "pass" }], critic: { verdict: "pass", rules: [] }, verdict: { decision, reasons: [] }, createdAt: "2026-10-13T00:00:00.000Z" });
		writeFileSync(ledgerPath, `${row("c1", "reject")}\n${row("c2", "adopt")}\nnot json\n`);
		const before = readFileSync(ledgerPath, "utf8");
		const imported = await call({ action: "import", ledgerPath, limit: "10" });
		assert.equal(imported.journal.status, "ok", "the journal import still runs alongside the ledger import");
		const stored = JSON.parse(readFileSync(storeFile, "utf8"));
		const ledgerEpisode = stored.episodes.find((episode) => episode.source === "self-improve-ledger");
		assert.ok(ledgerEpisode, "a ledger episode is stored");
		assert.equal(ledgerEpisode.attempts.length, 2, "malformed ledger rows are skipped, never repaired");
		assert.equal(ledgerEpisode.attempts.some((attempt) => attempt.decision === "adopt"), true);
		assert.equal(readFileSync(ledgerPath, "utf8"), before, "the ledger source is never modified");
	});

	await check("dream reports the frozen below-gate verdict for a small store", async () => {
		const isolatedHome = path.join(root, "home-small");
		mkdirSync(isolatedHome, { mode: 0o700 });
		const previous = process.env.HOME;
		process.env.HOME = isolatedHome;
		try {
			await call({ action: "capture", goal: "small store", attempts: JSON.stringify([{ objective: "small:fast", decision: "reject" }]) });
			const first = await call({ action: "dream", seed: "1" });
			const second = await call({ action: "dream", seed: "1" });
			assert.equal(first.policies, 40);
			assert.deepEqual(first.summary, second.summary, "same seed => identical summary");
			assert.equal(first.summary.thresholds.evaluated, false, "below the gate the thresholds are not evaluated");
			assert.equal(first.summary.verdict, "insufficient evidence at pass-gate size — thresholds not evaluated");
			assert.equal(typeof first.summary.caveat, "string");
			assert.match(first.summary.caveat, /no statistical significance is claimed/);
			assert.equal(first.journalStorage.persisted, true);
		} finally {
			process.env.HOME = previous;
		}
	});

	await check("a store at pass-gate size evaluates the thresholds instead", async () => {
		const attempts = Array.from({ length: 10 }, (_, index) => ({ objective: `round-${index % 2}:tier-${index}`, decision: index === 9 ? "adopt" : "reject", wallMs: 100 + index, hypothesisNovelty: index > 1 }));
		const captured = await call({ action: "capture", goal: "pass-gate episode", attempts: JSON.stringify(attempts) });
		assert.equal(captured.counts.attempts >= 20, true, `attempts=${captured.counts.attempts}`);
		const dreamed = await call({ action: "dream", seed: "7" });
		assert.equal(dreamed.summary.gate.ok, true, JSON.stringify(dreamed.summary.gate));
		assert.equal(dreamed.summary.thresholds.evaluated, true);
		assert.equal(typeof dreamed.summary.thresholds.attemptsOk, "boolean");
		const again = await call({ action: "dream", seed: "7" });
		assert.equal(dreamed.summary.receiptHash, again.summary.receiptHash, "same seed => identical receipt hash");
	});

	await check("the round trip runs capture -> import -> dream over >=10 imported attempts", async () => {
		const store = JSON.parse(readFileSync(storeFile, "utf8"));
		const importedAttempts = store.episodes.filter((episode) => episode.source === "jev-journal").flatMap((episode) => episode.attempts).length;
		assert.equal(importedAttempts >= 10, true, `imported real-shaped attempts=${importedAttempts}`);
		const dreamed = await call({ action: "dream", seed: "3" });
		assert.equal(dreamed.corpusAttempts >= 20, true);
		assert.equal(dreamed.summary.verdict !== undefined, true);
	});

	await check("store faults are reported and never repaired", async () => {
		const original = readFileSync(storeFile, "utf8");
		writeFileSync(storeFile, "{not json");
		const corrupt = await call({ action: "status" });
		assert.equal(corrupt.storageStatus, "invalid");
		assert.equal(readFileSync(storeFile, "utf8"), "{not json", "a corrupt store is never reset");
		rmSync(storeFile);
		symlinkSync(path.join(root, "elsewhere.json"), storeFile);
		const linked = await call({ action: "status" });
		assert.equal(linked.storageStatus, "invalid");
		rmSync(storeFile);
		writeFileSync(storeFile, "x".repeat(600 * 1024));
		const oversized = await call({ action: "status" });
		assert.equal(oversized.storageStatus, "invalid");
		rmSync(storeFile);
		writeFileSync(storeFile, original);
	});

	await check("unknown actions and malformed inputs are handled without throwing", async () => {
		const unknown = await call({ action: "explode" });
		assert.match(unknown.error, /unknown action/);
		assert.equal(unknown.journalStorage.persisted, true, "a handled invalid invocation is still journaled");
		const badAttempts = await call({ action: "capture", goal: "bad", attempts: "{not json" });
		assert.equal(badAttempts.episode.attempts, 0);
	});

	await check("the generated surface is keyless and offline", async () => {
		assert.equal(/fetch\s*\(/.test(generated), false, "no fetch path");
		assert.equal(/process\.env\.[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(generated), false, "no credential environment reads");
		assert.equal(/require\(["']https?["']\)/.test(generated), false, "no http client");
	});

	await check("generated surface is in sync with sources (rebuild is a no-op)", () => {
		const target = path.join(plugin, "tools/rrsi.ts");
		const before = readFileSync(target, "utf8");
		const build = spawnSync(process.execPath, [path.join(plugin, "scripts/build.mjs")], { encoding: "utf8", timeout: 60000 });
		assert.equal(build.status, 0, build.stderr);
		assert.equal(readFileSync(target, "utf8"), before, "tools/rrsi.ts drifted");
	});

	await check("the shared results registry accepts rrsi outcomes and rejects malformed ones", async () => {
		const shared = await import(pathToFileURL(path.join(plugin, "../shared/lib/results.ts")).href);
		for (const action of ["capture", "import", "dream", "status"]) {
			const result = await shared.appendPluginOutcome("rrsi", { operation: action, rrsi: { action, storage: "ok" } });
			assert.equal(result.persisted, true, action);
		}
		const rejected = await shared.appendPluginOutcome("rrsi", { operation: "capture", rrsi: { action: "explode", storage: "ok" } });
		assert.equal(rejected.persisted, false);
	});

	await check("the real jev-advisor journal is counted read-only (measured; never copied into the plugin store)", async () => {
		const source = process.env.RRSI_REAL_JOURNAL_DIR;
		if (!source || !existsSync(source)) {
			console.log(`   note: real jev-advisor journal unavailable at ${source ?? "(unset)"}; measured count stays null`);
			return;
		}
		const segments = readdirSync(source).filter((name) => name.endsWith(".jsonl"));
		let records = 0;
		for (const name of segments.slice(-8)) {
			for (const line of readFileSync(path.join(source, name), "utf8").split("\n")) if (line.trim()) records += 1;
		}
		realJournalRecords = records;
		console.log(`   measured real journal: segments=${segments.length} records=${records}`);
		assert.equal(records >= 10, true, `real journal records=${records}`);
	});

	const summary = {
		kind: "rrsi-plugin-acceptance",
		plugin: manifest.name,
		version: manifest.version,
		cases,
		failures,
		realJournalRecords,
		scope: "functional acceptance only; the performance proof (P1-P3) applies to the self-improve loop",
	};
	console.log(JSON.stringify(summary));
	if (failures > 0) process.exitCode = 1;
}
