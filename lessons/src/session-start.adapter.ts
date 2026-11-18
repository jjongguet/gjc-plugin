import { sessionStartLine } from "../lib/notice";

function hookCwd(ctx: unknown): string | null {
	if (ctx === null || typeof ctx !== "object") return null;
	const cwd = (ctx as { cwd?: unknown }).cwd;
	return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

/**
 * session_start adapter: one registration, no model-context injection, no
 * writes. It runs one bounded selection and reports a single advisory line; a
 * missing ledger, a timeout or a broken UI is silence, never a failed session.
 */
export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}) {
	api.on("session_start", async (_event: unknown, ctx: unknown) => {
		try {
			const line = await sessionStartLine(hookCwd(ctx) ?? process.cwd());
			if (line === null) return undefined;
			try {
				if (typeof api.logger?.info === "function") api.logger.info(line);
				else api.logger?.warn?.(line);
			} catch {
				/* logging is advisory */
			}
			try {
				const ui = (ctx as { ui?: { notify?: (message: string, type?: string) => void } } | undefined)?.ui;
				if (ui !== undefined && typeof ui.notify === "function") ui.notify(line, "info");
			} catch {
				/* a broken UI never blocks a session */
			}
		} catch {
			/* the hook never blocks a session */
		}
		return undefined;
	});
}
