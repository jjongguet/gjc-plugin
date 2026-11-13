// Goal-alignment before-tool surface. Only deterministic rules may block.
// Optional semantic advice runs afterwards and cannot alter their result.
// Only write-class calls are evaluated because reads
// and bash must never be blocked; the journal is best effort, so a storage
// failure degrades to in-process counters and can never cause or suppress a block.
import { existsSync } from "node:fs";
import {
	admitAlignedAction,
	alignmentReason,
	collectAuthority,
	detectDestructiveBash,
	digestTarget,
	digestText,
	evaluateAction,
	formatAuthorityLine,
	normalizeTarget,
	recordBashCoverage,
	recordBlock,
	recordCorrection,
	recordHookError,
	recordLatencyExceeded,
	type ActionClass,
	type AlignmentEvent,
	type Authority,
	type BashCoverage,
	type Observation,
} from "../lib/alignment";
import { appendJournalStore, journalSessionKey, journalStoreBudgetMs, loadJournalStore } from "../lib/alignment-journal";
import { askSemanticAdvice, semanticOutboundEnabled, SEMANTIC_MODEL, type SemanticInput } from "../lib/semantic";

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

/**
 * Destructive-bash advisory bridge (default OFF; JEV_BASH_BRIDGE=1 enables it). When off the
 * bash path returns before classification, so behaviour is unchanged. When on it only counts
 * bash calls, notifies at most ALIGNMENT_BRIDGE_MAX_NOTICES times per session that the RULES
 * jev_check obligation applies, and journals cumulative bash_coverage counts (pattern ids only,
 * never command text). It never blocks, rewrites or delays a call.
 */
const ALIGNMENT_BRIDGE_MAX_NOTICES = 3;
/** Shared with the shutdown surface (a separate generated module in the same realm). */
const ALIGNMENT_BRIDGE_SLOT = Symbol.for("gjc.jev-advisor.bash-bridge");
const ALIGNMENT_BRIDGE_MAX_SESSIONS = 32;

function alignmentBridgeEnabled(): boolean {
	try { return String(process.env.JEV_BASH_BRIDGE ?? "").trim() === "1"; } catch { return false; }
}

/** Per-session coverage shared with the shutdown surface through one namespaced global slot. */
function alignmentBridgeCoverage(sessionKey: string): BashCoverage {
	const root = globalThis as Record<symbol, unknown>;
	let slot = root[ALIGNMENT_BRIDGE_SLOT] as Map<string, BashCoverage> | undefined;
	if (!(slot instanceof Map)) { slot = new Map(); root[ALIGNMENT_BRIDGE_SLOT] = slot; }
	let coverage = slot.get(sessionKey);
	if (!coverage) {
		if (slot.size >= ALIGNMENT_BRIDGE_MAX_SESSIONS) slot.delete(slot.keys().next().value as string);
		coverage = { bashCalls: 0, destructive: 0, notices: 0, patterns: {} };
		slot.set(sessionKey, coverage);
	}
	return coverage;
}

async function alignmentBashBridge(call: Record<string, any>, ctx: unknown, storeBudgetMs: number): Promise<void> {
	const coverage = alignmentBridgeCoverage(journalSessionKey(ctx));
	coverage.bashCalls++;
	const input = alignmentAsRecord(call.input);
	const ids = detectDestructiveBash(input?.command ?? input?.cmd ?? input?.script);
	if (!ids.length) return;
	coverage.destructive++;
	for (const id of ids) coverage.patterns[id] = (coverage.patterns[id] ?? 0) + 1;
	if (coverage.notices >= ALIGNMENT_BRIDGE_MAX_NOTICES) return;
	coverage.notices++;
	const ui = alignmentAsRecord(alignmentAsRecord(ctx)?.ui);
	if (typeof ui?.notify === "function") {
		ui.notify(`jev-advisor bridge: destructive bash (${ids.join(", ")}). RULES asks for one jev_check before running it; advisory only, nothing is blocked (${coverage.notices}/${ALIGNMENT_BRIDGE_MAX_NOTICES}).`, "warning");
	}
	await appendJournalStore(ctx, [recordBashCoverage({ coverage, now: Date.now() })], Date.now(), storeBudgetMs);
}

/** Last authority line published per session; the status is set only when it changes. */
const alignmentAuthorityLines = new Map<string, string>();

