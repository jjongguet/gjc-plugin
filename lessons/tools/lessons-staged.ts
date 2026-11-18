// GENERATED FILE - do not edit by hand.
// Adapter: src/staged.adapter.ts
// Rebuild with: bun lessons/scripts/build.mjs

// One wiki-root resolution for every lessons surface.
//
// `GJC_COMPOUND_ROOT` wins over `GJC_LESSONS_WIKI`, which wins over the owner's
// personal-wiki checkout under the home directory. Both names are accepted in
// one chain so `lessons_select` and `lessons_staged` can never disagree about
// which checkout they mean; an empty or blank value falls through, and `~`
// expands against the same home the daemon used.
import os from "node:os";
import path from "node:path";

export const COMPOUND_ROOT_ENV = "GJC_COMPOUND_ROOT";
export const LESSONS_WIKI_ENV = "GJC_LESSONS_WIKI";

export type RootDeps = { env?: Record<string, string | undefined>; home?: string };

function configuredRoot(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function expandHome(value: string, home: string): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}

/** The wiki root: `GJC_COMPOUND_ROOT` → `GJC_LESSONS_WIKI` → `$HOME/jjongguet/personal-wiki`. */
export function compoundRoot(deps: RootDeps = {}): string {
	const env = deps.env ?? process.env;
	const home = deps.home ?? os.homedir();
	const configured = configuredRoot(env[COMPOUND_ROOT_ENV]) ?? configuredRoot(env[LESSONS_WIKI_ENV]);
	if (configured === null) return path.join(home, "jjongguet", "personal-wiki");
	return expandHome(configured, home);
}

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
// owner-runnable add command. Every impure step is bounded and skippable:
// discovery examines at most MAX_SESSION_DIRS project directories and
// MAX_SESSION_FILES transcripts inside a 15-minute mtime window, the transcript
// is read backwards in TRANSCRIPT_CHUNK_BYTES chunks up to TRANSCRIPT_MAX_BYTES,
// the staged file read is byte capped, and the append is one O_APPEND write of
// one JSON line at mode 0600.
//
// The 1500 ms shutdown budget is spent by the work itself: the deadline is
// checked between project directories, between transcripts and between chunks,
// and an expired scan is abandoned (no-op). Those checks cannot preempt a single
// blocking filesystem call, so one hung read or stat can still delay shutdown;
// `withBound` only guards promise settlement and is not a wall-clock bound.
import { createHash } from "node:crypto";
import { closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, statSync, writeSync } from "node:fs";

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
// A transcript is read backwards one mebibyte at a time until the last text
// user message (and an assistant turn before it) is inside the window, so a
// long final turn cannot push the real last user message out of a fixed tail.
export const TRANSCRIPT_CHUNK_BYTES = 1024 * 1024;
export const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_DIRS = 2048;
export const MAX_SESSION_FILES = 8192;
export const MAX_CORRECTION_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_HEAD_BYTES = 64 * 1024;
export const STAGED_ID_CHARS = 16;
export const REDACTED = "[REDACTED]";
const MAX_SOURCE_BYTES = 4000;
const MAX_TRIGGER_BYTES = 400;
const MAX_ID_CHARS = 64;
const MAX_SESSION_CHARS = 200;
const MAX_CWD_CHARS = 4096;
// `CONTROL` is stateless and only used with `.test`; the replacement pass needs
// its own global regex or only the first control character would be replaced.
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_GLOBAL = /[\u0000-\u001f\u007f]/g;

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
	/** Deadline clock; the verify suite advances a fake clock to exhaust the budget. */
	clock?: () => number;
	sessionsRoot?: string;
	/** Overrides `dataRoot()` directly: the `lessons` directory, not its parent. */
	dataRoot?: string;
	/** Bounds that the verify suite shrinks; each defaults to the documented cap. */
	chunkBytes?: number;
	maxTranscriptBytes?: number;
	maxSessionDirs?: number;
	maxSessionFiles?: number;
};

