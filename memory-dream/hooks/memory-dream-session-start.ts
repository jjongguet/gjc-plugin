// GENERATED FILE - do not edit by hand.
// Adapter: src/session-start.adapter.ts
// Rebuild with: bun scripts/build.mjs

import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const MAX_NOTICE_BYTES = 600;
export const MAX_NOTICE_LINES = 5;

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resultsRootFor(home: string, env: Record<string, string | undefined>): string {
	const override = env.MEMORY_DREAM_RESULTS_DIR?.trim();
	return override ? path.resolve(override) : path.join(home, ".gjc-plugin", "memory-dream");
}

function readLatestReportFile(file: string): Record<string, unknown> | null {
	try {
		const info = lstatSync(file);
		if (info.isSymbolicLink() || !info.isFile() || info.size > 16 * 1024 || (info.mode & 0o777) !== 0o600) return null;
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		return isObject(value) ? value : null;
	} catch {
		return null;
	}
}

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function clip(value: string, limit: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function clipBytes(value: string, limit: number): string {
	if (bytes(value) <= limit) return value;
	let out = "";
	for (const char of value) {
		if (bytes(out + char) > Math.max(0, limit - 1)) break;
		out += char;
	}
	return `${out}…`;
}

/**
 * Build the bounded session_start notice from the latest private report.
 * Only taken `contradicted` notes are shown; there is no jev call, no file
 * write and no network access here.
 */
export function buildSessionStartNotice(
	latest: unknown,
	maxBytes = MAX_NOTICE_BYTES,
	maxLines = MAX_NOTICE_LINES,
): string | null {
	if (!isObject(latest) || latest.schema !== "memory-dream.latest.v1") return null;
	if (!isObject(latest.counts) || typeof latest.counts.contradicted !== "number" || latest.counts.contradicted < 1) return null;
	if (!Array.isArray(latest.contradicted) || latest.contradicted.length === 0) return null;
	const date = typeof latest.generatedAt === "string" ? latest.generatedAt.slice(0, 10) : "unknown-date";
	const header = `memory-dream: ${latest.counts.contradicted} contradicted memory note(s), report ${date}.`;
	const lines: string[] = [header];
	for (const entry of latest.contradicted.slice(0, maxLines - 1)) {
		if (!isObject(entry) || typeof entry.claim !== "string") continue;
		const claim = clip(entry.claim, 110);
		const citation = typeof entry.citation === "string" ? clip(entry.citation, 80) : "citation unknown";
		lines.push(`- ${claim} (${citation})`);
	}
	while (lines.length > 1 && bytes(lines.join("\n")) > maxBytes) lines.pop();
	const text = lines.join("\n");
	if (bytes(text) <= maxBytes) return text;
	return clipBytes(text, maxBytes);
}

export function sessionStartNotice(deps: {
	home?: string;
	env?: Record<string, string | undefined>;
	maxBytes?: number;
	maxLines?: number;
} = {}): string | null {
	const home = deps.home ?? homedir();
	const env = deps.env ?? process.env;
	const latest = readLatestReportFile(path.join(resultsRootFor(home, env), "latest.json"));
	return buildSessionStartNotice(latest, deps.maxBytes, deps.maxLines);
}


/**
 * session_start adapter: one registration, no network, no writes.
 *
 * It only surfaces the latest report's contradicted notes. A malformed or
 * missing report is silent; a broken hook never blocks a session.
 */
export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	logger?: { warn?: (message: string) => void };
}) {
	api.on("session_start", async (_event: unknown, ctx: unknown) => {
		try {
			const notice = sessionStartNotice();
			if (!notice) return undefined;
			const ui = (ctx as { ui?: { notify?: (message: string, type?: string) => void } } | undefined)?.ui;
			if (ui && typeof ui.notify === "function") ui.notify(notice, "warning");
		} catch (error) {
			try {
				api.logger?.warn?.(`memory-dream-session-start: ${String((error as Error)?.message ?? error).slice(0, 80)}`);
			} catch {
				/* isolate */
			}
		}
		return undefined;
	});
}
