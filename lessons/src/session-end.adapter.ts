import { scanLine, sessionEndStage, stageLine, type CorrectionDeps } from "../lib/correction";

/**
 * session_shutdown adapter: one best-effort staging attempt. The scan checks its
 * own 1500 ms deadline between project directories, between transcripts and
 * between chunks, and every error is swallowed, so a missing transcript or a
 * broken ledger root can never fail a shutdown. A single blocking filesystem
 * call is not preemptible: one hung read or stat can still delay the shutdown,
 * and `withBound` inside sessionEndStage only guards promise settlement. Nothing
 * is written outside the plugin data directory; a staged correction is logged
 * once at info level and a scan that stopped at the read cap is logged once at
 * debug level. The host calls `register(api)`; the optional second argument lets
 * the verify suite point the same code at a synthetic session store and data
 * directory.
 */
export default function register(
	api: {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
		logger?: {
			info?: (message: string) => void;
			warn?: (message: string) => void;
			debug?: (message: string) => void;
		};
	},
	deps: CorrectionDeps = {},
) {
	api.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
		try {
			const outcome = await sessionEndStage(ctx, deps);
			const line = stageLine(outcome);
			if (line !== null) {
				try {
					if (typeof api.logger?.info === "function") api.logger.info(line);
					else api.logger?.warn?.(line);
				} catch {
					/* logging is advisory */
				}
				return undefined;
			}
			const debug = scanLine(outcome, deps);
			if (debug !== null) {
				try {
					api.logger?.debug?.(debug);
				} catch {
					/* logging is advisory */
				}
			}
		} catch {
			/* the hook never fails a shutdown; the deadline bounds the scan */
		}
		return undefined;
	});
}
