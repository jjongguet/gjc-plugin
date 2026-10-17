// Receipt-only observer for task launch envelopes and terminal subagent
// snapshots. It never calls a provider or rewrites a tool result.
import { appendPluginOutcome, type PluginOutcome } from '../../shared/lib/results';

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	api.on("tool_result", async (event, ctx) => {
		let outcome: PluginOutcome | undefined;
		const observations={completed:0,failed:0,cancelled:0,stored:0,unavailable:0};
		try {
			if (!isResultRecord(event) || event.type !== "tool_result") return undefined;
			const result = event;
			if (result.toolName !== "task" && result.toolName !== "subagent") return undefined;
			const operation = result.toolName === 'task' ? 'task_launch' : 'subagent_terminal';
			outcome={operation,evidenceStorage:{status:'not_requested'}};
			const sessionId = readSessionId(ctx);
			if (!sessionId) return undefined;
			const details = isResultRecord(result.details) ? result.details : {};

			// Widget lifecycle block. This runs before the ctx-signal, isError,
			// memory, and provider/config gates so clearing still works when
			// JEV_ADVISOR_MEMORY=off or the provider is off/unconfigured — the
			// pre-hook still draws its widget in those setups.
			const ui = isResultRecord(ctx) && isResultRecord(ctx.ui) ? ctx.ui : undefined;
			const clearWidget = () => {
				try {
					if (typeof ui?.setWidget === "function") ui.setWidget("jev-advisor", undefined);
				} catch {}
				widgetDropSession(sessionId);
			};
			if (result.toolName === "task") {
				const callId = boundedEventId(result.toolCallId);
				const entry = callId ? widgetSessionEntry(sessionId) : null;
				// Total matching-receipt classification. Only receipts matching the
				// session entry's toolCallId may affect the lifecycle; older batches
				// and other sessions never clear.
				if (callId && entry && entry.toolCallId === callId) {
					// Classification order matters: aborted/isError is checked first,
					// before the async-envelope check.
					const ctxAborted = isResultRecord(ctx) && isResultRecord(ctx.signal) && ctx.signal.aborted === true;
					if (ctxAborted || result.isError === true) {
						// The call ended without a live batch.
						clearWidget();
						return undefined;
					}
					if (result.blocked === true || details.blocked === true) {
						// Defensive: no producer of a blocked flag was found on the
						// result path, but if one appears, treat the call as ended.
						// Falls through so existing store behavior is preserved.
						clearWidget();
					} else {
						const asyncDetails = isResultRecord(details.async) ? details.async : null;
						const envelopeJobId = asyncDetails ? boundedEventId(asyncDetails.jobId) : null;
						if (asyncDetails && envelopeJobId) {
							const asyncState = typeof asyncDetails.state === "string" ? asyncDetails.state.trim().toLowerCase() : "";
							if (asyncState === "completed" || asyncState === "failed") {
								clearWidget();
							} else {
								// Batch backgrounded and still in flight: mark it as
								// awaiting async and pin the primary job id.
								widgetMarkAwaitingAsync(sessionId, callId, envelopeJobId);
							}
						} else {
							// No usable async job envelope: the call returned without a
							// backgrounded batch (sync batches end here, definitively).
							clearWidget();
						}
					}
				}
			}

			if (result.toolName === "subagent") {
				// Fold the snapshot into the lifecycle, then apply the CLEAR predicate.
				const subagents = Array.isArray(details.subagents) ? details.subagents : [];
				const snapshot = subagents
					.filter(isResultRecord)
					.map(rawEntry => ({ jobId: rawEntry.jobId, status: rawEntry.status }));
				widgetFoldSnapshot(sessionId, snapshot);
				if (widgetShouldClear(sessionId, snapshot)) clearWidget();
			}

			if (isResultRecord(ctx) && isResultRecord(ctx.signal) && ctx.signal.aborted === true) return undefined;
			if (result.isError !== undefined && typeof result.isError !== "boolean") return undefined;
			if (result.isError === true) return undefined;
			const cfg = readConfig();
			outcome = {operation,stateOverrideIgnored:cfg.stateOverrideIgnored,evidenceStorage:{status:'disabled'}};
			if (!cfg.memoryEnabled || !isConfigured(cfg)) return undefined;
			outcome.evidenceStorage = {status:'not_requested'};
			const file = version2StateFile(cfg.stateFile);
			const limits = storeLimits(cfg);
			if (result.toolName === "task") {
				const callId = boundedEventId(result.toolCallId);
				if (!callId) return undefined;
				const input = result.input;
				const originalTasks = isResultRecord(input) && Array.isArray(input.tasks) ? input.tasks : null;
				const extraction = extractTasks(input, providerPromptLimit(cfg));
				const soleTask = originalTasks?.length === 1 && extraction.tasks.length === 1 && extraction.tasks[0].index === 0
					? extraction.tasks[0]
					: null;
				const asyncDetails = isResultRecord(details.async) ? details.async : {};
				const jobId = boundedEventId(asyncDetails.jobId);
				const schedulingFailures = !Array.isArray(details.results) || details.results.length > 0;
				const blocked = result.blocked === true || details.blocked === true;
				const invocationObserved = jobId !== null && !blocked;
				const eligible = soleTask !== null && invocationObserved && !schedulingFailures;
				const job = eligible ? { sessionId, jobId: jobId! } : null;
				outcome.toolCallDigest=createHash('sha256').update(JSON.stringify([sessionId,callId])).digest('hex');
				try {
					const stored = await observeTaskLaunch(
						file,
						limits,
						sessionId,
						callId,
						invocationObserved,
						eligible ? soleTask!.index : null,
						job,
					);
					outcome.evidenceStorage={status:stored.status,...(stored.status === 'unavailable' ? {reason:stored.reason} : {})};
					if(stored.status==='ok')observations.stored++;else observations.unavailable++;
					reportStorageStatus(stored, ctx);
				} catch { observations.unavailable++;outcome.evidenceStorage = {status:'unavailable',reason:'io_error'}; }
				return undefined;
			}

			if (result.isError === true || !Array.isArray(details.subagents)) return undefined;
			for (const rawEntry of details.subagents) {
				if (!isResultRecord(rawEntry)) continue;
				const status = typeof rawEntry.status === "string" ? rawEntry.status.trim().toLowerCase() : "";
				if (status !== "completed" && status !== "failed" && status !== "cancelled") continue;
				const jobId = boundedEventId(rawEntry.jobId);
				if (!jobId) continue;
				observations[status]++;
				const actualTier = boundedTier(rawEntry.actualTier) ?? boundedTier(rawEntry.tier);
				const observation: TerminalObservation = {
					status,
					...(boundedEventId(rawEntry.id) ? { childId: boundedEventId(rawEntry.id)! } : {}),
					...(typeof rawEntry.durationMs === "number" ? { durationMs: rawEntry.durationMs } : {}),
					...(boundedModelValue(rawEntry.requestedModel) ? { requestedModel: boundedModelValue(rawEntry.requestedModel)! } : {}),
					...(boundedModelValue(rawEntry.effectiveModel) ? { effectiveModel: boundedModelValue(rawEntry.effectiveModel)! } : {}),
					...(actualTier ? { actualTier } : {}),
				};
				try {
					const stored = await observeTerminalJob(file, limits, { sessionId, jobId }, observation);
					if(stored.status==='ok') {observations.stored++;if(outcome.evidenceStorage?.status!=='unavailable')outcome.evidenceStorage={status:'ok'};}
					else {observations.unavailable++;outcome.evidenceStorage={status:'unavailable',reason:stored.reason};}
					reportStorageStatus(stored, ctx);
				} catch { observations.unavailable++;outcome.evidenceStorage={status:'unavailable',reason:'io_error'}; }
			}
			return undefined;
		} catch {
			return undefined;
		} finally {
			if(outcome) {
				outcome.evidenceObservations=observations;
				try {
					const stored = await appendPluginOutcome('jev-advisor',outcome);
					if (!stored.persisted) reportJournalStatus(stored.reason,ctx);
				} catch { reportJournalStatus('store_unavailable',ctx); }
			}
		}
	});
}

function reportJournalStatus(reason:string,ctx:unknown):void {
	try {
		if(isResultRecord(ctx)&&typeof ctx.ui?.setStatus==='function')ctx.ui.setStatus('jev-advisor',`Outcome journal unavailable (${reason}); correlation storage is independent.`);
	}catch{}
}

function reportStorageStatus(result: StoreResult<unknown>, ctx: unknown): void {
	if (result.status !== "unavailable") return;
	try {
		if (isResultRecord(ctx) && typeof ctx.ui?.setStatus === "function") {
			ctx.ui.setStatus("jev-advisor", `Evidence storage unavailable (${result.reason}); observation not retained.`);
		}
	} catch {}
}

function isResultRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedEventId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= 512 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

function boundedModelValue(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const model = value.trim();
	return model && model.length <= 128 && !/[\u0000-\u001f\u007f]/.test(model) ? model : null;
}

function boundedTier(value: unknown): "fast" | "balanced" | "strong" | null {
	return value === "fast" || value === "balanced" || value === "strong" ? value : null;
}
