/**
 * Goal-alignment journal store: the one read/append path shared by the
 * before-tool, observe and shutdown surfaces.
 *
 * The verdict never comes from here, and storage never delays a tool call:
 * every read and append is bounded by one budget
 * (`JEV_ALIGNMENT_STORE_TIMEOUT_MS`, default 100 ms). A bounded-out read
 * reports the empty, unavailable snapshot the adapters already treat as
 * degraded storage, and a bounded-out append reports "not stored" — never
 * "did not happen" and never a block.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	ALIGNMENT_LIMITS,
	compactJournalText,
	digestText,
	planJournalAppend,
	readJournalTexts,
	withDeadline,
	type AlignmentEvent,
	type JournalSnapshot,
} from "./alignment";

const DEFAULT_STORE_TIMEOUT_MS = 100;

/**
 * The store's whole filesystem surface. Production passes `JOURNAL_STORE_IO`;
 * a test passes its own so a hung or failing store is induced, not simulated
 * with a global builtin patch (builtin ESM bindings are snapshots in Bun).
 */
export type JournalStoreIo = {
	readFile: (file: string, encoding: "utf8") => Promise<string>;
	appendFile: (file: string, data: string, options: { mode: number }) => Promise<unknown>;
	writeFile: (file: string, data: string, options: { mode: number }) => Promise<unknown>;
	mkdir: (directory: string, options: { recursive: true; mode: number }) => Promise<unknown>;
};

export const JOURNAL_STORE_IO: JournalStoreIo = { readFile, appendFile, writeFile, mkdir };

/** One bounded budget for every journal read and append. */
export function journalStoreBudgetMs(env: Record<string, string | undefined> = process.env): number {
	const raw = Number(env.JEV_ALIGNMENT_STORE_TIMEOUT_MS ?? DEFAULT_STORE_TIMEOUT_MS);
	return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : DEFAULT_STORE_TIMEOUT_MS;
}

export type JournalLoad = { snapshot: JournalSnapshot; available: boolean };

function journalRecord(value: unknown): Record<string, any> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/** Bounded session segment key, or the shared segment when unreadable. */
export function journalSessionKey(ctx: unknown): string {
	const record = journalRecord(ctx);
	const manager = record ? journalRecord(record.sessionManager) : null;
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

export function journalFiles(ctx: unknown): { directory: string; current: string; rotated: string } {
	// Bun can cache os.homedir across HOME changes; honor the process-owned home.
	// One bounded segment pair per session keeps concurrent sessions apart.
	const directory = path.join(process.env.HOME || homedir(), ".gjc-plugin", "jev-advisor", "alignment", "v1", journalSessionKey(ctx));
	return { directory, current: path.join(directory, "events.jsonl"), rotated: path.join(directory, "events.1.jsonl") };
}

export async function journalReadText(file: string, io: JournalStoreIo = JOURNAL_STORE_IO): Promise<{ text: string | null; available: boolean }> {
	try {
		const text = await io.readFile(file, "utf8");
		return { text, available: Buffer.byteLength(text, "utf8") <= ALIGNMENT_LIMITS.maxTotalBytes };
	} catch (error) {
		return { text: null, available: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" };
	}
}

/** Unbounded store read; every caller goes through `loadJournalStore`. */
async function journalLoadUnbounded(ctx: unknown, now: number, io: JournalStoreIo): Promise<JournalLoad> {
	const files = journalFiles(ctx);
	const rotated = await journalReadText(files.rotated, io);
	const current = await journalReadText(files.current, io);
	return { snapshot: readJournalTexts([rotated.text, current.text], now), available: rotated.available && current.available };
}

/** Read the retained journal inside the store budget; a timeout is degraded storage. */
export async function loadJournalStore(
	ctx: unknown,
	now: number,
	budgetMs: number,
	io: JournalStoreIo = JOURNAL_STORE_IO,
): Promise<JournalLoad> {
	return withDeadline(journalLoadUnbounded(ctx, now, io), budgetMs, { snapshot: readJournalTexts([null, null], now), available: false });
}

/** Unbounded store append; every caller goes through `appendJournalStore`. */
async function journalAppendUnbounded(ctx: unknown, events: readonly AlignmentEvent[], now: number, io: JournalStoreIo): Promise<boolean> {
	if (events.length === 0) return true;
	const files = journalFiles(ctx);
	try {
		await io.mkdir(files.directory, { recursive: true, mode: 0o700 });
		const existing = await journalReadText(files.current, io);
		const plan = planJournalAppend(existing.text ?? "", events, now);
		if (!plan.text) return plan.skipped === 0;
		if (plan.rotate) {
			await io.writeFile(files.rotated, compactJournalText(existing.text ?? "", now), { mode: 0o600 });
			await io.writeFile(files.current, plan.text, { mode: 0o600 });
		} else {
			await io.appendFile(files.current, plan.text, { mode: 0o600 });
		}
		return true;
	} catch {
		return false;
	}
}

/** Append inside the store budget; `false` means "not stored", never "not attempted". */
export async function appendJournalStore(
	ctx: unknown,
	events: readonly AlignmentEvent[],
	now: number,
	budgetMs: number,
	io: JournalStoreIo = JOURNAL_STORE_IO,
): Promise<boolean> {
	return withDeadline(journalAppendUnbounded(ctx, events, now, io), budgetMs, false);
}
