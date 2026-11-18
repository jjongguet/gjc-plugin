// egm plugin core — the pinned Elephant-Goldfish Model (EGM) release, the GJC
// adapters generated from it, and an offline, read-only readiness report.
//
// GJC 0.20.0 refuses `skills` and `agents` in a bundle manifest, so EGM's
// skills and reviewer personas live on GJC's loose user surfaces. The checkout
// script `scripts/install.ts` writes three things under the agent directory:
// the unmodified upstream files (`egm/<tag>/`), a composed copy of each skill
// (`skills/egm-<name>/SKILL.md`: the upstream text plus a short GJC preamble)
// and a composed agent definition for each reviewer (`agents/egm-<name>.md`:
// the upstream persona plus a `tools` allowlist). This module owns the pin, the
// compose rules both the installer and the report use, and the report itself.
// It never fetches, installs or runs EGM and never contacts the network.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const EGM_REPOSITORY = "https://github.com/google/elephant-goldfish-model";
export const EGM_PINNED_TAG = "v0.1.1";
export const EGM_PINNED_COMMIT = "dea7761de06ce5b51c177ebb9bba0469f24af5a4";
/** The one install entry, run from a gjc-plugin checkout root. */
export const EGM_INSTALL_COMMAND = "bun run egm:install";
export const EGM_SKILLS = [
	"egm-brainstorm",
	"egm-draft",
	"egm-review",
	"egm-review-loop",
	"egm-resolve",
	"egm-bootstrap",
	"egm-drift-report",
] as const;
/** Persona file under `agents/` → the `name` its frontmatter declares. */
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
 * Upstream gives these two roles write and spawn tools. They stay unmodified in
 * the bundle and are not registered as GJC agents: the parent session runs the
 * bootstrap orchestrator inline and dispatches reviewers itself.
 */
export const EGM_UNREGISTERED_PERSONAS: readonly string[] = ["agents/bootstrap_orchestrator.md", "agents/synthesizer.md"];
/** The eight Goldfish reviewers registered as read-only GJC agents. */
export const EGM_REVIEWERS: ReadonlyArray<readonly [string, string]> = EGM_PERSONAS.filter(([file]) => !EGM_UNREGISTERED_PERSONAS.includes(file));
/** Built-in tools a reviewer may use; GJC appends `yield` itself. */
export const EGM_REVIEWER_TOOLS = ["read", "search", "find"] as const;
/**
 * sha256 of every upstream file the installer copies, at the pinned tag
 * (`git show v0.1.1:<path> | shasum -a 256`): the files the skills read at run
 * time, the three documents every skill names, and the license.
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
	"docs/harnesses.md": "fbb15af14f2233436b474f5d186acb6a2df7a8ac743fb4993eff0bdabc56c060",
	"docs/codex.md": "91be58251456904c2542ee1299d1096b569cbc08afdcf24c671eb09b32d09bfc",
	"docs/claude.md": "7c8be13c296e582467dec6141a18387168ffc1e32d4e0ece4c29b2af5c631350",
	LICENSE: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
};

const JOURNAL_MAX_BYTES = 1024 * 1024;
const RUNTIME_FILE_MAX_BYTES = 4 * 1024 * 1024;
const AGENT_HEADER_MAX_BYTES = 8 * 1024;
const MISMATCH_LIMIT = 12;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

// ---- agent directory ----

export type AgentDirSource = "host" | "GJC_CODING_AGENT_DIR" | "PI_CODING_AGENT_DIR" | "home";
export type AgentDirResolution = { dir: string; source: AgentDirSource };
export type AgentDirInput = {
	env?: Readonly<Record<string, string | undefined>>;
	home?: string;
	/** The host's own resolver, when the caller can reach it (a plugin tool can; the installer cannot). */
	host?: () => unknown;
};

/**
 * The agent directory `gjc` 0.20.0 reads: the host resolver when available,
 * otherwise `GJC_CODING_AGENT_DIR`, then `PI_CODING_AGENT_DIR`, then
 * `<home>/.gjc/agent`. `GJC_AGENT_DIR` alone is not honoured by `gjc` and is
 * not consulted here.
 */
