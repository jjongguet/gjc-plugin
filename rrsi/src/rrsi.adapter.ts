// rrsi tool adapter: one explicitly invoked tool with actions capture | import | dream | status.
// The only automatic invocation is the session_start hook (src/periodic.adapter.ts, generated as
// hooks/rrsi-periodic.ts): a due-gated, bounded refresh — no timer process. Keyless and offline:
// the tool never reads credentials and makes no network call.
// Every handled invocation appends exactly one sanitized rrsi outcome to the shared journal.
// capture/import read-modify-write sequences are serialized by the shared store lock
// (store_busy on contention; see lib/rrsi.ts withStoreLock).
import { appendPluginOutcome } from '../../shared/lib/results';
import {
	RRSI_LIMITS,
	RRSI_SCOPE_SENTENCE,
	captureEpisode,
	derivedEpisodeSetFor,
	dreamOverStore,
	projectionDigestFor,
	projectionCoverage,
	projectJournalRecords,
	journalWindowCoverage,
	projectQualityCohort,
	readTrialRecords,
	projectLedgerRows,
	readJournalRecords,
	readLedgerRows,
	readStore,
	replaceDerivedSet,
	rrsiJournalDir,
	storeCounts,
	summarizeReceipt,
	withStoreLock,
	writeStore,
} from '../lib/rrsi';
import { RRSI_PERIODIC_DEFAULTS, readPeriodicState, summarizePeriodicState } from '../lib/periodic';

