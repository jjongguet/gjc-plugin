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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

	await check("manifest declares one tool, one session_start hook (no target/phase), and the four actions", async () => {
		assert.equal(manifest.name, "rrsi");
		assert.equal(manifest.version, "0.0.1");
		assert.equal(manifest.tools.length, 1);
		assert.equal(manifest.tools[0].path, "tools/rrsi.ts");
		assert.equal(typeof tool.execute, "function");
		assert.equal(Array.isArray(manifest.hooks), true);
		assert.equal(manifest.hooks.length, 1);
		assert.deepEqual(Object.keys(manifest.hooks[0]).sort(), ["event", "name", "path"]);
		assert.equal(manifest.hooks[0].name, "rrsi-periodic");
		assert.equal(manifest.hooks[0].event, "session_start");
		assert.equal(manifest.hooks[0].path, "hooks/rrsi-periodic.ts");
		assert.equal(manifest.hooks[0].target, undefined);
		assert.equal(manifest.hooks[0].phase, undefined);
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

	await check("journal-dream emits a deterministic receipt over the synthetic journal", async () => {
		const scriptPath = path.join(plugin, "scripts", "journal-dream.mjs");
		const outA = path.join(root, "journal-dream-a.json");
		const outB = path.join(root, "journal-dream-b.json");
		const run = (out) => spawnSync(process.execPath, ["--no-env-file", scriptPath, "--out", out], { encoding: "utf8", env: process.env, timeout: 120000 });
		const first = run(outA);
		assert.equal(first.status, 0, first.stderr);
		const second = run(outB);
		assert.equal(second.status, 0, second.stderr);
		assert.equal(readFileSync(outA, "utf8"), readFileSync(outB, "utf8"), "same journal+seed reruns must be byte-identical");
		const receipt = JSON.parse(readFileSync(outA, "utf8"));
		assert.equal(receipt.schema, "gjc.self-improve.journal-dream.v1");
		assert.equal(receipt.provenance.source, "jev-journal");
		assert.equal(receipt.provenance.records, 12);
		assert.equal(receipt.provenance.importedAttempts, 12);
		assert.equal(receipt.counts.attempts, 12);
		assert.match(receipt.receiptHash, /^[0-9a-f]{64}$/);
		assert.equal(statSync(outA).mode & 0o7777, 0o600);
		assert.equal(receipt.dream.thresholds.evaluated, false, "a small corpus stays below the pass gate");
	});

	await check("journal-dream fails closed with no_journal and never writes the store", async () => {
		const scriptPath = path.join(plugin, "scripts", "journal-dream.mjs");
		const storeBefore = existsSync(storeFile) ? readFileSync(storeFile, "utf8") : null;
		const neverOut = path.join(root, "journal-dream-never.json");
		const missing = spawnSync(
			process.execPath,
			["--no-env-file", scriptPath, "--journal-dir", path.join(root, "definitely-missing-journal"), "--out", neverOut],
			{ encoding: "utf8", env: process.env, timeout: 120000 },
		);
		assert.equal(missing.status, 1);
		assert.match(missing.stderr, /no_journal/);
		assert.equal(existsSync(neverOut), false, "no receipt is written on failure");
		assert.equal(existsSync(storeFile) ? readFileSync(storeFile, "utf8") : null, storeBefore, "the rrsi store is never touched");
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

	// ---- periodic refresh (session_start hook core) ----
	const hookModule = await import(pathToFileURL(path.join(plugin, "hooks/rrsi-periodic.ts")).href);
	const hookSource = readFileSync(path.join(plugin, "hooks/rrsi-periodic.ts"), "utf8");
	const seedJournal = (homeDir, count, name = "seg-1.jsonl") => {
		const dir = path.join(homeDir, ".gjc-plugin", "jev-advisor", "journal", "v1");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(dir, name), `${syntheticRecords(count).map((record) => JSON.stringify(record)).join("\n")}\n`);
	};
	const periodicPaths = (homeDir) => {
		const rootDir = path.join(homeDir, ".gjc-plugin", "rrsi");
		return { root: rootDir, state: path.join(rootDir, "periodic.json"), store: path.join(rootDir, "store.json"), receipts: path.join(rootDir, "runs", "v1"), journal: path.join(rootDir, "journal", "v1") };
	};
	const withHome = async (homeDir, fn) => {
		const previous = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			return await fn();
		} finally {
			process.env.HOME = previous;
		}
	};
	const backdateState = (homeDir, ms) => {
		const { state } = periodicPaths(homeDir);
		const parsed = JSON.parse(readFileSync(state, "utf8"));
		parsed.lastAttemptAt = new Date(Date.now() - ms).toISOString();
		parsed.lastSuccessAt = parsed.lastAttemptAt;
		parsed.nextRetryAt = null;
		writeFileSync(state, `${JSON.stringify(parsed, null, 2)}\n`);
	};
	const readJournalOutcomes = (homeDir) => {
		const { journal } = periodicPaths(homeDir);
		if (!existsSync(journal)) return [];
		return readdirSync(journal).filter((name) => name.endsWith(".jsonl")).flatMap((name) => readFileSync(path.join(journal, name), "utf8").split("\n")).filter(Boolean).map((line) => JSON.parse(line));
	};
	const homeA = path.join(root, "periodic-home-a");

	await check("periodic: fresh fire runs inline and records receipt+state+one dream record; in-interval skip writes nothing", async () => {
		mkdirSync(homeA, { mode: 0o700 });
		seedJournal(homeA, 12);
		const paths = periodicPaths(homeA);
		const result = await withHome(homeA, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(result.status, "ran");
		assert.equal(result.storeWrite, "added");
		assert.equal(result.receipt, true);
		const receiptFiles = readdirSync(paths.receipts);
		assert.equal(receiptFiles.length, 1);
		const receipt = JSON.parse(readFileSync(path.join(paths.receipts, receiptFiles[0]), "utf8"));
		assert.equal(receipt.schema, "gjc.rrsi.periodic.run.v1");
		assert.equal(receipt.trigger, "session_start");
		assert.equal(receipt.status, "ran");
		assert.equal(receipt.storeWrite, "added");
		assert.equal(receipt.mode, "inline");
		assert.equal(receipt.persisted, true);
		assert.match(receipt.projectionDigest, /^[0-9a-f]{64}$/);
		const outcomes = readJournalOutcomes(homeA);
		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0].operation, "dream");
		const stateBytes = readFileSync(paths.state, "utf8");
		const second = await withHome(homeA, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(second.status, "skipped_due");
		assert.equal(second.receipt, false);
		assert.equal(second.journal, false);
		assert.equal(readFileSync(paths.state, "utf8"), stateBytes, "skipped_due must not advance state");
		assert.equal(readdirSync(paths.receipts).length, 1);
	});

	await check("periodic: unchanged content skips byte-identically; changed content replaces the one derived set; legacy episodes close by class", async () => {
		const paths = periodicPaths(homeA);
		const interval = 24 * 60 * 60 * 1000;
		backdateState(homeA, interval + 60_000);
		const storeBefore = readFileSync(paths.store, "utf8");
		const unchanged = await withHome(homeA, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(unchanged.status, "unchanged");
		assert.equal(unchanged.storeWrite, "unchanged");
		assert.equal(readFileSync(paths.store, "utf8"), storeBefore, "unchanged content must not rewrite the store");
		assert.equal(readdirSync(paths.receipts).length, 2);

		seedJournal(homeA, 12, "seg-2.jsonl");
		backdateState(homeA, interval + 60_000);
		const replaced = await withHome(homeA, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(replaced.status, "ran");
		assert.equal(replaced.storeWrite, "replaced");
		let store = JSON.parse(readFileSync(paths.store, "utf8"));
		assert.equal(store.episodes.filter((episode) => episode.source === "jev-journal").length, 1, "one slot per source class");
		assert.equal(store.episodes.filter((episode) => episode.id.startsWith("ep-jev-")).length, 1);

		store.episodes.push({ id: "ep-legacy-clock", source: "jev-journal", goal: "legacy manual import", createdAt: new Date().toISOString(), attempts: [{ index: 0, objective: "legacy", hypothesisNovelty: true, decision: "reject", wallMs: 1, guardFailures: [], budgetRung: 0, files: 0, hunks: 0 }] });
		store.episodes.push({ id: "ep-user-capture", source: "capture", goal: "user capture must survive", createdAt: new Date().toISOString(), attempts: [{ index: 0, objective: "user", hypothesisNovelty: true, decision: "reject", wallMs: 1, guardFailures: [], budgetRung: 0, files: 0, hunks: 0 }] });
		writeFileSync(paths.store, `${JSON.stringify(store, null, 2)}\n`);
		backdateState(homeA, interval + 60_000);
		const closure = await withHome(homeA, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(closure.storeWrite, "replaced");
		store = JSON.parse(readFileSync(paths.store, "utf8"));
		assert.equal(store.episodes.some((episode) => episode.id === "ep-legacy-clock"), false, "legacy clock-seeded episodes are superseded as a class");
		assert.equal(store.episodes.some((episode) => episode.id === "ep-user-capture"), true, "user captures are never selected by the filter");
	});

	await check("periodic: disabled consumes nothing, interval override fires per override, backoff is honored", async () => {
		const paths = periodicPaths(homeA);
		const stateBytes = readFileSync(paths.state, "utf8");
		const disabled = await withHome(homeA, () => hookModule.runPeriodic({ env: { ...process.env, RRSI_PERIODIC: "off" }, mode: "inline" }));
		assert.equal(disabled.status, "skipped_disabled");
		assert.equal(disabled.receipt, false);
		assert.equal(readFileSync(paths.state, "utf8"), stateBytes, "disabled must not consume the interval");

		const homeD = path.join(root, "periodic-home-d");
		mkdirSync(homeD, { mode: 0o700 });
		seedJournal(homeD, 12);
		const pathsD = periodicPaths(homeD);
		const override = await withHome(homeD, () => hookModule.runPeriodic({ env: { ...process.env, RRSI_PERIODIC_INTERVAL_MS: "60000" }, mode: "inline" }));
		assert.equal(override.status, "ran");
		const stateD = JSON.parse(readFileSync(pathsD.state, "utf8"));
		assert.equal(stateD.intervalMs, 60000);
		const receiptD = JSON.parse(readFileSync(path.join(pathsD.receipts, readdirSync(pathsD.receipts)[0]), "utf8"));
		assert.equal(receiptD.limits.intervalMs, 60000, "applied-limits records the configured interval override");
		backdateState(homeD, 61_000);
		const refire = await withHome(homeD, () => hookModule.runPeriodic({ env: { ...process.env, RRSI_PERIODIC_INTERVAL_MS: "60000" }, mode: "inline" }));
		assert.equal(refire.status, "unchanged");

		const backoffState = JSON.parse(readFileSync(pathsD.state, "utf8"));
		backoffState.lastAttemptAt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
		backoffState.nextRetryAt = new Date(Date.now() + 60_000).toISOString();
		writeFileSync(pathsD.state, `${JSON.stringify(backoffState, null, 2)}\n`);
		const backoff = await withHome(homeD, () => hookModule.runPeriodic({ env: { ...process.env, RRSI_PERIODIC_INTERVAL_MS: "60000" }, mode: "inline" }));
		assert.equal(backoff.status, "skipped_due");
		assert.equal(backoff.reason, "backoff");
		// Binding schedule: an EXPERED nextRetryAt is due even though the last attempt is recent.
		const expired = JSON.parse(readFileSync(pathsD.state, "utf8"));
		expired.lastAttemptAt = new Date().toISOString();
		expired.nextRetryAt = new Date(Date.now() - 60_000).toISOString();
		writeFileSync(pathsD.state, `${JSON.stringify(expired, null, 2)}\n`);
		const refire2 = await withHome(homeD, () => hookModule.runPeriodic({ env: { ...process.env, RRSI_PERIODIC_INTERVAL_MS: "60000" }, mode: "inline" }));
		assert.equal(refire2.status, "unchanged", "an expired nextRetryAt is due despite a recent lastAttemptAt");
	});

	await check("periodic: lock contention skips without writes; stale locks are taken over once (periodic and store locks)", async () => {
		const homeE = path.join(root, "periodic-home-e");
		mkdirSync(homeE, { mode: 0o700 });
		seedJournal(homeE, 12);
		const paths = periodicPaths(homeE);
		mkdirSync(paths.root, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(paths.root, "periodic.lock"), JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));
		const locked = await withHome(homeE, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(locked.status, "skipped_locked");
		assert.equal(locked.receipt, false);
		assert.equal(existsSync(paths.state), false, "skipped_locked writes no state");
		const old = new Date(Date.now() - 10 * 60 * 1000);
		utimesSync(path.join(paths.root, "periodic.lock"), old, old);
		const takeover = await withHome(homeE, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(takeover.status, "ran");
		assert.equal(existsSync(path.join(paths.root, "periodic.lock")), false, "the stale lock is removed and released");

		writeFileSync(path.join(paths.root, "store.lock"), JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));
		const busy = await withHome(homeE, () => call({ action: "capture", goal: "busy probe", attempts: "[]" }));
		assert.equal(busy.wrote.persisted, false);
		assert.equal(busy.wrote.reason, "store_busy");
		utimesSync(path.join(paths.root, "store.lock"), old, old);
		const reclaimed = await withHome(homeE, () => call({ action: "capture", goal: "reclaimed probe", attempts: "[]" }));
		assert.equal(reclaimed.wrote.persisted, true);
		assert.equal(existsSync(path.join(paths.root, "store.lock")), false);
	});

	await check("periodic: corrupt and oversized stores error without receipt or repair; resource_limit writes an error receipt and never prunes", async () => {
		const homeF = path.join(root, "periodic-home-f");
		mkdirSync(homeF, { mode: 0o700 });
		seedJournal(homeF, 12);
		const paths = periodicPaths(homeF);
		mkdirSync(paths.root, { recursive: true, mode: 0o700 });
		writeFileSync(paths.store, "{not json");
		const corrupt = await withHome(homeF, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(corrupt.status, "error");
		assert.equal(corrupt.reason, "store_corrupt");
		assert.equal(corrupt.receipt, false);
		assert.equal(readFileSync(paths.store, "utf8"), "{not json", "a corrupt store is never reset");
		const stateF = JSON.parse(readFileSync(paths.state, "utf8"));
		assert.equal(stateF.lastStatus, "error");
		assert.equal(typeof stateF.nextRetryAt, "string");
		backdateState(homeF, 25 * 60 * 60 * 1000);
		writeFileSync(paths.store, "x".repeat(600 * 1024));
		const oversized = await withHome(homeF, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(oversized.status, "error");
		assert.equal(oversized.reason, "store_oversized");
		assert.equal(readFileSync(paths.store, "utf8").length, 600 * 1024, "an oversized store is never touched");

		const homeG = path.join(root, "periodic-home-g");
		mkdirSync(homeG, { mode: 0o700 });
		seedJournal(homeG, 40);
		const pathsG = periodicPaths(homeG);
		mkdirSync(pathsG.root, { recursive: true, mode: 0o700 });
		const fillerAttempts = (base) => Array.from({ length: 40 }, (_, index) => ({ index, objective: `filler ${base}-${index}`, hypothesisNovelty: true, decision: "reject", wallMs: 5, guardFailures: [], budgetRung: 0, files: 0, hunks: 0, provenance: `p-${base}-${index}` }));
		const capBytes = 512 * 1024;
		let episodes = [];
		for (let i = 0; i < 128; i += 1) {
			const candidate = [...episodes, { id: `ep-fill-${i}`, source: "capture", goal: `filler ${i}`, createdAt: "2026-10-13T00:00:00.000Z", attempts: fillerAttempts(i) }];
			const size = Buffer.byteLength(`${JSON.stringify({ schema: "gjc.rrsi.store.v1", updatedAt: "2026-10-13T00:00:00.000Z", episodes: candidate }, null, 2)}\n`, "utf8");
			if (size > capBytes - 2048) break;
			episodes = candidate;
		}
		const fixture = { schema: "gjc.rrsi.store.v1", updatedAt: "2026-10-13T00:00:00.000Z", episodes };
		writeFileSync(pathsG.store, `${JSON.stringify(fixture, null, 2)}\n`);
		const fixtureBytes = readFileSync(pathsG.store, "utf8");
		const limited = await withHome(homeG, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(limited.status, "error");
		assert.equal(limited.reason, "resource_limit");
		assert.equal(limited.receipt, true, "the resource_limit path writes an error receipt");
		assert.equal(readFileSync(pathsG.store, "utf8"), fixtureBytes, "never prune or repair");
		const stateG = JSON.parse(readFileSync(pathsG.state, "utf8"));
		assert.equal(stateG.storeWrite, "rejected");
		assert.equal(stateG.lastReason, "resource_limit");
	});

	await check("periodic: empty journal yields no_input (state + one record, no receipt, retry at interval)", async () => {
		const homeH = path.join(root, "periodic-home-h");
		mkdirSync(homeH, { mode: 0o700 });
		const paths = periodicPaths(homeH);
		const empty = await withHome(homeH, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(empty.status, "no_input");
		assert.equal(empty.receipt, false);
		const state = JSON.parse(readFileSync(paths.state, "utf8"));
		assert.equal(state.lastStatus, "empty");
		assert.equal(typeof state.nextRetryAt, "string");
		assert.equal(existsSync(paths.store), false, "no_input writes no store");
		assert.equal(existsSync(paths.receipts), false, "no_input writes no receipt");
		assert.equal(readJournalOutcomes(homeH).length, 1);
	});

	await check("periodic: receipt retention prunes to the newest 60", async () => {
		const homeI = path.join(root, "periodic-home-i");
		mkdirSync(homeI, { mode: 0o700 });
		seedJournal(homeI, 12);
		const paths = periodicPaths(homeI);
		mkdirSync(paths.receipts, { recursive: true, mode: 0o700 });
		const seededAt = Date.now() - 65_000;
		for (let i = 0; i < 65; i += 1) {
			const seedPath = path.join(paths.receipts, `seed-${String(i).padStart(3, "0")}.json`);
			writeFileSync(seedPath, "{}");
			const stamp = new Date(seededAt + i * 1000);
			utimesSync(seedPath, stamp, stamp);
		}
		const result = await withHome(homeI, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(result.status, "ran");
		const remaining = readdirSync(paths.receipts).sort();
		assert.equal(remaining.length, 60);
		assert.equal(remaining.some((name) => /-in-[0-9a-f]{6}\.json$/.test(name)), true, "the newest receipt survives");
		assert.equal(existsSync(path.join(paths.receipts, "seed-000.json")), false, "the oldest receipt is pruned");
	});

	await check("periodic summary is exposed by the tool status and status stays read-only", async () => {
		const paths = periodicPaths(homeA);
		const before = readFileSync(paths.state, "utf8");
		const status = await withHome(homeA, () => call({ action: "status" }));
		assert.equal(status.periodic.lastStatus, "ran");
		assert.equal(status.periodic.due, false);
		assert.equal(status.periodic.receiptCount >= 3, true);
		assert.equal(readFileSync(paths.state, "utf8"), before, "status must not mutate the periodic state");
	});


	await check("periodic: unsafe symlinked roots are never written through", async () => {
		const homeJ = path.join(root, "periodic-home-j");
		mkdirSync(homeJ, { mode: 0o700 });
		const realDir = path.join(homeJ, ".gjc-plugin-real");
		mkdirSync(realDir, { mode: 0o700 });
		symlinkSync(realDir, path.join(homeJ, ".gjc-plugin"));
		seedJournal(homeJ, 12);
		const run = await withHome(homeJ, () => hookModule.runPeriodic({ env: process.env, mode: "inline" }));
		assert.equal(run.status, "error");
		assert.equal(run.reason, "unsafe_path");
		assert.equal(existsSync(path.join(realDir, "rrsi")), false, "nothing may be written through a symlinked root");
		const capture = await withHome(homeJ, () => call({ action: "capture", goal: "symlink probe", attempts: "[]" }));
		assert.equal(capture.wrote.persisted, false);
		assert.equal(capture.wrote.reason, "unsafe_path");
	});

	await check("periodic: deferred handoff writes a handoff receipt; the worker completes with its own receipt and one record", async () => {
		const homeK = path.join(root, "periodic-home-k");
		mkdirSync(homeK, { mode: 0o700 });
		seedJournal(homeK, 12);
		const paths = periodicPaths(homeK);
		mkdirSync(paths.root, { recursive: true, mode: 0o700 });
		const filler = (prefix) => (i) => ({ id: `ep-${prefix}-${i}`, source: "capture", goal: `${prefix} filler ${i}`, createdAt: "2026-10-13T00:00:00.000Z", attempts: Array.from({ length: 40 }, (_, j) => ({ index: j, objective: `${prefix}-${i}-${j}`, hypothesisNovelty: true, decision: "reject", wallMs: 5, guardFailures: [], budgetRung: 0, files: 0, hunks: 0 })) });
		writeFileSync(paths.store, `${JSON.stringify({ schema: "gjc.rrsi.store.v1", updatedAt: "2026-10-13T00:00:00.000Z", episodes: [0, 1, 2, 3, 4].map(filler("k")) }, null, 2)}\n`);
		let spawnCalls = 0;
		const deferred = await withHome(homeK, () => hookModule.runPeriodic({ env: process.env, mode: "inline", spawnWorker: () => { spawnCalls += 1; return { ok: true, pid: 4242 }; } }));
		assert.equal(deferred.status, "deferred");
		assert.equal(spawnCalls, 1);
		assert.equal(deferred.receipt, true);
		const receiptsAfterHandoff = readdirSync(paths.receipts);
		assert.equal(receiptsAfterHandoff.length, 1);
		const handoff = JSON.parse(readFileSync(path.join(paths.receipts, receiptsAfterHandoff[0]), "utf8"));
		assert.equal(handoff.status, "deferred");
		assert.equal(readJournalOutcomes(homeK).length, 0, "the handoff writes no record; the worker records completion");
		const stateAfterHandoff = JSON.parse(readFileSync(paths.state, "utf8"));
		assert.equal(stateAfterHandoff.lastStatus, "deferred");
		const worker = await withHome(homeK, () => hookModule.runPeriodic({ env: process.env, mode: "worker" }));
		assert.equal(worker.status, "unchanged", "the worker completes over identical derived content");
		assert.equal(readdirSync(paths.receipts).length, 2);
		assert.equal(readJournalOutcomes(homeK).length, 1);
		const stateAfterWorker = JSON.parse(readFileSync(paths.state, "utf8"));
		assert.equal(stateAfterWorker.lastStatus, "unchanged");
		assert.equal(typeof stateAfterWorker.lastSuccessAt, "string");
		assert.equal(typeof stateAfterWorker.nextRetryAt, "string", "success advances the next-due stamp");
	});

	await check("periodic: spawn failure is bounded (worker_spawn_failed, no crash, no receipt)", async () => {
		const homeL = path.join(root, "periodic-home-l");
		mkdirSync(homeL, { mode: 0o700 });
		seedJournal(homeL, 12);
		const paths = periodicPaths(homeL);
		mkdirSync(paths.root, { recursive: true, mode: 0o700 });
		const filler = (i) => ({ id: `ep-l-${i}`, source: "capture", goal: `l filler ${i}`, createdAt: "2026-10-13T00:00:00.000Z", attempts: Array.from({ length: 40 }, (_, j) => ({ index: j, objective: `l-${i}-${j}`, hypothesisNovelty: true, decision: "reject", wallMs: 5, guardFailures: [], budgetRung: 0, files: 0, hunks: 0 })) });
		writeFileSync(paths.store, `${JSON.stringify({ schema: "gjc.rrsi.store.v1", updatedAt: "2026-10-13T00:00:00.000Z", episodes: [0, 1, 2, 3, 4].map(filler) }, null, 2)}\n`);
		const failed = await withHome(homeL, () => hookModule.runPeriodic({ env: process.env, mode: "inline", spawnWorker: () => ({ ok: false, reason: "spawn_failed" }) }));
		assert.equal(failed.status, "error");
		assert.equal(failed.reason, "worker_spawn_failed");
		assert.equal(failed.receipt, false);
		const state = JSON.parse(readFileSync(paths.state, "utf8"));
		assert.equal(state.lastStatus, "error");
		assert.equal(readJournalOutcomes(homeL).length, 1);
		const defaultSpawn = await hookModule.defaultSpawnWorker({ env: { ...process.env, PATH: "/nonexistent" } });
		assert.equal(defaultSpawn.ok, false);
		assert.equal(typeof defaultSpawn.reason, "string");
	});

	await check("periodic: a dream failure is a bounded error (no masked success)", async () => {
		const homeM = path.join(root, "periodic-home-m");
		mkdirSync(homeM, { mode: 0o700 });
		seedJournal(homeM, 12);
		const paths = periodicPaths(homeM);
		const failed = await withHome(homeM, () => hookModule.runPeriodic({ env: process.env, mode: "inline", dreamer: () => { throw new Error("boom"); } }));
		assert.equal(failed.status, "error");
		assert.equal(failed.reason, "dream_failed");
		assert.equal(failed.receipt, true);
		const receiptFile = readdirSync(paths.receipts)[0];
		const receipt = JSON.parse(readFileSync(path.join(paths.receipts, receiptFile), "utf8"));
		assert.equal(receipt.status, "error");
		assert.equal(receipt.reason, "dream_failed");
		assert.equal(receipt.receiptHash, null);
		const state = JSON.parse(readFileSync(paths.state, "utf8"));
		assert.equal(state.lastStatus, "error");
		assert.equal(state.lastReason, "dream_failed");
		assert.equal(state.consecutiveFailures, 1);
		assert.equal(typeof state.nextRetryAt, "string");
		assert.equal(readJournalOutcomes(homeM).length, 1);
	});

	await check("periodic: the worker CLI entry runs, records, and stays inert without the flag", async () => {
		const homeN = path.join(root, "periodic-home-n");
		mkdirSync(homeN, { mode: 0o700 });
		seedJournal(homeN, 12);
		const paths = periodicPaths(homeN);
		const hookPath = path.join(plugin, "hooks/rrsi-periodic.ts");
		const workerRun = spawnSync(process.execPath, [hookPath], { encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: homeN, TMPDIR: root, RRSI_PERIODIC_WORKER: "1" } });
		assert.equal(workerRun.status, 0, `${workerRun.stdout}\n${workerRun.stderr}`);
		const workerLine = JSON.parse(workerRun.stdout.trim().split("\n").filter(Boolean).pop());
		assert.equal(workerLine.worker, true);
		assert.equal(["ran", "unchanged"].includes(workerLine.status), true, `worker status=${workerLine.status}`);
		assert.equal(readdirSync(paths.receipts).some((name) => name.includes("-wk-")), true, "a worker receipt is written");
		assert.equal(readJournalOutcomes(homeN).length, 1);
		const inertHome = path.join(root, "periodic-home-o");
		mkdirSync(inertHome, { mode: 0o700 });
		const inert = spawnSync(process.execPath, [hookPath], { encoding: "utf8", timeout: 60000, env: { ...process.env, HOME: inertHome } });
		assert.equal(inert.status, 0, inert.stderr);
		assert.equal(inert.stdout.trim(), "", "without the flag the file is inert");
		assert.equal(existsSync(path.join(inertHome, ".gjc-plugin", "rrsi", "runs")), false);
	});

	await check("the generated surfaces are keyless, offline, self-contained, and the hook registers exactly one session_start", async () => {
		for (const [label, source] of [["tool", generated], ["hook", hookSource]]) {
			assert.equal(/fetch\s*\(/.test(source), false, `${label}: no fetch path`);
			assert.equal(/process\.env\.[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(source), false, `${label}: no credential environment reads`);
			assert.equal(/require\(["']https?["']\)/.test(source), false, `${label}: no http client`);
			assert.equal(/^import\s.*from\s+["']\.\.?\//m.test(source), false, `${label}: no local relative imports remain`);
		}
		const registrations = [];
		const fakeApi = { on: (event, handler) => registrations.push([event, typeof handler]), logger: { warn: () => {} } };
		hookModule.default(fakeApi);
		assert.deepEqual(registrations, [["session_start", "function"]]);
	});

	await check("generated surfaces are in sync with sources (non-mutating --check drift gate)", () => {
		const toolTarget = path.join(plugin, "tools/rrsi.ts");
		const hookTarget = path.join(plugin, "hooks/rrsi-periodic.ts");
		const toolBefore = readFileSync(toolTarget, "utf8");
		const hookBefore = readFileSync(hookTarget, "utf8");
		const build = spawnSync(process.execPath, [path.join(plugin, "scripts/build.mjs"), "--check"], { encoding: "utf8", timeout: 60000 });
		assert.equal(build.status, 0, `${build.stderr}${build.stdout}`);
		assert.match(build.stdout, /generated surfaces are in sync/);
		assert.equal(readFileSync(toolTarget, "utf8"), toolBefore, "tools/rrsi.ts must not be mutated by --check");
		assert.equal(readFileSync(hookTarget, "utf8"), hookBefore, "hooks/rrsi-periodic.ts must not be mutated by --check");
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
