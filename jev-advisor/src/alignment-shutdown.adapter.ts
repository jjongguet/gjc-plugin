// Goal-alignment session-shutdown surface. Flushes the unresolved recovery
// counts once per recovery id; a repeated shutdown appends nothing.
import { recordHookError, recordShutdown } from "../lib/alignment";
import { appendJournalStore, journalStoreBudgetMs, loadJournalStore } from "../lib/alignment-journal";

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	api.on("session_shutdown", async (_event, ctx) => {
		// One store budget for this flush: a hung store degrades instead of
		// holding session shutdown open.
		const storeBudgetMs = journalStoreBudgetMs();
		try {
			const now = Date.now();
			const { snapshot } = await loadJournalStore(ctx, now, storeBudgetMs);
			const state = snapshot.latest;
			if (!state || state.step >= 4) return undefined;
			// Idempotent stop: the same unresolved recovery is flushed at most once.
			if (snapshot.shutdownFor[state.recoveryId]) return undefined;
			const shutdown = recordShutdown({ state, counts: snapshot.counts, now });
			await appendJournalStore(ctx, [shutdown], now, storeBudgetMs);
			return undefined;
		} catch (error) {
			// hook_error: shutdown is best effort and never blocks anything, but the
			// failure class is recorded for auditability.
			try {
				await appendJournalStore(ctx, [recordHookError({ errorClass: error instanceof Error ? error.name || "error" : "non_error", now: Date.now() })], Date.now(), storeBudgetMs);
			} catch {
				// Recording must never change the outcome.
			}
			return undefined;
		}
	});
}