export function resolveAgentDir(input: AgentDirInput = {}): AgentDirResolution {
	if (input.host) {
		try {
			const dir = input.host();
			if (typeof dir === "string" && path.isAbsolute(dir)) return { dir, source: "host" };
		} catch {
			// fall through to the environment chain
		}
	}
	const env = input.env ?? process.env;
	for (const name of ["GJC_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const) {
		const value = env[name];
		if (typeof value === "string" && path.isAbsolute(value)) return { dir: value, source: name };
	}
	return { dir: path.join(input.home ?? os.homedir(), ".gjc", "agent"), source: "home" };
}

export const bundleRoot = (agentDir: string): string => path.join(agentDir, "egm", EGM_PINNED_TAG);
export const journalPath = (agentDir: string): string => path.join(bundleRoot(agentDir), "bundle.json");

// ---- adapters (byte contract shared by the installer and the report) ----

const SKILL_ADAPTER = [
	"## GJC (gajae-code) adapter",
	"",
	"Resolve paths against four roots. `<bundleRoot>`: `agents/`, `resources/`, and `docs/harnesses.md`, `docs/codex.md`, `docs/claude.md` — also when written `../../docs/…` or `${CLAUDE_PLUGIN_ROOT}/docs/…`. `<skillDir>`: `references/`. Project working directory: user files, outputs, and every other `docs/…` path. Pass absolute paths to every reviewer you dispatch.",
	"GJC registers eight Goldfish reviewers by name: `egm-codebase-details`, `egm-comprehension`, `egm-design`, `egm-implementation-readiness`, `egm-inventive-catalyst`, `egm-structural`, `egm-style`, `egm-zoom-out`. Dispatch them directly with `task`; never call `task` with `egm-synthesizer` or `egm-bootstrap-orchestrator`.",
].join("\n");
const DELEGATION_CLAUSE =
	"For this skill only: use direct dispatch instead of the synthesizer — split the work into reviewer assignments yourself and keep the report writing in this session. If `task` is not among your tools, activate it with `search_tool_bm25` (query such as `subagent delegation task`); stop only when it cannot be activated.";
const SKILL_CLAUSES: Readonly<Record<string, string>> = {
	"egm-brainstorm": DELEGATION_CLAUSE,
	"egm-review": DELEGATION_CLAUSE,
	"egm-review-loop": DELEGATION_CLAUSE,
	"egm-bootstrap":
		"For this skill only: run the orchestrator role inline in this session, sequentially, from `<bundleRoot>/agents/bootstrap_orchestrator.md`; do not delegate. This skill runs with or without `task`.",
};
const AGENT_ADAPTER = [
	"GJC adapter — EGM bundle root: `<bundleRoot>`. Resolve `resources/` and `agents/` against it.",
	"Read whole files with `:raw` or a line range; GJC's `read` otherwise returns a bounded excerpt.",
	"If a required document standard or persona file cannot be read, report an incomplete review.",
].join("\n");
const FRONTMATTER_OPEN = Buffer.from("---\n");
const FRONTMATTER_CLOSE = Buffer.from("\n---\n");

/** Upstream bytes through the closing `---` line of the frontmatter, and everything after it. */
export function splitFrontmatter(upstream: Uint8Array): { header: Buffer; body: Buffer } | null {
	const bytes = Buffer.from(upstream.buffer, upstream.byteOffset, upstream.byteLength);
	if (!bytes.subarray(0, FRONTMATTER_OPEN.length).equals(FRONTMATTER_OPEN)) return null;
	const close = bytes.indexOf(FRONTMATTER_CLOSE, FRONTMATTER_OPEN.length - 1);
	if (close === -1) return null;
	const end = close + FRONTMATTER_CLOSE.length;
	return { header: bytes.subarray(0, end), body: bytes.subarray(end) };
}

/** The GJC preamble of one skill: the common block plus that skill's clause, if it has one. */
export function skillAdapterBlock(skill: string, root: string, skillDir: string): string {
	const clause = SKILL_CLAUSES[skill];
	return (clause ? `${SKILL_ADAPTER}\n${clause}` : SKILL_ADAPTER).replaceAll("<bundleRoot>", root).replaceAll("<skillDir>", skillDir);
}

export const agentAdapterBlock = (root: string): string => AGENT_ADAPTER.replaceAll("<bundleRoot>", root);

/** Loose skill = upstream frontmatter + GJC preamble + upstream body, byte for byte. */
export function composeSkill(upstream: Uint8Array, skill: string, root: string, skillDir: string): Buffer {
	const parts = splitFrontmatter(upstream);
	if (!parts) throw new Error(`egm: ${skill} has no frontmatter to compose from`);
	return Buffer.concat([parts.header, Buffer.from(`\n${skillAdapterBlock(skill, root, skillDir)}\n`), parts.body]);
}

/** Loose agent = upstream frontmatter with the `tools` allowlist + GJC adapter block + upstream body, byte for byte. */
export function composeAgent(upstream: Uint8Array, root: string): Buffer {
	const parts = splitFrontmatter(upstream);
	if (!parts) throw new Error("egm: persona has no frontmatter to compose from");
	const open = parts.header.subarray(0, parts.header.length - FRONTMATTER_CLOSE.length + 1);
	return Buffer.concat([open, Buffer.from(`tools: ${EGM_REVIEWER_TOOLS.join(", ")}\n---\n\n${agentAdapterBlock(root)}\n`), parts.body]);
}

export type LooseFile = {
	/** Path under the agent directory. */
	relative: string;
	kind: "skill" | "reference" | "agent";
	/** Path of the upstream file it is derived from, under the bundle root. */
	source: string;
	/** Skill name, or the registered agent name. */
	name: string;
};

/** Every file the installer writes outside the bundle root: 7 skills, their references, 8 agents. */
export function looseFiles(pinned: Readonly<Record<string, string>> = EGM_PINNED_FILES): LooseFile[] {
	const files: LooseFile[] = [];
	for (const skill of EGM_SKILLS) {
		const source = `skills/${skill}/SKILL.md`;
		files.push({ relative: source, kind: "skill", source, name: skill });
		for (const reference of Object.keys(pinned).filter(entry => entry.startsWith(`skills/${skill}/references/`))) {
			files.push({ relative: reference, kind: "reference", source: reference, name: skill });
		}
	}
	for (const [source, name] of EGM_REVIEWERS) files.push({ relative: `agents/${name}.md`, kind: "agent", source, name });
	return files;
}

/** The exact bytes of one loose file, derived from the upstream bytes of its source. */
export function renderLoose(file: LooseFile, agentDir: string, upstream: Uint8Array): Buffer {
	const root = bundleRoot(agentDir);
	if (file.kind === "skill") return composeSkill(upstream, file.name, root, path.join(agentDir, "skills", file.name));
	if (file.kind === "agent") return composeAgent(upstream, root);
	return Buffer.from(upstream.buffer, upstream.byteOffset, upstream.byteLength);
}

// ---- install journal ----

/** Ownership record the installer writes first (`pending`) and finalizes last (`complete`). */
export type Journal = {
	schemaVersion: 1;
	state: "pending" | "complete";
	tag: string;
	commit: string;
	/** Bundle-relative path → sha256 of the upstream file. */
	bundle: Record<string, string>;
	/** Agent-directory-relative path → sha256 of the written file. */
	loose: Record<string, string>;
};
export type JournalRead = { status: "complete" | "pending"; journal: Journal } | { status: "missing" | "unreadable" };

const isDigestMap = (value: unknown): value is Record<string, string> =>
	value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value as object).every(digest => typeof digest === "string" && DIGEST_RE.test(digest));