export type StageOutcome =
	| { status: "appended"; file: string; id: string; bytes: number }
	| { status: "duplicate"; file: string; id: string }
	| { status: "skipped"; reason: "transcript_cap" }
	| { status: "error"; reason: string };

export type StagedRead =
	| { status: "ok" | "empty"; file: string; count: number; truncated: boolean; entries: StagedEntry[] }
	| { status: "unavailable"; reason: string }
	| { status: "error"; reason: string };

// `truncated` is true when the staged file is larger than the MAX_CORRECTION_FILE_BYTES
// newest window: `count`, `entries` and id lookups then cover only the visible
// suffix, so older entries (and older dedupe keys) are not reported.
export type StagedResult =
	| {
			status: "ok" | "empty";
			format: "json";
			root: string;
			file: string;
			count: number;
			returned: number;
			truncated: boolean;
			entries: StagedEntry[];
	  }
	| { status: "ok"; format: "add-argv"; root: string; id: string; truncated: boolean; command: string }
	| { status: "unavailable"; reason: string; truncated: boolean }
	| { status: "error"; reason: string; truncated: boolean };

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

/**
 * Collapse control characters and whitespace runs: every staged field is one line.
 * Every C0 control and DEL becomes a space (global replace, not just the first),
 * so no NUL, ESC, BEL or other control byte can reach a staged field or the
 * printed add command.
 */
