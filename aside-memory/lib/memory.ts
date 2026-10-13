import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

const WARNINGS = ["memory_not_authorization", "relevance_not_truth", "observation_time_unknown", "privacy_filter_incomplete", "aside_network_and_retention_unknown", "host_transcript_retention_not_controlled", "non_atomic_retrieval"];
const ACCOUNT = /^u?(0|[1-9][0-9]{0,9})$/;
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const ROW_KEYS = ["path", "title", "headings", "excerpt", "line", "lineEnd", "score", "chunkId"];
type Stage = "validation" | "root" | "search" | "parse" | "minimize" | "done";
type Binding = "parameter" | "configuration" | null;
type Row = { path: string; title: string; headings: string[]; excerpt: string; line: number; lineEnd: number; score: number; chunkId: string };
type Source = { sourceId: string; path: string; matchRange: { startLine: number; endLine: number; kind: "cli_match" }; relevanceScore: number; fileUpdatedAt: null; observationTime: null; omittedBlocks: boolean; snippets: string[] };
export type MemoryResult = {
	schemaVersion: 1; operation: "aside_memory"; status: "ok" | "empty" | "withheld" | "unavailable" | "error"; reason: string;
	trust: "untrusted_historical_data"; accountBinding: Binding; retrievedAt: string | null;
	counts: { matches: number | null; returned: number; withheld: number | null; duplicates: number | null };
	briefing: Source[]; diagnosticStage: Stage; warnings: string[];
};
type Dependencies = { spawn?: typeof spawn; env?: NodeJS.ProcessEnv; now?: () => number; date?: () => Date };
type ChildResult = { reason?: string; stdout?: string; cleanupUnconfirmed?: boolean };

function envelope(status: MemoryResult["status"], reason: string, diagnosticStage: Stage, accountBinding: Binding): MemoryResult {
	return { schemaVersion: 1, operation: "aside_memory", status, reason, trust: "untrusted_historical_data", accountBinding, retrievedAt: null,
		counts: { matches: null, returned: 0, withheld: null, duplicates: null }, briefing: [], diagnosticStage, warnings: [...WARNINGS] };
}
function bytes(text: string) { return Buffer.byteLength(text, "utf8"); }
function validPathText(text: string) {
	return !!text && !FORBIDDEN.test(text) && !text.includes("\\") && !text.includes(":") && !text.includes("//") && !text.split(path.sep).some(part => part === "." || part === "..");
}
function rootPath(stdout: string) {
	const root = stdout.replace(/\r?\n$/, "");
	if (!validPathText(root) || !path.isAbsolute(root) || path.parse(root).root === root) return null;
	return path.normalize(root);
}
function relativeCitation(root: string, candidate: string) {
	if (!validPathText(candidate) || !path.isAbsolute(candidate) || !/\.md$/i.test(candidate)) return null;
	const relative = path.relative(root, candidate);
	if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => part === "..") || bytes(relative) > 512) return null;
	return relative.split(path.sep).join("/");
}

// Finite whole-block screening, not a guarantee against obfuscated secrets or instructions.
const SENSITIVE_PATH = /(?:^|[/_. -])(?:secrets?|credentials?|tokens?|passwords?|private[-_ ]?keys?|auth|payments?|contacts?|addresses?|identity|비밀|인증|연락처|주소|주민)(?:$|[/_. -])/i;
const PRIVATE_CITATION = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b0\d{1,2}[- ]\d{3,4}[- ]\d{4}\b|\+\d{10,15}/i;
const UNSAFE = [
	/[\p{Cc}\p{Cf}\p{Cs}]/u,
	/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|\[[^\]]*\]\s*\(|<\/?[a-z!]|`|!\[)/i,
	/(?:-----BEGIN|\b(?:sk-|gh[pousr]_|AKIA)[a-z0-9_-]{8,}|\bBearer\s+\S+)/i,
	/\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|passwd|secret|private[ _-]?key|credential|cookie|authorization|credit[ -]?card|bank[ -]?account|social[ -]?security|ssn)\b/i,
	/(?:비밀번호|패스워드|비밀\s*키|인증\s*(?:키|토큰|번호)|주민등록|계좌\s*번호|카드\s*번호|전화\s*번호|이메일|주소\s*[:：])/i,
	/(?:[가-힣]+(?:시|도)\s+[가-힣]+(?:구|군)\s+\S+(?:로|길|동)\s*\d)/u,
	/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
	/(?:\+?\d[\d ()-]{7,}\d|\b\d{1,5}\s+(?:[a-z]+\s+){1,4}(?:street|st|road|rd|avenue|ave)\b)/i,
	/\b(?:ignore|override|disregard|bypass|replace|disable)\b.{0,80}\b(?:instructions?|rules?|policy|policies|safety|permissions?|authorization|system|developer)\b/i,
	/\b(?:system|developer)\s*(?:prompt|message|role)|\b(?:exfiltrat\w*|execute|run|invoke)\b.{0,80}\b(?:commands?|shell|sudo|curl|bash|scripts?|tools?)\b/i,
	/\b(?:grant|change|escalate|revoke)\b.{0,60}\b(?:permissions?|authorization|access)\b|\b(?:send|upload|transmit)\b.{0,60}\b(?:data|files?|memories|credentials?)\b/i,
	/\byou are (?:now )?authorized\b|\b(?:sudo|curl|wget)\s+\S+|\brm\s+-[a-z]*[rf]/i,
	/(?:규칙|지침|정책|시스템|권한).{0,40}(?:무시|우회|덮어|변경|해제)|(?:명령|셸|스크립트).{0,30}실행|(?:유출|탈취)/i,
];
function selectBlocks(excerpt: string) {
	const blocks = excerpt.replace(/\r\n/g, "\n").split(/\n[ \t]*\n/);
	const snippets: string[] = [];
	let fenced = false;
	let omitted = false;
	for (const block of blocks) {
		const fenceCount = (block.match(/^[ \t]*(?:```|~~~)/gm) ?? []).length;
		const inFence = fenced || fenceCount > 0;
		if (fenceCount % 2) fenced = !fenced;
		const text = block.trim();
		// Whitespace-only separators carry no content; they are not omissions.
		if (!text) continue;
		// Newlines/tabs are prose layout; all other controls remain unsafe.
		const screen = text.replace(/[\n\t]/g, " ");
		if (inFence || UNSAFE.some(pattern => pattern.test(screen)) || bytes(text) > 600 || snippets.length === 2) { omitted = true; continue; }
		snippets.push(text);
	}
	return { snippets, omitted };
}
function compareText(a: string, b: string) {
	const aa = Array.from(a, char => char.codePointAt(0)!);
	const bb = Array.from(b, char => char.codePointAt(0)!);
	for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
	return aa.length - bb.length;
}

