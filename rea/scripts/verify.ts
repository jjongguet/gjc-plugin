#!/usr/bin/env bun
/**
 * Offline generated-package acceptance for the rea plugin.
 *
 * Hermetic: all command probes are injected fakes and every config/skill
 * fixture lives in a temporary isolated tree with a temporary HOME for
 * journal writes. The user's real ~/.gjc config, real binaries and the
 * network are never touched. The generated tool is exercised with its real
 * probes only for structural assertions.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(import.meta.url);
const plugin = path.resolve(path.dirname(script), "..");
if (process.argv[2] !== "--isolated") {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rea-offline-")));
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
				REA_VERIFY_CHILD: "1",
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
	assert.equal(process.env.REA_VERIFY_CHILD, "1");
	assert.equal(os.homedir(), path.join(root, "home"));
	let cases = 0;
	let failures = 0;
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
	const fakePi = {
		cwd: path.join(root, "cwd"),
		typebox: { Type: { Object: (fields) => fields, String: (options) => options ?? {}, Optional: (schema) => schema } },
	};

	const core = await import(pathToFileURL(path.join(plugin, "lib/readiness.ts")).href);
	const tool = (await import(pathToFileURL(path.join(plugin, "tools/rea-readiness.ts")).href)).default(fakePi);
	const sharedResults = await import(pathToFileURL(path.join(plugin, "../shared/lib/results.ts")).href);

	const home = path.join(root, "home");
	const cwd = path.join(root, "cwd");
	const userCfg = path.join(home, ".gjc", "agent", "mcp.json");
	const skillFile = path.join(home, ".gjc", "agent", "skills", "rea", "SKILL.md");
	const writeJson = (file, value) => {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
	};
	const observed = (line) => () => ({ status: "observed", line });
	const absent = () => ({ status: "missing", line: null });
	const probeOf = (map) => (command) => (map[command] ? map[command]() : absent());
	const fullMachine = { node: observed("v24.15.0"), npx: observed("11.10.0"), bun: observed("1.4.0"), bunx: observed("1.4.0") };

	await check("lib exposes only the intended readiness surface", () => {
		const exported = Object.keys(core).sort();
		assert.deepEqual(
			exported,
			[
				"REA_CLI_COMMAND",
				"REA_MCP_ADD_COMMAND",
				"REA_PINNED_VERSION",
				"REA_PROBE_TIMEOUT_MS",
				"REA_SERVER_NAME",
				"REA_SKILL_INSTALL_COMMAND",
				"nodeVersionSatisfies",
				"parseNodeVersion",
				"probeCommand",
				"projectMcpConfigPath",
				"readinessReport",
				"readRegistration",
				"userMcpConfigPath",
				"userSkillPath",
			].sort(),
		);
		assert.equal(core.REA_PINNED_VERSION, "6.4.0");
	});

	await check("manifest stays tool-only with no platform-quarantined surfaces", () => {
		const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8"));
		assert.equal(manifest.kind, "gajae-code-plugin");
		assert.equal(manifest.name, "rea");
		assert.match(manifest.version, /^0\.0\.\d+$/);
		assert.deepEqual(
			manifest.tools.map((entry) => entry.name),
			["rea_readiness"],
		);
		for (const entry of manifest.tools) assert.ok(existsSync(path.join(plugin, entry.path)), entry.path);
		for (const key of ["mcps", "mcpServers", "hooks", "subskills", "skills", "agents", "commands"]) {
			assert.equal(Object.hasOwn(manifest, key), false, `${key} must stay absent`);
		}
	});

	await check("tool registers with the manifest contract", () => {
		assert.equal(tool.name, "rea_readiness");
		assert.equal(tool.label, "REA Readiness");
		assert.equal(typeof tool.execute, "function");
		assert.ok(tool.parameters !== undefined);
	});

	await check("Node engine gate matches the pinned REA range", () => {
		assert.deepEqual(core.parseNodeVersion("v22.19.0"), [22, 19, 0]);
		assert.equal(core.parseNodeVersion("garbage"), null);
		assert.equal(core.nodeVersionSatisfies([22, 19, 0]), true);
		assert.equal(core.nodeVersionSatisfies([22, 18, 9]), false);
		assert.equal(core.nodeVersionSatisfies([24, 11, 0]), true);
		assert.equal(core.nodeVersionSatisfies([24, 10, 0]), false);
		assert.equal(core.nodeVersionSatisfies([26, 0, 0]), true);
		assert.equal(core.nodeVersionSatisfies([23, 5, 0]), false);
		assert.equal(core.nodeVersionSatisfies([25, 9, 9]), false);
	});

	await check("registration classification distinguishes every disabled shape", () => {
		const registeredPath = path.join(root, "reg", "registered.json");
		writeJson(registeredPath, {
			mcpServers: { rea: { type: "stdio", command: "npx", args: ["-y", "rea-agents@6.4.0", "mcp"], timeout: 60000 } },
		});
		const registered = core.readRegistration(registeredPath, "user");
		assert.equal(registered.status, "registered");
		assert.equal(registered.timeoutDeclared, true);
		const noTimeout = path.join(root, "reg", "no-timeout.json");
		writeJson(noTimeout, { mcpServers: { rea: { type: "stdio", command: "npx" } } });
		assert.equal(core.readRegistration(noTimeout, "user").timeoutDeclared, false);
		const disabledPath = path.join(root, "reg", "disabled.json");
		writeJson(disabledPath, { mcpServers: { rea: {} }, disabledServers: ["rea"] });
		assert.equal(core.readRegistration(disabledPath, "user").status, "disabled");
		const disabledInline = path.join(root, "reg", "disabled-inline.json");
		writeJson(disabledInline, { mcpServers: { rea: { enabled: false } } });
		assert.equal(core.readRegistration(disabledInline, "user").status, "disabled");
		const autoloadOff = path.join(root, "reg", "autoload-off.json");
		writeJson(autoloadOff, { mcpServers: { rea: { autoload: false } } });
		assert.equal(core.readRegistration(autoloadOff, "user").status, "autoload_off");
		assert.equal(core.readRegistration(path.join(root, "reg", "missing.json"), "user").status, "missing");
		const unreadable = path.join(root, "reg", "unreadable.json");
		writeJson(unreadable, "{not json");
		assert.equal(core.readRegistration(unreadable, "user").status, "unreadable");
		assert.equal(core.readRegistration(path.join(root, "reg"), "user").status, "unreadable");
	});

	await check("a fully configured machine reports ready with no remediation", () => {
		writeJson(userCfg, {
			mcpServers: { rea: { type: "stdio", command: "npx", args: ["-y", "rea-agents@6.4.0", "mcp"], timeout: 60000 } },
		});
		mkdirSync(path.dirname(skillFile), { recursive: true });
		writeFileSync(skillFile, "# rea probe skill\n");
		const report = core.readinessReport({ cwd, home, probe: probeOf(fullMachine) });
		assert.equal(report.status, "ready");
		assert.equal(report.fetchChannel, "npx");
		assert.equal(report.skill.status, "installed");
		assert.equal(report.runtimes.node.satisfies, true);
		assert.deepEqual(report.remediation, []);
	});

	await check("an unregistered machine with runtimes and the installed skill reports ready", () => {
		rmSync(path.join(home, ".gjc"), { recursive: true, force: true });
		mkdirSync(path.dirname(skillFile), { recursive: true });
		writeFileSync(skillFile, "# rea probe skill\n");
		const report = core.readinessReport({ cwd, home, probe: probeOf(fullMachine) });
		assert.equal(report.status, "ready");
		assert.equal(report.fetchChannel, "npx");
		assert.equal(report.cliCommand, core.REA_CLI_COMMAND);
		assert.ok(report.registrations.every((registration) => registration.status === "missing"));
		assert.deepEqual(report.remediation, []);
	});

	await check("a bare machine reports not_ready with the exact remediation commands", () => {
		rmSync(path.join(home, ".gjc"), { recursive: true, force: true });
		const report = core.readinessReport({ cwd, home, probe: probeOf({}) });
		assert.equal(report.status, "not_ready");
		assert.equal(report.fetchChannel, "none");
		assert.equal(report.runtimes.node.satisfies, null);
		assert.equal(report.cliCommand, core.REA_CLI_COMMAND);
		assert.ok(!report.remediation.some((line) => line.includes("gjc mcp add")));
		assert.ok(report.remediation.some((line) => line.includes("Node.js")));
		assert.ok(report.remediation.some((line) => line.includes("skills/rea/SKILL.md")));
	});

	await check("unsupported Node and a disabled registration are reported, not repaired", () => {
		writeJson(userCfg, { mcpServers: { rea: {} }, disabledServers: ["rea"] });
		mkdirSync(path.dirname(skillFile), { recursive: true });
		writeFileSync(skillFile, "# rea probe skill\n");
		const report = core.readinessReport({
			cwd,
			home,
			probe: probeOf({ node: observed("v20.11.0"), bun: observed("1.4.0"), bunx: observed("1.4.0") }),
		});
		assert.equal(report.fetchChannel, "bunx");
		assert.equal(report.status, "not_ready");
		assert.equal(report.runtimes.node.satisfies, false);
		assert.ok(report.registrations.some((registration) => registration.status === "disabled"));
		assert.ok(report.remediation.some((line) => line.includes("does not satisfy")));
		assert.ok(!report.remediation.some((line) => line.includes("disabled")));
		assert.ok(!report.remediation.some((line) => line.includes("Install the GJC workflow skill")));
	});

	await check("a registration without a declared timeout gets the re-add hint", () => {
		writeJson(userCfg, { mcpServers: { rea: { type: "stdio", command: "npx" } } });
		mkdirSync(path.dirname(skillFile), { recursive: true });
		writeFileSync(skillFile, "# rea probe skill\n");
		const report = core.readinessReport({ cwd, home, probe: probeOf(fullMachine) });
		assert.equal(report.status, "ready");
		assert.ok(report.remediation.some((line) => line.includes("--timeout 60000")));
	});

	await check("execute reports structural readiness and journals one sanitized record", async () => {
		const result = await tool.execute("call-1", {});
		assert.notEqual(result.isError, true);
		const text = result.content[0].text;
		assert.match(text, /rea_readiness: (ready|not_ready)/);
		const lines = text.trimEnd().split("\n");
		const journalLine = JSON.parse(lines[lines.length - 1]);
		const reportLine = JSON.parse(lines[lines.length - 2]);
		assert.equal(journalLine.journalStorage.persisted, true, JSON.stringify(journalLine));
		assert.equal(reportLine.report.pinnedReaAgentsVersion, "6.4.0");
		assert.equal(reportLine.report.cliCommand, core.REA_CLI_COMMAND);
		const journal = path.join(root, "home", ".gjc-plugin", "rea", "journal", "v1");
		assert.ok(existsSync(path.join(journal, "inventory.json")), journal);
		const inventory = JSON.parse(readFileSync(path.join(journal, "inventory.json"), "utf8"));
		assert.ok(inventory.segments.length >= 1, "at least one journal segment");
		const segment = readFileSync(path.join(journal, inventory.segments[0].name), "utf8");
		assert.match(segment, /"operation":"rea_readiness"/);
		assert.ok(!segment.includes(root), "journal must not contain raw fixture paths");
	});

	await check("execute rejects any input other than exactly {}", async () => {
		for (const params of [{ unexpected: "value" }, [], null, "{}"]) {
			const result = await tool.execute("call-bad", params);
			assert.equal(result.isError, true, JSON.stringify(params));
			const text = result.content[0].text;
			assert.match(text, /^rea_readiness: invalid_input/);
			assert.ok(!text.includes("pinned rea-agents"), "no probe runs for rejected input");
			const lines = text.trimEnd().split("\n");
			assert.equal(JSON.parse(lines[lines.length - 1]).journalStorage.persisted, true, "a rejected call is still journaled");
		}
		const journal = path.join(root, "home", ".gjc-plugin", "rea", "journal", "v1");
		const inventory = JSON.parse(readFileSync(path.join(journal, "inventory.json"), "utf8"));
		const segments = inventory.segments.map(segment => readFileSync(path.join(journal, segment.name), "utf8")).join("");
		assert.match(segments, /"reason":"invalid_or_unavailable_input"/);
	});

	await check("generated surfaces are in sync with sources (rebuild is a no-op)", () => {
		const target = path.join(plugin, "tools/rea-readiness.ts");
		const before = readFileSync(target, "utf8");
		const build = spawnSync(process.execPath, [path.join(plugin, "scripts/build.mjs")], { encoding: "utf8", timeout: 60000 });
		assert.equal(build.status, 0, build.stderr);
		assert.equal(readFileSync(target, "utf8"), before, "tools/rea-readiness.ts drifted");
	});

	await check("shared results module accepts the rea plugin and operation", async () => {
		const append = sharedResults.appendPluginOutcome;
		assert.equal((await append("rea", { operation: "rea_readiness" })).persisted, true);
		assert.equal((await append("nonexistent-plugin", { operation: "rea_readiness" })).persisted, false);
	});

	await check("skill payload matches the pinned version and frontmatter contract", () => {
		const skill = readFileSync(path.join(plugin, "skills", "rea", "SKILL.md"), "utf8");
		assert.match(skill, /^---\r?\nname: rea\r?\ndescription: [^\n]+\r?\n---/);
		assert.ok(skill.includes(core.REA_CLI_COMMAND), "skill must carry the pinned CLI invocation");
		assert.ok(skill.includes(core.REA_MCP_ADD_COMMAND), "skill must carry the exact optional registration command");
		assert.ok(skill.includes(core.REA_PINNED_VERSION), "skill must reference the pinned rea-agents version");
	});

	console.log(JSON.stringify({ kind: "api-package-test-report", cases, failures, realNetworkCalls: 0 }));
	console.log(failures ? `FAILED ${failures}/${cases}` : `ALL PASS (${cases} cases)`);
	process.exitCode = failures || cases === 0 ? 1 : 0;
}
