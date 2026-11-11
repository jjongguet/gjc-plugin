// egm plugin core — an offline, read-only readiness report for the
// Elephant-Goldfish Model (EGM) skills installed through GJC's own marketplace
// path. EGM itself is never bundled, fetched, installed or run here: GJC 0.20.0
// installs it natively (`gjc plugin marketplace add` + `gjc plugin install
// egm@egm`), and this module only reads the registries GJC wrote, compares the
// installed runtime files with the pinned release, and reads the session
// settings that can switch the Goldfish subagents off.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const EGM_REPOSITORY = "https://github.com/google/elephant-goldfish-model";
export const EGM_PINNED_TAG = "v0.1.1";
export const EGM_PINNED_COMMIT = "dea7761de06ce5b51c177ebb9bba0469f24af5a4";
export const EGM_MARKETPLACE = "egm";
export const EGM_PLUGIN_ID = "egm@egm";
/** Plugin-owned location of the pinned upstream checkout the local marketplace points at. */
export const EGM_PINNED_SOURCE = `~/.gjc-plugin/egm/elephant-goldfish-model-${EGM_PINNED_TAG}`;
export const EGM_INSTALL_COMMANDS = [
	`git clone --depth 1 --branch ${EGM_PINNED_TAG} ${EGM_REPOSITORY} ${EGM_PINNED_SOURCE}`,
	`gjc plugin marketplace add ${EGM_PINNED_SOURCE}`,
	`gjc plugin install ${EGM_PLUGIN_ID}`,
];
export const EGM_UNINSTALL_COMMANDS = [`gjc plugin uninstall ${EGM_PLUGIN_ID}`, `gjc plugin marketplace remove ${EGM_MARKETPLACE}`];
/** GJC loads marketplace skills under the plugin name, so `egm-review` registers as `egm:egm-review`. */
export const EGM_SKILLS = [
	"egm-brainstorm",
	"egm-draft",
	"egm-review",
	"egm-review-loop",
	"egm-resolve",
	"egm-bootstrap",
	"egm-drift-report",
] as const;
/** Persona file under `agents/` → the `name` GJC registers as a `task` agent. */
export const EGM_PERSONAS: ReadonlyArray<readonly [string, string]> = [
	["agents/bootstrap_orchestrator.md", "egm-bootstrap-orchestrator"],
	["agents/codebase_details.md", "egm-codebase-details"],
	["agents/comprehension.md", "egm-comprehension"],
	["agents/design_critic.md", "egm-design"],
	["agents/implementation_readiness.md", "egm-implementation-readiness"],
	["agents/inventive_catalyst.md", "egm-inventive-catalyst"],
	["agents/structural.md", "egm-structural"],
	["agents/style.md", "egm-style"],
	["agents/synthesizer.md", "egm-synthesizer"],
	["agents/zoom_out.md", "egm-zoom-out"],
];
/**
 * sha256 of every file the skills read at run time, at the pinned tag
 * (`git show v0.1.1:<path> | shasum -a 256`). Skill tests, icons and the
 * Codex-only `agents/openai.yaml` are not runtime inputs and are not pinned.
 */
