// GENERATED FILE — do not edit by hand.
// Core: lib/catalog.ts + lib/usage.ts + lib/report.ts + adapter: src/audit.adapter.ts
// Rebuild with: bun skill-audit/scripts/build.mjs

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type AuditScope = "user" | "project";

export interface SkillRoot {
	scope: AuditScope;
	path: string;
	exists: boolean;
}

export interface InstalledSkill {
	/** Catalog id: the skill directory name. */
	name: string;
	path: string;
	root: string;
	scope: AuditScope;
	declaredName: string | null;
	description: string | null;
	contentHash: string;
}

export interface AuditCandidate {
	kind: "duplicate_name" | "identical_content" | "stale_replica";
	skills: string[];
	basis: string;
}

const STALE_REPLICA = /^(.+)\.stale-(\d{8})$/;

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** The two install scopes GJC loads skills from. Missing roots stay in the list, marked absent. */
export function skillRoots(home: string, cwd: string): SkillRoot[] {
	const roots: SkillRoot[] = [
		{ scope: "user", path: path.join(home, ".gjc", "agent", "skills"), exists: false },
		{ scope: "project", path: path.join(cwd, ".gjc", "skills"), exists: false },
	];
	for (const root of roots) root.exists = isDirectory(root.path);
	return roots;
}

/** Top-level `key: value` frontmatter fields. Unparseable headers yield no fields, never an exception. */
export function parseFrontmatter(text: string): Record<string, string> {
	const fields: Record<string, string> = {};
	if (!text.startsWith("---")) return fields;
	const end = text.indexOf("\n---", 3);
	if (end < 0) return fields;
	for (const line of text.slice(3, end).split("\n")) {
		if (!line.includes(":") || /^[ \t]/.test(line)) continue;
		const at = line.indexOf(":");
		fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return fields;
}

/** Every installed skill (a directory holding SKILL.md), sorted by catalog name then scope. */
export function discoverSkills(roots: readonly SkillRoot[]): InstalledSkill[] {
	const skills: InstalledSkill[] = [];
	for (const root of roots) {
		if (!root.exists) continue;
		let entries;
		try {
			entries = readdirSync(root.path, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const dir = path.join(root.path, entry.name);
			let text: string;
			try {
				text = readFileSync(path.join(dir, "SKILL.md"), "utf8");
			} catch {
				continue;
			}
			const frontmatter = parseFrontmatter(text);
			skills.push({
				name: entry.name,
				path: dir,
				root: root.path,
				scope: root.scope,
				declaredName: frontmatter.name || null,
				description: frontmatter.description || null,
				contentHash: createHash("sha256").update(text).digest("hex"),
			});
		}
	}
	skills.sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0,
	);
	return skills;
}

/** Duplicate, identical-content and dated (.stale-YYYYMMDD) replica candidates with their basis. */
export function duplicateCandidates(skills: readonly InstalledSkill[]): AuditCandidate[] {
	const candidates: AuditCandidate[] = [];
	const byDeclaredName = new Map<string, InstalledSkill[]>();
	const byContent = new Map<string, InstalledSkill[]>();
	for (const skill of skills) {
		const declared = skill.declaredName || skill.name;
		const named = byDeclaredName.get(declared);
		if (named) named.push(skill);
		else byDeclaredName.set(declared, [skill]);
		const sameContent = byContent.get(skill.contentHash);
		if (sameContent) sameContent.push(skill);
		else byContent.set(skill.contentHash, [skill]);
	}
	for (const [declared, group] of byDeclaredName) {
		if (group.length < 2) continue;
		candidates.push({
			kind: "duplicate_name",
			skills: group.map(skill => skill.name),
			basis: `${group.length} installed copies declare frontmatter name '${declared}' (${group.map(skill => `${skill.scope}:${skill.name}`).join(", ")})`,
		});
	}
	for (const group of byContent.values()) {
		if (group.length < 2) continue;
		candidates.push({
			kind: "identical_content",
			skills: group.map(skill => skill.name),
			basis: `${group.length} installed copies share byte-identical SKILL.md content`,
		});
	}
	const catalog = new Set(skills.map(skill => skill.name));
	for (const skill of skills) {
		const match = STALE_REPLICA.exec(skill.name);
		if (!match || !catalog.has(match[1])) continue;
		candidates.push({
			kind: "stale_replica",
			skills: [match[1], skill.name],
			basis: `dated copy '${skill.name}' of installed '${match[1]}' is still exposed to the catalog`,
		});
	}
	candidates.sort((a, b) =>
		a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.skills[0] < b.skills[0] ? -1 : a.skills[0] > b.skills[0] ? 1 : 0,
	);
	return candidates;
}

export type UsageStatus = "ok" | "degraded" | "unknown";

export interface SkillUsage {
	toolCalls: number;
	promptInvocations: number;
	toolCallSessions: Set<string>;
	promptSessions: Set<string>;
	lastUsedAt: number | null;
	lastUsedIso: string | null;
}

export interface UsageScan {
	status: UsageStatus;
	root: string;
	rootExists: boolean;
	transcripts: number;
	filesScanned: number;
	unreadableFiles: number;
	corruptLines: number;
	toolCalls: number;
	promptInvocations: number;
	firstFileMtime: string | null;
	lastFileMtime: string | null;
	skills: Map<string, SkillUsage>;
}

/** The only tool call that loads a skill body. `skill_discovery` lists metadata and is not a use. */
const SKILL_TOOL = "skill";

/** `/skill:<name>` typed by the owner: an explicit invocation that may not produce a tool call. */
const SLASH_INVOKE = /\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g;

const TOOL_MARKER = Buffer.from('"skill"');
const SLASH_MARKER = Buffer.from("/skill:");

/**
 * `root/**\/*.jsonl` transcripts plus a top-level `*.jsonl` for tolerance; managed internals are skipped.
 * Entries are collected by name, so a transcript path that cannot be read is counted as unreadable
 * (degraded coverage) instead of being silently absent.
 */
export function discoverTranscripts(root: string): string[] {
	const files: string[] = [];
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		const target = path.join(root, entry.name);
		if (entry.name.endsWith(".jsonl")) {
			files.push(target);
			continue;
		}
		if (!entry.isDirectory() || entry.name.includes("internal")) continue;
		let inner;
		try {
			inner = readdirSync(target, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const child of inner) {
			if (child.name.endsWith(".jsonl")) files.push(path.join(target, child.name));
		}
	}
	files.sort();
	return files;
}

/** The `name` argument of a `skill` tool call: a plain object or a JSON-encoded string. */
export function skillArgumentName(args: unknown): string | null {
	let value = args;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const name = (value as { name?: unknown }).name;
	if (typeof name !== "string") return null;
	const trimmed = name.trim();
	return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
}

export function slashSkillNames(text: string): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(SLASH_INVOKE)) {
		// Sentence punctuation after the name (`/skill:alpha.`) is not part of the name.
		const name = match[1].replace(/[._-]+$/, "");
		if (name.length > 0) names.push(name);
	}
	return names;
}

