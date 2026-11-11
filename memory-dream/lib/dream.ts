import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * memory-dream core.
 *
 * Reads GJC's private memory artifacts (never writes them), decomposes the
 * injected notes into claims, checks deterministic facts, retrieves bounded
 * canonical evidence, optionally asks the Jev decision model whether a claim is
 * consistent with that evidence, and writes one private report under
 * ~/.gjc-plugin/memory-dream/.
 *
 * GJC regenerates MEMORY.md and memory_summary.md. This module therefore never
 * edits, deletes or enqueues those files; a report plus an upper-bounded
 * session_start notice is the correction path.
 */

export const REPORT_SCHEMA = "memory-dream.report.v1";
export const LATEST_SCHEMA = "memory-dream.latest.v1";
export const GOLDEN_SCHEMA = "memory-dream.golden.v1";
export const PROMPT_VERSION = "memory-dream/jev-consistency/v1";
export const JEV_MODEL = "typesafe/jev-1.14";
export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const JEV_PROVIDER = "openrouter";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
export const MAX_CLAIMS = 200;
export const DEFAULT_MAX_CLAIMS = 100;
export const MAX_JEV_CALLS = 120;
export const DEFAULT_MAX_JEV_CALLS = 60;
export const MAX_CLAIM_CHARS = 800;
export const MAX_ARTIFACT_CHARS = 6000;
export const MAX_EVIDENCE_ITEMS = 2;
export const MAX_EVIDENCE_EXCERPT_CHARS = 400;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const JEV_TIMEOUT_MS = 8000;

export const MAX_SUMMARY_BYTES = 8192;
export const MAX_SUMMARY_LINES = 120;
export const MAX_MEMORY_BYTES = 25_600;
export const MAX_MEMORY_LINES = 200;
export const STALE_AFTER_DAYS = 30;

const MEMORY_FILES = ["memory_summary.md", "MEMORY.md"] as const;
const CHECK_VERDICTS = ["correct", "incorrect", "unsure"] as const;

export type CheckVerdict = (typeof CHECK_VERDICTS)[number];
export type ClaimVerdict = "supported" | "contradicted" | "unverified" | "no-decision";
export type EvidenceKind = "canonical" | "transcript";
export type NoDecisionReason =
	| "disabled"
	| "unconfigured"
	| "invalid_endpoint"
	| "input_too_large"
	| "invalid_response"
	| "http_auth"
	| "http_credit"
	| "http_rate"
	| "http_server"
	| "http_error"
	| "redirect"
	| "timeout"
	| "aborted"
	| "provider_error";

export interface MemoryFileFacts {
	name: string;
	bytes: number;
	lines: number;
	sha256Before: string;
	sha256After?: string;
}

export interface BudgetCheck {
	file: string;
	bytes: number;
	lines: number;
	maxBytes: number;
	maxLines: number;
	status: "ok" | "over";
	overByBytes: number;
	overByLines: number;
}

export interface ClaimSource {
	file: string;
	line: number;
}

export interface ClaimFlags {
	deadReferences: string[];
	maskedReferences: string[];
	missingPaths: string[];
	staleDates: { date: string; days: number }[];
	secret: string | null;
	evidenceSecretDropped: boolean;
}

export interface EvidenceItem {
	kind: EvidenceKind;
	citation: string;
	excerpt: string;
	score: number;
}

export interface JevDecision {
	status: "decision";
	verdict: CheckVerdict;
	confidence: number;
	probabilities?: Record<CheckVerdict, number>;
	rationale?: string;
	confidenceKind: "provider_choice";
}

export interface JevNoDecision {
	status: "no_decision";
	reason: NoDecisionReason;
	httpStatus?: number;
}

export type JevOutcome = JevDecision | JevNoDecision;

export interface ClaimReport {
	id: string;
	text: string;
	sources: ClaimSource[];
	verdict: ClaimVerdict;
	basis: "jev" | "deterministic" | "none";
	confidence: number | null;
	jev: JevOutcome | null;
	evidence: EvidenceItem[];
	correction: string | null;
	flags: ClaimFlags;
	externalSend: boolean;
	reason?: string;
}

export interface DreamReport {
	schema: typeof REPORT_SCHEMA;
	generatedAt: string;
	promptVersion: string;
	model: string;
	provider: string;
	memory: {
		dir: string;
		projectRoot: string;
		files: MemoryFileFacts[];
		unchanged: boolean;
	};
	budgets: BudgetCheck[];
	deterministic: {
		deadReferences: { claimId: string; reference: string; reason: string }[];
		missingPaths: { claimId: string; value: string }[];
		staleFacts: { claimId: string; date: string; days: number }[];
		secretClaims: number;
	};
	claims: ClaimReport[];
	counts: {
		claims: number;
		omittedClaims: number;
		supported: number;
		contradicted: number;
		unverified: number;
		noDecision: number;
		sentToJev: number;
		secretsBlocked: number;
		jevCallsSkippedByCap: number;
	};
	confidenceThreshold: number;
	maxJevCalls: number;
	limitations: string[];
}

export interface DreamOptions {
	cwd: string;
	home?: string;
	agentDir?: string;
	memoryDir?: string;
	projectRoot?: string;
	now?: Date;
	env?: Record<string, string | undefined>;
	envFile?: string;
	jev?: boolean;
	maxClaims?: number;
	maxJevCalls?: number;
	confidenceThreshold?: number;
	transcriptSearch?: boolean;
	fetchImpl?: FetchLike;
	resultsRoot?: string;
	writeReports?: boolean;
	signal?: AbortSignal;
}

