import { sessionStartNotice } from "../lib/notice";

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
