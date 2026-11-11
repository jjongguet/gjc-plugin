#!/usr/bin/env bun
/**
 * Offline generated-package acceptance for the egm plugin.
 *
 * Hermetic: every registry, checkout and installed tree is a synthetic fixture
 * inside a temporary isolated HOME, the pinned digest table is injected for
 * the synthetic content, and session settings are fakes. EGM's own text is
 * never copied into a fixture; the real pinned table is checked for shape.
 * The user's real ~/.gjc, the network and git are never touched.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(import.meta.url);
const plugin = path.resolve(path.dirname(script), "..");
if (process.argv[2] !== "--isolated") {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "egm-offline-")));
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
				EGM_VERIFY_CHILD: "1",
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

async function runSuite(root: string) {
	assert.equal(process.env.EGM_VERIFY_CHILD, "1");
	assert.equal(os.homedir(), path.join(root, "home"));
	let cases = 0;
	let failures = 0;
	const check = async (name: string, fn: () => unknown) => {
		cases++;
		try {
			await fn();
			console.log(`ok ${cases} ${name}`);
		} catch (error) {
			failures++;
			console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
		}
	};
	const fakePi = { typebox: { Type: { Object: (fields: Record<string, unknown>) => fields } } };
	const core = await import(pathToFileURL(path.join(plugin, "lib/readiness.ts")).href);
	const tool = (await import(pathToFileURL(path.join(plugin, "tools/egm-readiness.ts")).href)).default(fakePi);

	const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
	const writeFile = (file: string, text: string) => {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	};
	const writeJson = (file: string, value: unknown) => writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
	const settingsOf = (values: Record<string, unknown> = {}) => ({
		get: (key: string) =>
			Object.hasOwn(values, key)
				? values[key]
				: ({ disabledProviders: [], "task.maxRecursionDepth": undefined, "task.disabledAgents": [], disabledExtensions: [] } as Record<string, unknown>)[key],
	});
	const COMMIT = core.EGM_PINNED_COMMIT as string;
	const OTHER = "1".repeat(40);

	// One synthetic fixture world per case: a HOME with GJC's two registries, an
	// installed tree whose files are synthetic, and the digest table for exactly
	// those files (so "pinned" is decided by the real comparison code).
	let world = 0;
	const fixture = (options: { enabled?: boolean; marketplace?: "local" | "git" | "none"; head?: string } = {}) => {
		world++;
		const home = path.join(root, `world-${world}`);
		const installPath = path.join(home, ".gjc", "plugins", "cache", "plugins", "egm___egm___0.1.1");
		const pinned: Record<string, string> = {};
		for (const relative of Object.keys(core.EGM_PINNED_FILES)) {
			const text = `synthetic ${relative}\n`;
			writeFile(path.join(installPath, relative), text);
			pinned[relative] = sha256(text);
		}
		const entry: Record<string, unknown> = { scope: "user", installPath, version: "0.1.1", installedAt: "2026-11-11T00:00:00.000Z" };
		if (options.enabled === false) entry.enabled = false;
		writeJson(path.join(home, ".gjc", "plugins", "installed_plugins.json"), { version: 2, plugins: { "egm@egm": [entry] } });
		const source = path.join(home, ".gjc-plugin", "egm", "elephant-goldfish-model-v0.1.1");
		const gitClone = path.join(home, ".gjc", "plugins", "cache", "marketplaces", "egm");
		const kind = options.marketplace ?? "local";
		if (kind !== "none") {
			writeJson(path.join(home, ".gjc", "marketplaces.json"), {
				version: 1,
				marketplaces: [
					{
						name: "egm",
						sourceType: kind,
						sourceUri: kind === "local" ? source : "https://github.com/google/elephant-goldfish-model",
						catalogPath: path.join(gitClone, "marketplace.json"),
					},
				],
			});
			writeFile(path.join(kind === "local" ? source : gitClone, ".git", "HEAD"), `${options.head ?? COMMIT}\n`);
		}
		return { home, installPath, pinned, source, gitClone };
	};

	await check("lib exposes only the intended readiness surface", () => {
		assert.deepEqual(Object.keys(core).sort(), [
			"EGM_INSTALL_COMMANDS",
			"EGM_MARKETPLACE",
			"EGM_PERSONAS",
			"EGM_PINNED_COMMIT",
			"EGM_PINNED_FILES",
			"EGM_PINNED_SOURCE",
			"EGM_PINNED_TAG",
			"EGM_PLUGIN_ID",
			"EGM_REPOSITORY",
			"EGM_SKILLS",
			"EGM_UNINSTALL_COMMANDS",
			"checkContent",
			"installedPluginsPath",
			"marketplacesPath",
			"readCheckoutCommit",
			"readInstallation",
			"readMarketplace",
			"readSession",
			"readinessReport",
		]);
	});

	await check("manifest stays tool-only and declares no EGM surface of its own", () => {
		const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8"));
		assert.equal(manifest.kind, "gajae-code-plugin");
		assert.equal(manifest.name, "egm");
		assert.match(manifest.version, /^0\.0\.\d+$/);
		assert.deepEqual(manifest.tools.map((entry: { name: string }) => entry.name), ["egm_readiness"]);
		for (const entry of manifest.tools) assert.ok(existsSync(path.join(plugin, entry.path)), entry.path);
		for (const key of ["mcps", "mcpServers", "hooks", "subskills", "skills", "agents", "commands"]) {
			assert.equal(Object.hasOwn(manifest, key), false, `${key} must stay absent`);
		}
		const tracked = readdirSync(plugin);
		for (const forbidden of ["skills", "agents", "resources"]) assert.ok(!tracked.includes(forbidden), `EGM ${forbidden}/ must not be bundled`);
	});

	await check("tool registers with the manifest contract", () => {
		const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8"));
		assert.equal(tool.name, "egm_readiness");
		assert.equal(tool.label, "EGM Readiness");
		assert.equal(tool.description, manifest.tools[0].description);
		assert.equal(typeof tool.execute, "function");
		assert.deepEqual(tool.parameters, {});
	});

	await check("the pinned table covers every skill, persona and document standard by path", () => {
		const files = core.EGM_PINNED_FILES as Record<string, string>;
		assert.equal(Object.keys(files).length, 27);
		for (const [relative, digest] of Object.entries(files)) {
			assert.match(digest, /^[0-9a-f]{64}$/, relative);
			assert.match(relative, /^(skills\/egm-[a-z-]+\/(SKILL\.md|references\/[A-Za-z0-9_.-]+)|agents\/[a-z_]+\.md|resources\/[A-Za-z0-9_./-]+)$/, relative);
		}
		assert.equal(core.EGM_SKILLS.length, 7);
		for (const name of core.EGM_SKILLS) assert.ok(files[`skills/${name}/SKILL.md`], name);
		assert.equal(core.EGM_PERSONAS.length, 10);
		for (const [file] of core.EGM_PERSONAS) assert.ok(files[file], file);
		assert.equal(Object.keys(files).filter(relative => relative.startsWith("resources/document_standards/")).length, 5);
		assert.match(core.EGM_PINNED_COMMIT, /^[0-9a-f]{40}$/);
		assert.equal(core.EGM_PINNED_TAG, "v0.1.1");
		assert.ok(core.EGM_INSTALL_COMMANDS[0].includes(`--branch ${core.EGM_PINNED_TAG}`));
		assert.ok(core.EGM_INSTALL_COMMANDS.every((command: string) => !command.includes("--dry-run")));
		assert.equal(core.EGM_INSTALL_COMMANDS[2], "gjc plugin install egm@egm");
	});

	await check("a bare HOME reports not_installed with the exact install commands", () => {
		const report = core.readinessReport({ home: path.join(root, "bare"), settings: settingsOf() });
		assert.equal(report.status, "not_installed");
		assert.equal(report.installation.status, "missing");
		assert.equal(report.marketplace.status, "missing");
		assert.equal(report.content.status, "absent");
		assert.ok(report.skills.every((skill: { present: boolean }) => !skill.present));
		assert.ok(report.remediation[0].includes(core.EGM_INSTALL_COMMANDS.join(" && ")));
	});

	await check("a pinned install with observed settings is ready and names the namespaced invocations", () => {
		const world = fixture();
		const report = core.readinessReport({ home: world.home, settings: settingsOf(), pinnedFiles: world.pinned });
		assert.equal(report.status, "ready", JSON.stringify(report.remediation));
		assert.equal(report.content.status, "pinned");
		assert.equal(report.content.matched, 27);
		assert.deepEqual(report.marketplace, { status: "registered", sourceType: "local", sourceUri: world.source, commit: COMMIT, commitMatchesPin: true });
		assert.equal(report.installation.installPath, world.installPath);
		assert.deepEqual(report.skills.map((skill: { invocation: string }) => skill.invocation), core.EGM_SKILLS.map((name: string) => `/skill:egm:${name}`));
		assert.ok(report.personas.every((persona: { present: boolean }) => persona.present));
		assert.deepEqual(report.session, { status: "observed", marketplaceProvider: "enabled", taskTool: "available", maxRecursionDepth: 2, disabledPersonas: [], disabledSkills: [] });
		assert.deepEqual(report.remediation, []);
	});

	await check("the same install without session settings is unverified, never ready", () => {
		const world = fixture();
		for (const settings of [undefined, {}, { get: () => { throw new Error("blocked accessor"); } }, settingsOf({ "task.disabledAgents": "egm-design" })]) {
			const report = core.readinessReport({ home: world.home, settings, pinnedFiles: world.pinned });
			assert.equal(report.status, "unverified");
			assert.equal(report.session.status, "unobserved");
		}
	});

	await check("one changed runtime file is drift with the file named and a pinned reinstall", () => {
		const world = fixture();
		writeFileSync(path.join(world.installPath, "skills/egm-bootstrap/SKILL.md"), "upstream main moved on\n");
		const report = core.readinessReport({ home: world.home, settings: settingsOf(), pinnedFiles: world.pinned });
		assert.equal(report.status, "drifted");
		assert.equal(report.content.matched, 26);
		assert.deepEqual(report.content.mismatches, [{ path: "skills/egm-bootstrap/SKILL.md", status: "differs" }]);
		assert.ok(report.skills.every((skill: { present: boolean }) => skill.present), "a drifted skill is still present");
		assert.ok(report.remediation.some((line: string) => line.includes("gjc plugin uninstall egm@egm") && line.includes("--branch v0.1.1")));
	});

	await check("a missing persona or standard is incomplete, which outranks drift", () => {
		const world = fixture();
		rmSync(path.join(world.installPath, "agents/zoom_out.md"));
		rmSync(path.join(world.installPath, "resources/document_standards"), { recursive: true });
		writeFileSync(path.join(world.installPath, "skills/egm-review/SKILL.md"), "changed\n");
		const report = core.readinessReport({ home: world.home, settings: settingsOf(), pinnedFiles: world.pinned });
		assert.equal(report.status, "incomplete");
		assert.equal(report.content.status, "incomplete");
		assert.equal(report.personas.find((persona: { name: string }) => persona.name === "egm-zoom-out").present, false);
		assert.ok(report.content.mismatches.some((entry: { path: string; status: string }) => entry.path === "agents/zoom_out.md" && entry.status === "missing"));
		assert.equal(report.content.mismatches.length + report.content.mismatchesOmitted, 7);
	});

	await check("mismatch listing is bounded and counts what it omits", () => {
		const world = fixture();
		for (const relative of Object.keys(world.pinned)) writeFileSync(path.join(world.installPath, relative), "different\n");
		const report = core.readinessReport({ home: world.home, settings: settingsOf(), pinnedFiles: world.pinned });
		assert.equal(report.content.matched, 0);
		assert.equal(report.content.mismatches.length, 12);
		assert.equal(report.content.mismatchesOmitted, 15);
	});

	await check("every session setting that switches the Goldfish path off is blocked with its remedy", () => {
		const world = fixture();
		const cases: Array<[Record<string, unknown>, (report: any) => void]> = [
			[{ disabledProviders: ["claude-plugins"] }, report => assert.equal(report.session.marketplaceProvider, "disabled")],
			[{ "task.maxRecursionDepth": 0 }, report => assert.equal(report.session.taskTool, "disabled")],
			[{ "task.disabledAgents": ["egm-zoom-out", "explore"] }, report => assert.deepEqual(report.session.disabledPersonas, ["egm-zoom-out"])],
			[{ disabledExtensions: ["skill:egm:egm-review", "skill:other"] }, report => assert.deepEqual(report.session.disabledSkills, ["egm-review"])],
		];
		for (const [values, assertion] of cases) {
			const report = core.readinessReport({ home: world.home, settings: settingsOf(values), pinnedFiles: world.pinned });
			assert.equal(report.status, "blocked", JSON.stringify(values));
			assertion(report);
			assert.equal(report.remediation.length, 1, JSON.stringify(report.remediation));
		}
		const unlimited = core.readinessReport({ home: world.home, settings: settingsOf({ "task.maxRecursionDepth": -1 }), pinnedFiles: world.pinned });
		assert.equal(unlimited.status, "ready");
		assert.equal(unlimited.session.taskTool, "available");
	});

	await check("a disabled install entry is blocked, not ready", () => {
		const world = fixture({ enabled: false });
		const report = core.readinessReport({ home: world.home, settings: settingsOf(), pinnedFiles: world.pinned });
		assert.equal(report.installation.status, "disabled");
		assert.equal(report.status, "blocked");
	});

	await check("a git marketplace resolves its branch commit and is flagged as unpinned", () => {
		const world = fixture({ marketplace: "git", head: "ref: refs/heads/main" });
		writeFile(path.join(world.gitClone, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/main\n`);
		const packed = core.readinessReport({ home: world.home, settings: settingsOf(), pinnedFiles: world.pinned });
		assert.equal(packed.marketplace.sourceType, "git");
		assert.equal(packed.marketplace.commit, OTHER);
		assert.equal(packed.marketplace.commitMatchesPin, false);
		assert.ok(packed.notes.some((note: string) => note.includes("follows the upstream default branch")));
		assert.equal(packed.status, "ready", "content, not the commit, is the pin authority");
		writeFile(path.join(world.gitClone, ".git", "refs", "heads", "main"), `${COMMIT}\n`);
		assert.equal(core.readCheckoutCommit(world.gitClone), COMMIT, "a loose ref wins over packed-refs");
		writeFile(path.join(world.gitClone, ".git", "HEAD"), "ref: refs/../../escape\n");
		assert.equal(core.readCheckoutCommit(world.gitClone), null);
		writeFile(path.join(world.gitClone, ".git", "HEAD"), "not a ref\n");
		assert.equal(core.readCheckoutCommit(world.gitClone), null);
	});

	await check("an installed plugin whose marketplace was removed gets the re-add remedy", () => {
		const world = fixture({ marketplace: "none" });
		const report = core.readinessReport({ home: world.home, settings: settingsOf(), pinnedFiles: world.pinned });
		assert.equal(report.marketplace.status, "missing");
		assert.equal(report.status, "ready");
		assert.ok(report.remediation.some((line: string) => line.includes(`gjc plugin marketplace add ${core.EGM_PINNED_SOURCE}`)));
	});

	await check("malformed registries are unreadable and never treated as installed", () => {
		const home = path.join(root, "malformed");
		const registry = path.join(home, ".gjc", "plugins", "installed_plugins.json");
		for (const content of ["{not json", "[]", JSON.stringify({ plugins: [] }), JSON.stringify({ plugins: { "egm@egm": {} } }), JSON.stringify({ plugins: { "egm@egm": [{ scope: "user", installPath: "relative/path" }] } })]) {
			writeJson(registry, content);
			const report = core.readinessReport({ home, settings: settingsOf() });
			assert.equal(report.installation.status, "unreadable", content);
			assert.equal(report.status, "not_installed");
		}
		writeJson(registry, { plugins: { "egm@egm": [{ scope: "project", installPath: "/elsewhere" }] } });
		assert.equal(core.readinessReport({ home }).installation.status, "missing", "only the user scope is reported");
		writeJson(path.join(home, ".gjc", "marketplaces.json"), { marketplaces: {} });
		assert.equal(core.readMarketplace(home).status, "unreadable");
	});

	await check("execute rejects any input other than exactly {} before reading anything", async () => {
		for (const params of [{ unexpected: "value" }, [], null, "{}"]) {
			const result = await tool.execute("call-bad", params);
			assert.equal(result.isError, true, JSON.stringify(params));
			assert.match(result.content[0].text, /^egm_readiness: invalid_input/);
		}
	});

	await check("execute reports the real HOME, uses ctx.settings and writes nothing", async () => {
		const home = os.homedir();
		const before = readdirSync(home);
		const seen: string[] = [];
		const result = await tool.execute("call-1", {}, undefined, { settings: { get: (key: string) => (seen.push(key), undefined) } });
		assert.notEqual(result.isError, true);
		const text = result.content[0].text;
		assert.match(text, /^egm_readiness: not_installed\n/);
		assert.match(text, /\/skill:egm:egm-review/);
		const report = JSON.parse(text.trimEnd().split("\n").at(-1)).report;
		assert.equal(report.session.status, "observed");
		assert.deepEqual(seen.sort(), ["disabledExtensions", "disabledProviders", "task.disabledAgents", "task.maxRecursionDepth"]);
		const unobserved = await tool.execute("call-2", {});
		assert.match(unobserved.content[0].text, /session: unobserved/);
		assert.deepEqual(readdirSync(home), before, "the tool must not create files in HOME");
	});

	await check("generated surfaces are in sync with sources (rebuild is a no-op)", () => {
		const target = path.join(plugin, "tools/egm-readiness.ts");
		const before = readFileSync(target, "utf8");
		const build = spawnSync(process.execPath, [path.join(plugin, "scripts/build.mjs")], { encoding: "utf8", timeout: 60000 });
		assert.equal(build.status, 0, build.stderr);
		assert.equal(readFileSync(target, "utf8"), before, "tools/egm-readiness.ts drifted");
	});

	console.log(JSON.stringify({ kind: "api-package-test-report", cases, failures, realNetworkCalls: 0 }));
	console.log(failures ? `FAILED ${failures}/${cases}` : `ALL PASS (${cases} cases)`);
	process.exitCode = failures || cases === 0 ? 1 : 0;
}