type RrsiStorage = 'ok' | 'missing' | 'unavailable' | 'invalid';
const ACTIONS = ['capture', 'import', 'dream', 'status', 'cohort'] as const;
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
			recordsPath: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: 'cohort: path to a bounded gjc.quality_trial.v2 receipt file (JSON array or JSONL, read-only)' })),
			limit: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: 'import: maximum attempts to project (default 200)' })),
			seed: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: 'dream: deterministic seed (default 1)' })),
		}),
		async execute(_toolCallId: string, params: { action?: string; goal?: string; attempts?: string; ledgerPath?: string; recordsPath?: string; limit?: string; seed?: string }) {
			const started = Date.now();
			const action = (ACTIONS as readonly string[]).includes(String(params?.action ?? '')) ? (params!.action as RrsiAction) : null;
			const limit = rrsiParseInt(params?.limit, RRSI_PERIODIC_DEFAULTS.projectionLimit, 4000);
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
				return { content: [{ type: 'text', text }], ...(action ? {} : { isError: true }) };
			};

			if (!action) {
				const empty = readStore();
				return finish({ store: empty.store, storageStatus: empty.status, counts: storeCounts(empty.store) }, (empty.status as RrsiStorage) ?? 'unavailable');
			}

			const loaded = readStore();
			const storage: RrsiStorage = loaded.status === 'ok' ? 'ok' : loaded.status === 'missing' ? 'missing' : loaded.status === 'invalid' ? 'invalid' : 'unavailable';
			if (action === 'status') {
				const periodicState = readPeriodicState();
				return finish(
					{
						store: loaded.store,
						storageStatus: loaded.status,
						storageReason: loaded.reason,
						counts: storeCounts(loaded.store),
						journalDir: rrsiJournalDir(),
						periodic: summarizePeriodicState({ state: periodicState.status === 'ok' ? periodicState.state : null }),
					},
					storage,
				);
			}

			if (action === 'capture') {
				const locked = withStoreLock(process.env, () => {
					const current = readStore();
					const captured = captureEpisode({ store: current.store, goal: params?.goal, attempts: parseAttempts(params?.attempts), now });
					const written = writeStore({ store: captured.store });
					return { captured, written };
				});
				if (!locked.ok) {
					return finish({ store: loaded.store, episode: null, counts: storeCounts(loaded.store), wrote: { persisted: false, reason: locked.reason ?? 'store_busy' } }, 'unavailable');
				}
				const { captured, written } = locked.result;
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
				const projection = projectionCoverage(journal.records, projected.attempts);
				const window = journalWindowCoverage(journal.segmentReport, limit);
				const journalSummary = {
					status: journal.status,
					segments: journal.segments,
					records: journal.records.length,
					branches: projected.branches,
					newestCovered: window.covered,
					ordering: journal.ordering,
					inventory: journal.inventory,
					skippedSegments: journal.skippedSegments,
					truncatedSegments: journal.truncatedSegments,
					window: { headOmitted: projected.headOmitted, novelty: projected.novelty },
				};
				const projectionDigest = projectionDigestFor(projected.attempts, limit);
				const derived = derivedEpisodeSetFor({ digest: projectionDigest, attempts: projected.attempts });
				let ledgerCount = 0;
				let ledgerDerived = { episodes: [] as Array<{ id: string }> };
				if (typeof params?.ledgerPath === 'string' && params.ledgerPath.length > 0) {
					const ledger = readLedgerRows({ ledgerPath: params.ledgerPath });
					const ledgerProjection = projectLedgerRows(ledger.rows, { limit });
					ledgerCount = ledgerProjection.attempts.length;
					const ledgerDigest = projectionDigestFor(ledgerProjection.attempts, limit);
					ledgerDerived = derivedEpisodeSetFor({ digest: ledgerDigest, attempts: ledgerProjection.attempts, source: 'self-improve-ledger', goalPrefix: 'ledger projection' });
				}
				const locked = withStoreLock(process.env, () => {
					const current = readStore();
					if (!window.covered) {
						return { store: current.store, storeWrite: 'held' as const, written: { persisted: false, reason: 'held', bytes: 0 } };
					}
					const replacedJournal = replaceDerivedSet({ store: current.store, sourceClass: 'jev-journal', derivedSet: derived.episodes });
					const replacedLedger =
						ledgerDerived.episodes.length > 0
							? replaceDerivedSet({ store: replacedJournal.store, sourceClass: 'self-improve-ledger', derivedSet: ledgerDerived.episodes })
							: { store: replacedJournal.store, storeWrite: 'none' as const, episodesDelta: 0, attemptsDelta: 0 };
					const storeWrite = replacedLedger.storeWrite === 'none' ? replacedJournal.storeWrite : replacedLedger.storeWrite;
					if (storeWrite === 'unchanged') {
						return { store: current.store, storeWrite, written: { persisted: true, reason: 'unchanged', bytes: 0 } };
					}
					const written = writeStore({ store: replacedLedger.store });
					return { store: written.persisted ? replacedLedger.store : current.store, storeWrite, written };
				});
				if (!locked.ok) {
					return finish(
						{
							store: loaded.store,
							imported: 0,
							journal: journalSummary,
							counts: storeCounts(loaded.store),
							wrote: { persisted: false, reason: locked.reason ?? 'store_busy' },
							storeWrite: 'rejected',
							projectionDigest,
							projection,
						},
						storage,
					);
				}
				const { store, storeWrite, written } = locked.result;
				return finish(
					{
						store,
						imported: storeWrite === 'held' ? 0 : projected.attempts.length + ledgerCount,
						journal: journalSummary,
						counts: storeCounts(store),
						wrote: written,
						storeWrite,
						projectionDigest,
						projection,
					},
					written.persisted ? 'ok' : 'unavailable',
				);
			}

			if (action === 'cohort') {
				const cohortLimit = rrsiParseInt(params?.limit, 4000, 4000);
				const trials = readTrialRecords({ recordsPath: params?.recordsPath, limit: cohortLimit });
				const source = { status: trials.status, reason: trials.reason ?? null, path: typeof params?.recordsPath === 'string' ? params.recordsPath : null };
				if (trials.status !== 'ok') {
					return finish(
						{
							store: loaded.store,
							cohort: { schema: 'rrsi.quality_cohort.v2', total: 0, admissible: [], excluded: [], duplicate: 0 },
							source,
							counts: storeCounts(loaded.store),
						},
						storage,
					);
				}
				return finish(
					{ store: loaded.store, cohort: projectQualityCohort(trials.records, { limit: cohortLimit }), source, counts: storeCounts(loaded.store) },
					storage,
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
