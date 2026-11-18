import { sessionEndStage, stageLine, type CorrectionDeps } from "../lib/correction";

/**
 * session_shutdown adapter: one bounded, best-effort staging attempt. The work
 * is capped at 1500 ms and every error is swallowed, so a missing transcript, a
 * broken ledger root or a slow filesystem can never block or fail a shutdown.
 * Nothing is written outside the plugin data directory and nothing is logged
 * unless a correction was actually staged. The host calls `register(api)`; the
 * optional second argument lets the verify suite point the same code at a
 * synthetic session store and data directory.
 */
export default function register(
	api: {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
		logger?: { info?: (message: string) => void; warn?: (message: string) => void };
	},
	deps: CorrectionDeps = {},
) {
	api.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
		try {
			const line = stageLine(await sessionEndStage(ctx, deps));
			if (line === null) return undefined;
			try {
				if (typeof api.logger?.info === "function") api.logger.info(line);
				else api.logger?.warn?.(line);
			} catch {
				/* logging is advisory */
			}
		} catch {
			/* the hook never blocks a shutdown */
		}
		return undefined;
	});
}