export const EGM_PINNED_FILES: Readonly<Record<string, string>> = {
	"agents/bootstrap_orchestrator.md": "5c2fa484754f8d582669500d16d5728fe95daff8bd964f8e7f09142c6a666bfc",
	"agents/codebase_details.md": "d80db07e449b57b3b3776d1401cca72a54b6b65a0ab218b86f9064ee4b8167bc",
	"agents/comprehension.md": "974f4972f717dc7b102a9b1407b3a625749149f2ae905727241e919f43cc3fa5",
	"agents/design_critic.md": "cee6294735ce2bd4fea19245852b6eb07cbe8ede7e72a4bfc829f586e4a39d0f",
	"agents/implementation_readiness.md": "1f6aa61cfe7cb86dc94943ab3b3fd339e5baba533937198fd10edb06dfa64e8f",
	"agents/inventive_catalyst.md": "e766638298dfa42859172df62d1c0a4faa9ade143bcfc92837b5843a684e1da4",
	"agents/structural.md": "f0d4fe6faee4e388366b7d653fe353a9b09f45ca1bf5dae29280e351cda7da87",
	"agents/style.md": "9330780622baaef8dc683ea78efb3ff8e4583e3dde7ab6092b84df50e8c9ea58",
	"agents/synthesizer.md": "44d1288c03ec829acafd8af0226ce1d0603f4cf04e9f8438b5b36a451be8f8b6",
	"agents/zoom_out.md": "adc9d7b7db4c304866e61d5e5e446502231abe188ce64656939305e07ae7995f",
	"resources/README.md": "109c89969542dd5919c3f50f1bcf569c7668a505bff10439044135526e1a6b01",
	"resources/document_standards/feature-spec-standard.md": "8e9821e7bfd7c074dd1cec7ba02e3ea09a3fd32e35b91a1463a37c1ee3b9d6a4",
	"resources/document_standards/heilmeier-standard.md": "a23bc354a5651bd00d817409a72ebcb7536c249e2038c13255ce89f49f138174",
	"resources/document_standards/implementation-readiness-standard.md": "49ef3a44228a14c774ec606477293be6467b232a9e4af9e031a3cad64ed87642",
	"resources/document_standards/re-implementation-standard.md": "421aacbf5e9a0d4c5b794edfa4cac333f8cc67bc4cf0e3717efcad4f827e6e46",
	"resources/document_standards/zoom-out-standard.md": "0a01013bd363a8d744f8372b65495892360d7339e4e35c767003ae38f48e6799",
	"resources/execution_instructions.md": "fa47f016cd8636e3b386faf402d40ac1a3dc987db5bc158cc299db4bf34492c8",
	"skills/egm-bootstrap/SKILL.md": "4a63ecf9db2a512f10da122b3767fdd1d501ae28d2d1db9865534557fe0f961b",
	"skills/egm-bootstrap/references/templates.md": "f49793727cccbd72afdc4a0569a1d8e8138e943d2fc9b0df772b09deaca80437",
	"skills/egm-bootstrap/references/worker-return.schema.json": "f18a3822f60a0f117e1582cccac78a90cf14154afca811d4e81ea3fe562e52a5",
	"skills/egm-brainstorm/SKILL.md": "a660b44e3cfdd23da8e8ecff2ff1aa01accb96ad2a823b67c90f89fc188ec7e8",
	"skills/egm-draft/SKILL.md": "2c107ecd3751635df1eedef261c7e14a79e7bb9429d20753c3f0df5834e1dbec",
	"skills/egm-draft/references/design_doc.md": "309246562d1ffd801b3a2cd81f5cbc767d36f7530046f6ac681b6db40c6c7965",
	"skills/egm-drift-report/SKILL.md": "c000ffe2e77a9fe74ee6915b314e1547337c95c79a19014c44fd976dc6511476",
	"skills/egm-resolve/SKILL.md": "fe12b8712f88b51780d817e6c8f0ac5e7a29961ee111d0fd19bfc2f738d2f531",
	"skills/egm-review-loop/SKILL.md": "844b174055d32a7394f1096964a289987272109fff531a080fc9c3c9acef26fa",
	"skills/egm-review/SKILL.md": "a17ee3b983bcd77000099bedf014db84a7a6e6f3245c712acd84a4f119b6b58c",
};

const REGISTRY_MAX_BYTES = 1024 * 1024;
const RUNTIME_FILE_MAX_BYTES = 4 * 1024 * 1024;
const MISMATCH_LIMIT = 12;
const SHA_RE = /^[0-9a-f]{40}$/;

export function marketplacesPath(home: string = os.homedir()): string {
	return path.join(home, ".gjc", "marketplaces.json");
}

export function installedPluginsPath(home: string = os.homedir()): string {
	return path.join(home, ".gjc", "plugins", "installed_plugins.json");
}

type ReadResult = { status: "ok"; text: string } | { status: "missing" | "unreadable" };

/** One bounded read; a file larger than the bound is unreadable, not truncated. */
function readBounded(file: string, maxBytes: number): ReadResult {
	try {
		const info = statSync(file);
		if (!info.isFile() || info.size > maxBytes) return { status: "unreadable" };
		return { status: "ok", text: readFileSync(file, "utf8") };
	} catch (error) {
		return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
	}
}

function readJsonRecord(file: string): { status: "ok"; value: Record<string, unknown> } | { status: "missing" | "unreadable" } {
	const read = readBounded(file, REGISTRY_MAX_BYTES);
	if (read.status !== "ok") return read;
	try {
		const value = JSON.parse(read.text) as unknown;
		if (value === null || typeof value !== "object" || Array.isArray(value)) return { status: "unreadable" };
		return { status: "ok", value: value as Record<string, unknown> };
	} catch {
		return { status: "unreadable" };
	}
}

