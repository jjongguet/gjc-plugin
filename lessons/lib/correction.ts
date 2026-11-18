// Correction staging for the personal-wiki lesson ledger.
//
// A session_shutdown hook reads the newest GJC transcript for the session cwd,
// looks at the last user message for an owner correction cue, and stages one
// candidate line in `${GJC_PLUGIN_DATA:-~/.gjc/plugin-data}/lessons/corrections.jsonl`.
// Staging is local and append-only: nothing is written to the wiki, to a git
// repository or to the network, and no model is called.
//
// Pure parts: cue matching, credential redaction (the ledger CLI's own rules,
// ported), 600-byte clipping, the candidate shape, the dedupe key and the
// owner-runnable add command. Impure parts are small, bounded and injected by
// deps: transcript discovery is capped by a 15-minute mtime window and a file
// scan limit, transcript/file reads are byte capped, and the append is one
// O_APPEND write of one JSON line at mode 0600.
import { createHash } from "node:crypto";
import { closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, statSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compoundRoot, expandHome } from "./root";

export const CORRECTION_SCHEMA = "lessons-correction.v1";
export const CORRECTION_TEXT_MAX_BYTES = 600;
export const EXCERPT_MAX_BYTES = 600;
export const RECENT_WINDOW_MS = 15 * 60 * 1000;
export const SHUTDOWN_TIMEOUT_MS = 1500;
export const STAGED_DEFAULT_LIMIT = 20;
export const STAGED_MIN_LIMIT = 1;
export const STAGED_MAX_LIMIT = 20;
export const MAX_RESULT_BYTES = 4096;
export const MAX_SCAN_FILES = 40;
export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_CORRECTION_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_HEAD_BYTES = 64 * 1024;
export const STAGED_ID_CHARS = 16;
export const REDACTED = "[REDACTED]";
const MAX_SOURCE_BYTES = 4000;
const MAX_TRIGGER_BYTES = 400;
const MAX_ID_CHARS = 64;
const MAX_SESSION_CHARS = 200;
const MAX_CWD_CHARS = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type CorrectionCandidate = {
	schema: typeof CORRECTION_SCHEMA;
	sessionId: string;
	cwd: string;
	pattern: string;
	correctionText: string;
	priorAssistantExcerpt: string;
	createdAt: string;
};

export type StagedEntry = CorrectionCandidate & { id: string };

export type CorrectionDeps = {
	env?: Record<string, string | undefined>;
	home?: string;
	now?: number;
	timeoutMs?: number;
	sessionsRoot?: string;
	/** Overrides `dataRoot()` directly: the `lessons` directory, not its parent. */
	dataRoot?: string;
};

export type StageOutcome =
	| { status: "appended"; file: string; id: string; bytes: number }
	| { status: "duplicate"; file: string; id: string }
	| { status: "error"; reason: string };

export type StagedRead =
	| { status: "ok" | "empty"; file: string; count: number; entries: StagedEntry[] }
	| { status: "unavailable"; reason: string }
	| { status: "error"; reason: string };

export type StagedResult =
	| {
			status: "ok" | "empty";
			format: "json";
			root: string;
			file: string;
			count: number;
			returned: number;
			entries: StagedEntry[];
	  }
	| { status: "ok"; format: "add-argv"; root: string; id: string; command: string }
	| { status: "unavailable"; reason: string }
	| { status: "error"; reason: string };

export type StagedInput = { limit: number; format: "json" | "add-argv"; id: string | null };

class InvalidInput extends Error {}

// The ledger CLI (`scripts/lessons.py`) refuses a PEM block outright and
// redacts every other credential shape before writing. The same rules apply
// here, before a candidate is staged: a private key is never shortened into a
// storable form, so a correction carrying one is dropped whole.
const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const SECRET_PATTERNS: { kind: string; pattern: RegExp; keep: 0 | 1 }[] = [
	{ kind: "github", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, keep: 0 },
	{ kind: "openai", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, keep: 0 },
	{ kind: "gitlab", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, keep: 0 },
	{ kind: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g, keep: 0 },
	{ kind: "slack", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, keep: 0 },
	{ kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, keep: 0 },
	{ kind: "bearer", pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, keep: 0 },
	{ kind: "url", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi, keep: 0 },
	{
		kind: "assignment",
		pattern:
			/(\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|secret|password|passwd)\b\s*[:=]\s*)["']?[^\s"']{12,}/gi,
		keep: 1,
	},
];

