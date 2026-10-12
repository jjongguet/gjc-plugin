// Delegation gate hook: appends a bounded verification-gate block to completed
// task/subagent/job results and records the gate in the private loop state.
// Fail-open: any classification or IO failure returns undefined and leaves the
// original content untouched. Never blocks, never calls a provider.
import { appendPluginOutcome } from '../../shared/lib/results';
import type { PluginOutcome } from '../../shared/lib/results';
import { BEFORE_BUDGET_MS, GATE_TEXT_MAX, buildGateText, gateOutcomePayload, gitDeltaFacts, jobDedupKey, latestReceiptSummary, readLoopState, recordGate, recordPendingAsync, repositoryDigestOf, resolveRepoRoot, sessionDigestOf, taskDedupKey } from '../lib/loop';
import type { LoopBindingEvidence, LoopGateFactState, LoopGateTrigger, LoopReceiptSummary } from '../lib/loop';

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function boundedId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= 512 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}
function readSessionId(ctx: unknown): string | null {
	if (!isRecord(ctx) || !isRecord(ctx.sessionManager) || typeof ctx.sessionManager.getSessionId !== 'function') return null;
	try { return boundedId(ctx.sessionManager.getSessionId.call(ctx.sessionManager)); } catch { return null; }
}

function bindingEvidenceOf(input: Record<string, any>, details: Record<string, any>): { evidence: LoopBindingEvidence; boundRoot?: string } {
	const bindings: Record<string, any>[] = [];
	if (isRecord(input.repositoryBinding)) bindings.push(input.repositoryBinding);
	if (isRecord(details.repositoryBinding)) bindings.push(details.repositoryBinding);
	if (Array.isArray(input.tasks)) for (const entry of input.tasks) if (isRecord(entry) && isRecord(entry.repositoryBinding)) bindings.push(entry.repositoryBinding);
	let persistencePresent = false;
	let persistenceUnknown = false;
	if (Array.isArray(details.results)) for (const entry of details.results) {
		if (!isRecord(entry)) continue;
		if (isRecord(entry.repositoryBinding)) bindings.push(entry.repositoryBinding);
		const outcome = isRecord(entry.persistence) && typeof entry.persistence.outcome === 'string' ? entry.persistence.outcome : '';
		if (outcome === 'applied' || outcome === 'recovery_available') persistencePresent = true;
		else if (outcome === 'no_changes') persistenceUnknown = true;
	}
	const isolated = input.isolated === true || details.isolated === true;
	if (bindings.length || isolated || persistencePresent) {
		const worktreeRoot = typeof bindings[0]?.worktreeRoot === 'string' && bindings[0].worktreeRoot.length <= 4096 ? bindings[0].worktreeRoot : undefined;
		return { evidence: 'present', ...(worktreeRoot ? { boundRoot: worktreeRoot } : {}) };
	}
	if (persistenceUnknown) return { evidence: 'unknown' };
	return { evidence: 'absent' };
}