export function readJournal(agentDir: string): JournalRead {
	let text: string;
	try {
		const info = statSync(journalPath(agentDir));
		if (!info.isFile() || info.size > JOURNAL_MAX_BYTES) return { status: "unreadable" };
		text = readFileSync(journalPath(agentDir), "utf8");
	} catch (error) {
		return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
	}
	try {
		const value = JSON.parse(text) as Partial<Journal> | null;
		if (value === null || typeof value !== "object" || Array.isArray(value)) return { status: "unreadable" };
		if (value.schemaVersion !== 1 || (value.state !== "pending" && value.state !== "complete")) return { status: "unreadable" };
		if (typeof value.tag !== "string" || typeof value.commit !== "string" || !isDigestMap(value.bundle) || !isDigestMap(value.loose)) return { status: "unreadable" };
		return { status: value.state, journal: value as Journal };
	} catch {
		return { status: "unreadable" };
	}
}

// ---- installed content ----

export type FileStatus = "match" | "differs" | "missing" | "unreadable";
export type Mismatch = { path: string; status: Exclude<FileStatus, "match">; detail?: string };
export type ContentStatus = "pinned" | "drifted" | "incomplete" | "absent";

function readBounded(file: string): { status: "ok"; bytes: Buffer } | { status: "missing" | "unreadable" } {
	try {
		const info = statSync(file);
		if (!info.isFile() || info.size > RUNTIME_FILE_MAX_BYTES) return { status: "unreadable" };
		return { status: "ok", bytes: readFileSync(file) };
	} catch (error) {
		return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
	}
}

