// Goal-alignment before-tool surface. Deterministic only: no provider call, no
// credential or config read. Only write-class calls are evaluated because reads
// and bash must never be blocked; the journal is best effort, so a storage
// failure degrades to in-process counters and can never cause or suppress a block.
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	ALIGNMENT_LIMITS,
	admitAlignedAction,
	alignmentReason,
	collectAuthority,
	compactJournalText,
	digestTarget,
	digestText,
	evaluateAction,
	normalizeTarget,
	planJournalAppend,
	readJournalTexts,
	recordBlock,
	recordCorrection,
	type ActionClass,
	type AlignmentEvent,
	type Authority,
	type JournalSnapshot,
	type Observation,
} from "../lib/alignment";

const ALIGNMENT_WRITE_TOOLS = new Set([
	"write",
	"write_file",
	"edit",
	"edit_file",
	"patch",
	"apply_patch",
	"multiedit",
	"multi_edit",
	"multi_edit_file",
	"str_replace",
	"str_replace_editor",
	"notebookedit",
	"notebook_edit",
]);
const ALIGNMENT_READ_TOOLS = new Set(["read", "read_file", "grep", "glob", "list", "ls", "view", "webfetch", "web_fetch", "websearch", "web_search"]);
const ALIGNMENT_BASH_TOOLS = new Set(["bash", "shell", "sh", "exec", "execute", "run", "terminal"]);
const ALIGNMENT_DEGRADED_COUNTERS_MAX = 64;

/**
 * Runtime mode for deterministic blocking, resolved per call:
 * `off` (kill switch), `shadow` (evaluate + journal, never block), or
 * `deterministic` (may block). Everything else, including unset, is `shadow`;
 * `JEV_ADVISOR_MODE` belongs to the tier advisor and is never read here.
 */
type AlignmentMode = "off" | "shadow" | "deterministic";

function alignmentMode(): AlignmentMode {
	try {
		const raw = process.env.JEV_ALIGNMENT_MODE;
		const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
		if (value === "off") return "off";
		if (value === "deterministic") return "deterministic";
		return "shadow";
	} catch {
		return "shadow";
	}
}

