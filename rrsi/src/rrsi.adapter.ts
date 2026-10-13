// rrsi tool adapter: one explicitly invoked tool with actions capture | import | dream | status.
// No hook registrations. Keyless and offline: the tool never reads credentials and makes no network call.
// Every handled invocation appends exactly one sanitized rrsi outcome to the shared journal.
import { appendPluginOutcome } from '../../shared/lib/results';
import {
	RRSI_LIMITS,
	RRSI_SCOPE_SENTENCE,
	captureEpisode,
	dreamOverStore,
	mergeEpisodes,
	normalizeEpisode,
	projectJournalRecords,
	projectLedgerRows,
	readJournalRecords,
	readLedgerRows,
	readStore,
	rrsiJournalDir,
	storeCounts,
	summarizeReceipt,
	writeStore,
} from '../lib/rrsi';

type RrsiStorage = 'ok' | 'missing' | 'unavailable' | 'invalid';
const ACTIONS = ['capture', 'import', 'dream', 'status'] as const;
type RrsiAction = (typeof ACTIONS)[number];

function rrsiParseInt(value: unknown, fallback: number, max = 100000): number {
	return typeof value === 'string' && /^\d+$/.test(value) ? Math.min(Number.parseInt(value, 10), max) : fallback;
}

function parseAttempts(raw: unknown): unknown[] {
	if (typeof raw !== 'string' || raw.trim() === '') return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.slice(0, RRSI_LIMITS.maxAttemptsPerEpisode) : [];
	} catch {
		return [];
	}
}

export default function rrsi(pi: {
	typebox: { Type: { Object: (fields: Record<string, unknown>) => unknown; String: (options?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };
}) {
	return {
		name: 'rrsi',
		label: 'RRSI Exploration Store',
		description:
			'Record, import and replay GJC exploration traces through the bundled Dream-RSI core (capture | import | dream | status). capture stores a bounded episode (goal plus attempts with features/outcome); import projects the jev-advisor journal and/or a self-improve ledger into attempts (read-only); dream ranks deterministic policies over the store off-policy; status reports store counts and storage state. Keyless and offline: no network, no credentials, no model calls, and the private store lives under ~/.gjc-plugin/rrsi/.',
		parameters: pi.typebox.Type.Object({
			action: pi.typebox.Type.String({ description: 'capture | import | dream | status' }),
			goal: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: 'capture: one bounded goal label for the episode' })),
			attempts: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: 'capture: JSON array of attempts [{objective, hypothesisNovelty, decision, wallMs, guardFailures, budgetRung, files, hunks}]' })),
			ledgerPath: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: 'import: optional path to a self-improve ledger.jsonl to project (read-only)' })),
			limit: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: 'import: maximum attempts to project (default 200)' })),
			seed: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: 'dream: deterministic seed (default 1)' })),
		}),
		async execute(_toolCallId: string, params: { action?: string; goal?: string; attempts?: string; ledgerPath?: string; limit?: string; seed?: string }) {
			const started = Date.now();
			const action = (ACTIONS as readonly string[]).includes(String(params?.action ?? '')) ? (params!.action as RrsiAction) : null;
			const limit = rrsiParseInt(params?.limit, 200, 4000);
			const seed = rrsiParseInt(params?.seed, 1, 1_000_000);
			const now = new Date().toISOString();
			const finish = async (payload: Record<string, unknown>, storage: RrsiStorage) => {
				const journalAction: RrsiAction = action ?? 'status';
				const counts = storeCounts(payload.store as never);
				let journalStorage: { persisted: boolean; reason: string };
				try {
					journalStorage = await appendPluginOutcome('rrsi', {
						operation: journalAction,
						durationMs: Date.now() - started,
						rrsi: {
							action: journalAction,
							episodes: counts.episodes,
							attempts: counts.attempts,
							imported: typeof payload.imported === 'number' ? payload.imported : 0,
							policies: typeof payload.policies === 'number' ? payload.policies : 0,
							storage,
						},
					});
				} catch {
					journalStorage = { persisted: false, reason: 'store_unavailable' };
				}
				const text = JSON.stringify(
					{
						action: journalAction,
						...(action ? {} : { error: `unknown action: ${String(params?.action ?? '')}` }),
						scope: RRSI_SCOPE_SENTENCE,
						...payload,
						store: undefined,
						journalStorage,
					},
					null,
					2,
				);
				return { content: [{ type: 'text', text }] };
			};

			if (!action) {
				const empty = readStore();
				return finish({ store: empty.store, storageStatus: empty.status, counts: storeCounts(empty.store) }, (empty.status as RrsiStorage) ?? 'unavailable');
			}

			const loaded = readStore();
			const storage: RrsiStorage = loaded.status === 'ok' ? 'ok' : loaded.status === 'missing' ? 'missing' : loaded.status === 'invalid' ? 'invalid' : 'unavailable';
			if (action === 'status') {
				return finish(
					{ store: loaded.store, storageStatus: loaded.status, storageReason: loaded.reason, counts: storeCounts(loaded.store), journalDir: rrsiJournalDir() },
					storage,
				);
			}

			if (action === 'capture') {
				const captured = captureEpisode({ store: loaded.store, goal: params?.goal, attempts: parseAttempts(params?.attempts), now });
				const written = writeStore({ store: captured.store });
				return finish(
					{
						store: written.persisted ? captured.store : loaded.store,
						episode: { id: captured.episode.id, goal: captured.episode.goal, attempts: captured.episode.attempts.length },
						counts: storeCounts(captured.store),
						wrote: written,
					},
					written.persisted ? 'ok' : 'unavailable',
				);
			}

			if (action === 'import') {
				const journal = readJournalRecords({ journalDir: rrsiJournalDir() });
				const projected = projectJournalRecords(journal.records, { limit });
				const episodes = [];
				if (projected.attempts.length > 0) {
					episodes.push(normalizeEpisode({ source: 'jev-journal', goal: `jev-advisor journal (${journal.segments} segment(s))`, attempts: projected.attempts }, now));
				}
				let ledgerCount = 0;
				if (typeof params?.ledgerPath === 'string' && params.ledgerPath.length > 0) {
					const ledger = readLedgerRows({ ledgerPath: params.ledgerPath });
					const ledgerProjection = projectLedgerRows(ledger.rows, { limit });
					ledgerCount = ledgerProjection.attempts.length;
					if (ledgerCount > 0) {
						episodes.push(normalizeEpisode({ source: 'self-improve-ledger', goal: 'self-improve ledger projection', attempts: ledgerProjection.attempts }, now));
					}
				}
				const merged = mergeEpisodes({ store: loaded.store, episodes, now });
				const written = writeStore({ store: merged });
				return finish(
					{
						store: written.persisted ? merged : loaded.store,
						imported: projected.attempts.length + ledgerCount,
						journal: { status: journal.status, segments: journal.segments, records: journal.records.length, branches: projected.branches },
						counts: storeCounts(merged),
						wrote: written,
					},
					written.persisted ? 'ok' : 'unavailable',
				);
			}

			// dream
			const { corpus, receipt } = dreamOverStore({ store: loaded.store, seed });
			return finish(
				{
					store: loaded.store,
					corpus: receipt.corpus,
					counts: storeCounts(loaded.store),
					policies: receipt.candidateCount,
					summary: summarizeReceipt(receipt),
					corpusAttempts: corpus.attempts.length,
				},
				storage,
			);
		},
	};
}