export interface DreamResult {
	report: DreamReport;
	reportPath: string | null;
	markdownPath: string | null;
	latestPath: string | null;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const STOPWORDS = new Set(
	(
		"a an the and or but if then than that this these those it its as at by for from in into of on onto over under to with within without " +
		"is are was were be been being do does did done can could should would will has have had not no nor so such own same very just now also " +
		"more most less least all any each both other another only about after before again until while when where which who whom whose why how " +
		"you your we our they their them he she his her i me my mine us " +
		"그리고 또는 그러나 하지만 이것 저것 그것 위해 대한 으로 에서 하고 한다 있다 없다 것은 것을"
	).split(/\s+/),
);

/** Tokens that are too common in this repository to establish evidence alone. */
const GENERIC_TOKENS = new Set([
	"plugin",
	"plugins",
	"repo",
	"repository",
	"project",
	"file",
	"files",
	"path",
	"paths",
	"test",
	"tests",
	"rule",
	"rules",
	"default",
	"current",
	"code",
	"source",
	"line",
	"lines",
	"use",
	"used",
	"using",
	"make",
	"made",
	"must",
	"never",
	"always",
	"only",
	"same",
	"different",
	"work",
	"works",
	"working",
]);

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function sha256Short(value: string | Uint8Array): string {
	return sha256(value).slice(0, 16);
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function countLines(value: string): number {
	if (value.length === 0) return 0;
	return value.split(/\r?\n/).length;
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function expandHome(value: string, home: string): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}

/** GJC's project-memory directory encoding, copied from memories/index.ts. */
export function encodeProjectPath(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function memoryRootFor(agentDir: string, cwd: string): string {
	return path.join(agentDir, "memories", encodeProjectPath(cwd));
}

export function defaultResultsRoot(home: string, env: Record<string, string | undefined> = {}): string {
	const override = env.MEMORY_DREAM_RESULTS_DIR?.trim();
	return override ? path.resolve(override) : path.join(home, ".gjc-plugin", "memory-dream");
}

async function readPrivateText(file: string, maxBytes: number): Promise<string> {
	const info = await lstat(file);
	if (info.isSymbolicLink()) throw new Error("symlink_not_allowed");
	if (!info.isFile()) throw new Error("not_a_regular_file");
	if (info.size > maxBytes) throw new Error("file_too_large");
	return await readFile(file, "utf8");
}

async function readMemoryFile(file: string): Promise<{ text: string; facts: MemoryFileFacts }> {
	const text = await readPrivateText(file, 1_000_000);
	return {
		text,
		facts: {
			name: path.basename(file),
			bytes: byteLength(text),
			lines: countLines(text),
			sha256Before: sha256(text),
		},
	};
}

export function budgetFor(file: string, text: string): BudgetCheck {
	const isSummary = file === "memory_summary.md";
	const maxBytes = isSummary ? MAX_SUMMARY_BYTES : MAX_MEMORY_BYTES;
	const maxLines = isSummary ? MAX_SUMMARY_LINES : MAX_MEMORY_LINES;
	const bytes = byteLength(text);
	const lines = countLines(text);
	return {
		file,
		bytes,
		lines,
		maxBytes,
		maxLines,
		status: bytes > maxBytes || lines > maxLines ? "over" : "ok",
		overByBytes: Math.max(0, bytes - maxBytes),
		overByLines: Math.max(0, lines - maxLines),
	};
}

function stripMarkdown(line: string): string {
	let value = line.trim();
	value = value.replace(/^>\s?/, "");
	value = value.replace(/^[-*+]\s+/, "");
	value = value.replace(/^\d+[.)]\s+/, "");
	value = value.replace(/\*\*([^*]+)\*\*/g, "$1");
	value = value.replace(/__([^_]+)__/g, "$1");
	value = value.replace(/`([^`]+)`/g, "$1");
	value = value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	return value.trim();
}

function skipClaimLine(line: string, inFence: boolean): boolean {
	if (inFence) return true;
	const trimmed = line.trim();
	if (!trimmed) return true;
	if (/^(?:```|~~~)/.test(trimmed)) return true;
	if (/^#{1,6}\s/.test(trimmed)) return true;
	if (/^\|?[\s:|-]+\|?$/.test(trimmed)) return true;
	if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) return true;
	if (/^<!--/.test(trimmed) || /^<\w/.test(trimmed)) return true;
	if (/^\[[^\]]+\]:\s/.test(trimmed)) return true;
	if (/^https?:\/\/\S+$/.test(trimmed)) return true;
	return false;
}

function splitSentences(text: string): string[] {
	const out: string[] = [];
	let buffer = "";
	let inCode = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === "`") inCode = !inCode;
		buffer += char;
		if (inCode || (char !== "." && char !== "!" && char !== "?")) continue;
		const after = text[index + 1];
		if (!after || !/\s/.test(after)) continue;
		const next = text[index + 2] ?? "";
		if (!/[A-Z0-9"'`(가-힣]/.test(next)) continue;
		const candidate = buffer.trim();
		if (candidate) out.push(candidate);
		buffer = "";
	}
	const tail = buffer.trim();
	if (tail) out.push(tail);
	return out;
}

export interface RawClaim {
	id: string;
	text: string;
	sources: ClaimSource[];
}

