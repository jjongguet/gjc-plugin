#!/usr/bin/env bun
/**
 * Offline generated-package acceptance for the wiki plugin.
 *
 * Hermetic: a temporary wiki fixture (a copy of the real scripts/wiki.py from
 * the sibling personal-wiki checkout, plus synthetic pages) and a temporary
 * HOME for journal writes. The user's real wiki, credentials and network are
 * never touched. If the sibling wiki.py is absent, the wiki.py-backed cases
 * are skipped with an explicit notice and only structural cases run.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(import.meta.url);
const plugin = path.resolve(path.dirname(script), "..");
if (process.argv[2] !== "--isolated") {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wiki-offline-")));
	let status = 1;
	try {
		for (const dir of ["home", "tmp", "cwd", "config"]) mkdirSync(path.join(root, dir), { mode: 0o700 });
		const child = spawnSync(process.execPath, ["--no-env-file", script, "--isolated", root], {
			cwd: path.join(root, "cwd"),
			env: { HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), XDG_CONFIG_HOME: path.join(root, "config"), LC_ALL: "C", WIKI_VERIFY_CHILD: "1" },
			stdio: "inherit",
			timeout: 180000,
		});
		if (child.error) console.error(child.error.message);
		status = child.status ?? 1;
	} finally { rmSync(root, { recursive: true, force: true }); }
	process.exitCode = status;
} else {
	await runSuite(process.argv[3]);
}

async function runSuite(root: string) {
	assert.equal(process.env.WIKI_VERIFY_CHILD, "1");
	assert.equal(os.homedir(), path.join(root, "home"));
	let cases = 0;
	let failures = 0;
	let wikiPyE2E = "skipped";
	const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
		cases++;
		try { await fn(); console.log(`ok ${cases} ${name}`); }
		catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`); }
	};
	const fakePi = { typebox: { Type: { Object: (fields: unknown) => fields, String: (options?: unknown) => options ?? {}, Optional: (schema: unknown) => schema } } };

	const core = await import(pathToFileURL(path.join(plugin, "lib/wiki.ts")).href);
	const queryTool = (await import(pathToFileURL(path.join(plugin, "tools/wiki-query.ts")).href)).default(fakePi);
	const proposeTool = (await import(pathToFileURL(path.join(plugin, "tools/wiki-propose.ts")).href)).default(fakePi);
	const sharedResults = await import(pathToFileURL(path.join(plugin, "../shared/lib/results.ts")).href);

	await check("lib exposes only the two intended operations (no approve/publish/refresh/configure)", () => {
		const exported = Object.keys(core).sort();
	assert.deepEqual(exported, ["WIKI_PAGE_PATH", "WIKI_PROPOSE_TIMEOUT_MS", "WIKI_QUERY_TIMEOUT_MS", "WIKI_SOURCE_ID", "WIKI_TEXT_LIMIT", "wikiProposeRun", "wikiQueryRun", "wikiRootDir"]);
	});

	await check("tool surfaces register with the manifest contract", () => {
		assert.equal(queryTool.name, "wiki_query");
		assert.equal(proposeTool.name, "wiki_propose");
		assert.equal(typeof queryTool.execute, "function");
		assert.equal(typeof proposeTool.execute, "function");
		const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8"));
		assert.equal(manifest.kind, "gajae-code-plugin");
		assert.equal(manifest.name, "wiki");
		assert.deepEqual(manifest.tools.map((t: { name: string }) => t.name).sort(), ["wiki_propose", "wiki_query"]);
		for (const tool of manifest.tools) assert.ok(existsSync(path.join(plugin, tool.path)), tool.path);
	});

	await check("query rejects empty and oversized input without touching wiki.py", async () => {
		const empty = await queryTool.execute("call-empty", { query: "   " });
		assert.match(empty.content[0].text, /invalid_input/);
		assert.equal(empty.isError, true);
		const long = await queryTool.execute("call-long", { query: "x".repeat(201) });
		assert.match(long.content[0].text, /invalid_input/);
		assert.equal(long.isError, true);
	});

	await check("propose rejects invalid id, origin, changes shape and missing citation", async () => {
		const bad = async (params: Record<string, string>, marker: RegExp) => {
			const result = await proposeTool.execute(`call-${marker.source}`, params);
			assert.match(result.content[0].text, marker);
			assert.equal(result.isError, true);
		};
		const good = { id: "verify-probe", title: "Verify probe", origin: "personal", source_text: "Approved probe source.", changes_json: JSON.stringify({ "journal/verify-probe.md": "# Verify probe\n\nCites [[_raw/verify-probe/original]]." }) };
		await bad({ ...good, id: "Bad_ID" }, /id/);
		await bad({ ...good, origin: "employer" }, /origin/);
		await bad({ ...good, changes_json: "{not json" }, /changes_json/);
		await bad({ ...good, changes_json: JSON.stringify({ "random/place.md": "x" }) }, /page path/);
		await bad({ ...good, changes_json: JSON.stringify({ "journal/verify-probe.md": "# No citation\n\nNothing." }) }, /cite/);
	});

	const wikiPySource = path.resolve(plugin, "../../personal-wiki/scripts/wiki.py");
	if (existsSync(wikiPySource)) {
		const fixture = path.join(root, "wiki-fixture");
		mkdirSync(path.join(fixture, "scripts"), { recursive: true });
		mkdirSync(path.join(fixture, "concepts"), { recursive: true });
		copyFileSync(wikiPySource, path.join(fixture, "scripts", "wiki.py"));
		writeFileSync(path.join(fixture, "concepts", "verify-probe.md"), "# Verify probe concept\n\nA canonical fixture page citing [[_raw/verify-source/original]].\n");
		const gitInit = (args: string[]) => spawnSync("git", ["-c", "user.name=wiki-verify", "-c", "user.email=wiki-verify@example.invalid", ...args], { cwd: fixture, encoding: "utf8", timeout: 30000 });
		assert.equal(gitInit(["init", "-q"]).status, 0, "git init");
		assert.equal(gitInit(["add", "."]).status, 0, "git add");
		assert.equal(gitInit(["commit", "-q", "-m", "verify fixture"]).status, 0, "git commit");
		process.env.WIKI_ROOT = fixture;
		wikiPyE2E = "real-wiki.py-fixture";

		await check("query returns fixture results through the real wiki.py", async () => {
			const result = await queryTool.execute("call-query", { query: "verify probe" });
			assert.notEqual(result.isError, true);
			const journalLine = result.content[0].text.slice(result.content[0].text.lastIndexOf("\n") + 1);
			assert.equal(JSON.parse(journalLine).journalStorage.persisted, true, journalLine);
		});

		await check("propose submits through real capture+propose and stays pending", async () => {
			const result = await proposeTool.execute("call-propose", {
				id: "verify-probe",
				title: "Verify probe",
				origin: "personal",
				source_text: "Approved probe source for the offline acceptance suite.",
				changes_json: JSON.stringify({ "journal/verify-probe.md": "# Verify probe\n\nLesson pending human approval. Cites [[_raw/verify-probe/original]]." }),
			});
			assert.notEqual(result.isError, true);
			assert.match(result.content[0].text, /digest=[a-f0-9]{64}/);
			const proposals = readdirSync(path.join(fixture, ".wiki", "proposals"));
			assert.equal(proposals.length, 1);
			const pending = await queryTool.execute("call-query-pending", { query: "Lesson pending human approval" });
			assert.notEqual(pending.isError, true);
			assert.doesNotMatch(pending.content[0].text, /journal\/verify-probe\.md/);
		});

		await check("propose failure path reports the failing stage", async () => {
			const result = await proposeTool.execute("call-propose-dup", {
				id: "verify-probe",
				title: "Verify probe duplicate",
				origin: "personal",
				source_text: "Second capture of the same id must fail at capture stage.",
				changes_json: JSON.stringify({ "journal/verify-probe-dup.md": "# Dup\n\nCites [[_raw/verify-probe/original]]." }),
			});
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /wiki_propose: (capture|propose) failed/);
		});
	} else {
		console.log("notice: sibling personal-wiki/scripts/wiki.py not found — wiki.py-backed e2e cases skipped (structural cases only)");
	}

	await check("journal records land under the isolated HOME", () => {
		const journal = path.join(root, "home", ".gjc-plugin", "wiki", "journal", "v1");
		assert.ok(existsSync(journal), journal);
		const files = readdirSync(journal);
		assert.ok(files.includes("inventory.json"), "inventory.json");
		const inventory = JSON.parse(readFileSync(path.join(journal, "inventory.json"), "utf8")) as { segments: { name: string }[] };
		assert.ok(inventory.segments.length >= 1, "at least one journal segment");
		assert.ok(files.includes(inventory.segments[0].name), "segment file listed in inventory");
		const segment = readFileSync(path.join(journal, inventory.segments[0].name), "utf8");
		assert.match(segment, /"operation":"wiki_query"/);
		assert.match(segment, /"operation":"wiki_propose"/);
		assert.doesNotMatch(segment, /verify-probe|Approved probe|Lesson pending/);
	});

	await check("generated surfaces are in sync with sources (rebuild is a no-op)", () => {
		const read = (file: string) => readFileSync(path.join(plugin, file), "utf8");
		const before = [read("tools/wiki-query.ts"), read("tools/wiki-propose.ts")];
		const build = spawnSync(process.execPath, [path.join(plugin, "scripts/build.mjs")], { encoding: "utf8", timeout: 60000 });
		assert.equal(build.status, 0, build.stderr);
		assert.equal(read("tools/wiki-query.ts"), before[0], "tools/wiki-query.ts drifted");
		assert.equal(read("tools/wiki-propose.ts"), before[1], "tools/wiki-propose.ts drifted");
	});

	await check("shared results module accepts the wiki plugin and operations", async () => {
		const append = sharedResults.appendPluginOutcome as (pluginName: string, outcome: Record<string, unknown>) => Promise<{ persisted: boolean }>;
		assert.equal((await append("wiki", { operation: "wiki_query" })).persisted, true);
		assert.equal((await append("wiki", { operation: "wiki_propose" })).persisted, true);
	});

	console.log(JSON.stringify({ kind: "api-package-test-report", cases, failures, wikiPyE2E, realNetworkCalls: 0 }));
	console.log(failures ? `FAILED ${failures}/${cases}` : `ALL PASS (${cases} cases)`);
	process.exitCode = failures || cases === 0 ? 1 : 0;
}
