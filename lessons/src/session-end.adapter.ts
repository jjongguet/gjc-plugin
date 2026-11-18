import { scanLine, sessionEndStage, stageLine, type CorrectionDeps } from "../lib/correction";

/**
 * session_shutdown adapter: one bounded, best-effort staging attempt. The scan
 * owns a 1500 ms deadline (checked between project directories, transcripts and
 * chunks) and every error is swallowed, so a missing transcript, a broken ledger
 * root or a slow filesystem can never block or fail a shutdown. Nothing is
 * written outside the plugin data directory; a staged correction is logged once
 * at info level and a scan that stopped at the read cap is logged once at debug
 * level. The host calls `register(api)`; the optional second argument lets the
 * verify suite point the same code at a synthetic session store and data
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
			/* the hook never blocks a shutdown */
		}
		return undefined;
	});
}