// The owner's correction cues (JJO-2566). Korean cues need an explicit
// boundary because Hangul has no `\b`; ASCII cues are case-insensitive. The
// order is the reporting order: the most specific cue wins.
export const CORRECTION_CUES: readonly { cue: string; pattern: RegExp }[] = [
	{ cue: "그게 아니라", pattern: /(?:^|[\s,.;:!?…"'()\[\]{}<>~—–-])그게\s*아니라/ },
	{ cue: "하지마", pattern: /(?:^|[\s,.;:!?…"'()\[\]{}<>~—–-])하지\s*마/ },
	{ cue: "아니", pattern: /(?:^|[\s,.;:!?…"'()\[\]{}<>~—–-])아니(?=[\s,.;:!?…"'()\[\]{}<>~—–-]|$)/ },
	{ cue: "다시", pattern: /(?:^|[\s,.;:!?…"'()\[\]{}<>~—–-])다시(?=[\s,.;:!?…"'()\[\]{}<>~—–-]|$)/ },
	{ cue: "no,", pattern: /(?:^|\s)no,/i },
	{ cue: "actually", pattern: /(?:^|\s)actually\b/i },
	{ cue: "remember:", pattern: /(?:^|\s)remember:/i },
];

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function clipChars(value: string, limit: number): string {
	return value.length > limit ? value.slice(0, limit) : value;
}

/** Clip to a UTF-8 byte budget on a character boundary. */
export function clipBytes(value: string, limit: number): string {
	if (utf8Bytes(value) <= limit) return value;
	let out = "";
	for (const char of value) {
		if (utf8Bytes(`${out}${char}`) > limit) break;
		out += char;
	}
	return out;
}

/** Collapse control characters and whitespace runs: every staged field is one line. */
export function normalizeText(value: string): string {
	return value
		.replace(CONTROL, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** The first correction cue in `text`, or null when the message is not a correction. */
export function matchCorrectionCue(text: string): string | null {
	for (const entry of CORRECTION_CUES) {
		if (entry.pattern.test(text)) return entry.cue;
	}
	return null;
}

export type RedactResult = { ok: true; text: string } | { ok: false; reason: "private_key" | "unstable_redaction" };

/**
 * Redact credential shapes with the ledger CLI's rules. A private key block is
 * refused (a redacted key is still a leaked key) and so is text that keeps
 * matching after four passes: neither is ever staged in shortened form.
 */
export function redactText(text: string): RedactResult {
	if (PEM.test(text)) return { ok: false, reason: "private_key" };
	let value = text;
	for (let pass = 0; pass < 4; pass++) {
		const previous = value;
		for (const entry of SECRET_PATTERNS) {
			entry.pattern.lastIndex = 0;
			value = value.replace(entry.pattern, (_match: string, ...rest: unknown[]) => {
				const head = entry.keep === 1 && typeof rest[0] === "string" ? rest[0] : "";
				return `${head}${REDACTED}`;
			});
		}
		if (value === previous) return { ok: true, text: value };
	}
	return { ok: false, reason: "unstable_redaction" };
}

/** The visible text of one message record, or null when it carries none. */
export function messageText(message: unknown): string | null {
	if (message === null || typeof message !== "object") return null;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const part of content) {
		if (part === null || typeof part !== "object") continue;
		const typed = part as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	return parts.length === 0 ? null : parts.join("\n");
}

type MessageRecord = { type?: unknown; message?: { role?: unknown } | null };

function messageRole(record: unknown): string | null {
	if (record === null || typeof record !== "object") return null;
	const typed = record as MessageRecord;
	if (typed.type !== "message") return null;
	const message = typed.message;
	if (message === null || typeof message !== "object") return null;
	return typeof message.role === "string" ? message.role : null;
}

function readableMessage(record: unknown, role: string): string | null {
	if (messageRole(record) !== role) return null;
	const message = (record as MessageRecord).message;
	const text = messageText(message);
	if (text === null) return null;
	const normalized = normalizeText(text);
	return normalized.length === 0 ? null : normalized;
}

/**
 * Build one correction candidate from transcript records: the last user
 * message must carry a correction cue, and the nearest preceding assistant
 * message becomes the evidence excerpt. Both fields are redacted and clipped,
 * so a credential-shaped value is never part of the result. No cue, no
 * readable user message, or an unredactable correction text means null.
 */
export function extractCorrection(records: readonly unknown[], context: { sessionId: string; cwd: string; now: number }): CorrectionCandidate | null {
	let userIndex = -1;
	let userText = "";
	for (let index = records.length - 1; index >= 0; index--) {
		const text = readableMessage(records[index], "user");
		if (text === null) continue;
		userIndex = index;
		userText = text;
		break;
	}
	if (userIndex < 0) return null;
	const cue = matchCorrectionCue(userText);
	if (cue === null) return null;
	const safeCorrection = redactText(clipBytes(userText, MAX_SOURCE_BYTES));
	if (!safeCorrection.ok) return null;
	let excerpt = "";
	for (let index = userIndex - 1; index >= 0; index--) {
		const text = readableMessage(records[index], "assistant");
		if (text === null) continue;
		const safeExcerpt = redactText(clipBytes(text, MAX_SOURCE_BYTES));
		excerpt = safeExcerpt.ok ? clipBytes(safeExcerpt.text, EXCERPT_MAX_BYTES) : "";
		break;
	}
	return {
		schema: CORRECTION_SCHEMA,
		sessionId: clipChars(context.sessionId, MAX_SESSION_CHARS),
		cwd: clipChars(context.cwd, MAX_CWD_CHARS),
		pattern: cue,
		correctionText: clipBytes(safeCorrection.text, CORRECTION_TEXT_MAX_BYTES),
		priorAssistantExcerpt: excerpt,
		createdAt: new Date(context.now).toISOString(),
	};
}

/** sha256(sessionId + correctionText): the dedupe key for one staged correction. */
export function correctionKey(sessionId: string, correctionText: string): string {
	return createHash("sha256").update(`${sessionId}\n${correctionText}`, "utf8").digest("hex");
}

/** The short, stable id the tool shows and accepts back. */
export function correctionId(sessionId: string, correctionText: string): string {
	return correctionKey(sessionId, correctionText).slice(0, STAGED_ID_CHARS);
}

/** `${GJC_PLUGIN_DATA:-~/.gjc/plugin-data}/lessons`. */
export function dataRoot(deps: CorrectionDeps = {}): string {
	if (deps.dataRoot !== undefined) return deps.dataRoot;
	const env = deps.env ?? process.env;
	const home = deps.home ?? os.homedir();
	const configured = typeof env.GJC_PLUGIN_DATA === "string" ? env.GJC_PLUGIN_DATA.trim() : "";
	const base = configured === "" ? path.join(home, ".gjc", "plugin-data") : expandHome(configured, home);
	return path.join(base, "lessons");
}

export function correctionFile(deps: CorrectionDeps = {}): string {
	return path.join(dataRoot(deps), "corrections.jsonl");
}

export function sessionsRoot(deps: CorrectionDeps = {}): string {
	if (deps.sessionsRoot !== undefined) return deps.sessionsRoot;
	return path.join(deps.home ?? os.homedir(), ".gjc", "agent", "sessions");
}

function readBounded(file: string, maxBytes: number, fromEnd: boolean): string {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, maxBytes);
		if (length <= 0) return "";
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

// A tail read can start mid-line; an unparseable line simply drops out here.
function parseRecords(text: string): unknown[] {
	const records: unknown[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			records.push(JSON.parse(trimmed));
		} catch {
			/* a partial or corrupt line is skipped, never repaired */
		}
	}
	return records;
}

function sessionIdOfTranscript(name: string): string {
	const stem = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
	const index = stem.indexOf("_");
	return index >= 0 ? stem.slice(index + 1) : stem;
}

export type TranscriptHit = { file: string; sessionId: string };

/**
 * The newest transcript whose `session` record `cwd` equals `cwd` and whose
 * mtime is inside the 15-minute window, or null. Candidates are ordered by
 * mtime (name breaks ties) and at most MAX_SCAN_FILES are inspected, so a large
 * session store cannot stretch the shutdown hook.
 */
export function latestTranscript(cwd: string, deps: CorrectionDeps = {}): TranscriptHit | null {
	const root = sessionsRoot(deps);
	const now = deps.now ?? Date.now();
	const cutoff = now - RECENT_WINDOW_MS;
	const target = path.resolve(cwd);
	let dirs: string[];
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return null;
	}
	const candidates: { file: string; mtimeMs: number; sessionId: string }[] = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = readdirSync(path.join(root, dir));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const file = path.join(root, dir, name);
			let stat;
			try {
				stat = statSync(file);
			} catch {
				continue;
			}
			if (!stat.isFile() || stat.mtimeMs < cutoff) continue;
			candidates.push({ file, mtimeMs: stat.mtimeMs, sessionId: sessionIdOfTranscript(name) });
		}
	}
	candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.file < right.file ? 1 : -1));
	for (const candidate of candidates.slice(0, MAX_SCAN_FILES)) {
		let head: string;
		try {
			head = readBounded(candidate.file, MAX_HEAD_BYTES, false);
		} catch {
			continue;
		}
		const first = parseRecords(head)[0];
		if (first === null || typeof first !== "object") continue;
		const record = first as { type?: unknown; cwd?: unknown };
		if (record.type !== "session" || typeof record.cwd !== "string") continue;
		if (path.resolve(record.cwd) !== target) continue;
		return { file: candidate.file, sessionId: candidate.sessionId };
	}
	return null;
}

function validateCandidate(raw: unknown): CorrectionCandidate | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	if (record.schema !== CORRECTION_SCHEMA) return null;
	for (const field of ["sessionId", "cwd", "pattern", "correctionText", "priorAssistantExcerpt", "createdAt"]) {
		if (typeof record[field] !== "string") return null;
	}
	return {
		schema: CORRECTION_SCHEMA,
		sessionId: clipChars(record.sessionId as string, MAX_SESSION_CHARS),
		cwd: clipChars(record.cwd as string, MAX_CWD_CHARS),
		pattern: clipChars(record.pattern as string, 40),
		correctionText: clipBytes(record.correctionText as string, CORRECTION_TEXT_MAX_BYTES),
		priorAssistantExcerpt: clipBytes(record.priorAssistantExcerpt as string, EXCERPT_MAX_BYTES),
		createdAt: clipChars(record.createdAt as string, 40),
	};
}

/**
 * Append one candidate line unless its dedupe key is already present. The write
 * is a single O_APPEND `write` of one line at mode 0600, so concurrent appends
 * cannot interleave inside a line; the file is never rewritten or truncated.
 */
export function stageCorrection(candidate: CorrectionCandidate, deps: CorrectionDeps = {}): StageOutcome {
	const file = correctionFile(deps);
	const id = correctionId(candidate.sessionId, candidate.correctionText);
	let existing: string | null = null;
	try {
		existing = readBounded(file, MAX_CORRECTION_FILE_BYTES, true);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return { status: "error", reason: "read_failed" };
	}
	if (existing !== null) {
		for (const record of parseRecords(existing)) {
			const parsed = validateCandidate(record);
			if (parsed === null) continue;
			if (correctionKey(parsed.sessionId, parsed.correctionText) === correctionKey(candidate.sessionId, candidate.correctionText)) {
				return { status: "duplicate", file, id };
			}
		}
	}
	const line = `${JSON.stringify(candidate)}\n`;
	try {
		mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const fd = openSync(file, "a", 0o600);
		try {
			try {
				fchmodSync(fd, 0o600);
			} catch {
				/* a filesystem without POSIX modes is not an error here */
			}
			writeSync(fd, line);
		} finally {
			closeSync(fd);
		}
	} catch {
		return { status: "error", reason: "append_failed" };
	}
	return { status: "appended", file, id, bytes: utf8Bytes(line) };
}

/**
 * Read the staged file, newest first, with duplicates collapsed. A missing file
 * is an empty staging area, not an error; an unreadable one is `unavailable`.
 */
export function stagedEntries(deps: CorrectionDeps = {}): StagedRead {
	const file = correctionFile(deps);
	let text: string;
	try {
		text = readBounded(file, MAX_CORRECTION_FILE_BYTES, true);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "empty", file, count: 0, entries: [] };
		return { status: "unavailable", reason: "file_unreadable" };
	}
	const seen = new Set<string>();
	const entries: StagedEntry[] = [];
	for (const record of parseRecords(text)) {
		const candidate = validateCandidate(record);
		if (candidate === null) continue;
		const key = correctionKey(candidate.sessionId, candidate.correctionText);
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ ...candidate, id: key.slice(0, STAGED_ID_CHARS) });
	}
	entries.reverse();
	return { status: entries.length === 0 ? "empty" : "ok", file, count: entries.length, entries };
}

function shellQuote(value: string): string {
	if (value === "") return "''";
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The owner-runnable ledger command for one staged correction. `--id` and
 * `--repo` are included because `scripts/lessons.py add` requires both (and
 * `--scope project` requires at least one repo); without them the printed line
 * would exit 1. The line is printed, never executed here.
 */
export function addArgvCommand(entry: StagedEntry, root: string): string {
	const script = path.join(root, "scripts", "lessons.py");
	const base = `Owner correction (${entry.pattern})`;
	const trigger = clipBytes(entry.priorAssistantExcerpt === "" ? base : `${base} after: ${entry.priorAssistantExcerpt}`, MAX_TRIGGER_BYTES);
	return [
		"python3",
		shellQuote(script),
		"--root",
		shellQuote(root),
		"add",
		"--id",
		shellQuote(`L-corr-${entry.id}`),
		"--trigger",
		shellQuote(trigger),
		"--action",
		shellQuote(entry.correctionText),
		"--scope",
		"project",
		"--repo",
		shellQuote(entry.cwd),
		"--evidence",
		shellQuote(entry.sessionId),
		"--json",
	].join(" ");
}

const STAGED_KEYS = ["limit", "format", "id"];

/**
 * Validate `lessons_staged` parameters. Unknown fields and wrong types are
 * refused; `limit` is clamped into the documented window and `format` must be
 * one of the two documented strings (the host rejects enum schemas, so the
 * value is checked here instead).
 */
export function normalizeStagedInput(input: unknown): { ok: true; value: StagedInput } | { ok: false; reason: string } {
	try {
		if (input === null || typeof input !== "object" || Array.isArray(input)) throw new InvalidInput("expected an object");
		const record = input as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!STAGED_KEYS.includes(key)) throw new InvalidInput(`unknown field ${clipChars(key, 40)}`);
		}
		let limit = STAGED_DEFAULT_LIMIT;
		if (record.limit !== undefined) {
			if (typeof record.limit !== "number" || !Number.isFinite(record.limit)) throw new InvalidInput("limit must be a number");
			limit = Math.min(STAGED_MAX_LIMIT, Math.max(STAGED_MIN_LIMIT, Math.floor(record.limit)));
		}
		let format: "json" | "add-argv" = "json";
		if (record.format !== undefined) {
			if (record.format !== "json" && record.format !== "add-argv") throw new InvalidInput("format must be json or add-argv");
			format = record.format;
		}
		let id: string | null = null;
		if (record.id !== undefined) {
			if (typeof record.id !== "string") throw new InvalidInput("id must be a string");
			if (record.id.length === 0 || record.id.length > MAX_ID_CHARS || CONTROL.test(record.id)) {
				throw new InvalidInput(`id must be a non-empty string under ${MAX_ID_CHARS} characters`);
			}
			id = record.id;
		}
		if (format === "add-argv" && id === null) throw new InvalidInput("id is required for format add-argv");
		if (format === "json" && id !== null) throw new InvalidInput("id is only used with format add-argv");
		return { ok: true, value: { limit, format, id } };
	} catch (error) {
		if (error instanceof InvalidInput) return { ok: false, reason: error.message };
		return { ok: false, reason: "invalid_input" };
	}
}

function directoryExists(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function fileExists(target: string): boolean {
	try {
		return statSync(target).isFile();
	} catch {
		return false;
	}
}

/**
 * The `lessons_staged` result. The wiki root must resolve to a checkout with
 * `scripts/lessons.py` (otherwise the add line could not run), the staged file
 * is read once, and the JSON envelope is reduced until it fits 4096 bytes by
 * dropping the oldest entries whole.
 */
export function stagedResult(input: StagedInput, deps: CorrectionDeps = {}): StagedResult {
	const root = compoundRoot(deps);
	if (!directoryExists(root)) return { status: "unavailable", reason: "wiki_root_missing" };
	if (!fileExists(path.join(root, "scripts", "lessons.py"))) return { status: "unavailable", reason: "script_missing" };
	const read = stagedEntries(deps);
	if (read.status !== "ok" && read.status !== "empty") return read;
	if (input.format === "add-argv") {
		const entry = read.entries.find((item) => item.id === input.id);
		if (entry === undefined) return { status: "error", reason: "unknown_correction_id" };
		const result: StagedResult = { status: "ok", format: "add-argv", root, id: entry.id, command: addArgvCommand(entry, root) };
		if (utf8Bytes(JSON.stringify(result)) > MAX_RESULT_BYTES) return { status: "error", reason: "result_too_large" };
		return result;
	}
	const kept: StagedEntry[] = [];
	for (const entry of read.entries.slice(0, input.limit)) {
		const candidate = [...kept, entry];
		const envelope: StagedResult = {
			status: "ok",
			format: "json",
			root,
			file: read.file,
			count: read.count,
			returned: candidate.length,
			entries: candidate,
		};
		if (utf8Bytes(JSON.stringify(envelope)) > MAX_RESULT_BYTES) break;
		kept.push(entry);
	}
	if (read.count > 0 && kept.length === 0) return { status: "error", reason: "result_too_large" };
	return {
		status: read.count === 0 ? "empty" : "ok",
		format: "json",
		root,
		file: read.file,
		count: read.count,
		returned: kept.length,
		entries: kept,
	};
}

/** Bound one promise; a timeout, rejection or failure all settle to null. */
export function withBound<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
	return new Promise<T | null>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (value: T | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		timer = setTimeout(() => finish(null), timeoutMs);
		if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
		work.then(
			(value) => finish(value),
			() => finish(null),
		);
	});
}

function hookCwd(ctx: unknown): string | null {
	if (ctx === null || typeof ctx !== "object") return null;
	const cwd = (ctx as { cwd?: unknown }).cwd;
	return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

/**
 * One bounded, best-effort staging attempt for a shutting-down session. The
 * hook cwd picks the transcript, its `session` record must name that cwd, only
 * the last user message is scanned, and every failure is null: a missing
 * transcript, an unredactable correction, a read error or a timeout never
 * blocks or fails the shutdown.
 */
export async function sessionEndStage(ctx: unknown, deps: CorrectionDeps = {}): Promise<StageOutcome | null> {
	const cwd = hookCwd(ctx);
	if (cwd === null) return null;
	const work = (async (): Promise<StageOutcome | null> => {
		const resolved = path.resolve(cwd);
		const hit = latestTranscript(resolved, deps);
		if (hit === null) return null;
		let records: unknown[];
		try {
			records = parseRecords(readBounded(hit.file, MAX_TRANSCRIPT_BYTES, true));
		} catch {
			return null;
		}
		const candidate = extractCorrection(records, { sessionId: hit.sessionId, cwd: resolved, now: deps.now ?? Date.now() });
		if (candidate === null) return null;
		return stageCorrection(candidate, deps);
	})();
	return withBound(work, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
}

/** The one advisory log line for an appended stage, or null. */
export function stageLine(outcome: StageOutcome | null): string | null {
	if (outcome === null || outcome.status !== "appended") return null;
	return `lessons: staged correction ${outcome.id.slice(0, 8)} (lessons_staged)`;
}
