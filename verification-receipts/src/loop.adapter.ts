// verification_loop tool: recompute the delegation verification ledger and
// report every open gate. Bounded (≤15s), read-only outside its own private
// state file, no network. "clean" is a mechanical recheck, never proof.
import { appendPluginOutcome } from '../../shared/lib/results';
import type { PluginOutcome } from '../../shared/lib/results';
import { evaluateRepoGates, loopOutcomePayload, repositoryDigestOf, requiredActionsFor, resolveRepoRoot, sessionDigestOf, LOOP_BUDGET_MS, type LoopEvaluation } from '../lib/loop';

const CLEAN_NOTE = 'clean is a mechanical recheck, not proof of correctness or coverage';

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readSessionId(ctx: unknown): string | null {
	if (!isRecord(ctx) || !isRecord(ctx.sessionManager) || typeof ctx.sessionManager.getSessionId !== 'function') return null;
	try {
		const value = ctx.sessionManager.getSessionId.call(ctx.sessionManager);
		return typeof value === 'string' && value.trim() ? value.trim().slice(0, 512) : null;
	} catch { return null; }
}
function blockedEvaluation(kind: 'not_a_repository' | 'state_unavailable', detail: string): LoopEvaluation {
	return { status: 'blocked', repositoryDigest: null, gaps: [{ gateId: '', trigger: 'task', kind, detail }], openGates: 0, resolvedGates: 0, scannedSessionFiles: 0, scanTruncated: false, silentPending: 0, gapKinds: [kind], stateWritten: false, budgetExceeded: false };
}

export default function verificationLoop(pi: { cwd: string; typebox: { Type: any } }) {
	const T = pi.typebox.Type;
	return {
		name: 'verification_loop',
		label: 'Verification Loop',
		description: 'Recompute the private post-delegation verification ledger for the current repository: resolve or report every open delegation gate using local repository facts and private verification receipts, including gates left open by earlier sessions. Status "clean" is a mechanical recheck, not proof of correctness or coverage; unreadable state is reported as blocked, never silently clean. Re-run after fixes until "clean" or report an explicit blocker with the remaining gaps. Bounded (≤15s), no network, no repair loops; it only writes its own per-session state file.',
		parameters: T.Object({}, { additionalProperties: false }),
		async execute(_toolCallId: string, params: Record<string, unknown>, _update?: unknown, ctx?: unknown, _signal?: AbortSignal) {
			const started = performance.now();
			const deadline = started + LOOP_BUDGET_MS;
			const journal = async (payload: Record<string, unknown>) => {
				try { return await appendPluginOutcome('verification-receipts', { ...payload, durationMs: Math.round(performance.now() - started) } as PluginOutcome); }
				catch { return { persisted: false, reason: 'store_unavailable' }; }
			};
			const text = async (value: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
			try {
				if (!params || Object.keys(params).length) {
					return text({ status: 'blocked', repositoryDigest: null, gaps: [], openGates: 0, resolvedGates: 0, scannedSessionFiles: 0, scanTruncated: false, silentPending: 0, requiredActions: ['Call verification_loop with no parameters.'], warnings: ['invalid_input'], advisoryOnly: true, notes: [CLEAN_NOTE] });
				}
				const sessionId = readSessionId(ctx);
				const root = await resolveRepoRoot(pi.cwd, Math.max(1, Math.min(3000, deadline - performance.now())));
				if (!root) {
					const evaluation = blockedEvaluation('not_a_repository', 'current directory is not inside a git repository');
					const journalStorage = await journal(loopOutcomePayload(evaluation, null));
					return text({ ...evaluation, requiredActions: requiredActionsFor(evaluation.gapKinds), journalStorage, advisoryOnly: true, notes: [CLEAN_NOTE, 'Delegation gates are recorded per repository; run this from the repository that received the delegated work.'] });
				}
				const repoDigest = await repositoryDigestOf(root);
				const sessionDigest = sessionId ? sessionDigestOf(sessionId) : sessionDigestOf('verification-loop:unattributed');
				const evaluation = await evaluateRepoGates(root, repoDigest, sessionDigest, { budgetMs: Math.max(1, deadline - performance.now()) });
				const journalStorage = await journal(loopOutcomePayload(evaluation, repoDigest));
				const warnings: string[] = [];
				if (!journalStorage.persisted) warnings.push('journal_not_persisted');
				if (!sessionId) warnings.push('session_unattributed');
				if (evaluation.budgetExceeded) warnings.push('budget_exceeded');
				if (evaluation.stateWritten === false && evaluation.status !== 'clean' && evaluation.openGates > 0) warnings.push('state_write_dropped');
				return text({
					status: evaluation.status, repositoryDigest: repoDigest, gaps: evaluation.gaps, gapKinds: evaluation.gapKinds, budgetExceeded: evaluation.budgetExceeded,
					openGates: evaluation.openGates, resolvedGates: evaluation.resolvedGates,
					scannedSessionFiles: evaluation.scannedSessionFiles, scanTruncated: evaluation.scanTruncated, silentPending: evaluation.silentPending,
					requiredActions: requiredActionsFor(evaluation.gapKinds), warnings, journalStorage, advisoryOnly: true,
					notes: [CLEAN_NOTE, 'silentPending is an upper-bound proxy for launches with no observed terminal (it may include still-running or cancelled jobs), not a count of missed gates.'],
				});
			} catch {
				const evaluation = blockedEvaluation('state_unavailable', 'evaluation failed before a verdict was reached');
				await journal(loopOutcomePayload(evaluation, null));
				return text({ ...evaluation, requiredActions: requiredActionsFor(evaluation.gapKinds), warnings: ['evaluation_failed'], advisoryOnly: true, notes: [CLEAN_NOTE] });
			}
		},
	};
}