export function normalizeText(value: string): string {
	return value
		.replace(CONTROL_GLOBAL, " ")
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

/** The last text user message and the nearest text assistant message before it. */
function correctionSpan(records: readonly unknown[]): { user: number; assistant: number } {
	let user = -1;
	for (let index = records.length - 1; index >= 0; index--) {
		if (readableMessage(records[index], "user") === null) continue;
		user = index;
		break;
	}
	if (user < 0) return { user: -1, assistant: -1 };
	for (let index = user - 1; index >= 0; index--) {
		if (readableMessage(records[index], "assistant") === null) continue;
		return { user, assistant: index };
	}
	return { user, assistant: -1 };
}

/**
 * Build one correction candidate from transcript records: the last user
 * message must carry a correction cue, and the nearest preceding assistant
 * message becomes the evidence excerpt. Both fields are redacted and clipped,
 * so a credential-shaped value is never part of the result. No cue, no
 * readable user message, or an unredactable correction text means null.
 */
export function extractCorrection(records: readonly unknown[], context: { sessionId: string; cwd: string; now: number }): CorrectionCandidate | null {
	const span = correctionSpan(records);
	if (span.user < 0) return null;
	const userText = readableMessage(records[span.user], "user");
	if (userText === null) return null;
	const cue = matchCorrectionCue(userText);
	if (cue === null) return null;
	const safeCorrection = redactText(clipBytes(userText, MAX_SOURCE_BYTES));
	if (!safeCorrection.ok) return null;
	let excerpt = "";
	const assistantText = span.assistant < 0 ? null : readableMessage(records[span.assistant], "assistant");
	if (assistantText !== null) {
		const safeExcerpt = redactText(clipBytes(assistantText, MAX_SOURCE_BYTES));
		excerpt = safeExcerpt.ok ? clipBytes(safeExcerpt.text, EXCERPT_MAX_BYTES) : "";
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

type WindowRead = { text: string; truncated: boolean };

// The newest `maxBytes` of a file, with whether the window binds. A tail read can
// start mid-line; an unparseable line simply drops out in parseRecords.
function readWindow(file: string, maxBytes: number): WindowRead {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, maxBytes);
		if (length <= 0) return { text: "", truncated: false };
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return { text: buffer.toString("utf8"), truncated: size > length };
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

function readByte(fd: number, position: number): number {
	const byte = Buffer.alloc(1);
	try {
		readSync(fd, byte, 0, 1, position);
	} catch {
		return -1;
	}
	return byte[0];
}

export type TranscriptWindow = { status: "found" | "complete" | "cap" | "deadline"; records: unknown[] };

type ReadPlan = { clock: () => number; deadline: number; chunkBytes: number; maxBytes: number };

/**
 * Read a transcript backwards in fixed-size chunks until the last text user
 * message and an assistant turn before it are inside the window, the file start
 * is reached, the byte cap is spent or the deadline expires. Chunks stay as
 * bytes and are split on the newline byte, so a chunk boundary never splits a
 * line or a multi-byte character; an unparseable line drops out and is never
 * repaired. Every chunk costs one deadline check and the total read never
 * exceeds `maxBytes`.
 */
function readTranscriptWindow(file: string, plan: ReadPlan): TranscriptWindow {
	let records: unknown[] = [];
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return { status: "complete", records };
	}
	try {
		let end = fstatSync(fd).size;
		let pending: Buffer = Buffer.alloc(0);
		let bytesRead = 0;
		for (;;) {
			const span = correctionSpan(records);
			if (span.user >= 0 && span.assistant >= 0) return { status: "found", records };
			if (end <= 0) return { status: "complete", records };
			if (plan.clock() >= plan.deadline) return { status: "deadline", records };
			if (bytesRead >= plan.maxBytes) return { status: "cap", records };
			const start = Math.max(0, end - plan.chunkBytes);
			const length = end - start;
			const chunk = Buffer.alloc(length);
			try {
				readSync(fd, chunk, 0, length, start);
			} catch {
				return { status: "complete", records };
			}
			bytesRead += length;
			// Was the previous (unread) byte a newline? Then this chunk starts a line.
			const atLineStart = start === 0 || readByte(fd, start - 1) === 0x0a;
			const joined = pending.length === 0 ? chunk : Buffer.concat([chunk, pending]);
			const segments: Buffer[] = [];
			let from = 0;
			for (let index = 0; index < joined.length; index++) {
				if (joined[index] !== 0x0a) continue;
				segments.push(joined.subarray(from, index));
				from = index + 1;
			}
			segments.push(joined.subarray(from));
			const complete = atLineStart ? segments : segments.slice(1);
			pending = atLineStart ? Buffer.alloc(0) : Buffer.from(segments[0]);
			const older: unknown[] = [];
			for (const segment of complete) {
				const text = segment.toString("utf8").trim();
				if (text.length === 0) continue;
				try {
					older.push(JSON.parse(text));
				} catch {
					/* a partial or corrupt line is skipped, never repaired */
				}
			}
			// concat, not unshift(...older): a chunk can hold tens of thousands of
			// short lines, and a spread of that size overflows the argument stack.
			records = older.concat(records);
			end = start;
		}
	} finally {
		closeSync(fd);
	}
}

function locateTranscript(target: string, deps: CorrectionDeps, clock: () => number, deadline: number): TranscriptHit | null {
	const root = sessionsRoot(deps);
	const now = deps.now ?? Date.now();
	const cutoff = now - RECENT_WINDOW_MS;
	const maxDirs = Math.max(0, Math.floor(deps.maxSessionDirs ?? MAX_SESSION_DIRS));
	const maxFiles = Math.max(0, Math.floor(deps.maxSessionFiles ?? MAX_SESSION_FILES));
	let dirs: string[];
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return null;
	}
	const candidates: { file: string; mtimeMs: number; sessionId: string }[] = [];
	let examined = 0;
	for (const dir of dirs.slice(0, maxDirs)) {
		if (clock() >= deadline) return null;
		let names: string[];
		try {
			names = readdirSync(path.join(root, dir)).sort();
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			if (examined >= maxFiles) break;
			examined += 1;
			if (clock() >= deadline) return null;
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
		if (examined >= maxFiles) break;
	}
	candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.file < right.file ? 1 : -1));
	for (const candidate of candidates.slice(0, MAX_SCAN_FILES)) {
		if (clock() >= deadline) return null;
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

/**
 * The newest transcript whose `session` record `cwd` equals `cwd` and whose
 * mtime is inside the 15-minute window, or null. The enumeration examines at
 * most MAX_SESSION_DIRS project directories and MAX_SESSION_FILES transcripts
 * and abandons the rest once the 1500 ms deadline expires; at most
 * MAX_SCAN_FILES candidates get a head read. Directory mtimes are not used for
 * ordering: a long session's directory mtime is its creation time, so it would
 * hide exactly the session that just ended.
 */
export function latestTranscript(cwd: string, deps: CorrectionDeps = {}): TranscriptHit | null {
	const clock = deps.clock ?? Date.now;
	const deadline = clock() + (deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
	return locateTranscript(path.resolve(cwd), deps, clock, deadline);
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
	let window: WindowRead;
	try {
		window = readWindow(file, MAX_CORRECTION_FILE_BYTES);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { status: "empty", file, count: 0, truncated: false, entries: [] };
		}
		return { status: "unavailable", reason: "file_unreadable" };
	}
	const text = window.text;
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
	return { status: entries.length === 0 ? "empty" : "ok", file, count: entries.length, truncated: window.truncated, entries };
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
 * The `lessons_staged` result. The staged file is read once as the newest
 * MAX_CORRECTION_FILE_BYTES window and `truncated` says whether that window
 * binds, so `count` never claims more than the visible suffix. The wiki root
 * must then resolve to a checkout with `scripts/lessons.py` (otherwise the add
 * line could not run), and the JSON envelope is reduced until it fits 4096
 * bytes by dropping the oldest entries whole.
 */
export function stagedResult(input: StagedInput, deps: CorrectionDeps = {}): StagedResult {
	// The staged file is read first so every path can report whether the newest
	// window binds; an unreadable file still answers the only question it can.
	const read = stagedEntries(deps);
	if (read.status !== "ok" && read.status !== "empty") return { ...read, truncated: false };
	const truncated = read.truncated;
	const root = compoundRoot(deps);
	if (!directoryExists(root)) return { status: "unavailable", reason: "wiki_root_missing", truncated };
	if (!fileExists(path.join(root, "scripts", "lessons.py"))) return { status: "unavailable", reason: "script_missing", truncated };
	if (input.format === "add-argv") {
		const entry = read.entries.find((item) => item.id === input.id);
		if (entry === undefined) return { status: "error", reason: "unknown_correction_id", truncated };
		const result: StagedResult = {
			status: "ok",
			format: "add-argv",
			root,
			id: entry.id,
			truncated,
			command: addArgvCommand(entry, root),
		};
		if (utf8Bytes(JSON.stringify(result)) > MAX_RESULT_BYTES) return { status: "error", reason: "result_too_large", truncated };
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
			truncated,
			entries: candidate,
		};
		if (utf8Bytes(JSON.stringify(envelope)) > MAX_RESULT_BYTES) break;
		kept.push(entry);
	}
	if (read.count > 0 && kept.length === 0) return { status: "error", reason: "result_too_large", truncated };
	return {
		status: read.count === 0 ? "empty" : "ok",
		format: "json",
		root,
		file: read.file,
		count: read.count,
		returned: kept.length,
		truncated,
		entries: kept,
	};
}

/**
 * Promise-settlement guard: resolves with the value, or with null when the
 * timeout wins or the promise rejects, and never rejects itself. It cannot
 * interrupt synchronous work — a hung filesystem call inside `work` keeps
 * running and keeps the event loop waiting — so it is not a wall-clock bound.
 * Work that needs a real budget must check its own deadline, as the transcript
 * scan does.
 */
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
 * transcript, an unredactable correction, a read error or an expired scan never
 * blocks or fails the shutdown. The deadline is checked inside the scan, between
 * project directories, transcripts and chunks, so the budget is spent by the
 * work itself rather than by a timer wrapped around already-finished work. One
 * blocking filesystem call is not preemptible, so a hung read or stat can still
 * delay shutdown; `withBound` guards promise settlement only. A scan that stops
 * at the byte cap with no user record is reported as `skipped` so the hook can
 * log exactly one debug line.
 */
export async function sessionEndStage(ctx: unknown, deps: CorrectionDeps = {}): Promise<StageOutcome | null> {
	const cwd = hookCwd(ctx);
	if (cwd === null) return null;
	const clock = deps.clock ?? Date.now;
	const budget = deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
	const deadline = clock() + budget;
	const work = (async (): Promise<StageOutcome | null> => {
		const resolved = path.resolve(cwd);
		const hit = locateTranscript(resolved, deps, clock, deadline);
		if (hit === null) return null;
		const window = readTranscriptWindow(hit.file, {
			clock,
			deadline,
			chunkBytes: Math.max(1, Math.floor(deps.chunkBytes ?? TRANSCRIPT_CHUNK_BYTES)),
			maxBytes: Math.max(1, Math.floor(deps.maxTranscriptBytes ?? TRANSCRIPT_MAX_BYTES)),
		});
		if (window.status === "deadline") return null;
		const candidate = extractCorrection(window.records, { sessionId: hit.sessionId, cwd: resolved, now: deps.now ?? Date.now() });
		if (candidate !== null) return stageCorrection(candidate, deps);
		return window.status === "cap" ? { status: "skipped", reason: "transcript_cap" } : null;
	})();
	return withBound(work, budget);
}

/** The one advisory log line for an appended stage, or null. */
export function stageLine(outcome: StageOutcome | null): string | null {
	if (outcome === null || outcome.status !== "appended") return null;
	return `lessons: staged correction ${outcome.id.slice(0, 8)} (lessons_staged)`;
}

/** The one debug line for a scan that stopped at the byte cap, or null. */
export function scanLine(outcome: StageOutcome | null, deps: CorrectionDeps = {}): string | null {
	if (outcome === null || outcome.status !== "skipped") return null;
	const mebibytes = Math.max(1, Math.round((deps.maxTranscriptBytes ?? TRANSCRIPT_MAX_BYTES) / (1024 * 1024)));
	return `lessons: no correction staged (transcript scan stopped at the ${mebibytes} MiB read cap)`;
}


function serialized(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		text = JSON.stringify({ status: "error", reason: "serialize_failed" });
	}
	if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) return text;
	return JSON.stringify({ status: "error", reason: "result_too_large" });
}