export function splitClaims(text: string, file: string, startLine = 1): RawClaim[] {
	const claims: RawClaim[] = [];
	let inFence = false;
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (/^\s*(?:```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (skipClaimLine(line, inFence)) continue;
		const stripped = stripMarkdown(line);
		if (stripped.length < 12) continue;
		if (!/[A-Za-z0-9가-힣]/.test(stripped)) continue;
		for (const sentence of splitSentences(stripped)) {
			const normalized = normalizeText(sentence);
			if (normalized.length < 12) continue;
			const bounded = normalized.slice(0, MAX_CLAIM_CHARS);
			claims.push({
				id: sha256Short(`${file}:${startLine + index}:${bounded}`),
				text: bounded,
				sources: [{ file, line: startLine + index }],
			});
		}
	}
	return claims;
}

export function collectClaims(files: { file: string; text: string }[]): { claims: RawClaim[]; omitted: number } {
	const byText = new Map<string, RawClaim>();
	for (const entry of files) {
		for (const claim of splitClaims(entry.text, entry.file)) {
			const key = normalizeText(claim.text).toLowerCase();
			const existing = byText.get(key);
			if (existing) {
				existing.sources.push(...claim.sources);
				continue;
			}
			byText.set(key, claim);
		}
	}
	return { claims: [...byText.values()], omitted: 0 };
}

export function tokenize(text: string): string[] {
	const normalized = text.toLowerCase().replace(/node\s+--test/g, "node:test");
	const matches = normalized.match(/[a-z0-9가-힣][a-z0-9가-힣_:-]*/g) ?? [];
	const seen = new Set<string>();
	const tokens: string[] = [];
	const push = (value: string) => {
		if (value.length < 2 || STOPWORDS.has(value) || seen.has(value)) return;
		seen.add(value);
		tokens.push(value);
	};
	for (const raw of matches) {
		const value = raw.replace(/:$/, "");
		push(value);
		if (value.includes(":")) for (const part of value.split(":")) push(part);
	}
	return tokens;
}

function distinctive(tokens: string[]): string[] {
	return tokens.filter(token => !GENERIC_TOKENS.has(token));
}

interface DocLine {
	number: number;
	text: string;
	tokens: Set<string>;
}

interface Doc {
	path: string;
	lines: DocLine[];
	tokens: Set<string>;
	priority: number;
}

function docPriority(relative: string): number {
	if (relative === "SYSTEM.md" || relative === "RULES.md" || relative === "AGENTS.md") return 0;
	if (relative.startsWith("rules/")) return 1;
	if (relative === "README.md" || relative === "CONTRIBUTING.md" || relative === "SECURITY.md") return 2;
	if (relative.startsWith("docs/")) return 3;
	if (relative.endsWith("/README.md")) return 4;
	return 5;
}

function makeDoc(relative: string, text: string): Doc {
	const lines: DocLine[] = [];
	const all = new Set<string>();
	const rawLines = text.split(/\r?\n/);
	for (let index = 0; index < rawLines.length; index++) {
		const tokens = tokenize(stripMarkdown(rawLines[index]));
		if (tokens.length === 0) continue;
		for (const token of tokens) all.add(token);
		if (/^#{1,6}\s/.test(rawLines[index].trim())) continue;
		const sentences = splitSentences(stripMarkdown(rawLines[index])).filter(sentence => sentence.length >= 20);
		if (sentences.length > 1) {
			for (const sentence of sentences.slice(0, 4)) {
				const sentenceTokens = tokenize(sentence);
				if (sentenceTokens.length > 0) lines.push({ number: index + 1, text: sentence, tokens: new Set(sentenceTokens) });
			}
			continue;
		}
		lines.push({ number: index + 1, text: rawLines[index].trim(), tokens: new Set(tokens) });
	}
	return { path: relative, lines, tokens: all, priority: docPriority(relative) };
}

async function walkMarkdown(root: string, relative: string, depth: number, out: string[], limit: number): Promise<void> {
	if (out.length >= limit || depth > 3) return;
	let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
	try {
		entries = await readdir(path.join(root, relative), { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (out.length >= limit) return;
		if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "artifacts") continue;
		const child = relative ? path.join(relative, entry.name) : entry.name;
		if (entry.isDirectory()) {
			if (entry.name === "fixtures" || entry.name === "tests") continue;
			await walkMarkdown(root, child, depth + 1, out, limit);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			out.push(child);
		}
	}
}

export async function loadCanonicalDocs(projectRoot: string): Promise<Doc[]> {
	const relativePaths: string[] = [];
	for (const name of ["SYSTEM.md", "RULES.md", "AGENTS.md"]) {
		try {
			const info = await stat(path.join(projectRoot, name));
			if (info.isFile()) relativePaths.push(name);
		} catch {
			/* absent canonical file */
		}
	}
	try {
		const rules = await readdir(path.join(projectRoot, "rules"), { withFileTypes: true });
		for (const entry of rules.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.isFile() && entry.name.endsWith(".md")) relativePaths.push(path.join("rules", entry.name));
		}
	} catch {
		/* no rules directory */
	}
	for (const name of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
		try {
			const info = await stat(path.join(projectRoot, name));
			if (info.isFile()) relativePaths.push(name);
		} catch {
			/* absent */
		}
	}
	const docs: string[] = [];
	await walkMarkdown(projectRoot, "docs", 0, docs, 80);
	relativePaths.push(...docs);
	try {
		const top = await readdir(projectRoot, { withFileTypes: true });
		const pluginReadmes: string[] = [];
		for (const entry of top.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "artifacts") continue;
			try {
				const info = await lstat(path.join(projectRoot, entry.name, "README.md"));
				if (info.isFile() && !info.isSymbolicLink()) pluginReadmes.push(path.join(entry.name, "README.md"));
			} catch {
				/* no plugin README */
			}
		}
		relativePaths.push(...pluginReadmes.slice(0, 20));
	} catch {
		/* no top-level directories */
	}
	const unique = [...new Set(relativePaths)];
	const loaded: Doc[] = [];
	let total = 0;
	for (const relative of unique) {
		let text: string;
		try {
			const info = await lstat(path.join(projectRoot, relative));
			if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) continue;
			text = await readFile(path.join(projectRoot, relative), "utf8");
		} catch {
			continue;
		}
		total += byteLength(text);
		if (total > 2 * 1024 * 1024) break;
		loaded.push(makeDoc(relative.split(path.sep).join("/"), text));
	}
	return loaded.sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
}

export interface EvidenceSearch {
	evidence: EvidenceItem[];
	searchedDocs: number;
}

export function searchCanonical(claim: string, docs: Doc[]): EvidenceSearch {
	const claimTokens = tokenize(claim);
	const wanted = new Set(claimTokens);
	const wantedDistinctive = new Set(distinctive(claimTokens));
	if (wanted.size < 3 || wantedDistinctive.size < 1) return { evidence: [], searchedDocs: docs.length };
	const documentFrequency = new Map<string, number>();
	for (const doc of docs) {
		for (const token of wanted) if (doc.tokens.has(token)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
	}
	const total = docs.length;
	const idf = (token: string) => Math.log((total + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 0.1;
	const rareLimit = Math.max(2, Math.floor(total * 0.3));
	const bigrams = new Set<string>();
	for (let index = 0; index + 1 < claimTokens.length; index++) bigrams.add(`${claimTokens[index]} ${claimTokens[index + 1]}`);
	const scored: { doc: Doc; score: number; line: DocLine; matched: number; rare: number }[] = [];
	for (const doc of docs) {
		const matched = claimTokens.filter(token => doc.tokens.has(token));
		if (matched.length < 3) continue;
		const rare = matched.filter(token => (documentFrequency.get(token) ?? 0) <= rareLimit && (documentFrequency.get(token) ?? 0) > 0).length;
		let best: DocLine | null = null;
		let bestScore = 0;
		let bestMatched = 0;
		for (const line of doc.lines) {
			let lineMatched = 0;
			let score = 0;
			for (const token of wanted) {
				if (!line.tokens.has(token)) continue;
				lineMatched++;
				score += idf(token);
			}
			if (lineMatched < 2) continue;
			const lowered = line.text.toLowerCase();
			for (const bigram of bigrams) if (lowered.includes(bigram)) score += 1.2;
			if (score > bestScore) {
				bestScore = score;
				bestMatched = lineMatched;
				best = line;
			}
		}
		if (!best || bestMatched < 2) continue;
		const bestRare = claimTokens.filter(token => best.tokens.has(token) && (documentFrequency.get(token) ?? 0) <= rareLimit).length;
		if (bestMatched < 3 && bestRare === 0) continue;
		if (rare === 0 && bestMatched < 3) continue;
		const documentScore = matched.reduce((sum, token) => sum + idf(token), 0) + bestScore;
		scored.push({ doc, score: documentScore, line: best, matched: bestMatched, rare });
	}
	scored.sort((a, b) => b.score - a.score || b.rare - a.rare || a.doc.priority - b.doc.priority || a.doc.path.localeCompare(b.doc.path));
	const evidence: EvidenceItem[] = [];
	const usedDocs = new Set<string>();
	for (const candidate of scored) {
		if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
		if (usedDocs.has(candidate.doc.path)) continue;
		usedDocs.add(candidate.doc.path);
		evidence.push({
			kind: "canonical",
			citation: `${candidate.doc.path}:${candidate.line.number}`,
			excerpt: boundExcerpt(candidate.line.text),
			score: Math.round(candidate.score * 100) / 100,
		});
	}
	return { evidence, searchedDocs: docs.length };
}

function boundExcerpt(value: string): string {
	const text = stripMarkdown(value).replace(/\s+/g, " ").trim();
	return text.length > MAX_EVIDENCE_EXCERPT_CHARS ? `${text.slice(0, MAX_EVIDENCE_EXCERPT_CHARS - 1)}…` : text;
}

function extractMessageText(record: unknown): string[] {
	if (!isObject(record) || record.type !== "message" || !isObject(record.message)) return [];
	const message = record.message;
	const content = message.content;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (!isObject(part)) continue;
		if (part.type === "text" && typeof part.text === "string") out.push(part.text);
		if (part.type === "toolResult" && Array.isArray(part.content)) {
			for (const item of part.content) {
				if (isObject(item) && item.type === "text" && typeof item.text === "string") out.push(item.text);
			}
		}
	}
	return out;
}

async function transcriptFiles(agentDir: string): Promise<{ file: string; session: string }[]> {
	const sessionsRoot = path.join(agentDir, "sessions");
	let dirs: { name: string; at: number }[];
	try {
		dirs = (await readdir(sessionsRoot, { withFileTypes: true }))
			.filter(entry => entry.isDirectory() && entry.name.startsWith("v2-"))
			.map(entry => ({ name: entry.name, at: 0 }));
	} catch {
		return [];
	}
	const withTimes = await Promise.all(
		dirs.map(async entry => {
			try {
				const info = await stat(path.join(sessionsRoot, entry.name));
				return { ...entry, at: info.mtimeMs };
			} catch {
				return { ...entry, at: 0 };
			}
		}),
	);
	withTimes.sort((a, b) => b.at - a.at);
	const files: { file: string; session: string }[] = [];
	for (const dir of withTimes.slice(0, 3)) {
		let names: string[];
		try {
			names = (await readdir(path.join(sessionsRoot, dir.name))).filter(name => name.endsWith(".jsonl")).sort();
		} catch {
			continue;
		}
		for (const name of names.slice(-2)) {
			files.push({ file: path.join(sessionsRoot, dir.name, name), session: dir.name });
		}
	}
	return files;
}

export async function searchTranscripts(
	claim: string,
	agentDir: string,
	maxBytes = 4 * 1024 * 1024,
): Promise<EvidenceItem[]> {
	const claimTokens = tokenize(claim);
	const wanted = new Set(claimTokens);
	const wantedDistinctive = new Set(distinctive(claimTokens));
	if (wanted.size < 3 || wantedDistinctive.size < 1) return [];
	let remaining = maxBytes;
	const best: { citation: string; excerpt: string; score: number }[] = [];
	for (const entry of await transcriptFiles(agentDir)) {
		if (remaining <= 0) break;
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(entry.file);
		} catch {
			continue;
		}
		if (!info.isFile() || info.isSymbolicLink() || info.size > 1_500_000 || info.size > remaining) continue;
		remaining -= info.size;
		let text: string;
		try {
			text = await readFile(entry.file, "utf8");
		} catch {
			continue;
		}
		const digest = sha256Short(entry.session);
		const lines = text.split(/\r?\n/);
		for (let index = 0; index < lines.length; index++) {
			let record: unknown;
			try {
				record = JSON.parse(lines[index]);
			} catch {
				continue;
			}
			for (const block of extractMessageText(record)) {
				for (const rawLine of block.split(/\r?\n/)) {
					if (rawLine.length < 20 || rawLine.length > 2000) continue;
					const lineTokens = tokenize(rawLine);
					const matched = lineTokens.filter(token => wanted.has(token));
					if (matched.length < 3) continue;
					if (!matched.some(token => wantedDistinctive.has(token))) continue;
					const excerpt = boundExcerpt(rawLine);
					if (detectSecret(excerpt)) continue;
					best.push({
						citation: `transcript:${digest}:${index + 1}`,
						excerpt,
						score: matched.length,
					});
				}
			}
		}
		if (best.length >= 20) break;
	}
	best.sort((a, b) => b.score - a.score || a.citation.localeCompare(b.citation));
	return best.slice(0, 1).map(item => ({ kind: "transcript", citation: item.citation, excerpt: item.excerpt, score: item.score }));
}

const DATE_PATTERN = /\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/g;

export function staleDates(text: string, now: Date): { date: string; days: number }[] {
	const out: { date: string; days: number }[] = [];
	for (const match of text.matchAll(DATE_PATTERN)) {
		const year = Number(match[1]);
		const month = Number(match[2]);
		const day = Number(match[3]);
		const time = Date.UTC(year, month - 1, day);
		if (!Number.isFinite(time)) continue;
		const days = Math.floor((now.getTime() - time) / 86_400_000);
		if (days > STALE_AFTER_DAYS) out.push({ date: `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, days });
	}
	return out;
}

