// session_start hook adapter: exactly one registration; awaits one bounded
// inline periodic attempt inside try/catch; silent except one bounded logger
// line on failure; returns undefined. No timers: this hook is the only
// automatic invocation of the rrsi plugin. The generated, committed surface
// (hooks/rrsi-periodic.ts) is this file plus the inlined cores; the same file
// doubles as the detached worker CLI when executed with RRSI_PERIODIC_WORKER=1.
import { runPeriodic } from '../lib/periodic';

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	logger?: { warn?: (message: string) => void };
}) {
	api.on('session_start', async () => {
		try {
			const result = await runPeriodic({ env: process.env, mode: 'inline' });
			if (result && result.status === 'error' && api.logger && typeof api.logger.warn === 'function') {
				api.logger.warn(`rrsi-periodic: ${String(result.reason ?? 'error').slice(0, 80)}`);
			}
		} catch {
			/* isolate: a broken periodic run never blocks or fails a session */
		}
		return undefined;
	});
}