export default function lessonsStaged(pi: { typebox: { Type: any } }) {
	const T = pi.typebox.Type;
	return {
		name: "lessons_staged",
		label: "Lessons Staged",
		description:
			"Read the corrections staged for the lesson ledger (4096 bytes of JSON). Read-only: it never writes, never runs a command and never promotes a lesson. Default returns counts plus up to 20 entries, newest first. `format:\"add-argv\"` with an `id` returns the exact owner-runnable `scripts/lessons.py add` command line as text; printing it does not run it. Returns `{\"status\":\"ok\"|\"empty\"|\"unavailable\"|\"error\",...}`.",
		parameters: T.Object({
			limit: T.Optional(T.Number({ description: "Maximum entries, 1-20 (default 20; out-of-range values are clamped)." })),
			format: T.Optional(
				T.String({
					description: "`json` (default) for the staged entries, `add-argv` for one entry's runnable command line.",
				}),
			),
			id: T.Optional(
				T.String({
					description: "Entry id from a previous `json` result; required with `format:\"add-argv\"` and refused without it.",
				}),
			),
		}),
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			try {
				const normalized = normalizeStagedInput(params);
				if (!normalized.ok) {
					return {
						content: [{ type: "text", text: `lessons_staged: invalid_input (${normalized.reason})` }],
						isError: true,
					};
				}
				return { content: [{ type: "text", text: serialized(stagedResult(normalized.value)) }] };
			} catch {
				return { content: [{ type: "text", text: serialized({ status: "error", reason: "internal_error" }) }] };
			}
		},
	};
}