/** Resolve the commit a checkout's HEAD names, from `.git` files only (no git process). */
export function readCheckoutCommit(dir: string): string | null {
	const gitDir = path.join(dir, ".git");
	const head = readBounded(path.join(gitDir, "HEAD"), 4096);
	if (head.status !== "ok") return null;
	const value = head.text.trim();
	if (SHA_RE.test(value)) return value;
	const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(value)?.[1];
	if (!ref || ref.split("/").includes("..")) return null;
	const loose = readBounded(path.join(gitDir, ref), 4096);
	if (loose.status === "ok" && SHA_RE.test(loose.text.trim())) return loose.text.trim();
	const packed = readBounded(path.join(gitDir, "packed-refs"), REGISTRY_MAX_BYTES);
	if (packed.status !== "ok") return null;
	for (const line of packed.text.split("\n")) {
		const [sha, name] = line.trim().split(" ");
		if (name === ref && SHA_RE.test(sha ?? "")) return sha;
	}
	return null;
}

export type MarketplaceReport = {
	status: "registered" | "missing" | "unreadable";
	sourceType: string | null;
	sourceUri: string | null;
	commit: string | null;
	commitMatchesPin: boolean | null;
};

export function readMarketplace(home: string): MarketplaceReport {
	const none = { sourceType: null, sourceUri: null, commit: null, commitMatchesPin: null };
	const registry = readJsonRecord(marketplacesPath(home));
	if (registry.status !== "ok") return { status: registry.status, ...none };
	const list = registry.value.marketplaces;
	if (!Array.isArray(list)) return { status: "unreadable", ...none };
	const entry = list.find(item => item !== null && typeof item === "object" && (item as Record<string, unknown>).name === EGM_MARKETPLACE) as
		| Record<string, unknown>
		| undefined;
	if (!entry) return { status: "missing", ...none };
	const sourceType = typeof entry.sourceType === "string" ? entry.sourceType : null;
	const sourceUri = typeof entry.sourceUri === "string" ? entry.sourceUri : null;
	const catalogPath = typeof entry.catalogPath === "string" ? entry.catalogPath : null;
	// A local marketplace is read in place; a git marketplace is the clone that holds the catalog.
	const checkout = sourceType === "local" ? sourceUri : catalogPath ? path.dirname(catalogPath) : null;
	const commit = checkout ? readCheckoutCommit(checkout) : null;
	return { status: "registered", sourceType, sourceUri, commit, commitMatchesPin: commit === null ? null : commit === EGM_PINNED_COMMIT };
}

export type InstallationReport = {
	status: "installed" | "disabled" | "missing" | "unreadable";
	scope: "user";
	version: string | null;
	installPath: string | null;
};

export function readInstallation(home: string): InstallationReport {
	const none = { scope: "user" as const, version: null, installPath: null };
	const registry = readJsonRecord(installedPluginsPath(home));
	if (registry.status !== "ok") return { status: registry.status, ...none };
	const plugins = registry.value.plugins;
	if (plugins === null || typeof plugins !== "object" || Array.isArray(plugins)) return { status: "unreadable", ...none };
	const entries = (plugins as Record<string, unknown>)[EGM_PLUGIN_ID];
	if (entries === undefined) return { status: "missing", ...none };
	if (!Array.isArray(entries)) return { status: "unreadable", ...none };
	const entry = entries.find(item => item !== null && typeof item === "object" && (item as Record<string, unknown>).scope === "user") as
		| Record<string, unknown>
		| undefined;
	if (!entry) return { status: "missing", ...none };
	const installPath = typeof entry.installPath === "string" && path.isAbsolute(entry.installPath) ? entry.installPath : null;
	if (installPath === null) return { status: "unreadable", ...none };
	const version = typeof entry.version === "string" ? entry.version : null;
	return { status: entry.enabled === false ? "disabled" : "installed", scope: "user", version, installPath };
}

export type FileStatus = "match" | "differs" | "missing" | "unreadable";
export type ContentReport = {
	status: "pinned" | "drifted" | "incomplete" | "absent";
	checked: number;
	matched: number;
	mismatches: Array<{ path: string; status: Exclude<FileStatus, "match"> }>;
	mismatchesOmitted: number;
};

