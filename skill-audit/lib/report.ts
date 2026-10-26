import path from "node:path";

import { type AuditCandidate, type AuditScope, type InstalledSkill, type SkillRoot, discoverSkills, duplicateCandidates, skillRoots } from "./catalog";
import { type UsageScan, scanUsage } from "./usage";

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
