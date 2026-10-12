// Before-task baseline hook: records one bounded repository baseline per task
// call. It never blocks or rewrites anything; any failure simply leaves the
// delegation ungated-factually (partial facts at gate time).
import { BEFORE_BUDGET_MS, captureBaseline, recordTaskBaseline, repositoryDigestOf, resolveRepoRoot, sessionDigestOf } from '../lib/loop';

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

export default function register(api: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) {
	api.on('tool_call', async (event, ctx) => {
		try {
			const call = isRecord(event) ? event : null;
			if (!call || call.type !== 'tool_call' || call.toolName !== 'task') return undefined;
			const sessionId = readSessionId(ctx);
			const toolCallId = boundedId(call.toolCallId);
			const cwd = isRecord(ctx) && typeof ctx.cwd === 'string' ? ctx.cwd : null;
			if (!sessionId || !toolCallId || !cwd) return undefined;
			const deadline = performance.now() + BEFORE_BUDGET_MS;
			const root = await resolveRepoRoot(cwd, Math.max(1, deadline - performance.now()));
			if (!root) return undefined;
			const baseline = await captureBaseline(root, Math.max(1, deadline - performance.now()));
			if (!baseline) return undefined;
			const repoDigest = await repositoryDigestOf(root);
			await recordTaskBaseline(repoDigest, sessionDigestOf(sessionId), root, toolCallId, baseline);
			return undefined;
		} catch {
			return undefined;
		}
	});
}
