// session_start advisory health line. One registration, no provider call, no cost, no writes:
// it reads the effective configuration (names and layers only) and one bounded journal
// snapshot, and stays silent when the advisor is healthy. JEV_HEALTH_LINE=off disables it,
// JEV_HEALTH_LINE=stderr writes the same line to stderr (headless diagnostics) instead of
// ui.notify. A failure never blocks a session: one bounded logger line, then undefined.
import { collectHealthLine } from '../lib/decision';

export default function jevAdvisorSessionStart(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	logger?: { warn?: (message: string) => void };
}) {
	api.on('session_start', async (_event: unknown, ctx: unknown) => {
		try {
			const mode = String(process.env.JEV_HEALTH_LINE ?? 'notify').trim().toLowerCase();
			if (mode === 'off') return undefined;
			const line = await collectHealthLine();
			if (!line) return undefined;
			if (mode === 'stderr') {
				process.stderr.write(line + '\n');
				return undefined;
			}
			const ui = (ctx as { ui?: { notify?: (message: string, type?: string) => void } } | undefined)?.ui;
			if (ui && typeof ui.notify === 'function') ui.notify(line, 'warning');
		} catch (error) {
			try {
				api.logger?.warn?.(`jev-advisor-session-start: ${String((error as Error)?.message ?? error).slice(0, 80)}`);
			} catch {
				/* isolate */
			}
		}
		return undefined;
	});
}