function usageFor(scan: UsageScan, name: string): SkillUsage {
	const existing = scan.skills.get(name);
	if (existing) return existing;
	const created: SkillUsage = {
		toolCalls: 0,
		promptInvocations: 0,
		toolCallSessions: new Set<string>(),
		promptSessions: new Set<string>(),
		lastUsedAt: null,
		lastUsedIso: null,
	};
	scan.skills.set(name, created);
	return created;
}

function touch(usage: SkillUsage, at: number, iso: string | null): void {
	if (Number.isNaN(at)) return;
	if (usage.lastUsedAt !== null && usage.lastUsedAt >= at) return;
	usage.lastUsedAt = at;
	usage.lastUsedIso = iso;
}

/**
 * Read-only scan of retained session transcripts. Missing or empty coverage is `unknown`, never
 * `ok`-with-zero: an absent log cannot distinguish "never used" from "not measured".
 */
export function scanUsage(root: string): UsageScan {
	const scan: UsageScan = {
		status: "unknown",
		root,
		rootExists: false,
		transcripts: 0,
		filesScanned: 0,
		unreadableFiles: 0,
		corruptLines: 0,
		toolCalls: 0,
		promptInvocations: 0,
		firstFileMtime: null,
		lastFileMtime: null,
		skills: new Map<string, SkillUsage>(),
	};
	try {
		scan.rootExists = statSync(root).isDirectory();
	} catch {
		scan.rootExists = false;
	}
	if (!scan.rootExists) return scan;

	const files = discoverTranscripts(root);
	scan.transcripts = files.length;
	for (const file of files) {
		let buffer: Buffer;
		try {
			buffer = readFileSync(file);
		} catch {
			scan.unreadableFiles++;
			continue;
		}
		scan.filesScanned++;
		try {
			const mtime = new Date(statSync(file).mtimeMs).toISOString();
			if (scan.firstFileMtime === null || mtime < scan.firstFileMtime) scan.firstFileMtime = mtime;
			if (scan.lastFileMtime === null || mtime > scan.lastFileMtime) scan.lastFileMtime = mtime;
		} catch {
			// A vanished file still counts as scanned text; only the window marker is lost.
		}
		if (!buffer.includes(TOOL_MARKER) && !buffer.includes(SLASH_MARKER)) continue;
		for (const line of buffer.toString("utf8").split("\n")) {
			if (!line.includes('"skill"') && !line.includes("/skill:")) continue;
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				if (line.trim()) scan.corruptLines++;
				continue;
			}
			if (!record || typeof record !== "object") continue;
			const entry = record as { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
			if (entry.type !== "message" || !entry.message) continue;
			const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
			const iso = typeof entry.timestamp === "string" ? entry.timestamp : null;
			const content = Array.isArray(entry.message.content) ? entry.message.content : [];
			for (const item of content) {
				if (!item || typeof item !== "object") continue;
				const block = item as { type?: unknown; name?: unknown; arguments?: unknown; text?: unknown };
				if (block.type === "toolCall" && typeof block.name === "string" && block.name.toLowerCase() === SKILL_TOOL) {
					const name = skillArgumentName(block.arguments);
					if (name === null) continue;
					const usage = usageFor(scan, name);
					usage.toolCalls++;
					usage.toolCallSessions.add(file);
					touch(usage, at, iso);
					scan.toolCalls++;
					continue;
				}
				if (entry.message.role === "user" && block.type === "text" && typeof block.text === "string") {
					for (const name of slashSkillNames(block.text)) {
						const usage = usageFor(scan, name);
						usage.promptInvocations++;
						usage.promptSessions.add(file);
						touch(usage, at, iso);
						scan.promptInvocations++;
					}
				}
			}
		}
	}
	scan.status =
		scan.transcripts === 0 ? "unknown" : scan.corruptLines > 0 || scan.unreadableFiles > 0 ? "degraded" : "ok";
	return scan;
}

