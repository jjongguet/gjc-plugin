#!/usr/bin/env bun
/**
 * Hermetic acceptance for the egm plugin: the native core, the installer
 * (runtime + GJC plugin half) and the generated tool.
 *
 * Every HOME, agent directory, source tree, fake `gjc` and install root is a
 * temporary fixture under an isolated HOME; the pinned digest table is injected
 * for synthetic content, while the git HEAD identity check always uses the
 * production pin. The fake `gjc` writes the same `gjc-plugins/registry.json`
 * shape as GJC 0.21.1 and copies the declared plugin surface, so the
 * installer's registry-content fast path is exercised without a real CLI or
 * network. Adapter checks run only after `build.mjs --check` proves the
 * generated tool carries the current core and adapter.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
	assert.equal(process.env.GJC_CODING_AGENT_DIR, undefined, "the suite must not inherit a real agent directory");
	assert.equal(process.env.PI_CODING_AGENT_DIR, undefined, "the suite must not inherit a real agent directory");

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
	const installer = await import(pathToFileURL(path.join(plugin, "scripts/install.ts")).href);
	const installScript = path.join(plugin, "scripts/install.ts");

	const drift = spawnSync(process.execPath, ["--no-env-file", path.join(plugin, "scripts/build.mjs"), "--check"], {
		encoding: "utf8",
		timeout: 60000,
	});
	await check("generated surfaces are in sync with sources", () => {
		assert.equal(drift.status, 0, `${drift.stderr ?? ""}${drift.stdout ?? ""}`.trim() || "build.mjs --check failed");
	});
	const tool = drift.status === 0 ? (await import(pathToFileURL(path.join(plugin, "tools/egm-readiness.ts")).href)).default(fakePi) : null;
	if (!tool) {
		cases++;
		failures++;
		console.error("FAIL adapter checks skipped: run `bun run build:egm` and re-run this suite");
	}

	const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
	const writeFile = (file: string, text: string) => {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	};
	const writeJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));
	const readText = (file: string) => readFileSync(file, "utf8");
	const readBytes = (file: string) => readFileSync(file);
	const walk = (dir: string, base = ""): string[] => {
		const out: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const relative = base ? `${base}/${entry.name}` : entry.name;
			if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), relative));
			else out.push(entry.isFile() ? relative : `${relative} (not a regular file)`);
		}
		return out.sort();
	};
	const settingsOf = (values: Record<string, unknown> = {}) => ({
		get: (key: string) =>
			Object.hasOwn(values, key)
				? values[key]
				: ({ "task.maxRecursionDepth": undefined, "task.disabledAgents": [], disabledExtensions: [] } as Record<string, unknown>)[key],
	});
	const refusal = (fn: () => unknown, code: string) => {
		let caught: { code?: string; message?: string; detail?: string | null } | null = null;
		try {
			fn();
		} catch (error) {
			caught = error as { code?: string; message?: string; detail?: string | null };
		}
		assert.ok(caught, `expected a refusal (${code})`);
		assert.equal(caught.code, code, `${caught.code}: ${caught.message}`);
		return caught;
	};

	// Synthetic upstream tree: frontmatter where the compose rules need it,
	// plain text elsewhere. The digest table is computed from exactly these
	// bytes; the .git HEAD always names the production pinned commit.
	const personaNames = new Map(core.EGM_PERSONAS.map(([file, name]: [string, string]) => [file, name]));
	const syntheticUpstream = (relative: string): string => {
		if (relative.startsWith("skills/") && relative.endsWith("/SKILL.md")) {
			const skill = relative.split("/")[1];
			return `---\nname: ${skill}\ndescription: synthetic ${skill}\n---\n\n# ${skill}\n\nSynthetic body for ${relative}; preserved verbatim.\n`;
		}
		if (relative.startsWith("agents/")) {
			const name = personaNames.get(relative) ?? `egm-${path.basename(relative, ".md").replaceAll("_", "-")}`;
			return `---\nname: ${name}\ndescription: synthetic persona for ${relative}\n---\n\n# ${name}\n\nSynthetic persona body for ${relative}; preserved verbatim.\n`;
		}
		return `synthetic ${relative}\n`;
	};

	// Fake `gjc`: a real executable on PATH (installed by a fixture), simulating
	// the measured 0.21.1 plugin JSON shape, registry entries and copied files.
	// It records every argv and never touches a real registry.
	const fakeGjcSource =
		[
			`#!${process.execPath}`,
			'import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";',
			'import { createHash } from "node:crypto";',
			'import path from "node:path";',
			"const state = process.env.EGM_FAKE_GJC_STATE;",
			"const agent = process.env.GJC_CODING_AGENT_DIR;",
			'const registryPath = path.join(agent, "gjc-plugins", "registry.json");',
			'const bundleRoot = path.join(agent, "gjc-plugins", "egm");',
			'const installedFile = path.join(state, "installed");',
			"const argv = process.argv.slice(2);",
			'appendFileSync(path.join(state, "calls.log"), JSON.stringify(argv) + "\\n");',
			'const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");',
			'const mode = (() => { try { return readFileSync(path.join(state, "mode"), "utf8").trim(); } catch { return ""; } })();',
			"const readRegistry = () => { try { return JSON.parse(readFileSync(registryPath, \"utf8\")); } catch { return null; } };",
			'const writeRegistry = entries => { mkdirSync(path.dirname(registryPath), { recursive: true }); writeFileSync(registryPath, JSON.stringify({ version: 1, scope: "user", plugins: entries }, null, 2) + "\\n"); };',
			"const installed = existsSync(installedFile);",
			'const fail = (code, text) => { console.error(text); process.exit(code); };',
			'if (argv[0] === "--version") { console.log("gjc/0.21.1"); process.exit(0); }',
			'if (argv[0] === "plugin" && argv[1] === "list") {',
			'  if (mode.includes("list-fail")) fail(1, "list failed");',
			"  let entries = [];",
			'  if (!mode.includes("list-hides")) {',
			"    const registry = readRegistry();",
			'    if (Array.isArray(registry?.plugins)) entries = registry.plugins.filter(entry => entry?.name === "egm").map(entry => ({ identity: { kind: "gjc-bundle", scope: "user", name: "egm" }, version: entry.version ?? null, enabled: entry.enabled }));',
			'    if (entries.length === 0 && installed) entries = [{ identity: { kind: "gjc-bundle", scope: "user", name: "egm" }, version: "0.0.1" }];',
			"  }",
			'  console.log(JSON.stringify({ npm: [], marketplace: [], gjc: entries }));',
			"  process.exit(0);",
			"}",
			'if (argv[0] === "plugin" && argv[1] === "uninstall") {',
			'  if (mode.includes("uninstall-fail")) fail(1, "uninstall failed");',
			"  const registry = readRegistry();",
			'  const registered = Array.isArray(registry?.plugins) && registry.plugins.some(entry => entry?.name === "egm");',
			'  if (!installed && !registered) fail(1, "not installed");',
			'  writeRegistry((Array.isArray(registry?.plugins) ? registry.plugins : []).filter(entry => entry?.name !== "egm"));',
			'  rmSync(installedFile, { force: true });',
			'  rmSync(bundleRoot, { recursive: true, force: true });',
			'  console.log("uninstalled egm");',
			"  process.exit(0);",
			"}",
			'if (argv[0] === "plugin" && argv[1] === "install") {',
			'  if (mode.includes("install-fail")) fail(1, "install failed");',
			'  if (mode.includes("install-refuse-once") && !existsSync(path.join(state, "refused"))) {',
			'    writeFileSync(path.join(state, "refused"), "");',
			'    fail(2, "plugin egm is already installed");',
			"  }",
			"  const source = argv[2];",
			'  const manifestPath = path.join(source, "gajae-plugin.json");',
			"  const manifestRaw = readFileSync(manifestPath);",
			'  const manifest = JSON.parse(manifestRaw.toString("utf8"));',
			'  const surface = ["gajae-plugin.json", ...(manifest.tools ?? []).map(tool => tool.path), ...(manifest.hooks ?? []).map(hook => hook.path)];',
			'  const copiedFiles = surface.map(relativePath => ({ relativePath, sha256: sha256(path.join(source, relativePath)), bytes: statSync(path.join(source, relativePath)).size }));',
			'  mkdirSync(bundleRoot, { recursive: true });',
			"  for (const relativePath of surface) {",
			'    mkdirSync(path.dirname(path.join(bundleRoot, relativePath)), { recursive: true });',
			'    copyFileSync(path.join(source, relativePath), path.join(bundleRoot, relativePath));',
			"  }",
			"  const registry = readRegistry();",
			'  const others = (Array.isArray(registry?.plugins) ? registry.plugins : []).filter(entry => entry?.name !== "egm");',
			'  others.push({ name: "egm", version: manifest.version ?? "0.0.1", scope: "user", enabled: true, pluginRoot: bundleRoot, manifestPath, manifestHash: sha256(manifestPath), source: { kind: "path", uri: source }, copiedFiles });',
			"  writeRegistry(others);",
			'  writeFileSync(installedFile, "");',
			'  console.log("installed egm");',
			"  process.exit(0);",
			"}",
			'fail(64, "unexpected " + JSON.stringify(argv));',
		].join("\n") + "\n";

	type World = { home: string; source: string; agentDir: string; pinned: Record<string, string>; fakeGjc: string; gjcState: string };
	let worlds = 0;
	const makeWorld = (label: string): World => {
		worlds++;
		const home = path.join(root, `home-${worlds}-${label}`);
		mkdirSync(home);
		const source = path.join(root, `source-${worlds}-${label}`);
		const pinned: Record<string, string> = {};
		for (const relative of Object.keys(core.EGM_PINNED_FILES)) {
			const content = syntheticUpstream(relative);
			writeFile(path.join(source, relative), content);
			pinned[relative] = sha256(content);
		}
		writeFile(path.join(source, ".git", "HEAD"), `${core.EGM_PINNED_COMMIT}\n`);
		const fakeGjc = path.join(home, "fake-bin", "gjc");
		mkdirSync(path.dirname(fakeGjc), { recursive: true });
		writeFileSync(fakeGjc, fakeGjcSource, { mode: 0o755 });
		const gjcState = path.join(home, "fake-gjc-state");
		mkdirSync(gjcState, { recursive: true });
		writeFile(path.join(gjcState, "mode"), "");
		return { home, source, agentDir: path.join(home, "agent"), pinned, fakeGjc, gjcState };
	};
	const envOf = (world: World) => ({ GJC_CODING_AGENT_DIR: world.agentDir });
	const gjcEnvAt = (world: World, agentDir: string) => ({ HOME: world.home, TMPDIR: path.join(root, "tmp"), GJC_CODING_AGENT_DIR: agentDir, EGM_FAKE_GJC_STATE: world.gjcState });
	const gjcEnvOf = (world: World) => gjcEnvAt(world, world.agentDir);
	const install = (world: World, overrides: Record<string, unknown> = {}) =>
		installer.installEgm({
			source: { kind: "local", dir: world.source },
			pinnedFiles: world.pinned,
			env: envOf(world),
			home: world.home,
			gjcCommand: world.fakeGjc,
			gjcEnv: gjcEnvOf(world),
			...overrides,
		});
	const setGjcMode = (world: World, mode: string) => writeFile(path.join(world.gjcState, "mode"), mode);
	const markInstalled = (world: World) => writeFile(path.join(world.gjcState, "installed"), "");
	const unmarkInstalled = (world: World) => rmSync(path.join(world.gjcState, "installed"), { force: true });
	const gjcCalls = (world: World) =>
		readText(path.join(world.gjcState, "calls.log"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as string[]);
	const bundleOf = (world: World) => path.join(world.agentDir, "egm", core.EGM_PINNED_TAG);
	const journalOf = (world: World) => path.join(bundleOf(world), "bundle.json");
	const registryPathOf = (world: World) => path.join(world.agentDir, "gjc-plugins", "registry.json");
	const pluginRootOf = (world: World) => path.join(world.agentDir, "gjc-plugins", "egm");
	const reportOf = (world: World, overrides: Record<string, unknown> = {}) =>
		core.readinessReport({ env: envOf(world), home: world.home, pinnedFiles: world.pinned, argv: ["gjc"], ...overrides });

	// The real checkout's declared plugin surface, used to seed registry
	// fixtures and to assert the fake's copiedFiles exactly.
	const sourceSurface = () => {
		const manifestPath = path.join(plugin, "gajae-plugin.json");
		const manifestRaw = readFileSync(manifestPath);
		const manifest = JSON.parse(manifestRaw.toString("utf8"));
		const paths = ["gajae-plugin.json", ...(manifest.tools ?? []).map((entry: { path: string }) => entry.path), ...(manifest.hooks ?? []).map((entry: { path: string }) => entry.path)];
		return {
			manifestHash: sha256(manifestRaw),
			copiedFiles: paths.map(relativePath => ({ relativePath, sha256: sha256(readFileSync(path.join(plugin, relativePath))) })),
		};
	};
	const copySurfaceTo = (rootDir: string) => {
		for (const file of sourceSurface().copiedFiles) {
			mkdirSync(path.dirname(path.join(rootDir, file.relativePath)), { recursive: true });
			copyFileSync(path.join(plugin, file.relativePath), path.join(rootDir, file.relativePath));
		}
	};
	const seedRegistry = (world: World, options: { enabled?: boolean; manifestHash?: string; copiedFiles?: Array<{ relativePath: string; sha256: string }>; source?: string; withCopies?: boolean } = {}) => {
		const surface = sourceSurface();
		const entry = {
			name: "egm",
			version: "0.0.1",
			scope: "user",
			enabled: options.enabled ?? true,
			pluginRoot: pluginRootOf(world),
			manifestPath: path.join(plugin, "gajae-plugin.json"),
			manifestHash: options.manifestHash ?? surface.manifestHash,
			source: { kind: "path", uri: options.source ?? "/registered/old/egm" },
			copiedFiles: (options.copiedFiles ?? surface.copiedFiles).map(file => ({ relativePath: file.relativePath, sha256: file.sha256 })),
		};
		writeJson(registryPathOf(world), { version: 1, scope: "user", plugins: [entry] });
		if (options.withCopies) copySurfaceTo(entry.pluginRoot);
		markInstalled(world);
		return entry;
	};
	const removePluginRegistration = (world: World) => {
		rmSync(registryPathOf(world), { force: true });
		rmSync(pluginRootOf(world), { recursive: true, force: true });
		unmarkInstalled(world);
	};

	await check("the native core exposes the documented surface", () => {
		assert.deepEqual(Object.keys(core).sort(), [
			"EGM_INSTALL_COMMAND",
			"EGM_PERSONAS",
			"EGM_PINNED_COMMIT",
			"EGM_PINNED_FILES",
			"EGM_PINNED_TAG",
			"EGM_REPOSITORY",
			"EGM_REVIEWERS",
			"EGM_REVIEWER_TOOLS",
			"EGM_SKILLS",
			"EGM_UNREGISTERED_PERSONAS",
			"agentAdapterBlock",
			"agentFrontmatter",
			"bundleRoot",
			"checkBundle",
			"checkLoose",
			"composeAgent",
			"composeSkill",
			"journalPath",
			"launchToolList",
			"looseFiles",
			"readinessReport",
			"readJournal",
			"readPluginRecord",
			"readSession",
			"renderLoose",
			"resolveAgentDir",
			"sessionToolList",
			"sha256Hex",
			"skillAdapterBlock",
			"splitFrontmatter",
			"taskVisibility",
		].sort());
	});

	await check("the pin covers 31 files with the accepted layout", () => {
		const files = core.EGM_PINNED_FILES as Record<string, string>;
		assert.equal(Object.keys(files).length, 31);
		assert.equal(core.EGM_SKILLS.length, 7);
		assert.equal(core.EGM_PERSONAS.length, 10);
		assert.equal(core.EGM_REVIEWERS.length, 8);
		assert.equal(core.EGM_UNREGISTERED_PERSONAS.length, 2);
		assert.deepEqual(core.EGM_REVIEWERS, core.EGM_PERSONAS.filter(([file]: [string, string]) => !core.EGM_UNREGISTERED_PERSONAS.includes(file)));
		assert.deepEqual([...core.EGM_REVIEWER_TOOLS], ["read", "search", "find"]);
		for (const [relative, digest] of Object.entries(files)) {
			assert.match(digest, /^[0-9a-f]{64}$/, relative);
			assert.ok(!relative.startsWith("/") && !relative.includes("..") && !relative.includes("\\"), relative);
		}
		for (const skill of core.EGM_SKILLS) assert.ok(files[`skills/${skill}/SKILL.md`], skill);
		for (const [file] of core.EGM_REVIEWERS) assert.ok(files[file], file);
		assert.equal(Object.keys(files).filter(key => key.startsWith("skills/") && key.includes("/references/")).length, 3);
		assert.equal(Object.keys(files).filter(key => key.startsWith("resources/document_standards/")).length, 5);
		assert.equal(Object.keys(files).filter(key => key.startsWith("agents/")).length, 10);
		for (const key of ["docs/harnesses.md", "docs/codex.md", "docs/claude.md", "LICENSE"]) assert.ok(files[key], key);
		assert.equal(core.EGM_PINNED_TAG, "v0.1.1");
		assert.match(core.EGM_PINNED_COMMIT, /^[0-9a-f]{40}$/);
		assert.equal(core.EGM_REPOSITORY, "https://github.com/google/elephant-goldfish-model");
		assert.equal(core.EGM_INSTALL_COMMAND, "bun run egm:install");
	});

	await check("compose keeps the upstream body byte for byte and adds the GJC adapters", () => {
		const skillText = "---\nname: egm-review\ndescription: x\n---\n\n# Review\n\nBody line.\n";
		const skillBytes = Buffer.from(skillText);
		const parts = core.splitFrontmatter(skillBytes);
		assert.ok(parts);
		const composed = core.composeSkill(skillBytes, "egm-review", "/bundle", "/agent/skills/egm-review");
		assert.ok(composed.subarray(composed.length - parts.body.length).equals(parts.body), "the upstream body must stay the suffix");
		assert.ok(composed.subarray(0, parts.header.length).equals(parts.header), "the upstream frontmatter must be preserved");
		const skill = composed.toString("utf8");
		assert.ok(skill.includes("## GJC (gajae-code) adapter"));
		assert.ok(skill.includes("/bundle") && skill.includes("/agent/skills/egm-review"));
		assert.ok(skill.includes("use direct dispatch"), "egm-review carries the delegation clause");
		assert.ok(core.composeSkill(skillBytes, "egm-bootstrap", "/b", "/s").toString("utf8").includes("run the orchestrator role inline"));
		assert.ok(!core.composeSkill(skillBytes, "egm-draft", "/b", "/s").toString("utf8").includes("use direct dispatch"));

		const personaText = "---\nname: egm-design\ndescription: x\n---\n\nPersona body.\n";
		const personaBytes = Buffer.from(personaText);
		const personaParts = core.splitFrontmatter(personaBytes);
		assert.ok(personaParts);
		const persona = core.composeAgent(personaBytes, "/bundle");
		assert.ok(persona.subarray(persona.length - personaParts.body.length).equals(personaParts.body));
		const agentText = persona.toString("utf8");
		assert.equal((agentText.match(/^tools:/gm) ?? []).length, 1, "exactly one tools line");
		assert.equal(core.agentFrontmatter(persona).tools?.join(","), "read,search,find");
		assert.equal(core.agentFrontmatter(persona).name, "egm-design");
		assert.ok(agentText.includes("GJC adapter — EGM bundle root: `/bundle`"));
		assert.throws(() => core.composeSkill(Buffer.from("no frontmatter\n"), "egm-review", "/b", "/s"), /no frontmatter/);
	});

	await check("a fresh install writes the runtime and registers the exact plugin bundle", () => {
		const world = makeWorld("fresh");
		const result = install(world);
		assert.equal(result.status, "installed");
		assert.equal(result.runtime, "written");
		assert.equal(result.plugin.status, "installed");
		assert.equal(result.plugin.content, "missing");
		assert.equal(result.plugin.listedBefore, false);
		assert.equal(result.pluginDir, path.resolve(plugin));
		assert.equal(result.agentDir.dir, world.agentDir);
		assert.equal(result.agentDir.source, "GJC_CODING_AGENT_DIR");
		assert.equal(result.bundleRoot, bundleOf(world));
		assert.equal(result.journal, journalOf(world));
		assert.deepEqual(result.counts, { bundle: 31, skills: 7, references: 3, agents: 8 });
		assert.ok(existsSync(path.join(world.gjcState, "installed")), "the fake gjc never recorded the plugin install");
		const calls = gjcCalls(world);
		assert.deepEqual(calls[0], ["--version"]);
		assert.ok(calls.some(argv => argv.join(" ") === `plugin install ${path.resolve(plugin)} --user`), JSON.stringify(calls));
		assert.ok(!calls.some(argv => argv.join(" ") === "plugin list --json"), "a missing registry must install without a list probe");
		assert.ok(calls.every(argv => !argv.includes("--force") && !argv.includes("--dry-run")), "the installer must never force or dry-run the plugin half");

		for (const [relative, digest] of Object.entries(world.pinned)) {
			const installed = readBytes(path.join(bundleOf(world), relative));
			assert.equal(sha256(installed), digest, relative);
			assert.equal(installed.toString("utf8"), readText(path.join(world.source, relative)), relative);
		}
		const files = core.looseFiles(world.pinned);
		assert.equal(files.length, 18);
		for (const file of files) assert.ok(existsSync(path.join(world.agentDir, file.relative)), file.relative);
		assert.deepEqual(walk(bundleOf(world)), [...Object.keys(world.pinned), "bundle.json"].sort());
		assert.deepEqual(walk(path.join(world.agentDir, "agents")), core.EGM_REVIEWERS.map(([, name]: [string, string]) => `${name}.md`).sort());
		assert.deepEqual(
			walk(path.join(world.agentDir, "skills")),
			files.filter((file: { kind: string }) => file.kind !== "agent").map((file: { relative: string }) => file.relative.slice("skills/".length)).sort(),
		);

		const record = core.readPluginRecord(world.agentDir);
		const surface = sourceSurface();
		assert.equal(record.status, "registered");
		assert.equal(record.enabled, true);
		assert.equal(record.manifestHash, surface.manifestHash);
		assert.deepEqual(record.copiedFiles?.map((file: { relativePath: string }) => file.relativePath).sort(), surface.copiedFiles.map(file => file.relativePath).sort());
		for (const file of surface.copiedFiles) assert.equal(sha256(readBytes(path.join(pluginRootOf(world), file.relativePath))), file.sha256, file.relativePath);

		const sourceOf = (relative: string) => readText(path.join(world.source, relative));
		const bodyOf = (relative: string) => {
			const parts = core.splitFrontmatter(Buffer.from(sourceOf(relative)));
			assert.ok(parts, relative);
			return parts.body;
		};
		for (const skill of core.EGM_SKILLS) {
			const relative = `skills/${skill}/SKILL.md`;
			const installed = readBytes(path.join(world.agentDir, relative));
			const body = bodyOf(relative);
			assert.ok(installed.subarray(installed.length - body.length).equals(body), `${relative} body`);
			assert.ok(installed.toString("utf8").includes("## GJC (gajae-code) adapter"), relative);
		}
		const references = files.filter((file: { kind: string }) => file.kind === "reference");
		assert.equal(references.length, 3);
		for (const reference of references) assert.equal(readText(path.join(world.agentDir, reference.relative)), sourceOf(reference.relative));
		for (const [source, name] of core.EGM_REVIEWERS) {
			const installed = readBytes(path.join(world.agentDir, "agents", `${name}.md`));
			assert.equal(core.agentFrontmatter(installed).name, name);
			assert.deepEqual(core.agentFrontmatter(installed).tools, ["read", "search", "find"]);
			const body = bodyOf(source);
			assert.ok(installed.subarray(installed.length - body.length).equals(body), `${name} body`);
		}
		for (const unregistered of ["egm-bootstrap-orchestrator", "egm-synthesizer"]) {
			assert.ok(!existsSync(path.join(world.agentDir, "agents", `${unregistered}.md`)), unregistered);
		}

		const read = core.readJournal(world.agentDir);
		assert.equal(read.status, "complete");
		const journal = read.journal;
		assert.equal(journal.schemaVersion, 1);
		assert.equal(journal.tag, core.EGM_PINNED_TAG);
		assert.equal(journal.commit, core.EGM_PINNED_COMMIT);
		assert.deepEqual(journal.bundle, world.pinned);
		assert.deepEqual(Object.keys(journal.loose).sort(), files.map((file: { relative: string }) => file.relative).sort());
		for (const [relative, digest] of Object.entries(journal.loose)) assert.equal(sha256(readBytes(path.join(world.agentDir, relative))), digest, relative);
	});

	await check("an identical re-run reports unchanged with zero plugin writes", () => {
		const world = makeWorld("unchanged");
		assert.equal(install(world).status, "installed");
		const journalBefore = statSync(journalOf(world));
		const loose = path.join(world.agentDir, "agents/egm-design.md");
		const looseBefore = statSync(loose);
		const callsBefore = gjcCalls(world).length;
		const result = install(world);
		assert.equal(result.status, "unchanged");
		assert.equal(result.runtime, "unchanged");
		assert.equal(result.plugin.status, "unchanged");
		assert.equal(result.plugin.content, "current");
		const journalAfter = statSync(journalOf(world));
		const looseAfter = statSync(loose);
		assert.equal(journalAfter.mtimeMs, journalBefore.mtimeMs);
		assert.equal(journalAfter.ino, journalBefore.ino);
		assert.equal(looseAfter.mtimeMs, looseBefore.mtimeMs);
		assert.equal(looseAfter.ino, looseBefore.ino);
		const added = gjcCalls(world).slice(callsBefore).map(argv => argv.join(" "));
		assert.deepEqual(added, ["--version"], "a current registry must not trigger a plugin list/install/uninstall");
	});

	await check("a stale manifest hash replaces the bundle", () => {
		const world = makeWorld("stale-hash");
		seedRegistry(world, { manifestHash: "0".repeat(64), withCopies: true });
		const result = install(world);
		assert.equal(result.plugin.status, "replaced");
		assert.equal(result.plugin.content, "replace");
		const calls = gjcCalls(world).map(argv => argv.join(" "));
		assert.deepEqual(calls.slice(0, 3), ["--version", "plugin uninstall egm --user", `plugin install ${path.resolve(plugin)} --user`], JSON.stringify(calls));
		assert.equal(core.readPluginRecord(world.agentDir).manifestHash, sourceSurface().manifestHash);
	});

	await check("a disabled bundle is replaced", () => {
		const world = makeWorld("disabled");
		seedRegistry(world, { enabled: false, withCopies: true });
		const result = install(world);
		assert.equal(result.plugin.status, "replaced");
		assert.equal(result.plugin.content, "replace");
		assert.equal(core.readPluginRecord(world.agentDir).enabled, true, "the reinstall must re-enable the bundle");
	});

	await check("a copiedFiles mismatch replaces the bundle", () => {
		const world = makeWorld("copied-mismatch");
		const surface = sourceSurface();
		const copiedFiles = surface.copiedFiles.map((file, index) => (index === 0 ? { ...file, sha256: "f".repeat(64) } : file));
		seedRegistry(world, { copiedFiles });
		const result = install(world);
		assert.equal(result.plugin.status, "replaced");
		assert.equal(result.plugin.content, "replace");
	});

	await check("an installed-copy mismatch replaces a complete runtime's bundle", () => {
		const world = makeWorld("installed-copy");
		assert.equal(install(world).status, "installed");
		const toolPath = path.join(pluginRootOf(world), "tools/egm-readiness.ts");
		writeFile(toolPath, `${readText(toolPath)}\n// tampered installed copy\n`);
		const result = install(world);
		assert.equal(result.status, "installed");
		assert.equal(result.runtime, "unchanged");
		assert.equal(result.plugin.status, "replaced");
		assert.equal(result.plugin.content, "replace");
		const expected = sourceSurface().copiedFiles.find(file => file.relativePath === "tools/egm-readiness.ts")?.sha256;
		assert.equal(sha256(readBytes(toolPath)), expected, "the reinstall must restore the installed tool copy");
	});

	await check("an under-reported list plus an already-installed refusal gets exactly one retry", () => {
		const world = makeWorld("retry");
		markInstalled(world);
		writeFile(registryPathOf(world), "{not json");
		setGjcMode(world, "list-hides install-refuse-once");
		const result = install(world);
		assert.equal(result.plugin.status, "installed");
		assert.equal(result.plugin.retried, true);
		assert.equal(result.plugin.content, "unknown");
		const calls = gjcCalls(world).map(argv => argv.join(" "));
		assert.equal(calls.filter(line => line === "plugin uninstall egm --user").length, 1, JSON.stringify(calls));
		assert.equal(calls.filter(line => line.startsWith("plugin install ")).length, 2, JSON.stringify(calls));
		assert.ok(existsSync(path.join(world.gjcState, "installed")));
	});

	await check("a plugin refusal leaves a pending journal with no runtime files, and a re-run resumes", () => {
		const world = makeWorld("plugin-fail");
		setGjcMode(world, "install-fail");
		const failure = refusal(() => install(world), "plugin_install_failed");
		assert.ok(failure.detail?.includes("pending journal") && failure.detail?.includes("resume"), failure.detail ?? "");
		assert.equal(core.readJournal(world.agentDir).status, "pending");
		assert.deepEqual(walk(bundleOf(world)), ["bundle.json"]);
		assert.equal(existsSync(path.join(world.agentDir, "skills")), false);
		assert.equal(existsSync(path.join(world.agentDir, "agents")), false);
		assert.equal(existsSync(path.join(world.gjcState, "installed")), false);
		setGjcMode(world, "");
		const resumed = install(world);
		assert.equal(resumed.status, "installed");
		assert.equal(resumed.plugin.status, "installed");
		assert.equal(resumed.plugin.content, "missing");
		assert.equal(core.readJournal(world.agentDir).status, "complete");
		assert.equal(core.looseFiles(world.pinned).every((file: { relative: string }) => existsSync(path.join(world.agentDir, file.relative))), true);
	});

	await check("a failed uninstall refuses with the existing plugin intact and a pending journal", () => {
		const world = makeWorld("uninstall-fail");
		seedRegistry(world, { manifestHash: "0".repeat(64), withCopies: true });
		setGjcMode(world, "uninstall-fail");
		refusal(() => install(world), "plugin_uninstall_failed");
		assert.equal(core.readJournal(world.agentDir).status, "pending");
		assert.ok(existsSync(path.join(world.gjcState, "installed")), "the existing plugin must not be reported as removed");
		assert.deepEqual(walk(bundleOf(world)), ["bundle.json"]);
		assert.equal(existsSync(path.join(world.agentDir, "skills")), false);
	});

	await check("a removed plugin registration is repaired without rewriting a complete runtime", () => {
		const world = makeWorld("plugin-repair");
		assert.equal(install(world).status, "installed");
		removePluginRegistration(world);
		const journalBefore = statSync(journalOf(world));
		const result = install(world);
		assert.equal(result.status, "installed");
		assert.equal(result.runtime, "unchanged");
		assert.equal(result.plugin.status, "installed");
		assert.equal(result.plugin.content, "missing");
		assert.equal(statSync(journalOf(world)).mtimeMs, journalBefore.mtimeMs);
		assert.ok(existsSync(registryPathOf(world)));
		assert.equal(core.readJournal(world.agentDir).status, "complete");
	});

	await check("an invalid incoming plugin bundle is refused before any uninstall", () => {
		const world = makeWorld("plugin-source-invalid");
		seedRegistry(world, { manifestHash: "0".repeat(64), source: "/registered/old/egm" });
		const bad = path.join(world.home, "bad-plugin");
		writeJson(path.join(bad, "gajae-plugin.json"), { kind: "gajae-code-plugin", name: "egm", version: "0.0.1", tools: [{ name: "x", path: "tools/missing.ts", description: "x" }] });
		const failure = refusal(() => install(world, { pluginDir: bad }), "plugin_source_invalid");
		assert.match(failure.message ?? "", /registered source: \/registered\/old\/egm/);
		const calls = gjcCalls(world).map(argv => argv.join(" "));
		assert.ok(!calls.some(line => line.startsWith("plugin uninstall")), JSON.stringify(calls));
		assert.ok(!calls.some(line => line.startsWith("plugin install")), JSON.stringify(calls));
		assert.equal(existsSync(bundleOf(world)), false);
	});

	await check("a missing gjc refuses before the first write", () => {
		const world = makeWorld("no-gjc");
		const failure = refusal(() => install(world, { gjcCommand: path.join(world.home, "missing", "gjc") }), "gjc_missing");
		assert.ok(failure.detail?.includes("nothing was written"), failure.detail ?? "");
		assert.equal(existsSync(world.agentDir), false);
		assert.equal(existsSync(bundleOf(world)), false);
	});

	await check("a missing, drifted or symlinked source refuses before the first write", () => {
		const missing = makeWorld("source-missing");
		rmSync(path.join(missing.source, "skills/egm-review/SKILL.md"));
		assert.ok(refusal(() => install(missing), "source_missing").message?.includes("skills/egm-review/SKILL.md"));
		assert.equal(existsSync(missing.agentDir), false);

		const drifted = makeWorld("source-drifted");
		writeFile(path.join(drifted.source, "resources/execution_instructions.md"), "tampered\n");
		assert.ok(refusal(() => install(drifted), "source_mismatch").message?.includes("resources/execution_instructions.md"));
		assert.equal(existsSync(drifted.agentDir), false);

		const linked = makeWorld("source-symlink");
		const license = path.join(linked.source, "LICENSE");
		rmSync(license);
		symlinkSync(path.join(linked.source, "docs/codex.md"), license);
		refusal(() => install(linked), "source_symlink");
		assert.equal(existsSync(linked.agentDir), false);
	});

	await check("the local source must carry the pinned git HEAD identity", () => {
		const noGit = makeWorld("source-no-git");
		rmSync(path.join(noGit.source, ".git"), { recursive: true, force: true });
		const unknown = refusal(() => install(noGit), "source_commit_unknown");
		assert.ok(unknown.detail?.includes("no bypass flag"), unknown.detail ?? "");
		assert.equal(existsSync(noGit.agentDir), false);

		const wrongHead = makeWorld("source-wrong-head");
		writeFile(path.join(wrongHead.source, ".git", "HEAD"), `${"1".repeat(40)}\n`);
		refusal(() => install(wrongHead), "source_head_mismatch");
		assert.equal(existsSync(wrongHead.agentDir), false);

		const symbolic = makeWorld("source-symbolic");
		writeFile(path.join(symbolic.source, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFile(path.join(symbolic.source, ".git", "refs", "heads", "main"), `${core.EGM_PINNED_COMMIT}\n`);
		assert.equal(install(symbolic).status, "installed");

		const packed = makeWorld("source-packed");
		writeFile(path.join(packed.source, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFile(path.join(packed.source, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${core.EGM_PINNED_COMMIT} refs/heads/main\n`);
		assert.equal(install(packed).status, "installed");
	});

	await check("foreign files and symlinked destinations are refused without being replaced", () => {
		const foreign = makeWorld("foreign");
		const target = path.join(foreign.agentDir, "skills/egm-review/SKILL.md");
		writeFile(target, "user content\n");
		refusal(() => install(foreign), "foreign_file");
		assert.equal(readText(target), "user content\n");
		assert.equal(existsSync(bundleOf(foreign)), false);

		const linkedDir = makeWorld("symlink-dir");
		const outside = path.join(root, `outside-${worlds}`);
		mkdirSync(outside);
		writeFile(path.join(outside, "keep.txt"), "keep\n");
		mkdirSync(linkedDir.agentDir, { recursive: true });
		symlinkSync(outside, path.join(linkedDir.agentDir, "agents"));
		refusal(() => install(linkedDir), "target_symlink");
		assert.equal(readText(path.join(outside, "keep.txt")), "keep\n");
		assert.deepEqual(readdirSync(outside), ["keep.txt"]);

		const linkedFile = makeWorld("symlink-file");
		const outsideFile = path.join(root, `outside-file-${worlds}.txt`);
		writeFile(outsideFile, "keep\n");
		writeFile(path.join(linkedFile.agentDir, "skills/egm-review/.keep"), "");
		rmSync(path.join(linkedFile.agentDir, "skills/egm-review/.keep"));
		symlinkSync(outsideFile, path.join(linkedFile.agentDir, "skills/egm-review/SKILL.md"));
		refusal(() => install(linkedFile), "target_symlink");
		assert.equal(readText(outsideFile), "keep\n");
	});

	await check("a journal that does not match the pin is refused untouched", () => {
		const wrongCommit = makeWorld("journal-commit");
		install(wrongCommit);
		const commitJournal = JSON.parse(readText(journalOf(wrongCommit)));
		commitJournal.commit = "0".repeat(40);
		writeJson(journalOf(wrongCommit), commitJournal);
		refusal(() => install(wrongCommit), "journal_mismatch");
		assert.equal(JSON.parse(readText(journalOf(wrongCommit))).commit, "0".repeat(40));

		const wrongLoose = makeWorld("journal-loose");
		install(wrongLoose);
		const looseJournal = JSON.parse(readText(journalOf(wrongLoose)));
		looseJournal.loose["agents/egm-design.md"] = "f".repeat(64);
		writeJson(journalOf(wrongLoose), looseJournal);
		refusal(() => install(wrongLoose), "journal_mismatch");

		const broken = makeWorld("journal-broken");
		install(broken);
		writeFile(journalOf(broken), "{not json");
		refusal(() => install(broken), "journal_unreadable");
	});

	await check("a failed journal replacement leaves the previous journal intact", () => {
		const world = makeWorld("journal-durable");
		install(world);
		const before = readBytes(journalOf(world));
		assert.equal(core.readJournal(world.agentDir).status, "complete");
		mkdirSync(`${journalOf(world)}.tmp`, { recursive: true });
		rmSync(path.join(world.agentDir, "agents/egm-design.md"));
		refusal(() => install(world), "write_failed");
		assert.deepEqual(readBytes(journalOf(world)), before, "a failed journal write must not truncate the previous journal");
		assert.equal(core.readJournal(world.agentDir).status, "complete");
		rmSync(`${journalOf(world)}.tmp`, { recursive: true, force: true });
		assert.equal(install(world).status, "installed");
	});

	await check("a pending journal resumes an interrupted install", () => {
		const world = makeWorld("resume");
		install(world);
		const journal = JSON.parse(readText(journalOf(world)));
		journal.state = "pending";
		writeJson(journalOf(world), journal);
		rmSync(path.join(world.agentDir, "agents/egm-design.md"));
		rmSync(path.join(bundleOf(world), "resources/execution_instructions.md"));
		const interrupted = reportOf(world, { settings: settingsOf() });
		assert.equal(interrupted.status, "incomplete");
		assert.equal(interrupted.journal, "pending");
		const result = install(world);
		assert.equal(result.status, "installed");
		assert.equal(result.runtime, "written");
		assert.equal(result.plugin.status, "unchanged");
		assert.equal(result.plugin.content, "current");
		assert.equal(core.readJournal(world.agentDir).status, "complete");
		for (const file of core.looseFiles(world.pinned)) assert.ok(existsSync(path.join(world.agentDir, file.relative)), file.relative);
		assert.ok(existsSync(path.join(bundleOf(world), "resources/execution_instructions.md")));
	});

	await check("a changed owned file is refused, and missing owned files are restored", () => {
		const world = makeWorld("owned");
		install(world);
		const loose = path.join(world.agentDir, "agents/egm-design.md");
		writeFile(loose, `${readText(loose)}\nuser edit\n`);
		refusal(() => install(world), "owned_file_modified");
		assert.ok(readText(loose).endsWith("user edit\n"), "the changed file must not be overwritten");
		const bundled = path.join(bundleOf(world), "resources/execution_instructions.md");
		writeFile(bundled, "tampered\n");
		refusal(() => install(world), "owned_file_modified");
		assert.equal(readText(bundled), "tampered\n");
		rmSync(loose);
		rmSync(bundled);
		assert.equal(install(world).status, "installed");
		assert.ok(existsSync(loose) && existsSync(bundled));
		assert.equal(core.readJournal(world.agentDir).status, "complete");
	});

	await check("readiness reports install_verified and the registered plugin block", () => {
		const world = makeWorld("readiness");
		install(world);
		const report = reportOf(world, { settings: settingsOf() });
		assert.equal(report.status, "install_verified");
		assert.equal(report.journal, "complete");
		assert.equal(report.pinned.files, 31);
		assert.deepEqual(report.bundle, { status: "pinned", checked: 31, matched: 31, mismatches: [], mismatchesOmitted: 0 });
		assert.equal(report.loose.status, "pinned");
		assert.deepEqual(report.loose.skills, { checked: 7, matched: 7 });
		assert.deepEqual(report.loose.references, { checked: 3, matched: 3 });
		assert.deepEqual(report.loose.agents, { checked: 8, matched: 8 });
		assert.deepEqual(report.loose.extraAgents, []);
		assert.equal(report.plugin.status, "registered");
		assert.equal(report.plugin.registered, true);
		assert.equal(report.plugin.enabled, true);
		assert.equal(report.plugin.manifestHash, sourceSurface().manifestHash);
		assert.ok(report.plugin.source?.includes(path.resolve(plugin)));
		assert.deepEqual(report.skills.map((skill: { invocation: string }) => skill.invocation), core.EGM_SKILLS.map((name: string) => `/skill:${name}`));
		assert.deepEqual(report.reviewers.map((reviewer: { name: string }) => reviewer.name), core.EGM_REVIEWERS.map(([, name]: [string, string]) => name));
		assert.equal(report.task.state, "unobservable");
		assert.deepEqual(report.remediation, []);
		assert.ok(report.notes.some((note: string) => note.includes("SYSTEM.md") && note.includes("RULES.md")), "host instruction inflow stays documented");
		assert.ok(report.notes.some((note: string) => note.includes("does not byte-compare")), "the plugin block limitation stays explicit");
		assert.equal(report.installCommand, "bun run egm:install");
		assert.equal(reportOf(world).status, "unverified");
		assert.equal(reportOf(world, { settings: { get: () => { throw new Error("blocked accessor"); } } }).status, "unverified");
	});

	await check("the plugin block is report-only and the status ladder stays runtime-scoped", () => {
		const world = makeWorld("plugin-block");
		install(world);
		seedRegistry(world, { enabled: false });
		const disabled = reportOf(world, { settings: settingsOf() });
		assert.equal(disabled.plugin.status, "disabled");
		assert.equal(disabled.plugin.registered, true);
		assert.equal(disabled.plugin.enabled, false);
		assert.equal(disabled.status, "install_verified", "a disabled bundle must not change the runtime status");
		writeFile(registryPathOf(world), "{not json");
		const unreadable = reportOf(world, { settings: settingsOf() });
		assert.equal(unreadable.plugin.status, "unreadable");
		assert.equal(unreadable.plugin.registered, false);
		assert.equal(unreadable.status, "install_verified");
		rmSync(registryPathOf(world), { force: true });
		const missing = reportOf(world, { settings: settingsOf() });
		assert.equal(missing.plugin.status, "missing");
		assert.equal(missing.status, "install_verified");
	});

	await check("readiness separates not_installed, incomplete and drifted states", () => {
		const bare = makeWorld("bare");
		const missing = reportOf(bare, { settings: settingsOf() });
		assert.equal(missing.status, "not_installed");
		assert.equal(missing.journal, "missing");
		assert.equal(missing.plugin.status, "missing");
		assert.ok(missing.remediation[0].includes(core.EGM_INSTALL_COMMAND));

		const drifted = makeWorld("readiness-drifted");
		install(drifted);
		writeFile(path.join(bundleOf(drifted), "skills/egm-review/SKILL.md"), "upstream moved\n");
		const drift = reportOf(drifted, { settings: settingsOf() });
		assert.equal(drift.status, "drifted");
		assert.ok(drift.bundle.mismatches.some((entry: { path: string; status: string }) => entry.path === "skills/egm-review/SKILL.md" && entry.status === "differs"));
		assert.ok(drift.remediation.some((line: string) => line.includes("Reinstall")));

		const incomplete = makeWorld("readiness-incomplete");
		install(incomplete);
		rmSync(path.join(incomplete.agentDir, "agents/egm-zoom-out.md"));
		const partial = reportOf(incomplete, { settings: settingsOf() });
		assert.equal(partial.status, "incomplete");
		assert.ok(partial.loose.mismatches.some((entry: { path: string; status: string }) => entry.path === "agents/egm-zoom-out.md" && entry.status === "missing"));

		const pending = makeWorld("readiness-pending");
		install(pending);
		const journal = JSON.parse(readText(journalOf(pending)));
		journal.state = "pending";
		writeJson(journalOf(pending), journal);
		const pendingReport = reportOf(pending, { settings: settingsOf() });
		assert.equal(pendingReport.status, "incomplete");
		assert.equal(pendingReport.journal, "pending");
		assert.ok(pendingReport.remediation.some((line: string) => line.includes("did not finish")));
	});

	await check("extra egm-* agents and a wider tool allowlist are drift, never install_verified", () => {
		const extra = makeWorld("extra-agent");
		install(extra);
		writeFile(path.join(extra.agentDir, "agents/egm-synthesizer.md"), "---\nname: egm-synthesizer\n---\n\nSneaky.\n");
		const report = reportOf(extra, { settings: settingsOf() });
		assert.equal(report.status, "drifted");
		assert.deepEqual(report.loose.extraAgents, ["agents/egm-synthesizer.md"]);
		assert.ok(report.remediation.some((line: string) => line.includes("egm-synthesizer.md")));

		const widened = makeWorld("wide-tools");
		install(widened);
		const agentFile = path.join(widened.agentDir, "agents/egm-design.md");
		writeFile(agentFile, readText(agentFile).replace("tools: read, search, find", "tools: read, search, find, bash"));
		const wide = reportOf(widened, { settings: settingsOf() });
		assert.equal(wide.status, "drifted");
		const mismatch = wide.loose.mismatches.find((entry: { path: string }) => entry.path === "agents/egm-design.md");
		assert.ok(mismatch);
		assert.match(mismatch.detail ?? "", /expected read, search, find/);
	});

	await check("settings and task visibility gate the report (task-hidden refusal)", () => {
		const world = makeWorld("gate");
		install(world);
		const depthZero = reportOf(world, { settings: settingsOf({ "task.maxRecursionDepth": 0 }) });
		assert.equal(depthZero.status, "blocked");
		assert.ok(depthZero.remediation.some((line: string) => line.includes("maxRecursionDepth")));
		const disabledReviewer = reportOf(world, { settings: settingsOf({ "task.disabledAgents": ["egm-design"] }) });
		assert.equal(disabledReviewer.status, "blocked");
		assert.deepEqual(disabledReviewer.session.disabledReviewers, ["egm-design"]);
		const disabledSkill = reportOf(world, { settings: settingsOf({ disabledExtensions: ["skill:egm-review", "skill:other"] }) });
		assert.equal(disabledSkill.status, "blocked");
		assert.deepEqual(disabledSkill.session.disabledSkills, ["egm-review"]);

		const noTools = reportOf(world, { settings: settingsOf(), argv: ["gjc", "--tools", "read,edit"] });
		assert.equal(noTools.task.state, "absent");
		assert.equal(noTools.task.source, "launch_tools");
		assert.equal(noTools.status, "blocked");
		assert.ok(noTools.remediation.some((line: string) => line.includes("--tools")));
		assert.equal(reportOf(world, { settings: settingsOf(), argv: ["gjc", "--no-tools"] }).task.state, "absent");

		const child = reportOf(world, { settings: settingsOf(), entries: [{ type: "session_init", tools: ["read", "search"] }] });
		assert.equal(child.task.state, "absent");
		assert.equal(child.task.source, "session_tools");
		assert.equal(child.status, "blocked");
		assert.ok(child.remediation.some((line: string) => line.includes("child session")));
		const available = reportOf(world, { settings: settingsOf(), entries: [{ type: "session_init", tools: ["read", "task"] }] });
		assert.equal(available.task.state, "listed");
		assert.equal(available.status, "install_verified");
		const unobservable = reportOf(world, { settings: settingsOf(), entries: [] });
		assert.equal(unobservable.task.state, "unobservable");
		assert.equal(unobservable.status, "install_verified");
	});

	await check("the installer resolves the home agent directory and writes only inside the disposable HOME", () => {
		const world = makeWorld("home-default");
		const homeAgent = path.join(world.home, ".gjc", "agent");
		const result = installer.installEgm({
			source: { kind: "local", dir: world.source },
			pinnedFiles: world.pinned,
			home: world.home,
			env: {},
			gjcCommand: world.fakeGjc,
			gjcEnv: gjcEnvAt(world, homeAgent),
		});
		assert.equal(result.agentDir.source, "home");
		assert.equal(result.agentDir.dir, homeAgent);
		assert.ok(result.bundleRoot.startsWith(world.home));
		assert.equal(core.readPluginRecord(homeAgent).status, "registered");
		const report = core.readinessReport({ home: world.home, env: {}, pinnedFiles: world.pinned, settings: settingsOf(), argv: ["gjc"] });
		assert.equal(report.status, "install_verified");
	});

	await check("the manifest stays tool-only, matches the adapter description and wires the install script", () => {
		const manifest = JSON.parse(readText(path.join(plugin, "gajae-plugin.json")));
		assert.equal(manifest.kind, "gajae-code-plugin");
		assert.equal(manifest.name, "egm");
		assert.match(manifest.version, /^0\.0\.\d+$/);
		assert.deepEqual(manifest.tools.map((entry: { name: string }) => entry.name), ["egm_readiness"]);
		for (const entry of manifest.tools) assert.ok(existsSync(path.join(plugin, entry.path)), entry.path);
		for (const key of ["mcps", "mcpServers", "hooks", "subskills", "skills", "agents", "commands"]) assert.equal(Object.hasOwn(manifest, key), false, key);
		const tracked = readdirSync(plugin);
		for (const forbidden of ["skills", "agents", "resources"]) assert.ok(!tracked.includes(forbidden), forbidden);
		const packageJson = JSON.parse(readText(path.join(plugin, "..", "package.json")));
		assert.equal(packageJson.scripts["egm:install"], "bun egm/scripts/install.ts");
	});

	await check("the CLI refuses bad sources and flags without touching the agent directory", () => {
		const world = makeWorld("cli");
		const cliAgent = path.join(world.home, "cli-agent");
		const run = (args: string[], pathValue: string = path.dirname(world.fakeGjc)) =>
			spawnSync(process.execPath, ["--no-env-file", installScript, ...args], {
				encoding: "utf8",
				timeout: 60000,
				env: {
					HOME: world.home,
					TMPDIR: path.join(root, "tmp"),
					PATH: pathValue,
					LC_ALL: "C",
					GJC_CODING_AGENT_DIR: cliAgent,
					EGM_FAKE_GJC_STATE: world.gjcState,
					EGM_VERIFY_CHILD: "1",
				},
			});
		const mismatch = run(["--source", world.source]);
		assert.equal(mismatch.status, 1, mismatch.stderr);
		assert.match(`${mismatch.stderr}${mismatch.stdout}`, /source_mismatch/);
		assert.equal(existsSync(cliAgent), false, "a refused CLI run writes nothing");

		const noGit = makeWorld("cli-no-git");
		rmSync(path.join(noGit.source, ".git"), { recursive: true, force: true });
		const unknown = spawnSync(process.execPath, ["--no-env-file", installScript, "--source", noGit.source], {
			encoding: "utf8",
			timeout: 60000,
			env: {
				HOME: noGit.home,
				TMPDIR: path.join(root, "tmp"),
				PATH: path.dirname(noGit.fakeGjc),
				LC_ALL: "C",
				GJC_CODING_AGENT_DIR: path.join(noGit.home, "cli-agent"),
				EGM_FAKE_GJC_STATE: noGit.gjcState,
				EGM_VERIFY_CHILD: "1",
			},
		});
		assert.equal(unknown.status, 1, unknown.stderr);
		assert.match(`${unknown.stderr}${unknown.stdout}`, /source_commit_unknown/);

		const emptyPath = path.join(world.home, "empty-bin");
		mkdirSync(emptyPath, { recursive: true });
		const noGjc = run(["--source", world.source], emptyPath);
		assert.equal(noGjc.status, 2, noGjc.stderr);
		assert.match(`${noGjc.stderr}${noGjc.stdout}`, /gjc_missing/);

		const help = run(["--help"]);
		assert.equal(help.status, 0);
		assert.match(help.stdout, /--source <dir>/);
		for (const flag of ["--bogus", "--pin", "--force"]) {
			const rejected = run([flag, "x"]);
			assert.equal(rejected.status, 2, `${flag}: ${rejected.stderr}`);
			assert.match(rejected.stderr, new RegExp(`unknown argument ${flag}`));
		}
	});

	if (tool) {
		await check("the generated tool registers with the manifest and keeps the exact-{} contract", async () => {
			const manifest = JSON.parse(readText(path.join(plugin, "gajae-plugin.json")));
			assert.equal(tool.name, "egm_readiness");
			assert.equal(tool.label, "EGM Readiness");
			assert.equal(tool.description, manifest.tools[0].description, "update egm/gajae-plugin.json tools[0].description to the adapter description");
			assert.deepEqual(tool.parameters, {});
			for (const params of [{ unexpected: "value" }, [], null, "{}"]) {
				const result = await tool.execute("call-bad", params);
				assert.equal(result.isError, true, JSON.stringify(params));
				assert.match(result.content[0].text, /^egm_readiness: invalid_input/);
			}
		});

		await check("the tool reports the registered bundle present and absent, and writes nothing", async () => {
			const world = makeWorld("tool");
			const sharedAgent = path.join(os.homedir(), ".gjc", "agent");
			const result = installer.installEgm({
				source: { kind: "local", dir: world.source },
				pinnedFiles: world.pinned,
				home: os.homedir(),
				env: {},
				gjcCommand: world.fakeGjc,
				gjcEnv: gjcEnvAt(world, sharedAgent),
			});
			assert.equal(result.agentDir.dir, sharedAgent);
			const before = readdirSync(os.homedir());
			const seen: string[] = [];
			const defaults = settingsOf();
			const settings = { get: (key: string) => (seen.push(key), defaults.get(key)) };
			const output = await tool.execute("call-1", {}, undefined, { settings, sessionManager: { getBranch: () => [] } });
			assert.notEqual(output.isError, true);
			const body = output.content[0].text;
			assert.match(body, /^egm_readiness: drifted\n/);
			assert.match(body, /agent dir: .*\(home\)/);
			assert.match(body, /journal: complete/);
			assert.match(body, /plugin bundle: registered/);
			assert.match(body, /bundle: drifted \(0\/31 match the pin\)/);
			assert.match(body, /reviewers: 8 read-only/);
			assert.match(body, /skills: \/skill:egm-brainstorm/);
			const report = JSON.parse(body.trimEnd().split("\n").at(-1)).report;
			assert.equal(report.pinned.files, 31);
			assert.equal(report.loose.agents.checked, 8);
			assert.equal(report.plugin.status, "registered");
			assert.equal(report.plugin.enabled, true);
			assert.equal(report.plugin.manifestHash, sourceSurface().manifestHash);
			assert.deepEqual(seen.sort(), ["disabledExtensions", "task.disabledAgents", "task.maxRecursionDepth"]);
			assert.deepEqual(readdirSync(os.homedir()), before, "the tool must not create files in HOME");
			const unobserved = await tool.execute("call-2", {}, undefined, { sessionManager: { getBranch: () => [] } });
			assert.match(unobserved.content[0].text, /session: unobserved/);
			const throwing = await tool.execute("call-3", {}, undefined, { settings, sessionManager: { getBranch: () => { throw new Error("blocked"); } } });
			assert.match(throwing.content[0].text, /task: unobservable/);
			rmSync(path.join(sharedAgent, "gjc-plugins", "registry.json"), { force: true });
			const absent = await tool.execute("call-4", {}, undefined, { settings, sessionManager: { getBranch: () => [] } });
			assert.match(absent.content[0].text, /plugin bundle: missing/);
			const absentReport = JSON.parse(absent.content[0].text.trimEnd().split("\n").at(-1)).report;
			assert.equal(absentReport.plugin.status, "missing");
			assert.equal(absentReport.status, "drifted");
		});
	}

	console.log(JSON.stringify({ kind: "api-package-test-report", cases, failures, realNetworkCalls: 0 }));
	console.log(failures ? `FAILED ${failures}/${cases}` : `ALL PASS (${cases} cases)`);
	process.exitCode = failures || cases === 0 ? 1 : 0;
}
