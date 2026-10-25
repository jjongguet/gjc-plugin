// Goal-alignment session-shutdown surface. Flushes the unresolved recovery
// counts once per recovery id; a repeated shutdown appends nothing.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	ALIGNMENT_LIMITS,
	compactJournalText,
	digestText,
	planJournalAppend,
	readJournalTexts,
	recordHookError,
	recordShutdown,
	type AlignmentEvent,
	type JournalSnapshot,
} from "../lib/alignment";

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	api.on("session_shutdown", async (_event, ctx) => {
		try {
			const now = Date.now();
			const { snapshot } = await alignmentLoadJournal(ctx, now);
			const state = snapshot.latest;
			if (!state || state.step >= 4) return undefined;
			// Idempotent stop: the same unresolved recovery is flushed at most once.
			if (snapshot.shutdownFor[state.recoveryId]) return undefined;
			const shutdown = recordShutdown({ state, counts: snapshot.counts, now });
			await alignmentAppendEvents(ctx, [shutdown], now);
			return undefined;
		} catch (error) {
			// hook_error: shutdown is best effort and never blocks anything, but the
			// failure class is recorded for auditability.
			try {
				await alignmentAppendEvents(ctx, [recordHookError({ errorClass: error instanceof Error ? error.name || "error" : "non_error", now: Date.now() })], Date.now());
			} catch {
				// Recording must never change the outcome.
			}
			return undefined;
		}
	});
}

function alignmentAsRecord(value: unknown): Record<string, any> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : null;
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