export interface SkillAuditRow {
	name: string;
	installed: true;
	/** Install root; the owner's home directory is collapsed to `~` so the report stays committable. */
	source: string;
	scope: AuditScope;
	path: string;
	used_count: number | null;
	last_used: string | null;
	tool_calls: number | null;
	prompt_invocations: number | null;
	prompt_only_sessions: number | null;
	sessions_used: number | null;
	verdict: "used" | "unused" | "unknown";
}

export interface UnusedCandidate {
	name: string;
	basis: string;
}

export interface SkillAuditReport {
	schema_version: 1;
	report: "skill_audit";
	mode: "read_only";
	generated_at: string;
	status: "complete" | "partial" | "unknown";
	roots: { scope: AuditScope; path: string; exists: boolean }[];
	usage: {
		status: UsageScan["status"];
		sessions_root: string;
		transcripts: number;
		files_scanned: number;
		unreadable_files: number;
		corrupt_lines: number;
		tool_calls_observed: number;
		prompt_invocations_observed: number;
		signals: string[];
		window: { first_file_mtime: string | null; last_file_mtime: string | null };
		/** Skill names seen loading with no installed directory in the audited roots (bundled or project scope). */
		outside_roots: { name: string; used_count: number; last_used: string | null }[];
	};
	counts: {
		installed: number;
		used: number;
		unused: number;
		usage_unknown: number;
		duplicate_candidates: number;
		stale_replicas: number;
		outside_roots: number;
	};
	skills: SkillAuditRow[];
	candidates: { unused: UnusedCandidate[]; duplicates: AuditCandidate[] };
	limitations: string[];
}

export interface AuditInput {
	home: string;
	cwd: string;
	now?: Date;
}

const LIMITATIONS = [
	"usage comes only from retained session transcripts; deleted or unretained sessions are not reconstructed",
	"each skill tool call counts once even if the load failed; call results are not correlated",
	"a /skill:<name> prompt counts only in a transcript with no skill tool call for the same skill",
	"catalog exposure, skill_discovery lookups and prompt mentions are not uses",
	"file mtimes bound the scanned window; a transcript without timestamps contributes no last_used",
	"read-only: this report reads skill directories and session transcripts and writes nothing by itself",
];

function collapse(home: string, target: string): string {
	if (target === home) return "~";
	if (target.startsWith(home + path.sep)) return `~${target.slice(home.length)}`;
	return target;
}

