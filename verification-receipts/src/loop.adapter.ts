// verification_loop tool: recompute the delegation verification ledger and
// report every open gate. Bounded (≤15s), read-only outside its own private
// state file, no network. "clean" is a mechanical recheck, never proof.
import { appendPluginOutcome } from '../../shared/lib/results';
import type { PluginOutcome } from '../../shared/lib/results';
import { evaluateRepoGates, loopOutcomePayload, repositoryDigestOf, requiredActionsFor, resolveRepoRoot, sessionDigestOf, LOOP_BUDGET_MS, type LoopEvaluation } from '../lib/loop';
import { resolveReceiptRepository, RECEIPT_REPOSITORY_REASONS } from '../lib/receipts';

const CLEAN_NOTE = 'clean is a mechanical recheck, not proof of correctness or coverage';
const REPOSITORY_DETAILS: Record<string, string> = {
	not_a_repository: 'the session directory is not inside a Git work tree and no usable `repository` was given; delegated gates started from it were never recorded',
	invalid_repository: '`repository` must name an existing Git work-tree root',
	repository_outside_session_cwd: '`repository` must be the session repository or lie inside the session directory',
};
const UNGATED_SESSION_DETAIL = 'the session cwd is not inside a Git work tree, so delegation gates started from this session were never recorded; clean cannot cover them';

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
	return { status: 'blocked', repositoryDigest: null, gaps: [{ gateId: '', trigger: 'task', kind, detail }], openGates: 0, resolvedGates: 0, scannedSessionFiles: 0, scanTruncated: false, silentPending: 0, gapKinds: [kind], stateWritten: false, stateWriteAttempted: false, budgetExceeded: false };
}