export function memoryBriefing(stdout: string, root: string, limit: number, binding: Binding, date: () => Date = () => new Date()): MemoryResult {
	let raw: unknown;
	try { raw = JSON.parse(stdout); } catch { return envelope("error", "invalid_json", "parse", binding); }
	if (!Array.isArray(raw) || raw.length > limit) return envelope("error", "invalid_search_response", "parse", binding);
	const rows: (Row & { relative: string })[] = [];
	for (const row of raw) {
		if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== ROW_KEYS.length || !ROW_KEYS.every(key => Object.hasOwn(row, key)) ||
			typeof row.path !== "string" || typeof row.title !== "string" || typeof row.excerpt !== "string" || !Array.isArray(row.headings) || !row.headings.every((h: unknown) => typeof h === "string") ||
			!Number.isSafeInteger(row.line) || row.line < 1 || !Number.isSafeInteger(row.lineEnd) || row.lineEnd < row.line || typeof row.score !== "number" || !Number.isFinite(row.score) || typeof row.chunkId !== "string" || !/^[a-f0-9]{64}$/i.test(row.chunkId))
			return envelope("error", "invalid_search_response", "parse", binding);
		const relative = relativeCitation(root, row.path);
		if (relative === null) return envelope("error", "unsafe_result_path", "parse", binding);
		rows.push({ ...row, relative });
	}
	rows.sort((a, b) => b.score - a.score || compareText(a.relative, b.relative) || a.line - b.line || a.lineEnd - b.lineEnd || compareText(a.chunkId, b.chunkId));
	const identities = new Map<string, string>();
	const briefing: Source[] = [];
	let duplicates = 0;
	let withheld = 0;
	let omissions = false;
	for (const row of rows) {
		const identity = JSON.stringify([row.relative, row.line, row.lineEnd, row.chunkId]);
		if (identities.has(identity)) {
			if (identities.get(identity) !== row.excerpt) return envelope("error", "invalid_search_response", "parse", binding);
			duplicates++; continue;
		}
		identities.set(identity, row.excerpt);
		const selected = selectBlocks(row.excerpt);
		if (SENSITIVE_PATH.test(row.relative) || PRIVATE_CITATION.test(row.relative) || selected.snippets.length === 0) { withheld++; omissions = true; continue; }
		omissions ||= selected.omitted;
		briefing.push({ sourceId: `m${briefing.length + 1}`, path: row.relative, matchRange: { startLine: row.line, endLine: row.lineEnd, kind: "cli_match" }, relevanceScore: row.score,
			fileUpdatedAt: null, observationTime: null, omittedBlocks: selected.omitted, snippets: selected.snippets });
	}
	const result = envelope(briefing.length ? "ok" : rows.length ? "withheld" : "empty", briefing.length ? "results_returned" : rows.length ? "no_safe_excerpt" : "no_matches", "done", binding);
	result.retrievedAt = date().toISOString();
	result.counts = { matches: rows.length, returned: briefing.length, withheld, duplicates };
	result.briefing = briefing;
	if (omissions) result.warnings.push("content_withheld");
	if (bytes(JSON.stringify(result)) > 16384) return envelope("error", "result_overflow", "minimize", binding);
	return result;
}