function usageSummary(keys: Iterable<string>, scan: UsageScan) {
	const keySet = new Set(keys);
	const toolCallSessions = new Set<string>();
	const promptSessions = new Set<string>();
	let toolCalls = 0;
	let promptInvocations = 0;
	let lastUsedAt: number | null = null;
	let lastUsedIso: string | null = null;
	for (const key of keySet) {
		const usage = scan.skills.get(key);
		if (!usage) continue;
		toolCalls += usage.toolCalls;
		promptInvocations += usage.promptInvocations;
		for (const session of usage.toolCallSessions) toolCallSessions.add(session);
		for (const session of usage.promptSessions) promptSessions.add(session);
		if (usage.lastUsedAt !== null && (lastUsedAt === null || usage.lastUsedAt > lastUsedAt)) {
			lastUsedAt = usage.lastUsedAt;
			lastUsedIso = usage.lastUsedIso;
		}
	}
	const promptOnly = [...promptSessions].filter(session => !toolCallSessions.has(session)).length;
	return {
		toolCalls,
		promptInvocations,
		promptOnly,
		usedCount: toolCalls + promptOnly,
		sessionsUsed: new Set([...toolCallSessions, ...promptSessions]).size,
		lastUsed: lastUsedIso,
	};
}

function rowFor(skill: InstalledSkill, scan: UsageScan, home: string): SkillAuditRow {
	const base = {
		name: skill.name,
		installed: true as const,
		source: collapse(home, skill.root),
		scope: skill.scope,
		path: collapse(home, skill.path),
	};
	if (scan.status === "unknown") {
		return {
			...base,
			used_count: null,
			last_used: null,
			tool_calls: null,
			prompt_invocations: null,
			prompt_only_sessions: null,
			sessions_used: null,
			verdict: "unknown",
		};
	}
	const usage = usageSummary([skill.name, ...(skill.declaredName ? [skill.declaredName] : [])], scan);
	return {
		...base,
		used_count: usage.usedCount,
		last_used: usage.lastUsed,
		tool_calls: usage.toolCalls,
		prompt_invocations: usage.promptInvocations,
		prompt_only_sessions: usage.promptOnly,
		sessions_used: usage.sessionsUsed,
		verdict: usage.usedCount > 0 ? "used" : "unused",
	};
}

/**
 * Installed-vs-used audit of the skill catalog. Reads only: skill directories, session transcripts.
 * An unmeasurable usage window reports `unknown` per skill instead of zero uses.
 */