const isDirectory = (dir: string): boolean => {
	try {
		return statSync(dir).isDirectory();
	} catch {
		return false;
	}
};

const summarize = (mismatches: Mismatch[]) => ({ mismatches: mismatches.slice(0, MISMATCH_LIMIT), mismatchesOmitted: Math.max(0, mismatches.length - MISMATCH_LIMIT) });
const contentStatus = (mismatches: Mismatch[]): ContentStatus => (mismatches.some(entry => entry.status !== "differs") ? "incomplete" : mismatches.length > 0 ? "drifted" : "pinned");

export type BundleReport = { status: ContentStatus; checked: number; matched: number; mismatches: Mismatch[]; mismatchesOmitted: number };

/** Compare every upstream file under the bundle root with the pin. */
export function checkBundle(agentDir: string, pinned: Readonly<Record<string, string>> = EGM_PINNED_FILES): BundleReport {
	const entries = Object.entries(pinned);
	const root = bundleRoot(agentDir);
	if (!isDirectory(root)) return { status: "absent", checked: entries.length, matched: 0, mismatches: [], mismatchesOmitted: 0 };
	const mismatches: Mismatch[] = [];
	for (const [relative, digest] of entries) {
		const read = readBounded(path.join(root, relative));
		if (read.status !== "ok") mismatches.push({ path: relative, status: read.status });
		else if (sha256Hex(read.bytes) !== digest) mismatches.push({ path: relative, status: "differs" });
	}
	return { status: contentStatus(mismatches), checked: entries.length, matched: entries.length - mismatches.length, ...summarize(mismatches) };
}

