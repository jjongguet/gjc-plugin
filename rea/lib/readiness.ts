// rea plugin core — an offline, read-only readiness report for the REA
// integration. The pinned rea-agents version lives here; this module never
// installs, registers, downloads or executes REA itself. The primary channel
// is the pinned CLI (REA_CLI_COMMAND); an MCP registration is optional for
// stateful MCP sessions and is reported, never required or repaired — GJC
// 0.18.5 refuses plugin-bundle stdio MCP servers off Linux and the bundle
// grammar cannot express a pinned `npx` command.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const REA_PINNED_VERSION = "6.4.0";
export const REA_SERVER_NAME = "rea";
export const REA_PROBE_TIMEOUT_MS = 5000;
export const REA_CLI_COMMAND = `npx -y rea-agents@${REA_PINNED_VERSION}`;
export const REA_MCP_ADD_COMMAND = `gjc mcp add ${REA_SERVER_NAME} --timeout 60000 -- npx -y rea-agents@${REA_PINNED_VERSION} mcp`;
export const REA_SKILL_INSTALL_COMMAND =
	"mkdir -p ~/.gjc/agent/skills/rea && cp rea/skills/rea/SKILL.md ~/.gjc/agent/skills/rea/SKILL.md";

export type ProbeStatus = "observed" | "missing" | "failed";

export type CommandProbeResult = { status: ProbeStatus; line: string | null };

export type Probe = (command: string, args: string[]) => CommandProbeResult;