function alignmentPublishAuthority(ctx: unknown, authority: Authority | null): void {
	const ui = alignmentAsRecord(alignmentAsRecord(ctx)?.ui);
	if (typeof ui?.setStatus !== "function") return;
	const key = journalSessionKey(ctx);
	const line = formatAuthorityLine(authority);
	if (alignmentAuthorityLines.get(key) === line) return;
	if (alignmentAuthorityLines.size >= ALIGNMENT_BRIDGE_MAX_SESSIONS) alignmentAuthorityLines.delete(alignmentAuthorityLines.keys().next().value as string);
	alignmentAuthorityLines.set(key, line);
	ui.setStatus("jev-alignment-authority", line);
}

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	api.on("tool_call", async (event, ctx) => {
		const mode = alignmentMode();
		// off is a true kill switch: no evaluation, no journal, no block.
		if (mode === "off") return undefined;
		let blockReason: string | null = null;
		let semanticInput: SemanticInput | null = null;
		// One store budget for this call's read and appends: a hung store degrades
		// to "unavailable"/"not stored" instead of delaying the verdict.
		const storeBudgetMs = journalStoreBudgetMs();
		try {
			const call = alignmentAsRecord(event);
			if (!call || call.type !== "tool_call") return undefined;
			const actionClass = alignmentClassifyAction(call.toolName);
			// bash_observe is never blocked; with the opt-in bridge it is only counted and noticed.
			if (actionClass === "bash" && alignmentBridgeEnabled()) {
				try { await alignmentBashBridge(call, ctx, storeBudgetMs); } catch { /* advisory only */ }
				return undefined;
			}
			// read_allow / bash_observe: never blocked, never journaled.
			if (actionClass !== "write") return undefined;
			const startedAt = Date.now();
			const now = startedAt;
			const branchEntries = alignmentReadBranch(ctx);
			const authority = collectAuthority(branchEntries, { windowSize: 12 });
			try { alignmentPublishAuthority(ctx, authority); } catch { /* status is advisory only */ }
			const { paths, complete } = alignmentWritePaths(call.input);
			semanticInput = { branchEntries, targetPaths: complete ? paths : null };
			const targetDigest = paths.length === 1 ? digestTarget(paths[0]) : paths.length > 1 ? digestText(paths.join("\n")) : null;
			// A multi-target write is evaluated per path so one forbidden target
			// still blocks; only single-target writes can be stage-2 admitted.
			const evaluations =
				paths.length > 1
					? paths.map(value => evaluateAction({ actionClass: "write", targetDigest: digestTarget(value), authority }))
					: [evaluateAction({ actionClass: "write", targetDigest, authority })];
			const evaluation = evaluations.find(candidate => candidate.block) ?? evaluations[0];
			const toolCallIdDigest = alignmentToolCallDigest(call.toolCallId);
			const loaded = await loadJournalStore(ctx, now, storeBudgetMs);
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
			const stored = await appendJournalStore(ctx, events, now, storeBudgetMs);
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
				await appendJournalStore(ctx, [recordHookError({ errorClass: error instanceof Error ? error.name || "error" : "non_error", now: Date.now() })], Date.now(), storeBudgetMs);
			} catch {
				// The recorder itself must never change the verdict.
			}
			return undefined;
		}
		// This is outside deterministic evaluation, storage and latency accounting.
		// No semantic score is consumed as a block, admission or release signal.
		try {
			if (semanticInput && semanticOutboundEnabled()) {
				const advice = await askSemanticAdvice(semanticInput);
				const ui = alignmentAsRecord(alignmentAsRecord(ctx)?.ui);
				if (typeof ui?.setStatus === "function") {
					const summary = advice.status === "decision"
						? { model: SEMANTIC_MODEL, status: advice.status, choice: advice.choice, confidence: advice.confidence, probabilities: advice.probabilities }
						: { model: SEMANTIC_MODEL, status: advice.status, reason: advice.reason };
					ui.setStatus("jev-alignment-semantic", JSON.stringify(summary));
				}
			}
		} catch {
			// Provider, configuration and UI failures cannot suppress or create blocks.
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
function alignmentWritePaths(input: unknown): { paths: string[]; complete: boolean } {
	const record = alignmentAsRecord(input);
	if (!record) return { paths: [], complete: false };
	const found = new Set<string>();
	let complete = true;
	const add = (value: unknown) => {
		if (typeof value !== "string") { complete = false; return; }
		// Separator normalization must not disguise a raw URL as a file target.
		if (value.includes("://")) complete = false;
		const token = normalizeTarget(value);
		if (!token) { complete = false; return; }
		found.add(token);
	};
	for (const key of ["filePath", "file_path", "path", "notebook_path", "notebookPath", "target"]) {
		if (Object.prototype.hasOwnProperty.call(record, key)) add(record[key]);
	}
	if (Array.isArray(record.files)) for (const value of record.files) add(value);
	else if (record.files !== undefined) complete = false;
	if ((record.patch !== undefined && typeof record.patch !== "string") || (record.diff !== undefined && typeof record.diff !== "string")) complete = false;
	const patch = typeof record.patch === "string" ? record.patch : typeof record.diff === "string" ? record.diff : "";
	if (patch) {
		const lines = patch.split("\n");
		if (lines.length > 400) complete = false;
		for (const line of lines.slice(0, 400)) {
			const trimmed = line.trim();
			const update = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(trimmed);
			if (update) add(update[1]);
			const git = /^diff --git a\/(\S+) b\/(\S+)/.exec(trimmed);
			if (git) add(git[2]);
			if ((trimmed.startsWith("diff --git ") && (!git || git[1] !== git[2])) || trimmed.startsWith("*** Move to:")) complete = false;
		}
	}
	if (found.size > 16) complete = false;
	// Preserve the existing deterministic window, but never advise on a partial action.
	return { paths: [...found].slice(0, 16), complete };
}

function alignmentToolCallDigest(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= 512 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? digestText(trimmed) : null;
}

/** Host user entries are the only authority; a missing facade yields none. */
function alignmentReadBranch(ctx: unknown): unknown {
	const record = alignmentAsRecord(ctx);
	const manager = record ? alignmentAsRecord(record.sessionManager) : null;
	if (!manager || typeof manager.getBranch !== "function") return null;
	try {
		const branch = manager.getBranch.call(manager);
		const entries = Array.isArray(branch) ? branch : alignmentAsRecord(branch)?.entries;
		return entries;
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