export default function verificationLoop(pi: { cwd: string; typebox: { Type: any } }) {
	const T = pi.typebox.Type;
	return {
		name: 'verification_loop',
		label: 'Verification Loop',
		description: 'Recompute the private post-delegation verification ledger for the session repository or the work-tree root passed as `repository`: resolve or report every open delegation gate using local repository facts and private verification receipts, including gates left open by earlier sessions. Status "clean" is a mechanical recheck, not proof of correctness or coverage; unreadable state or a session started outside every Git work tree (which records no gates) is reported as blocked, never silently clean. Re-run after fixes until "clean" or report an explicit blocker with the remaining gaps. Bounded (≤15s), no network, no repair loops; it only writes its own per-session state file.',
		parameters: T.Object({ repository: T.Optional(T.String({ minLength: 1, maxLength: 4096, description: 'Root of the Git work tree to evaluate, absolute or relative to the session directory. Needed when the session directory is not inside a repository; it must be the session repository or lie inside the session directory. Defaults to the repository containing the session directory.' })) }, { additionalProperties: false }),
		async execute(_toolCallId: string, params: { repository?: unknown }, _update?: unknown, ctx?: unknown, _signal?: AbortSignal) {
			const started = performance.now();
			const deadline = started + LOOP_BUDGET_MS;
			const journal = async (payload: Record<string, unknown>) => {
				try { return await appendPluginOutcome('verification-receipts', { ...payload, durationMs: Math.round(performance.now() - started) } as PluginOutcome); }
				catch { return { persisted: false, reason: 'store_unavailable' }; }
			};
			const text = async (value: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
			try {
				if (!params || Object.keys(params).some(key => key !== 'repository')) {
					return text({ status: 'blocked', repositoryDigest: null, gaps: [], openGates: 0, resolvedGates: 0, scannedSessionFiles: 0, scanTruncated: false, silentPending: 0, requiredActions: ['Call verification_loop with only an optional `repository`.'], warnings: ['invalid_input'], advisoryOnly: true, notes: [CLEAN_NOTE] });
				}
				const sessionId = readSessionId(ctx);
				const repository = params.repository;
				let root: string | null = null;
				let repositoryReason = 'not_a_repository';
				if (repository === undefined) {
					root = await resolveRepoRoot(pi.cwd, Math.max(1, Math.min(3000, deadline - performance.now())));
				} else {
					try { root = await resolveReceiptRepository(pi.cwd, repository); }
					catch (error) {
						const cause = error instanceof Error ? error.message : '';
						if ((RECEIPT_REPOSITORY_REASONS as readonly string[]).includes(cause)) repositoryReason = cause;
					}
				}
				if (!root) {
					const evaluation = blockedEvaluation('not_a_repository', REPOSITORY_DETAILS[repositoryReason] ?? REPOSITORY_DETAILS.not_a_repository);
					const journalStorage = await journal(loopOutcomePayload(evaluation, null));
					return text({ ...evaluation, reason: repositoryReason, requiredActions: [...new Set([...requiredActionsFor(evaluation.gapKinds), 'Pass `repository` with the work-tree root when the session directory is not a Git work tree.'])].slice(0, 4), journalStorage, advisoryOnly: true, warnings: repository === undefined ? [] : [repositoryReason], notes: [CLEAN_NOTE, 'Delegation gates are recorded per repository; run this from the repository that received the delegated work.'] });
				}
				const repoDigest = await repositoryDigestOf(root);
				const sessionDigest = sessionId ? sessionDigestOf(sessionId) : sessionDigestOf('verification-loop:unattributed');
				const evaluation = await evaluateRepoGates(root, repoDigest, sessionDigest, { budgetMs: Math.max(1, deadline - performance.now()) });
				// A session started outside every Git work tree never records delegation gates, so an
				// explicit repository cannot make that session's ungated work look clean.
				const unrecorded = repository !== undefined && !(await resolveRepoRoot(pi.cwd, Math.max(1, Math.min(3000, deadline - performance.now()))));
				const effective: LoopEvaluation = unrecorded ? {
					...evaluation,
					status: 'blocked',
					gaps: [{ gateId: '', trigger: 'task', kind: 'not_a_repository', detail: UNGATED_SESSION_DETAIL }, ...evaluation.gaps].slice(0, 16),
					gapKinds: [...new Set(['not_a_repository' as const, ...evaluation.gapKinds])].slice(0, 10),
				} : evaluation;
				const journalStorage = await journal(loopOutcomePayload(effective, repoDigest));
				const warnings: string[] = [];
				if (!journalStorage.persisted) warnings.push('journal_not_persisted');
				if (!sessionId) warnings.push('session_unattributed');
				if (effective.budgetExceeded) warnings.push('budget_exceeded');
				if (effective.stateWriteAttempted && !effective.stateWritten) warnings.push('state_write_dropped');
				if (unrecorded) warnings.push('ungated_session_cwd');
				const requiredActions = unrecorded
					? [...new Set(['Delegated work started outside a Git work tree is ungated; rerun it from inside the repository or report the missing gate explicitly in the final message.', ...requiredActionsFor(effective.gapKinds)])].slice(0, 4)
					: requiredActionsFor(effective.gapKinds);
				return text({
					status: effective.status, repositoryDigest: repoDigest, gaps: effective.gaps, gapKinds: effective.gapKinds, budgetExceeded: effective.budgetExceeded,
					openGates: effective.openGates, resolvedGates: effective.resolvedGates,
					scannedSessionFiles: effective.scannedSessionFiles, scanTruncated: effective.scanTruncated, silentPending: effective.silentPending,
					requiredActions, warnings, ...(unrecorded ? { reason: 'not_a_repository' } : {}), journalStorage, advisoryOnly: true,
					notes: [CLEAN_NOTE, ...(unrecorded ? ['Gates are recorded in the repository containing the session cwd; a session outside every Git work tree records none.'] : []), 'silentPending is an upper-bound proxy for launches with no observed terminal (it may include still-running or cancelled jobs), not a count of missed gates.'],
				});
			} catch {
				const evaluation = blockedEvaluation('state_unavailable', 'evaluation failed before a verdict was reached');
				await journal(loopOutcomePayload(evaluation, null));
				return text({ ...evaluation, requiredActions: requiredActionsFor(evaluation.gapKinds), warnings: ['evaluation_failed'], advisoryOnly: true, notes: [CLEAN_NOTE] });
			}
		},
	};
}