/** The `name` and `tools` an agent file's frontmatter declares (line-based; no YAML dependency). */
export function agentFrontmatter(bytes: Uint8Array): { name: string | null; tools: string[] | null } {
	const header = splitFrontmatter(bytes)?.header.toString("utf8") ?? "";
	const field = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(header)?.[1]?.trim() ?? null;
	const tools = field("tools");
	const list = tools === null ? null : tools.replace(/^\[|\]$/g, "").split(",").map(entry => entry.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean);
	return { name: field("name")?.replace(/^["']|["']$/g, "") ?? null, tools: list };
}

const allowlistDetail = (tools: string[] | null): string =>
	tools === null ? "no tools allowlist" : `tools: ${tools.join(", ") || "(empty)"} — expected ${EGM_REVIEWER_TOOLS.join(", ")}`;

export type LooseReport = {
	status: ContentStatus;
	skills: { checked: number; matched: number };
	references: { checked: number; matched: number };
	agents: { checked: number; matched: number };
	/** Agent files that register an `egm-*` name without being one of the installer's eight. */
	extraAgents: string[];
	mismatches: Mismatch[];
	mismatchesOmitted: number;
};

/**
 * Compare every loose file with the bytes the compose rules produce from the
 * bundle, and look for agent files that register an `egm-*` name outside the
 * eight reviewers (they would run without the allowlist).
 */
export function checkLoose(agentDir: string, pinned: Readonly<Record<string, string>> = EGM_PINNED_FILES): LooseReport {
	const files = looseFiles(pinned);
	const count = (kind: LooseFile["kind"]) => ({ checked: files.filter(file => file.kind === kind).length, matched: 0 });
	const totals = { skill: count("skill"), reference: count("reference"), agent: count("agent") };
	const mismatches: Mismatch[] = [];
	let present = 0;
	for (const file of files) {
		const installed = readBounded(path.join(agentDir, file.relative));
		if (installed.status !== "ok") {
			mismatches.push({ path: file.relative, status: installed.status });
			continue;
		}
		present++;
		const upstream = readBounded(path.join(bundleRoot(agentDir), file.source));
		if (upstream.status !== "ok") {
			mismatches.push({ path: file.relative, status: "unreadable", detail: `its source ${file.source} is ${upstream.status} in the bundle` });
			continue;
		}
		let expected: Buffer | null = null;
		try {
			expected = renderLoose(file, agentDir, upstream.bytes);
		} catch {
			// a bundle file without frontmatter cannot be composed; the bundle check reports it
		}
		if (expected?.equals(installed.bytes)) totals[file.kind].matched++;
		else mismatches.push({ path: file.relative, status: "differs", ...(file.kind === "agent" ? { detail: allowlistDetail(agentFrontmatter(installed.bytes).tools) } : {}) });
	}
	const expectedAgents = new Set(files.filter(file => file.kind === "agent").map(file => path.basename(file.relative)));
	const extraAgents: string[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(path.join(agentDir, "agents")).filter(name => name.endsWith(".md")).sort();
	} catch {
		// no agents directory: nothing registers an egm-* name
	}
	for (const name of names) {
		if (expectedAgents.has(name)) continue;
		let registered: string | null = null;
		try {
			registered = agentFrontmatter(readFileSync(path.join(agentDir, "agents", name)).subarray(0, AGENT_HEADER_MAX_BYTES)).name;
		} catch {
			// unreadable: fall back to the file name
		}
		if ((registered ?? name).startsWith("egm-")) extraAgents.push(`agents/${name}`);
	}
	const status: ContentStatus = present === 0 && extraAgents.length === 0 ? "absent" : contentStatus(mismatches) === "pinned" && extraAgents.length > 0 ? "drifted" : contentStatus(mismatches);
	return { status, skills: totals.skill, references: totals.reference, agents: totals.agent, extraAgents, ...summarize(mismatches) };
}

// ---- session ----

/** The read-only session settings facade GJC passes to tool execution. */
export type SettingsReader = { get(key: string): unknown };

export type SessionReport = {
	status: "observed" | "unobserved";
	maxRecursionDepth: number | null;
	delegation: "enabled" | "disabled" | null;
	disabledReviewers: string[];
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
	const unobserved: SessionReport = { status: "unobserved", maxRecursionDepth: null, delegation: null, disabledReviewers: [], disabledSkills: [] };
	if (!settings || typeof settings.get !== "function") return unobserved;
	const depth = readSetting(settings, "task.maxRecursionDepth");
	const agents = readSetting(settings, "task.disabledAgents");
	const extensions = readSetting(settings, "disabledExtensions");
	if (!depth.ok || !agents.ok || !extensions.ok) return unobserved;
	const agentList = stringList(agents.value);
	const extensionList = stringList(extensions.value);
	// GJC defaults an unset depth to 2; `task` exists at the top level while depth is not 0 (negative is unlimited).
	const maxRecursionDepth = depth.value === undefined || depth.value === null ? 2 : depth.value;
	if (agentList === null || extensionList === null || typeof maxRecursionDepth !== "number" || !Number.isFinite(maxRecursionDepth)) return unobserved;
	const reviewerNames = new Set(EGM_REVIEWERS.map(([, name]) => name));
	return {
		status: "observed",
		maxRecursionDepth,
		delegation: maxRecursionDepth === 0 ? "disabled" : "enabled",
		disabledReviewers: agentList.filter(name => reviewerNames.has(name)),
		disabledSkills: EGM_SKILLS.filter(name => extensionList.includes(`skill:${name}`)),
	};
}

/**
 * What a plugin tool can see of the session's `task` tool. GJC gives a tool no
 * tool list, so availability in an ordinary session is not observable. Two
 * things are: the tool list of a `task` child session (its `session_init`
 * entry) and an explicit `--tools` / `--no-tools` launch list.
 */
export type TaskVisibility = {
	state: "listed" | "absent" | "unobservable";
	source: "session_tools" | "launch_tools" | null;
};

/** The explicit tool list a `gjc` process was launched with, or null when it has none. */
export function launchToolList(argv: readonly string[]): string[] | null {
	let list: string[] | null = null;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--no-tools") list = [];
		else if (arg === "--tools" && typeof argv[index + 1] === "string") list = argv[++index].split(",");
		else if (arg.startsWith("--tools=")) list = arg.slice("--tools=".length).split(",");
	}
	return list === null ? null : list.map(name => name.trim().toLowerCase()).filter(Boolean);
}

/** The tool names recorded in a session's `session_init` entry (written for `task` child sessions). */
export function sessionToolList(entries: unknown): string[] | null {
	if (!Array.isArray(entries)) return null;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; tools?: unknown } | null;
		if (entry && typeof entry === "object" && entry.type === "session_init" && Array.isArray(entry.tools) && entry.tools.every(name => typeof name === "string")) {
			return entry.tools as string[];
		}
	}
	return null;
}