const SECRET_PATTERNS: { kind: string; pattern: RegExp }[] = [
	{ kind: "openai_key", pattern: /sk-[A-Za-z0-9_-]{16,}/g },
	{ kind: "github_token", pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
	{ kind: "github_pat", pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
	{ kind: "aws_key", pattern: /AKIA[0-9A-Z]{16}/g },
	{ kind: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
	{ kind: "bearer", pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/gi },
	{ kind: "assigned_secret", pattern: /(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{12,}/gi },
	{ kind: "long_base64", pattern: /[A-Za-z0-9+/]{64,}={0,2}/g },
];

export function detectSecret(text: string): string | null {
	for (const entry of SECRET_PATTERNS) {
		entry.pattern.lastIndex = 0;
		if (entry.pattern.test(text)) return entry.kind;
	}
	return null;
}

export function redactSecrets(text: string): string {
	let value = text;
	for (const entry of SECRET_PATTERNS) {
		entry.pattern.lastIndex = 0;
		value = value.replace(entry.pattern, `[REDACTED:${entry.kind}]`);
	}
	return value;
}

function ruleReferenceCandidates(name: string, projectRoot: string, agentDir: string): string[] {
	const clean = name.replace(/[.,;:]+$/, "");
	return [
		path.join(projectRoot, "rules", `${clean}.md`),
		path.join(projectRoot, ".gjc", "rules", `${clean}.md`),
		path.join(agentDir, "rules", `${clean}.md`),
		path.join(agentDir, "..", "rules", `${clean}.md`),
	];
}

export async function analyzeClaim(
	claim: RawClaim,
	projectRoot: string,
	agentDir: string,
	now: Date,
): Promise<ClaimFlags> {
	const flags: ClaimFlags = {
		deadReferences: [],
		maskedReferences: [],
		missingPaths: [],
		staleDates: staleDates(claim.text, now),
		secret: detectSecret(claim.text),
		evidenceSecretDropped: false,
	};
	for (const match of claim.text.matchAll(/rule:\/\/([^\s)>},;]+)/g)) {
		const reference = match[1]?.replace(/[.,;:]+$/, "");
		if (!reference) continue;
		if (/redacted|\[|\]|\*{3,}/i.test(reference)) {
			flags.maskedReferences.push(reference);
			continue;
		}
		const candidates = ruleReferenceCandidates(reference, projectRoot, agentDir);
		let exists = false;
		for (const candidate of candidates) {
			try {
				const info = await stat(candidate);
				if (info.isFile()) {
					exists = true;
					break;
				}
			} catch {
				/* keep checking */
			}
		}
		if (!exists) flags.deadReferences.push(reference);
	}
	for (const match of claim.text.matchAll(/`((?:~\/|\/|\.\/)[^`\s]+)`/g)) {
		const value = match[1];
		if (!value || value.includes("*") || value.includes("://")) continue;
		const expanded = expandHome(value, path.join(agentDir, "..", ".."));
		const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
		const withinProject = !path.relative(projectRoot, absolute).startsWith("..");
		const withinHome = !path.relative(path.dirname(path.dirname(agentDir)), absolute).startsWith("..");
		if (!withinProject && !withinHome) continue;
		try {
			await stat(absolute);
		} catch {
			flags.missingPaths.push(value);
		}
	}
	return flags;
}

export interface JevConfig {
	key: string | null;
	providerOff: boolean;
	source: "env" | "file" | null;
}

export function readEnvFile(file: string): Record<string, string> {
	const values: Record<string, string> = {};
	try {
		const text = readFileSync(file, "utf8");
		for (const line of text.split(/\r?\n/)) {
			const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
			if (!match) continue;
			values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
		}
	} catch {
		/* missing credential files are a documented keyless state */
	}
	return values;
}

/**
 * Small synchronous reader for the hook-safe path. The tool calls it once per
 * run, never inside a loop. The require() indirection keeps the generated
 * bundle free of a second node:fs import alias.
 */


export function resolveJevConfig(
	env: Record<string, string | undefined>,
	envFile: string,
): JevConfig {
	const fileEnv = readEnvFile(envFile);
	const merged = { ...fileEnv, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) } as Record<
		string,
		string | undefined
	>;
	const provider = merged.JEV_ADVISOR_PROVIDER?.trim().toLowerCase();
	if (provider === "off") return { key: null, providerOff: true, source: null };
	for (const name of ["JEV_ADVISOR_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_DECISION_API_KEY"]) {
		const value = merged[name]?.trim();
		if (value) return { key: value, providerOff: false, source: env[name] ? "env" : "file" };
	}
	return { key: null, providerOff: false, source: null };
}

export function buildJevArtifact(claim: string, evidence: EvidenceItem[]): string {
	const parts = [`CLAIM:\n${claim.slice(0, MAX_CLAIM_CHARS)}`, "", "EVIDENCE:"];
	for (const item of evidence.slice(0, MAX_EVIDENCE_ITEMS)) {
		parts.push(`[${item.kind}] ${item.citation}\n${item.excerpt.slice(0, MAX_EVIDENCE_EXCERPT_CHARS)}`);
	}
	let text = parts.join("\n");
	if (text.length > MAX_ARTIFACT_CHARS) {
		text = text.slice(0, MAX_ARTIFACT_CHARS - 1) + "…";
	}
	return text;
}

function noDecision(reason: NoDecisionReason, httpStatus?: number): JevNoDecision {
	return httpStatus === undefined ? { status: "no_decision", reason } : { status: "no_decision", reason, httpStatus };
}

function validVerdict(value: unknown): CheckVerdict | null {
	if (typeof value !== "string") return null;
	const verdict = value.trim().toLowerCase();
	return CHECK_VERDICTS.includes(verdict as CheckVerdict) ? (verdict as CheckVerdict) : null;
}

function validProbabilityMap(value: unknown): Record<CheckVerdict, number> | null {
	if (!isObject(value) || Object.keys(value).length !== CHECK_VERDICTS.length) return null;
	const probabilities = {} as Record<CheckVerdict, number>;
	for (const verdict of CHECK_VERDICTS) {
		const probability = value[verdict];
		if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
		probabilities[verdict] = probability;
	}
	const sum = CHECK_VERDICTS.reduce((total, verdict) => total + probabilities[verdict], 0);
	return Math.abs(sum - 1) <= 0.001 + Number.EPSILON * 4 ? probabilities : null;
}

export function parseJevResponse(status: number, text: string): JevOutcome {
	if (status === 401) return noDecision("http_auth", status);
	if (status === 402) return noDecision("http_credit", status);
	if (status === 429) return noDecision("http_rate", status);
	if (status >= 500) return noDecision("http_server", status);
	if (status < 200 || status >= 300) return noDecision("http_error", status);
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return noDecision("invalid_response");
	}
	if (!isObject(data) || !isObject(data.answers) || !isObject(data.answers.consistency)) return noDecision("invalid_response");
	const answer = data.answers.consistency;
	if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
		return noDecision("invalid_response");
	}
	const verdict = validVerdict(answer.choice);
	if (!verdict) return noDecision("invalid_response");
	let probabilities: Record<CheckVerdict, number> | undefined;
	if (answer.probabilities !== undefined) {
		const parsed = validProbabilityMap(answer.probabilities);
		if (!parsed) return noDecision("invalid_response");
		probabilities = parsed;
	}
	if (answer.rationale !== undefined && typeof answer.rationale !== "string") return noDecision("invalid_response");
	const rationale = typeof answer.rationale === "string" ? answer.rationale.slice(0, 120) : undefined;
	return {
		status: "decision",
		verdict,
		confidence: answer.confidence,
		...(probabilities ? { probabilities } : {}),
		confidenceKind: "provider_choice",
		...(rationale ? { rationale } : {}),
	};
}

async function readBoundedResponse(response: Response): Promise<string | null> {
	const length = response.headers.get("content-length");
	if (length && Number.isFinite(Number(length)) && Number(length) > MAX_RESPONSE_BYTES) return null;
	if (!response.body || typeof response.body.getReader !== "function") return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			if (!part.value) continue;
			size += part.value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				try {
					await reader.cancel();
				} catch {
					/* ignore */
				}
				return null;
			}
			chunks.push(part.value);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* ignore */
		}
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return Buffer.from(bytes).toString("utf8");
}

export async function askJev(
	claim: string,
	evidence: EvidenceItem[],
	config: JevConfig,
	fetchImpl: FetchLike | undefined,
	signal: AbortSignal | undefined,
	timeoutMs = JEV_TIMEOUT_MS,
): Promise<JevOutcome> {
	if (config.providerOff) return noDecision("disabled");
	if (!config.key) return noDecision("unconfigured");
	const endpoint = new URL(JEV_ENDPOINT);
	if (endpoint.protocol !== "https:" || endpoint.origin !== "https://openrouter.ai") return noDecision("invalid_endpoint");
	const artifact = buildJevArtifact(claim, evidence);
	const body = JSON.stringify({
		model: JEV_MODEL,
		state: artifact,
		questions: {
			consistency: {
				type: "choice",
				instructions: "Is the memory claim consistent with the cited canonical or transcript evidence?",
				criteria: {
					correct: "The evidence supports the claim as stated.",
					incorrect: "The evidence contradicts the claim as stated.",
					unsure: "The evidence is insufficient to decide.",
				},
			},
		},
	});
	if (byteLength(body) > 16 * 1024) return noDecision("input_too_large");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) {
			clearTimeout(timeout);
			return noDecision("aborted");
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const response = await (fetchImpl ?? fetch)(JEV_ENDPOINT, {
			method: "POST",
			redirect: "manual",
			signal: controller.signal,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${config.key}`,
				"http-referer": "https://github.com/jjongguet/gjc-plugin",
				"x-title": "memory-dream",
			},
			body,
		});
		if (response.status >= 300 && response.status < 400 || response.redirected) {
			try {
				await response.body?.cancel();
			} catch {
				/* ignore */
			}
			return noDecision("redirect", response.status);
		}
		if (!response.ok) {
			try {
				await response.body?.cancel();
			} catch {
				/* ignore */
			}
			return parseJevResponse(response.status, "");
		}
		const text = await readBoundedResponse(response);
		if (text === null) return noDecision("invalid_response");
		return parseJevResponse(response.status, text);
	} catch {
		return noDecision(controller.signal.aborted ? "timeout" : "provider_error");
	} finally {
		clearTimeout(timeout);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

export function verdictFor(
	jev: JevOutcome,
	evidence: EvidenceItem[],
	confidenceThreshold: number,
): { verdict: ClaimVerdict; basis: "jev" | "none"; confidence: number | null; reason?: string } {
	if (jev.status === "no_decision") return { verdict: "no-decision", basis: "none", confidence: null, reason: jev.reason };
	if (jev.verdict === "correct") return { verdict: "supported", basis: "jev", confidence: jev.confidence };
	if (jev.verdict === "unsure") return { verdict: "unverified", basis: "jev", confidence: jev.confidence, reason: "unsure" };
	const hasCanonical = evidence.some(item => item.kind === "canonical");
	if (!hasCanonical) return { verdict: "unverified", basis: "jev", confidence: jev.confidence, reason: "no_canonical_evidence" };
	if (jev.confidence < confidenceThreshold) {
		return { verdict: "unverified", basis: "jev", confidence: jev.confidence, reason: "below_threshold" };
	}
	return { verdict: "contradicted", basis: "jev", confidence: jev.confidence };
}

function correctionFor(evidence: EvidenceItem[]): string | null {
	const canonical = evidence.find(item => item.kind === "canonical");
	if (!canonical) return null;
	return `Canonical evidence at ${canonical.citation} states: "${canonical.excerpt}". Rewrite the note to match it; do not edit GJC memory files directly.`;
}

export interface ClaimAnalysisDeps {
	projectRoot: string;
	agentDir: string;
	now: Date;
	jevConfig: JevConfig;
	documents: Doc[];
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
	transcriptSearch: boolean;
	confidenceThreshold: number;
	callJev: boolean;
}

export async function analyzeClaimForReport(
	claim: RawClaim,
	deps: ClaimAnalysisDeps,
	options: { callJev: boolean; capReached?: boolean },
): Promise<ClaimReport> {
	const flags = await analyzeClaim(claim, deps.projectRoot, deps.agentDir, deps.now);
	let evidence = flags.secret ? [] : searchCanonical(claim.text, deps.documents).evidence;
	if (evidence.length === 0 && !flags.secret && deps.transcriptSearch) {
		evidence = await searchTranscripts(claim.text, deps.agentDir);
	}
	const safeEvidence: EvidenceItem[] = [];
	for (const item of evidence) {
		if (detectSecret(item.excerpt)) {
			flags.evidenceSecretDropped = true;
			continue;
		}
		safeEvidence.push({ ...item, excerpt: redactSecrets(item.excerpt) });
	}
	const report: ClaimReport = {
		id: claim.id,
		text: flags.secret ? redactSecrets(claim.text) : claim.text,
		sources: claim.sources,
		verdict: "unverified",
		basis: "none",
		confidence: null,
		jev: null,
		evidence: safeEvidence,
		correction: null,
		flags,
		externalSend: false,
	};
	if (flags.secret) {
		report.reason = "secret_blocked";
		return report;
	}
	if (safeEvidence.length === 0) {
		report.reason = "no_evidence";
		return report;
	}
	if (options.capReached) {
		report.reason = "jev_cap";
		return report;
	}
	if (!options.callJev) {
		report.verdict = "no-decision";
		report.reason = "disabled";
		return report;
	}
	report.externalSend = Boolean(deps.jevConfig.key) && !deps.jevConfig.providerOff;
	const jev = await askJev(claim.text, safeEvidence, deps.jevConfig, deps.fetchImpl, deps.signal);
	report.jev = jev;
	const mapped = verdictFor(jev, safeEvidence, deps.confidenceThreshold);
	report.verdict = mapped.verdict;
	report.basis = mapped.basis;
	report.confidence = mapped.confidence;
	if (mapped.reason) report.reason = mapped.reason;
	if (mapped.verdict === "contradicted") report.correction = correctionFor(safeEvidence);
	return report;
}

function countVerdicts(claims: ClaimReport[]): DreamReport["counts"] {
	return {
		claims: claims.length,
		omittedClaims: 0,
		supported: claims.filter(claim => claim.verdict === "supported").length,
		contradicted: claims.filter(claim => claim.verdict === "contradicted").length,
		unverified: claims.filter(claim => claim.verdict === "unverified").length,
		noDecision: claims.filter(claim => claim.verdict === "no-decision").length,
		sentToJev: claims.filter(claim => claim.externalSend).length,
		secretsBlocked: claims.filter(claim => claim.flags.secret !== null).length,
		jevCallsSkippedByCap: claims.filter(claim => claim.reason === "jev_cap").length,
	};
}

function latestPayload(report: DreamReport, reportId: string): Record<string, unknown> {
	const contradicted = report.claims
		.filter(claim => claim.verdict === "contradicted")
		.slice(0, 5)
		.map(claim => ({
			claim: claim.text.slice(0, 180),
			citation: claim.evidence.find(item => item.kind === "canonical")?.citation ?? claim.sources[0]?.file ?? "unknown",
			confidence: claim.confidence,
		}));
	return {
		schema: LATEST_SCHEMA,
		generatedAt: report.generatedAt,
		reportId,
		reportPath: `reports/${reportId}/report.json`,
		counts: report.counts,
		confidenceThreshold: report.confidenceThreshold,
		contradicted,
	};
}

export async function ensurePrivateDirectory(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const info = await lstat(dir);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe_results_directory");
	if ((info.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
}

export async function writePrivateFile(file: string, text: string): Promise<void> {
	const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	await writeFile(temp, text, { mode: 0o600, flag: "wx" });
	await rename(temp, file);
	const info = await lstat(file);
	if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) {
		throw new Error("unsafe_report_file");
	}
}

export function renderMarkdown(report: DreamReport): string {
	const lines: string[] = [];
	lines.push("# memory-dream report");
	lines.push("");
	lines.push(`- generated: ${report.generatedAt}`);
	lines.push(`- model: ${report.model} (${report.provider})`);
	lines.push(`- prompt: ${report.promptVersion}`);
	lines.push(`- memory scope: ${report.memory.dir}`);
	lines.push(`- canonical project: ${report.memory.projectRoot}`);
	lines.push(`- memory files unchanged during run: ${report.memory.unchanged ? "yes" : "NO"}`);
	lines.push("");
	lines.push("## Counts");
	lines.push("");
	lines.push(`- claims: ${report.counts.claims} (omitted: ${report.counts.omittedClaims})`);
	lines.push(`- supported: ${report.counts.supported}`);
	lines.push(`- contradicted: ${report.counts.contradicted}`);
	lines.push(`- unverified: ${report.counts.unverified}`);
	lines.push(`- no-decision: ${report.counts.noDecision}`);
	lines.push(`- sent to jev: ${report.counts.sentToJev}`);
	lines.push(`- secret claims blocked: ${report.counts.secretsBlocked}`);
	lines.push("");
	lines.push("## Injection budget");
	lines.push("");
	for (const budget of report.budgets) {
		lines.push(
			`- ${budget.file}: ${budget.bytes}B/${budget.lines} lines (max ${budget.maxBytes}B/${budget.maxLines}) — ${budget.status}`,
		);
	}
	lines.push("");
	lines.push("## Deterministic checks");
	lines.push("");
	const maskedReferences = report.deterministic.deadReferences.filter(item => item.reason === "masked").length;
	lines.push(`- rule references: ${report.deterministic.deadReferences.length - maskedReferences} missing, ${maskedReferences} masked`);
	lines.push(`- missing paths: ${report.deterministic.missingPaths.length}`);
	lines.push(`- stale dated facts: ${report.deterministic.staleFacts.length}`);
	const sections: { verdict: ClaimVerdict; title: string }[] = [
		{ verdict: "contradicted", title: "Contradicted" },
		{ verdict: "supported", title: "Supported" },
		{ verdict: "unverified", title: "Unverified" },
		{ verdict: "no-decision", title: "No decision" },
	];
	for (const section of sections) {
		const claims = report.claims.filter(claim => claim.verdict === section.verdict);
		if (claims.length === 0) continue;
		lines.push("");
		lines.push(`## ${section.title} (${claims.length})`);
		for (const claim of claims) {
			const source = claim.sources.map(item => `${item.file}:${item.line}`).join(", ");
			lines.push("");
			lines.push(`### ${claim.id} — ${source}`);
			lines.push("");
			lines.push(claim.text);
			if (claim.jev?.status === "decision") {
				lines.push("");
				lines.push(`- jev: ${claim.jev.verdict} confidence=${claim.jev.confidence.toFixed(2)}`);
			} else if (claim.jev?.status === "no_decision") {
				lines.push("");
				lines.push(`- jev: no_decision (${claim.jev.reason})`);
			}
			for (const evidence of claim.evidence) {
				lines.push(`- evidence [${evidence.kind}] ${evidence.citation}: ${evidence.excerpt}`);
			}
			if (claim.correction) {
				lines.push("");
				lines.push(`- correction: ${claim.correction}`);
			}
			if (claim.reason) lines.push(`- reason: ${claim.reason}`);
		}
	}
	lines.push("");
	lines.push("## Limitations");
	for (const limitation of report.limitations) lines.push(`- ${limitation}`);
	lines.push("");
	return lines.join("\n");
}

export function limitations(): string[] {
	return [
		"The report is advisory; it does not prove a memory note is true or that the cited evidence is complete.",
		"GJC regenerates MEMORY.md and memory_summary.md; this tool never edits them and cannot guarantee a correction is adopted.",
		"Canonical evidence search is lexical and bounded; a missing citation is not proof that no evidence exists.",
		"Transcript evidence is a bounded excerpt from a recent local session, not a canonical source.",
		"Jev receives only the bounded claim and cited excerpts; secret-shaped claims are not sent, and every verdict is advisory.",
		"No periodic execution: the tool runs only when explicitly invoked.",
	];
}

export async function runDream(options: DreamOptions): Promise<DreamResult> {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const agentDir = options.agentDir ?? path.resolve(env.MEMORY_DREAM_AGENT_DIR ?? path.join(home, ".gjc", "agent"));
	const projectRoot = path.resolve(expandHome(options.projectRoot ?? options.cwd, home));
	const memoryDir = options.memoryDir
		? path.resolve(expandHome(options.memoryDir, home))
		: memoryRootFor(agentDir, path.resolve(options.cwd));
	const memoriesRoot = path.join(agentDir, "memories");
	const relative = path.relative(memoriesRoot, memoryDir);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("memory_dir_outside_memories_root");
	const memoryInfo = await lstat(memoryDir);
	if (memoryInfo.isSymbolicLink() || !memoryInfo.isDirectory()) throw new Error("memory_dir_not_a_directory");
	const now = options.now ?? new Date();
	const envFile = options.envFile ?? path.join(agentDir, "jev-advisor", ".env");
	const jevConfig = resolveJevConfig(env, envFile);
	const maxClaims = Math.min(Math.max(1, options.maxClaims ?? DEFAULT_MAX_CLAIMS), MAX_CLAIMS);
	const maxJevCalls = Math.min(Math.max(1, options.maxJevCalls ?? DEFAULT_MAX_JEV_CALLS), MAX_JEV_CALLS);
	const confidenceThreshold = Math.min(1, Math.max(0, options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD));

	const memoryFiles: { file: string; text: string; facts: MemoryFileFacts }[] = [];
	for (const name of MEMORY_FILES) {
		try {
			memoryFiles.push({ file: name, ...(await readMemoryFile(path.join(memoryDir, name))) });
		} catch (error) {
			if (isMissing(error)) continue;
			throw error;
		}
	}
	if (memoryFiles.length === 0) throw new Error("no_memory_files");
	const budgets = memoryFiles.map(entry => budgetFor(entry.file, entry.text));
	const collected = collectClaims(memoryFiles.map(entry => ({ file: entry.file, text: entry.text })));
	const documents = await loadCanonicalDocs(projectRoot);
	const claims = collected.claims.slice(0, maxClaims);
	const omittedClaims = collected.claims.length - claims.length;
	const deps: ClaimAnalysisDeps = {
		projectRoot,
		agentDir,
		now,
		jevConfig,
		documents,
		fetchImpl: options.fetchImpl,
		signal: options.signal,
		transcriptSearch: options.transcriptSearch ?? true,
		confidenceThreshold,
		callJev: options.jev === true,
	};
	const reports: ClaimReport[] = [];
	let jevCalls = 0;
	for (const claim of claims) {
		if (options.signal?.aborted) {
			reports.push({
				id: claim.id,
				text: claim.text,
				sources: claim.sources,
				verdict: "no-decision",
				basis: "none",
				confidence: null,
				jev: null,
				evidence: [],
				correction: null,
				flags: {
					deadReferences: [],
					maskedReferences: [],
					missingPaths: [],
					staleDates: [],
					secret: null,
					evidenceSecretDropped: false,
				},
				externalSend: false,
				reason: "aborted",
			});
			continue;
		}
		const report = await analyzeClaimForReport(claim, deps, {
			callJev: deps.callJev,
			capReached: jevCalls >= maxJevCalls,
		});
		if (report.externalSend) jevCalls++;
		reports.push(report);
	}

	const after: Record<string, string> = {};
	for (const entry of memoryFiles) {
		try {
			after[entry.file] = sha256(await readPrivateText(path.join(memoryDir, entry.file), 1_000_000));
		} catch {
			after[entry.file] = "unreadable";
		}
	}
	const facts = memoryFiles.map(entry => ({
		...entry.facts,
		sha256After: after[entry.file],
	}));
	const unchanged = facts.every(fact => fact.sha256Before === fact.sha256After);
	const counts = countVerdicts(reports);
	counts.omittedClaims = omittedClaims;
	const report: DreamReport = {
		schema: REPORT_SCHEMA,
		generatedAt: now.toISOString(),
		promptVersion: PROMPT_VERSION,
		model: JEV_MODEL,
		provider: JEV_PROVIDER,
		memory: {
			dir: memoryDir,
			projectRoot,
			files: facts,
			unchanged,
		},
		budgets,
		deterministic: {
			deadReferences: reports.flatMap(claim =>
				claim.flags.deadReferences.map(reference => ({ claimId: claim.id, reference, reason: "missing" })),
			),
			missingPaths: reports.flatMap(claim =>
				claim.flags.missingPaths.map(value => ({ claimId: claim.id, value })),
			),
			staleFacts: reports.flatMap(claim =>
				claim.flags.staleDates.map(item => ({ claimId: claim.id, date: item.date, days: item.days })),
			),
			secretClaims: reports.filter(claim => claim.flags.secret !== null).length,
		},
		claims: reports,
		counts,
		confidenceThreshold,
		maxJevCalls,
		limitations: limitations(),
	};
	const deadFromMasked = reports.flatMap(claim =>
		claim.flags.maskedReferences.map(reference => ({ claimId: claim.id, reference, reason: "masked" })),
	);
	report.deterministic.deadReferences.push(...deadFromMasked);

	let reportPath: string | null = null;
	let markdownPath: string | null = null;
	let latestPath: string | null = null;
	if (options.writeReports !== false) {
		const resultsRoot = options.resultsRoot ?? defaultResultsRoot(home, env);
		const reportId = `${now.toISOString().replace(/[:.]/g, "-")}-${sha256Short(JSON.stringify(reports)).slice(0, 8)}`;
		const dir = path.join(resultsRoot, "reports", reportId);
		await ensurePrivateDirectory(path.join(resultsRoot, "reports"));
		await ensurePrivateDirectory(dir);
		reportPath = path.join(dir, "report.json");
		markdownPath = path.join(dir, "report.md");
		await writePrivateFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		await writePrivateFile(markdownPath, renderMarkdown(report));
		latestPath = path.join(resultsRoot, "latest.json");
		await writePrivateFile(latestPath, `${JSON.stringify(latestPayload(report, reportId), null, 2)}\n`);
	}
	return { report, reportPath, markdownPath, latestPath };
}
