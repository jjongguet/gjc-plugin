// Receipt-only observer for task launch envelopes and terminal subagent
// snapshots. It never calls a provider or rewrites a tool result.

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	api.on("tool_result", async (event, ctx) => {
		try {
			if (!isResultRecord(event) || event.type !== "tool_result") return undefined;
			if (isResultRecord(ctx) && isResultRecord(ctx.signal) && ctx.signal.aborted === true) return undefined;
			const result = event;
			if (result.toolName !== "task" && result.toolName !== "subagent") return undefined;
			if (result.isError !== undefined && typeof result.isError !== "boolean") return undefined;
			if (result.isError === true) return undefined;
			const cfg = readConfig();
			if (!cfg.memoryEnabled || !isConfigured(cfg)) return undefined;
			const sessionId = readSessionId(ctx);
			if (!sessionId) return undefined;
			const file = version2StateFile(cfg.stateFile);
			const limits = storeLimits(cfg);
			const details = isResultRecord(result.details) ? result.details : {};
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
					reportStorageStatus(stored, ctx);
				} catch {}
				return undefined;
			}

			if (result.isError === true || !Array.isArray(details.subagents)) return undefined;
			for (const rawEntry of details.subagents) {
				if (!isResultRecord(rawEntry)) continue;
				const status = typeof rawEntry.status === "string" ? rawEntry.status.trim().toLowerCase() : "";
				if (status !== "completed" && status !== "failed" && status !== "cancelled") continue;
				const jobId = boundedEventId(rawEntry.jobId);
				if (!jobId) continue;
				const observation: TerminalObservation = {
					status,
					...(boundedEventId(rawEntry.id) ? { childId: boundedEventId(rawEntry.id)! } : {}),
					...(typeof rawEntry.durationMs === "number" ? { durationMs: rawEntry.durationMs } : {}),
					...(boundedModelValue(rawEntry.requestedModel) ? { requestedModel: boundedModelValue(rawEntry.requestedModel)! } : {}),
					...(boundedModelValue(rawEntry.effectiveModel) ? { effectiveModel: boundedModelValue(rawEntry.effectiveModel)! } : {}),
				};
				try {
					const stored = await observeTerminalJob(file, limits, { sessionId, jobId }, observation);
					reportStorageStatus(stored, ctx);
				} catch {}
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
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