export function taskVisibility(input: { argv?: readonly string[]; entries?: unknown } = {}): TaskVisibility {
	const session = sessionToolList(input.entries);
	if (session) return { state: session.includes("task") ? "listed" : "absent", source: "session_tools" };
	const launch = input.argv ? launchToolList(input.argv) : null;
	if (launch) return { state: launch.includes("task") ? "listed" : "absent", source: "launch_tools" };
	return { state: "unobservable", source: null };
}

// ---- report ----

/**
 * `install_verified` is the healthy status: the install matches the pin and no
 * observed setting or tool list rules out the reviewers. There is no `ready`:
 * a plugin tool cannot observe that `task` is available in an ordinary session.
 */
export type ReadinessStatus = "install_verified" | "unverified" | "blocked" | "drifted" | "incomplete" | "not_installed";

export type ReadinessReport = {
	status: ReadinessStatus;
	pinned: { repository: string; tag: string; commit: string; files: number };
	agentDir: AgentDirResolution;
	journal: JournalRead["status"];
	bundle: BundleReport;
	loose: LooseReport;
	skills: Array<{ name: string; invocation: string }>;
	reviewers: Array<{ name: string; file: string }>;
	session: SessionReport;
	task: TaskVisibility;
	installCommand: string;
	remediation: string[];
	notes: string[];
};

export type ReadinessInput = AgentDirInput & {
	settings?: SettingsReader;
	pinnedFiles?: Readonly<Record<string, string>>;
	/** The host process arguments (`process.argv`). */
	argv?: readonly string[];
	/** The session entries (`ctx.sessionManager.getEntries()`). */
	entries?: unknown;
};

