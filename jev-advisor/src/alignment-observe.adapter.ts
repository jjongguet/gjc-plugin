// Goal-alignment after-tool surface. Binds one admitted write to its result,
// observes the declared criterion and completes the recovery only on a
// false|unknown → true transition. Never rewrites a tool result; never blocks.
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	ALIGNMENT_LIMITS,
	collectAuthority,
	compactJournalText,
	digestTarget,
	digestText,
	evaluateCompletion,
	normalizeTarget,
	observeResult,
	planJournalAppend,
	readJournalTexts,
	type AlignmentEvent,
	type AlignmentState,
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

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	api.on("tool_result", async (event, ctx) => {
		try {
			const result = alignmentAsRecord(event);
			if (!result || result.type !== "tool_result") return undefined;
			if (!alignmentIsWriteTool(result.toolName)) return undefined;
			const now = Date.now();
			const { snapshot } = await alignmentLoadJournal(ctx, now);
			const state = snapshot.latest;
			if (!state || state.step !== 2 || state.status !== "aligned_admitted" || state.actionClass !== "write") return undefined;
			const toolCallIdDigest = alignmentToolCallDigest(result.toolCallId);
			const events: AlignmentEvent[] = [];
			if (!toolCallIdDigest) {
				// An unbound write result never claims recovery.
				const unverified = observeResult({ state, toolCallIdDigest: null, observation: "unknown", now });
				if (unverified.applied && unverified.event) events.push(unverified.event);
			} else if (toolCallIdDigest === state.toolCallIdDigest) {
				const observed = observeResult({
					state,
					toolCallIdDigest,
					observation: alignmentObservation(state, result, ctx),
					now,
				});
				if (observed.applied && observed.event) events.push(observed.event);
				if (observed.state) {
					const completion = evaluateCompletion({ state: observed.state, now });
					if (completion.applied && completion.event) events.push(completion.event);
				}
			} else {
				// A different call is not this recovery; it is ignored, not claimed.
				return undefined;
			}
			if (events.length > 0) await alignmentAppendEvents(ctx, events, now);
			return undefined;
		} catch {
			// hook_error: observers are always fail-open.
			return undefined;
		}
	});
}

function alignmentAsRecord(value: unknown): Record<string, any> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function alignmentIsWriteTool(toolName: unknown): boolean {
	return typeof toolName === "string" && ALIGNMENT_WRITE_TOOLS.has(toolName.trim().toLowerCase());
}

function alignmentToolCallDigest(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= 512 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? digestText(trimmed) : null;
}

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

/**
 * Criterion observation from the bound result. Paths are not journaled, so the
 * checked path is re-derived from the write input or the current branch; an
 * unresolvable path is `unknown`, never an assumed success.
 */
function alignmentObservation(state: AlignmentState, result: Record<string, any>, ctx: unknown): Observation {
	const criterion = state.criterion;
	if (!criterion) return "unknown";
	if (criterion.kind === "exit_zero") {
		const details = alignmentAsRecord(result.details) ?? {};
		const code = details.exitCode ?? details.exit_code ?? details.code;
		return typeof code === "number" && Number.isFinite(code) ? (code === 0 ? "true" : "false") : "unknown";
	}
	const direct = alignmentWritePaths(result.input).find(value => digestTarget(value) === criterion.targetDigest);
	const target = direct ?? alignmentReadAuthority(ctx)?.targets.find(item => item.digest === criterion.targetDigest)?.path ?? null;
	if (!target) return "unknown";
	if (criterion.kind === "criterion_file") {
		// A criterion file is a bounded JSON verdict: only an explicit boolean
		// `satisfied` counts, and an oversized or malformed file is `unknown`.
		try {
			const body = readFileSync(target, "utf8");
			if (Buffer.byteLength(body, "utf8") > 4096) return "unknown";
			const parsed = alignmentAsRecord(JSON.parse(body));
			if (!parsed || typeof parsed.satisfied !== "boolean") return "unknown";
			return parsed.satisfied ? "true" : "false";
		} catch {
			return "unknown";
		}
	}
	try {
		return existsSync(target) ? "true" : "false";
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