export default function register(api: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) {
	api.on('tool_result', async (event, ctx) => {
		try {
			const result = isRecord(event) ? event : null;
			if (!result || result.type !== 'tool_result') return undefined;
			const toolName = result.toolName;
			if (toolName !== 'task' && toolName !== 'subagent' && toolName !== 'job') return undefined;
			if (isRecord(ctx) && isRecord(ctx.signal) && ctx.signal.aborted === true) return undefined;
			if (result.isError === true) return undefined;
			const sessionId = readSessionId(ctx);
			const cwd = isRecord(ctx) && typeof ctx.cwd === 'string' ? ctx.cwd : null;
			if (!sessionId || !cwd) return undefined;
			const root = await resolveRepoRoot(cwd, BEFORE_BUDGET_MS);
			if (!root) return undefined;
			const repoDigest = await repositoryDigestOf(root);
			const sessionDigest = sessionDigestOf(sessionId);
			const stateRead = await readLoopState(repoDigest, sessionDigest);
			const state = stateRead.state;
			const details = isRecord(result.details) ? result.details : {};
			const input = isRecord(result.input) ? result.input : {};
			const toolCallId = boundedId(result.toolCallId);
			const appended: { idShort: string; text: string }[] = [];

			const gate = async (opts: { trigger: LoopGateTrigger; dedupKey: string; jobId?: string; callId?: string; partial?: { completed: number; total: number }; binding: { evidence: LoopBindingEvidence; boundRoot?: string } }) => {
				const pendingBaseline = opts.jobId ? state?.pendingAsync.find(entry => entry.jobId === opts.jobId)?.baselineToolCallId ?? null : null;
				const baselineCallId = opts.callId ?? pendingBaseline;
				const baseline = baselineCallId ? state?.baselines.find(entry => entry.toolCallId === baselineCallId) ?? null : null;
				const delta = await gitDeltaFacts(root, baseline?.head ?? null, BEFORE_BUDGET_MS);
				const receipt = await latestReceiptSummary(root);
				const facts: LoopGateFactState = !delta.available ? 'unavailable' : opts.binding.evidence === 'absent' ? 'available' : 'partial';
				const noChange = delta.available && baseline !== null && opts.binding.evidence === 'absent' && delta.commits === 0 && delta.changedFiles === 0 && delta.treeClean;
				const recorded = await recordGate(repoDigest, sessionDigest, root, {
					trigger: opts.trigger, dedupKey: opts.dedupKey, ...(opts.callId ? { toolCallId: opts.callId } : {}), ...(opts.jobId ? { jobId: opts.jobId } : {}),
					baselineToolCallId: baselineCallId, facts, bindingEvidence: opts.binding.evidence, ...(opts.binding.boundRoot ? { boundRoot: opts.binding.boundRoot } : {}),
					changedFiles: delta.changedFiles, commits: delta.commits, receiptState: receipt.state, noChange,
				});
				if (recorded.duplicate) return;
				const idShort = (recorded.gateId ?? opts.dedupKey).slice(0, 8);
				const text = buildGateText({
					tool: toolName, idShort, facts, root, baselinePresent: baseline !== null, baselineAt: baseline?.capturedAt ?? null,
					treeClean: delta.treeClean, effectsClean: delta.changedFiles === 0, changedFiles: delta.changedFiles, changedNames: delta.changedNames,
					namesOverflow: delta.namesOverflow, commits: delta.commits, binding: opts.binding.evidence, receipt, partial: opts.partial ?? null, noChange,
				});
				appended.push({ idShort, text });
					try {
					const outcome = gateOutcomePayload({
						repositoryDigest: repoDigest, trigger: opts.trigger, dedupKey: opts.dedupKey, facts, baselinePresent: baseline !== null,
						binding: opts.binding.evidence === 'present' ? 'bound' : opts.binding.evidence === 'absent' ? 'none' : 'unknown', stateWrite: recorded.stateWrite,
						persistence: opts.binding.evidence !== 'absent' ? 'recovery_available' : noChange ? 'no_changes' : 'applied',
						changedFiles: delta.changedFiles, commits: delta.commits, receiptState: receipt.state,
					});
					await appendPluginOutcome('verification-receipts', outcome as PluginOutcome);
				} catch { /* journaling is best-effort; the appended text carries the requirement */ }
			};

			if (toolName === 'task') {
				const asyncInfo = isRecord(details.async) ? details.async : null;
				const jobId = asyncInfo ? boundedId(asyncInfo.jobId) : null;
				const asyncState = asyncInfo && typeof asyncInfo.state === 'string' ? asyncInfo.state.trim().toLowerCase() : '';
				if (jobId && asyncState !== 'completed' && asyncState !== 'failed') {
					if (toolCallId) await recordPendingAsync(repoDigest, sessionDigest, root, jobId, toolCallId);
					return undefined;
				}
				const results = Array.isArray(details.results) ? details.results : [];
				const tasks = Array.isArray(input.tasks) ? input.tasks : [];
				const total = tasks.length || results.length;
				const completed = results.filter(entry => isRecord(entry) && entry.status === 'completed').length;
				if (jobId) {
					if (asyncState !== 'completed') return undefined;
					await gate({ trigger: 'task_async', dedupKey: jobDedupKey(jobId), jobId, binding: bindingEvidenceOf(input, details) });
				} else {
					if (completed < 1 || !toolCallId) return undefined;
					await gate({ trigger: 'task', dedupKey: taskDedupKey(toolCallId), callId: toolCallId, partial: { completed, total }, binding: bindingEvidenceOf(input, details) });
				}
			} else if (toolName === 'subagent') {
				const subagents = Array.isArray(details.subagents) ? details.subagents : [];
				for (const entry of subagents) {
					if (!isRecord(entry) || entry.status !== 'completed') continue;
					const jobId = boundedId(entry.jobId);
					if (!jobId) continue;
					await gate({ trigger: 'subagent_terminal', dedupKey: jobDedupKey(jobId), jobId, binding: { evidence: 'unknown' } });
				}
			} else {
				const jobs = Array.isArray(details.jobs) ? details.jobs : [];
				for (const entry of jobs) {
					if (!isRecord(entry) || entry.status !== 'completed') continue;
					const type = typeof entry.type === 'string' ? entry.type : typeof entry.kind === 'string' ? entry.kind : '';
					if (type && type !== 'task') continue;
					const jobId = boundedId(entry.id) ?? boundedId(entry.jobId);
					if (!jobId) continue;
					await gate({ trigger: 'job_terminal', dedupKey: jobDedupKey(jobId), jobId, binding: { evidence: 'unknown' } });
				}
			}

			if (!appended.length) return undefined;
			const content = Array.isArray(result.content) ? result.content : [];
			const extra = appended.length > 1 ? `\n(+${appended.length - 1} more terminal gates in this event)` : '';
			const text = (appended[0].text + extra).slice(0, GATE_TEXT_MAX + 200);
			return { content: [...content, { type: 'text', text }] };
		} catch {
			return undefined;
		}
	});
}
