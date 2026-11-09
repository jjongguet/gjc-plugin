import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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