function firstLine(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	for (const line of value.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return null;
}

/** One bounded local version probe. Never sets a shell and never touches the network. */
export const probeCommand: Probe = (command, args) => {
	try {
		const result = spawnSync(command, args, {
			encoding: "utf8",
			timeout: REA_PROBE_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code;
			return { status: code === "ENOENT" ? "missing" : "failed", line: null };
		}
		if (result.status !== 0) return { status: "failed", line: firstLine(result.stdout) ?? firstLine(result.stderr) };
		const line = firstLine(result.stdout);
		return line === null ? { status: "failed", line: null } : { status: "observed", line };
	} catch {
		return { status: "failed", line: null };
	}
};

export function parseNodeVersion(line: string | null): [number, number, number] | null {
	if (typeof line !== "string") return null;
	const match = line.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** REA engines: ^22.19.0 || ^24.11.0 || >=26.0.0 */
export function nodeVersionSatisfies(version: [number, number, number]): boolean {
	const [major, minor] = version;
	if (major === 22) return minor >= 19;
	if (major === 24) return minor >= 11;
	return major >= 26;
}

export type RegistrationStatus = "registered" | "disabled" | "autoload_off" | "missing" | "unreadable";
export type RegistrationReport = {
	scope: "user" | "project";
	path: string;
	status: RegistrationStatus;
	timeoutDeclared?: boolean;
};

export function userMcpConfigPath(home: string = os.homedir()): string {
	return path.join(home, ".gjc", "agent", "mcp.json");
}

export function projectMcpConfigPath(cwd: string = process.cwd()): string {
	return path.join(cwd, ".gjc", "mcp.json");
}

export function userSkillPath(home: string = os.homedir()): string {
	return path.join(home, ".gjc", "agent", "skills", REA_SERVER_NAME, "SKILL.md");
}

/** Classify one GJC MCP config file without repairing or rewriting it. */
export function readRegistration(configPath: string, scope: "user" | "project"): RegistrationReport {
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { scope, path: configPath, status: code === "ENOENT" ? "missing" : "unreadable" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { scope, path: configPath, status: "unreadable" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { scope, path: configPath, status: "unreadable" };
	}
	const record = parsed as Record<string, unknown>;
	const servers = record.mcpServers;
	const entry =
		servers !== null && typeof servers === "object" && !Array.isArray(servers)
			? (servers as Record<string, unknown>)[REA_SERVER_NAME]
			: undefined;
	if (entry === undefined) return { scope, path: configPath, status: "missing" };
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
		return { scope, path: configPath, status: "unreadable" };
	}
	const server = entry as Record<string, unknown>;
	const disabledByList =
		Array.isArray(record.disabledServers) && (record.disabledServers as unknown[]).includes(REA_SERVER_NAME);
	const timeoutDeclared = typeof server.timeout === "number" && Number.isFinite(server.timeout) && server.timeout > 0;
	if (server.enabled === false || disabledByList) return { scope, path: configPath, status: "disabled", timeoutDeclared };
	if (server.autoload === false) return { scope, path: configPath, status: "autoload_off", timeoutDeclared };
	return { scope, path: configPath, status: "registered", timeoutDeclared };
}

export type RuntimeReport = { status: ProbeStatus; line: string | null; satisfies?: boolean | null };

export type ReadinessReport = {
	pinnedReaAgentsVersion: string;
	status: "ready" | "not_ready";
	fetchChannel: "npx" | "bunx" | "none";
	runtimes: { node: RuntimeReport; npx: RuntimeReport; bun: RuntimeReport; bunx: RuntimeReport };
	registrations: RegistrationReport[];
	skill: { path: string; status: "installed" | "missing" };
	cliCommand: string;
	mcpAddCommand: string;
	skillInstallCommand: string;
	remediation: string[];
	notes: string[];
};

export type ReadinessInput = {
	cwd?: string;
	home?: string;
	probe?: Probe;
};

export function readinessReport(input: ReadinessInput = {}): ReadinessReport {
	const cwd = input.cwd ?? process.cwd();
	const home = input.home ?? os.homedir();
	const probe = input.probe ?? probeCommand;

	const node = probe("node", ["--version"]);
	const nodeVersion = node.status === "observed" ? parseNodeVersion(node.line) : null;
	const npx = probe("npx", ["--version"]);
	const bun = probe("bun", ["--version"]);
	const bunx = probe("bunx", ["--version"]);
	const runtimes: ReadinessReport["runtimes"] = {
		node: { status: node.status, line: node.line, satisfies: nodeVersion === null ? null : nodeVersionSatisfies(nodeVersion) },
		npx: { status: npx.status, line: npx.line },
		bun: { status: bun.status, line: bun.line },
		bunx: { status: bunx.status, line: bunx.line },
	};
	const fetchChannel: ReadinessReport["fetchChannel"] =
		runtimes.npx.status === "observed" ? "npx" : runtimes.bunx.status === "observed" ? "bunx" : "none";

	const registrations = [
		readRegistration(userMcpConfigPath(home), "user"),
		readRegistration(projectMcpConfigPath(cwd), "project"),
	];
	const skill = { path: userSkillPath(home), status: existsSync(userSkillPath(home)) ? "installed" : "missing" } as {
		path: string;
		status: "installed" | "missing";
	};

	const remediation: string[] = [];
	if (fetchChannel === "none") {
		remediation.push(
			"Install Node.js (>=22.19, or >=24.11, or >=26) with npm/npx, or Bun (bunx), so the pinned rea-agents package can be fetched.",
		);
	}
	if (runtimes.node.status === "observed" && runtimes.node.satisfies === false) {
		remediation.push(
			`Node ${runtimes.node.line ?? "?"} does not satisfy the REA engine range (^22.19 || ^24.11 || >=26); upgrade Node.`,
		);
	}
	for (const registration of registrations) {
		if (registration.status === "registered" && registration.timeoutDeclared === false) {
			remediation.push(
				`Server "${REA_SERVER_NAME}" in ${registration.path} declares no positive timeout; ordinary sessions wait only ~250ms for startup. Re-add with --timeout 60000 so the npx-backed server can connect.`,
			);
		}
		if (registration.status === "unreadable") {
			remediation.push(`MCP config ${registration.path} is unreadable or malformed; fix or remove it.`);
		}
	}
	if (skill.status === "missing") {
		remediation.push(
			`Install the GJC workflow skill (from the gjc-plugin checkout root): ${REA_SKILL_INSTALL_COMMAND}`,
		);
	}

	const nodeUnsupported = runtimes.node.satisfies === false;
	return {
		pinnedReaAgentsVersion: REA_PINNED_VERSION,
		status: fetchChannel !== "none" && !nodeUnsupported ? "ready" : "not_ready",
		fetchChannel,
		runtimes,
		registrations,
		skill,
		cliCommand: REA_CLI_COMMAND,
		mcpAddCommand: REA_MCP_ADD_COMMAND,
		skillInstallCommand: REA_SKILL_INSTALL_COMMAND,
		remediation,
		notes: [
			"Offline readiness only: no network, no install/registration, and no proof that the pinned package is cached or that any command runs.",
			`Primary channel: the pinned CLI (${REA_CLI_COMMAND} <command>). An MCP registration is optional and only relevant to sessions that opt into the stateful MCP tools; the authoritative capability list is the pinned package's own --llms manifest. Deep native analysis additionally needs a user-provided Hopper, Ghidra or IDA.`,
		],
	};
}