export function checkContent(installPath: string | null, pinned: Readonly<Record<string, string>> = EGM_PINNED_FILES): {
	report: ContentReport;
	present: Set<string>;
} {
	const present = new Set<string>();
	const entries = Object.entries(pinned);
	if (installPath === null) {
		return { report: { status: "absent", checked: entries.length, matched: 0, mismatches: [], mismatchesOmitted: 0 }, present };
	}
	const mismatches: ContentReport["mismatches"] = [];
	let matched = 0;
	let incomplete = false;
	for (const [relative, digest] of entries) {
		let status: FileStatus;
		try {
			const info = statSync(path.join(installPath, relative));
			if (!info.isFile() || info.size > RUNTIME_FILE_MAX_BYTES) status = "unreadable";
			else {
				const actual = createHash("sha256").update(readFileSync(path.join(installPath, relative))).digest("hex");
				status = actual === digest ? "match" : "differs";
			}
		} catch (error) {
			status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
		}
		if (status === "match" || status === "differs") present.add(relative);
		if (status === "match") matched++;
		else {
			if (status !== "differs") incomplete = true;
			mismatches.push({ path: relative, status });
		}
	}
	const status: ContentReport["status"] = incomplete ? "incomplete" : mismatches.length > 0 ? "drifted" : "pinned";
	return {
		report: {
			status,
			checked: entries.length,
			matched,
			mismatches: mismatches.slice(0, MISMATCH_LIMIT),
			mismatchesOmitted: Math.max(0, mismatches.length - MISMATCH_LIMIT),
		},
		present,
	};
}

/** The read-only session settings facade GJC passes to tool execution. */
export type SettingsReader = { get(key: string): unknown };

export type SessionReport = {
	status: "observed" | "unobserved";
	marketplaceProvider: "enabled" | "disabled" | null;
	taskTool: "available" | "disabled" | null;
	maxRecursionDepth: number | null;
	disabledPersonas: string[];
	disabledSkills: string[];
};

function readSetting(settings: SettingsReader, key: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: settings.get(key) };
	} catch {
		return { ok: false };
	}
}

const stringList = (value: unknown): string[] | null =>
	value === undefined || value === null ? [] : Array.isArray(value) && value.every(item => typeof item === "string") ? value : null;

export function readSession(settings: SettingsReader | undefined): SessionReport {
	const unobserved: SessionReport = {
		status: "unobserved",
		marketplaceProvider: null,
		taskTool: null,
		maxRecursionDepth: null,
		disabledPersonas: [],
		disabledSkills: [],
	};
	if (!settings || typeof settings.get !== "function") return unobserved;
	const providers = readSetting(settings, "disabledProviders");
	const depth = readSetting(settings, "task.maxRecursionDepth");
	const agents = readSetting(settings, "task.disabledAgents");
	const extensions = readSetting(settings, "disabledExtensions");
	if (!providers.ok || !depth.ok || !agents.ok || !extensions.ok) return unobserved;
	const providerList = stringList(providers.value);
	const agentList = stringList(agents.value);
	const extensionList = stringList(extensions.value);
	// GJC defaults an unset depth to 2; the task tool exists at the top level while depth > 0 (or < 0, unlimited).
	const maxRecursionDepth = depth.value === undefined || depth.value === null ? 2 : depth.value;
	if (providerList === null || agentList === null || extensionList === null || typeof maxRecursionDepth !== "number" || !Number.isFinite(maxRecursionDepth)) {
		return unobserved;
	}
	const personaNames = new Set(EGM_PERSONAS.map(([, name]) => name));
	return {
		status: "observed",
		marketplaceProvider: providerList.includes("claude-plugins") ? "disabled" : "enabled",
		taskTool: maxRecursionDepth === 0 ? "disabled" : "available",
		maxRecursionDepth,
		disabledPersonas: agentList.filter(name => personaNames.has(name)),
		disabledSkills: EGM_SKILLS.filter(name => extensionList.includes(`skill:${EGM_MARKETPLACE}:${name}`)),
	};
}

export type ReadinessStatus = "ready" | "unverified" | "blocked" | "drifted" | "incomplete" | "not_installed";

export type ReadinessReport = {
	status: ReadinessStatus;
	pinned: { repository: string; tag: string; commit: string; files: number };
	marketplace: MarketplaceReport;
	installation: InstallationReport;
	content: ContentReport;
	skills: Array<{ name: string; invocation: string; present: boolean }>;
	personas: Array<{ name: string; file: string; present: boolean }>;
	session: SessionReport;
	installCommands: string[];
	remediation: string[];
	notes: string[];
};

export type ReadinessInput = {
	home?: string;
	settings?: SettingsReader;
	pinnedFiles?: Readonly<Record<string, string>>;
};