export function auditSkills(input: AuditInput): SkillAuditReport {
	const home = path.resolve(input.home);
	const cwd = path.resolve(input.cwd);
	const now = input.now ?? new Date();
	const roots: SkillRoot[] = skillRoots(home, cwd);
	const installed = discoverSkills(roots);
	const sessionsRoot = path.join(home, ".gjc", "agent", "sessions");
	const scan = scanUsage(sessionsRoot);
	const duplicates = duplicateCandidates(installed);
	const rows = installed.map(skill => rowFor(skill, scan, home));
	const installedNames = new Set<string>();
	for (const skill of installed) {
		installedNames.add(skill.name);
		if (skill.declaredName) installedNames.add(skill.declaredName);
	}
	const outsideRoots =
		scan.status === "unknown"
			? []
			: [...scan.skills.entries()]
					.filter(([name]) => !installedNames.has(name))
					.map(([name, usage]) => ({
						name,
						used_count: usageSummary([name], scan).usedCount,
						last_used: usage.lastUsedIso,
					}))
					.sort((a, b) => b.used_count - a.used_count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	const coverage =
		scan.status === "unknown"
			? "no retained transcript coverage"
			: `${scan.transcripts} retained transcripts (file mtimes ${scan.firstFileMtime ?? "unknown"}..${scan.lastFileMtime ?? "unknown"})` +
				(scan.corruptLines > 0 ? `, ${scan.corruptLines} corrupt line(s) skipped` : "");
	const unused: UnusedCandidate[] =
		scan.status === "unknown"
			? []
			: rows
					.filter(row => row.verdict === "unused")
					.map(row => ({
						name: row.name,
						basis: `0 skill tool calls and 0 prompt-only /skill: invocations across ${coverage}`,
					}));

	return {
		schema_version: 1,
		report: "skill_audit",
		mode: "read_only",
		generated_at: now.toISOString(),
		status: scan.status === "unknown" ? "unknown" : scan.status === "degraded" ? "partial" : "complete",
		roots: roots.map(root => ({ scope: root.scope, path: collapse(home, root.path), exists: root.exists })),
		usage: {
			status: scan.status,
			sessions_root: collapse(home, sessionsRoot),
			transcripts: scan.transcripts,
			files_scanned: scan.filesScanned,
			unreadable_files: scan.unreadableFiles,
			corrupt_lines: scan.corruptLines,
			tool_calls_observed: scan.toolCalls,
			prompt_invocations_observed: scan.promptInvocations,
			signals: ["skill_tool_call", "prompt_slash_invocation"],
			window: { first_file_mtime: scan.firstFileMtime, last_file_mtime: scan.lastFileMtime },
			outside_roots: outsideRoots,
		},
		counts: {
			installed: rows.length,
			used: rows.filter(row => row.verdict === "used").length,
			unused: unused.length,
			usage_unknown: rows.filter(row => row.verdict === "unknown").length,
			duplicate_candidates: duplicates.length,
			stale_replicas: duplicates.filter(candidate => candidate.kind === "stale_replica").length,
			outside_roots: outsideRoots.length,
		},
		skills: rows,
		candidates: { unused, duplicates },
		limitations: LIMITATIONS,
	};
}

const MARKS: Record<SkillAuditRow["verdict"], string> = { used: "✓", unused: "○", unknown: "?" };

/** Human summary: counts first, then each candidate list with the shared basis stated once. */
export function formatSummary(report: SkillAuditReport): string {
	const lines: string[] = [];
	const { counts, usage } = report;
	lines.push(
		`skill-audit: ${counts.installed} installed · ${counts.used} used · ${counts.unused} unused · ` +
			`${counts.usage_unknown} unknown · ${counts.duplicate_candidates} duplicate/stale candidate(s)`,
	);
	lines.push(
		`usage: ${usage.status} — ${usage.transcripts} transcript(s) under ${usage.sessions_root}` +
			(usage.window.first_file_mtime
				? ` (file mtimes ${usage.window.first_file_mtime}..${usage.window.last_file_mtime})`
				: "") +
			`, ${usage.tool_calls_observed} skill call(s), ${usage.prompt_invocations_observed} /skill: mention(s), ` +
			`${usage.corrupt_lines} corrupt line(s), ${usage.unreadable_files} unreadable file(s)`,
	);
	if (usage.outside_roots.length > 0) {
		lines.push(
			`observed outside the audited roots (${usage.outside_roots.length}) — bundled or project-scope skills, not cleanup candidates:`,
		);
		for (const entry of usage.outside_roots) lines.push(`  · ${entry.name} (${entry.used_count} use(s), last ${entry.last_used ?? "unknown"})`);
	}
	if (usage.status === "unknown") {
		lines.push("unused candidates: withheld — no transcript coverage, so zero uses cannot be claimed");
	}
	if (report.candidates.unused.length > 0) {
		lines.push(`unused (${report.candidates.unused.length}) — ${report.candidates.unused[0].basis}:`);
		for (const candidate of report.candidates.unused) lines.push(`  ${MARKS.unused} ${candidate.name}`);
	}
	if (report.candidates.duplicates.length > 0) {
		lines.push(`duplicate/stale (${report.candidates.duplicates.length}):`);
		for (const candidate of report.candidates.duplicates) {
			lines.push(`  ${candidate.kind}: ${candidate.skills.join(", ")} — ${candidate.basis}`);
		}
	}
	if (report.status !== "complete") lines.push(`report status: ${report.status} (see limitations)`);
	return lines.join("\n");
}

export default function skillAuditTool(pi: {
	typebox: { Type: { Object: (fields: Record<string, unknown>, options?: Record<string, unknown>) => unknown } };
}) {
	return {
		name: "skill_audit",
		label: "Skill Audit",
		description:
			"Read-only installed-vs-used audit of the GJC skill catalog: per-skill used_count, last_used and install source from retained session transcripts, plus unused, duplicate and stale candidates with their basis. Skill tool calls and /skill: invocations count as use; catalog exposure and skill_discovery do not. Missing transcript coverage reports unknown, never zero uses, and a corrupt line degrades the report instead of hiding it. It does not prove skill quality or effect, never installs or deletes skills, changes no configuration and writes nothing.",
		parameters: pi.typebox.Type.Object({}, { additionalProperties: false }),
		execute(_toolCallId: string, params: unknown) {
			const exactEmptyObject =
				typeof params === "object" && params !== null && !Array.isArray(params) && Object.keys(params as object).length === 0;
			if (!exactEmptyObject) {
				return {
					content: [
						{
							type: "text",
							text: "skill_audit: invalid_input. This tool accepts exactly {} — no paths or options; run the CLI for a written report.",
						},
					],
					isError: true,
				};
			}
			try {
				const report = auditSkills({ home: process.env.HOME || homedir(), cwd: process.cwd() });
				return { content: [{ type: "text", text: JSON.stringify(report) }], isError: false };
			} catch {
				return { content: [{ type: "text", text: "skill_audit: unexpected_error. The report could not be produced." }], isError: true };
			}
		},
	};
}