/** In-process retry counters used only while the journal store is unavailable. */
const alignmentDegradedRetries = new Map<string, number>();

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	api.on("tool_call", async (event, ctx) => {
		const mode = alignmentMode();
		// off is a true kill switch: no evaluation, no journal, no block.
		if (mode === "off") return undefined;
		let blockReason: string | null = null;
		try {
			const call = alignmentAsRecord(event);
			if (!call || call.type !== "tool_call") return undefined;
			const actionClass = alignmentClassifyAction(call.toolName);
			// read_allow / bash_observe: never blocked, never journaled.
			if (actionClass !== "write") return undefined;
			const startedAt = Date.now();
			const now = startedAt;
			const authority = alignmentReadAuthority(ctx);
			const paths = alignmentWritePaths(call.input);
			const targetDigest = paths.length === 1 ? digestTarget(paths[0]) : paths.length > 1 ? digestText(paths.join("\n")) : null;
			// A multi-target write is evaluated per path so one forbidden target
			// still blocks; only single-target writes can be stage-2 admitted.
			const evaluations =
				paths.length > 1
					? paths.map(value => evaluateAction({ actionClass: "write", targetDigest: digestTarget(value), authority }))
					: [evaluateAction({ actionClass: "write", targetDigest, authority })];
			const evaluation = evaluations.find(candidate => candidate.block) ?? evaluations[0];
			const toolCallIdDigest = alignmentToolCallDigest(call.toolCallId);
			const loaded = await alignmentLoadJournal(ctx, now);
			const events: AlignmentEvent[] = [];
			let state = loaded.snapshot.latest;
			if (authority && state?.latestUserEntryId !== authority.latestUserEntryId) {
				const correction = recordCorrection({ authority, baseline: alignmentBaseline(authority), now, previous: state });
				if (correction.applied && correction.event && correction.state) {
					state = correction.state;
					events.push(correction.event);
				}
			}
			let blockRetryCount = 0;
			if (evaluation.block) {
				blockRetryCount = Math.max(loaded.snapshot.retryCounts[evaluation.retryKey] ?? 0, alignmentDegradedRetries.get(evaluation.retryKey) ?? 0) + 1;
				events.push(recordBlock({ evaluation, retryCount: blockRetryCount, now }));
				blockReason = alignmentReason(evaluation, blockRetryCount);
			} else if (evaluation.stage2Admissible && state) {
				const admission = admitAlignedAction({ state, evaluation, targetDigest, toolCallIdDigest, now });
				if (admission.applied && admission.event) events.push(admission.event);
			}
			// A deterministic evaluation that overruns its budget must never block:
			// record the overrun, then fall through to the default allow.
			const budgetMs = Number(process.env.JEV_ALIGNMENT_LATENCY_BUDGET_MS ?? 250);
			const elapsedMs = Date.now() - startedAt;
			if (blockReason && Number.isFinite(budgetMs) && elapsedMs > budgetMs) {
				blockReason = null;
				events.push(recordLatencyExceeded({ elapsedMs, budgetMs, now }));
			}
			// A hung store must not hold the tool call: the verdict is already
			// decided, so a slow append degrades to "not stored" instead of delay.
			const appendBudgetMs = Number(process.env.JEV_ALIGNMENT_APPEND_TIMEOUT_MS ?? 100);
			const stored = await withDeadline(alignmentAppendEvents(ctx, events, now), appendBudgetMs, false);
			// Degraded storage keeps the retry chain in process memory so a repeated
			// violation still reaches stop_recommended; it never changes the verdict.
			if (evaluation.block && (!loaded.available || !stored)) {
				alignmentRememberDegradedRetry(evaluation.retryKey, blockRetryCount);
				// The verdict is unchanged, but the reason carries the observable
				// storage_degraded code so the degradation is not silent.
				if (blockReason) blockReason = `${blockReason} [storage_degraded]`;
			}
		} catch (error) {
			// hook_error: a thrown handler is fail-open and can never block a tool.
			// Record the failure class so a silent throw stays auditable.
			try {
				await alignmentAppendEvents(ctx, [recordHookError({ errorClass: error instanceof Error ? error.name || "error" : "non_error", now: Date.now() })], Date.now());
			} catch {
				// The recorder itself must never change the verdict.
			}
			return undefined;
		}
		// shadow journals the same block record but never enforces it.
		return mode === "deterministic" && blockReason ? { block: true, reason: blockReason } : undefined;
	});
}

function alignmentRememberDegradedRetry(key: string, count: number): void {
	if (alignmentDegradedRetries.size >= ALIGNMENT_DEGRADED_COUNTERS_MAX) alignmentDegradedRetries.clear();
	alignmentDegradedRetries.set(key, Math.max(alignmentDegradedRetries.get(key) ?? 0, count));
}

function alignmentAsRecord(value: unknown): Record<string, any> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function alignmentClassifyAction(toolName: unknown): ActionClass | null {
	const name = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
	if (!name) return null;
	if (ALIGNMENT_WRITE_TOOLS.has(name)) return "write";
	if (ALIGNMENT_READ_TOOLS.has(name)) return "read";
	if (ALIGNMENT_BASH_TOOLS.has(name)) return "bash";
	return null;
}

/** Bounded, normalised write targets of one tool input. */
function alignmentWritePaths(input: unknown): string[] {
	const record = alignmentAsRecord(input);
	if (!record) return [];
	const found = new Set<string>();
	const add = (value: unknown) => {
		if (typeof value !== "string") return;
		const token = normalizeTarget(value);
		if (token) found.add(token);
	};
	for (const key of ["filePath", "file_path", "path", "notebook_path", "notebookPath", "target"]) add(record[key]);
	if (Array.isArray(record.files)) for (const value of record.files) add(value);
	const patch = typeof record.patch === "string" ? record.patch : typeof record.diff === "string" ? record.diff : "";
	if (patch) {
		for (const line of patch.split("\n").slice(0, 400)) {
			const trimmed = line.trim();
			const update = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(trimmed);
			if (update) add(update[1]);
			const git = /^diff --git a\/(\S+) b\/(\S+)/.exec(trimmed);
			if (git) add(git[2]);
		}
	}
	return [...found].slice(0, 16);
}