export function readinessReport(input: ReadinessInput = {}): ReadinessReport {
	const home = input.home ?? os.homedir();
	const pinnedFiles = input.pinnedFiles ?? EGM_PINNED_FILES;
	const marketplace = readMarketplace(home);
	const installation = readInstallation(home);
	const usable = installation.status === "installed" || installation.status === "disabled" ? installation.installPath : null;
	const { report: content, present } = checkContent(usable, pinnedFiles);
	const session = readSession(input.settings);

	const skills = EGM_SKILLS.map(name => ({
		name: `${EGM_MARKETPLACE}:${name}`,
		invocation: `/skill:${EGM_MARKETPLACE}:${name}`,
		present: present.has(`skills/${name}/SKILL.md`),
	}));
	const personas = EGM_PERSONAS.map(([file, name]) => ({ name, file, present: present.has(file) }));

	const remediation: string[] = [];
	const reinstall = `Reinstall from the pinned ${EGM_PINNED_TAG} checkout: ${[...EGM_UNINSTALL_COMMANDS, ...EGM_INSTALL_COMMANDS].join(" && ")}`;
	if (installation.status === "missing") remediation.push(`Install the pinned EGM release: ${EGM_INSTALL_COMMANDS.join(" && ")}`);
	if (installation.status === "unreadable") remediation.push(`${installedPluginsPath(home)} is unreadable or malformed; inspect it with \`gjc plugin list --json\`.`);
	if (installation.status === "disabled") remediation.push(`${EGM_PLUGIN_ID} is installed but disabled (enabled: false); re-enable it before use.`);
	if (content.status === "incomplete" || content.status === "drifted") remediation.push(reinstall);
	if (installation.status !== "missing" && marketplace.status === "missing") {
		remediation.push(`The ${EGM_MARKETPLACE} marketplace is not registered, so an upgrade or reinstall cannot resolve it: gjc plugin marketplace add ${EGM_PINNED_SOURCE}`);
	}
	if (session.marketplaceProvider === "disabled") remediation.push('Remove "claude-plugins" from disabledProviders; it hides every marketplace skill and agent, EGM included.');
	if (session.taskTool === "disabled") remediation.push("task.maxRecursionDepth is 0, so no session has the task tool and egm-review stops by design; set it to 1 or more (GJC default 2).");
	if (session.disabledPersonas.length > 0) remediation.push(`Remove ${session.disabledPersonas.join(", ")} from task.disabledAgents; the review skills spawn these personas by name.`);
	if (session.disabledSkills.length > 0) remediation.push(`Remove ${session.disabledSkills.map(name => `skill:${EGM_MARKETPLACE}:${name}`).join(", ")} from disabledExtensions.`);

	const blocked =
		installation.status === "disabled" ||
		session.marketplaceProvider === "disabled" ||
		session.taskTool === "disabled" ||
		session.disabledPersonas.length > 0 ||
		session.disabledSkills.length > 0;
	let status: ReadinessStatus;
	if (installation.status === "missing" || installation.status === "unreadable") status = "not_installed";
	else if (content.status === "incomplete" || content.status === "absent") status = "incomplete";
	else if (blocked) status = "blocked";
	else if (content.status === "drifted") status = "drifted";
	else if (session.status !== "observed") status = "unverified";
	else status = "ready";

	const notes = [
		"Offline readiness only: reads GJC's plugin registries, the installed files and the session settings. It never installs, fetches or runs EGM, and a ready report does not prove that a review ran or that reviewers were isolated.",
		`Skills register as ${EGM_MARKETPLACE}:<name>; invoke them as /skill:${EGM_MARKETPLACE}:<name> (for example /skill:${EGM_MARKETPLACE}:egm-review). The bare /skill:egm-review form is not a registered command.`,
		"Goldfish reviewers are task subagents: they start without the parent conversation, but GJC still gives them the user SYSTEM.md, RULES.md and always-apply rules. State review assumptions as explicit review criteria. Launch flags such as --tools are not visible to this tool.",
	];
	if (marketplace.sourceType !== null && marketplace.sourceType !== "local") {
		notes.push(`The ${EGM_MARKETPLACE} marketplace is a ${marketplace.sourceType} source, which follows the upstream default branch rather than ${EGM_PINNED_TAG}; the content check above is the pin authority.`);
	}

	return {
		status,
		pinned: { repository: EGM_REPOSITORY, tag: EGM_PINNED_TAG, commit: EGM_PINNED_COMMIT, files: Object.keys(pinnedFiles).length },
		marketplace,
		installation,
		content,
		skills,
		personas,
		session,
		installCommands: [...EGM_INSTALL_COMMANDS],
		remediation,
		notes,
	};
}