export function readinessReport(input: ReadinessInput = {}): ReadinessReport {
	const pinnedFiles = input.pinnedFiles ?? EGM_PINNED_FILES;
	const agentDir = resolveAgentDir(input);
	const journal = readJournal(agentDir.dir);
	const bundle = checkBundle(agentDir.dir, pinnedFiles);
	const loose = checkLoose(agentDir.dir, pinnedFiles);
	const session = readSession(input.settings);
	const task = taskVisibility(input);

	const absent = journal.status === "missing" && bundle.status === "absent" && loose.status === "absent";
	const incomplete = journal.status !== "complete" || bundle.status === "incomplete" || bundle.status === "absent" || loose.status === "incomplete" || loose.status === "absent";
	const drifted = bundle.status === "drifted" || loose.status === "drifted";
	const blocked = session.delegation === "disabled" || session.disabledReviewers.length > 0 || session.disabledSkills.length > 0 || task.state === "absent";
	let status: ReadinessStatus;
	if (absent) status = "not_installed";
	else if (incomplete) status = "incomplete";
	else if (blocked) status = "blocked";
	else if (drifted) status = "drifted";
	else if (session.status !== "observed") status = "unverified";
	else status = "install_verified";

	const remediation: string[] = [];
	const fromCheckout = `from a gjc-plugin checkout root: ${EGM_INSTALL_COMMAND}`;
	if (absent) remediation.push(`Install EGM ${EGM_PINNED_TAG} ${fromCheckout}`);
	else if (journal.status === "pending") remediation.push(`An install did not finish; run it again ${fromCheckout}`);
	else if (incomplete || bundle.status === "drifted" || loose.mismatches.length > 0) {
		remediation.push(`Reinstall ${fromCheckout} (it rewrites the files it owns and refuses to overwrite any it did not write)`);
	}
	for (const file of loose.extraAgents) {
		remediation.push(`Remove ${file} from the agent directory: it registers an egm-* agent outside the eight read-only reviewers, without the tools allowlist.`);
	}
	if (session.delegation === "disabled") remediation.push("task.maxRecursionDepth is 0, so no session has the task tool and the review skills stop by design; set it to 1 or more (GJC default 2).");
	if (session.disabledReviewers.length > 0) remediation.push(`Remove ${session.disabledReviewers.join(", ")} from task.disabledAgents; the review skills dispatch these reviewers by name.`);
	if (session.disabledSkills.length > 0) remediation.push(`Remove ${session.disabledSkills.map(name => `skill:${name}`).join(", ")} from disabledExtensions.`);
	if (task.state === "absent") {
		remediation.push(
			task.source === "launch_tools"
				? "This gjc process was launched with a tool list that has no task tool, so reviewers cannot be dispatched; start a session without --tools/--no-tools or add task to the list."
				: "This is a task child session without the task tool; run the EGM skills from the top-level session.",
		);
	}

	const notes = [
		"Offline readiness only: reads the files under the agent directory, the session settings, this process's launch arguments and the session's own entries. It never installs, fetches or runs EGM, and a healthy report does not prove that a review ran.",
		`Invoke the skills as /skill:<name> (for example /skill:egm-review design_draft.md). The review skills dispatch the eight registered reviewers through the task tool, which an ordinary session activates through tool search.`,
		"A plugin tool cannot see a session's tool set, so there is no ready status: only an explicit --tools/--no-tools launch list and a task child's own tool list are observable, and either one without task is reported as blocked.",
		"Reviewers are read-only for the built-in edit, write and bash tools. Tools from installed plugins are still offered to them, and the user SYSTEM.md, RULES.md and always-apply rules still reach them; they start without the parent conversation.",
	];
	if (agentDir.source !== "host") {
		notes.push("The agent directory was resolved from the environment, not by the host; a session started with another agent directory reads a different install.");
	}

	return {
		status,
		pinned: { repository: EGM_REPOSITORY, tag: EGM_PINNED_TAG, commit: EGM_PINNED_COMMIT, files: Object.keys(pinnedFiles).length },
		agentDir,
		journal: journal.status,
		bundle,
		loose,
		skills: EGM_SKILLS.map(name => ({ name, invocation: `/skill:${name}` })),
		reviewers: EGM_REVIEWERS.map(([file, name]) => ({ name, file })),
		session,
		task,
		installCommand: EGM_INSTALL_COMMAND,
		remediation,
		notes,
	};
}