export function memoryChild(args: string[], cap: number, timeoutMs: number, dependencies: Dependencies = {}): Promise<ChildResult> {
	return new Promise(resolve => {
		let child: ReturnType<typeof spawn>;
		let settled = false;
		let stopping: string | undefined;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let chunks: Buffer[] = [];
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let cleanup: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: ChildResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline); clearTimeout(cleanup);
			chunks = [];
			child?.stdout?.removeListener("data", onStdout);
			child?.stderr?.removeListener("data", onStderr);
			child?.removeListener("error", onError);
			child?.removeListener("close", onClose);
			child?.stdout?.destroy(); child?.stderr?.destroy();
			resolve(result);
		};
		const stop = (reason: string) => {
			if (settled || stopping) return;
			stopping = reason; chunks = [];
			try { child.kill("SIGKILL"); } catch { /* Cleanup deadline reports uncertainty. */ }
			cleanup = setTimeout(() => finish({ reason, cleanupUnconfirmed: true }), 250);
		};
		const onStdout = (chunk: Buffer | string) => {
			if (settled || stopping) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			stdoutBytes += buffer.byteLength;
			if (stdoutBytes > cap) { stop("output_overflow"); return; }
			chunks.push(buffer);
		};
		const onStderr = (chunk: Buffer | string) => {
			if (settled || stopping) return;
			stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
			if (stderrBytes > 4096) stop("output_overflow");
		};
		const onError = (error: NodeJS.ErrnoException) => {
			if (stopping) return;
			const reason = error.code === "ENOENT" ? "cli_not_found" : error.code === "EACCES" ? "cli_not_executable" : "spawn_failed";
			if (child.pid) stop(reason); else finish({ reason });
		};
		const onClose = (code: number | null) => {
			if (stopping) { finish({ reason: stopping }); return; }
			if (code !== 0) { finish({ reason: "cli_nonzero" }); return; }
			try { finish({ stdout: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) }); }
			catch { finish({ reason: "invalid_utf8" }); }
		};
		try { child = (dependencies.spawn ?? spawn)("aside", args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: dependencies.env ?? process.env }); }
		catch { resolve({ reason: "spawn_failed" }); return; }
		child.stdout?.on("data", onStdout); child.stderr?.on("data", onStderr);
		child.on("error", onError); child.on("close", onClose);
		deadline = setTimeout(() => stop("timeout"), Math.max(0, timeoutMs));
	});
}

export async function asideMemory(input: unknown, dependencies: Dependencies = {}): Promise<MemoryResult> {
	let binding: Binding = null;
	const fail = (reason: string, stage: Stage = "validation", cleanup = false) => {
		const result = envelope(["account_required", "invalid_account_configuration", "cli_not_found", "cli_not_executable"].includes(reason) ? "unavailable" : "error", reason, stage, binding);
		if (cleanup) result.warnings.push("cli_cleanup_unconfirmed");
		return result;
	};
	if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input");
	const params = input as Record<string, unknown>;
	if (Object.keys(params).some(key => !["query", "account", "max_results"].includes(key)) || !Object.hasOwn(params, "query") || typeof params.query !== "string" || FORBIDDEN.test(params.query)) return fail("invalid_input");
	const query = params.query.trim();
	if (!query || query.startsWith("-") || Array.from(query).length > 300 || bytes(query) > 1200) return fail("invalid_input");
	const limit = Object.hasOwn(params, "max_results") ? params.max_results : 3;
	if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 5) return fail("invalid_input");
	const env = dependencies.env ?? process.env;
	let account: string;
	if (Object.hasOwn(params, "account")) {
		if (typeof params.account !== "string" || !ACCOUNT.test(params.account)) return fail("invalid_input");
		account = params.account; binding = "parameter";
	} else {
		const configured = env.GJC_ASIDE_MEMORY_ACCOUNT;
		if (!configured) return fail("account_required");
		if (!ACCOUNT.test(configured)) return fail("invalid_account_configuration");
		account = configured; binding = "configuration";
	}
	const now = dependencies.now ?? (() => performance.now());
	const start = now();
	const rootResult = await memoryChild(["--account", account, "memory", "path"], 8192, 5000, dependencies);
	if (rootResult.reason) return fail(rootResult.reason === "invalid_utf8" ? "invalid_root" : rootResult.reason, "root", rootResult.cleanupUnconfirmed);
	const root = rootPath(rootResult.stdout!);
	if (!root) return fail("invalid_root", "root");
	const remaining = 30000 - (now() - start);
	if (remaining <= 0) return fail("timeout", "search");
	const searchResult = await memoryChild(["--account", account, "memory", "search", "--max-results", String(limit), "--json", query], 65536, Math.min(25000, remaining), dependencies);
	if (searchResult.reason) return fail(searchResult.reason === "invalid_utf8" ? "invalid_json" : searchResult.reason, "search", searchResult.cleanupUnconfirmed);
	return memoryBriefing(searchResult.stdout!, root, limit as number, binding, dependencies.date);
}