function alignmentToolCallDigest(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= 512 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? digestText(trimmed) : null;
}

/** Host user entries are the only authority; a missing facade yields none. */
function alignmentReadAuthority(ctx: unknown): Authority | null {
	const record = alignmentAsRecord(ctx);
	const manager = record ? alignmentAsRecord(record.sessionManager) : null;
	if (!manager || typeof manager.getBranch !== "function") return null;
	try {
		const branch = manager.getBranch.call(manager);
		const entries = Array.isArray(branch) ? branch : alignmentAsRecord(branch)?.entries;
		return collectAuthority(entries, { windowSize: 12 });
	} catch {
		return null;
	}
}

/** Baseline of the declared criterion, observed before the action runs. */
function alignmentBaseline(authority: Authority | null): Observation | null {
	const criterion = authority?.criterion;
	if (!criterion) return null;
	if (criterion.kind === "exit_zero") return "unknown";
	const target = authority?.targets.find(item => item.digest === criterion.targetDigest);
	if (!target) return "unknown";
	try {
		return existsSync(target.path) ? "true" : "false";
	} catch {
		return "unknown";
	}
}

function alignmentSessionKey(ctx: unknown): string {
	const record = alignmentAsRecord(ctx);
	const manager = record ? alignmentAsRecord(record.sessionManager) : null;
	if (manager && typeof manager.getSessionId === "function") {
		try {
			const value = manager.getSessionId.call(manager);
			if (typeof value === "string" && value.trim() && value.length <= 512) return digestText(value.trim()).slice(0, 16);
		} catch {
			// An unreadable session id falls back to the shared segment.
		}
	}
	return "default";
}

function alignmentJournalFiles(ctx: unknown): { directory: string; current: string; rotated: string } {
	// Bun can cache os.homedir across HOME changes; honor the process-owned home.
	// One bounded segment pair per session keeps concurrent sessions apart.
	const directory = path.join(process.env.HOME || homedir(), ".gjc-plugin", "jev-advisor", "alignment", "v1", alignmentSessionKey(ctx));
	return { directory, current: path.join(directory, "events.jsonl"), rotated: path.join(directory, "events.1.jsonl") };
}

async function alignmentReadText(file: string): Promise<{ text: string | null; available: boolean }> {
	try {
		const text = await readFile(file, "utf8");
		return { text, available: Buffer.byteLength(text, "utf8") <= ALIGNMENT_LIMITS.maxTotalBytes };
	} catch (error) {
		return { text: null, available: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" };
	}
}

async function alignmentLoadJournal(ctx: unknown, now: number): Promise<{ snapshot: JournalSnapshot; available: boolean }> {
	const files = alignmentJournalFiles(ctx);
	const rotated = await alignmentReadText(files.rotated);
	const current = await alignmentReadText(files.current);
	return { snapshot: readJournalTexts([rotated.text, current.text], now), available: rotated.available && current.available };
}

async function alignmentAppendEvents(ctx: unknown, events: readonly AlignmentEvent[], now: number): Promise<boolean> {
	if (events.length === 0) return true;
	const files = alignmentJournalFiles(ctx);
	try {
		await mkdir(files.directory, { recursive: true, mode: 0o700 });
		const existing = await alignmentReadText(files.current);
		const plan = planJournalAppend(existing.text ?? "", events, now);
		if (!plan.text) return plan.skipped === 0;
		if (plan.rotate) {
			await writeFile(files.rotated, compactJournalText(existing.text ?? "", now), { mode: 0o600 });
			await writeFile(files.current, plan.text, { mode: 0o600 });
		} else {
			await appendFile(files.current, plan.text, { mode: 0o600 });
		}
		return true;
	} catch {
		return false;
	}
}
