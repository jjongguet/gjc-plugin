// Before-task advisory hook. Provider calls are task-scoped, sequential and
// bounded; persistent state is metadata-only and never supplies prompt evidence.

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	let lastReservedAt: number | null = null;
	api.on("tool_call", async (event, ctx) => {
		try {
			const call = isHookRecord(event) ? event : null;
			if (!call || call.type !== "tool_call" || call.toolName !== "task") return undefined;
			const invocationStartedAt = performance.now();
			const cfg = readConfig();
			const limits = storeLimits(cfg);
			const extraction = extractTasks(call.input, providerPromptLimit(cfg));
			const callId = boundedEventId(call.toolCallId);
			const sessionId = readSessionId(ctx);
			const configured = isConfigured(cfg);
			const persistent = cfg.memoryEnabled && configured && sessionId !== null && callId !== null;
			let storageUnavailable: string | null = null;
			const preparations = new Map<number, TaskPreparation>();
			if (cfg.memoryEnabled && configured && sessionId !== null && callId !== null && extraction.tasks.length > 0) {
				const prepared = await prepareTaskRecords(
					version2StateFile(cfg.stateFile),
					limits,
					sessionId,
					callId,
					extraction.tasks,
				);
				if (prepared.status === "ok") {
					for (const item of prepared.value) preparations.set(item.index, item);
				} else {
					storageUnavailable = prepared.reason;
				}
			}
			const adviceByIndex = new Map<number, Advice>();
			const needsAdvice: TaskInput[] = [];
			for (const task of extraction.tasks) {
				const prepared = preparations.get(task.index);
				if (prepared?.state === "conflict") {
					adviceByIndex.set(task.index, noDecision("invalid_task"));
				} else if (prepared?.state === "reused") {
					adviceByIndex.set(
						task.index,
						prepared.advice ?? noDecision("already_pending"),
					);
				} else if (!task.complete) {
					adviceByIndex.set(task.index, noDecision("input_too_large"));
				} else {
					needsAdvice.push(task);
				}
			}

			if (needsAdvice.length && !configured) {
				const reason: NoDecisionReason = cfg.provider === "off" ? "disabled" : "unconfigured";
				for (const task of needsAdvice) {
					const advice = noDecision(reason);
					adviceByIndex.set(task.index, advice);
					const writeFailure = await persistAdvice(cfg, sessionId, callId, task, preparations.get(task.index), advice);
					storageUnavailable ??= writeFailure;
				}
			} else if (needsAdvice.length && !isAllowedEndpoint(cfg.endpoint)) {
				for (const task of needsAdvice) {
					const advice = noDecision("invalid_endpoint");
					adviceByIndex.set(task.index, advice);
					const writeFailure = await persistAdvice(cfg, sessionId, callId, task, preparations.get(task.index), advice);
					storageUnavailable ??= writeFailure;
				}
			} else if (needsAdvice.length) {
				const admittedAt = performance.now();
				if (cfg.minIntervalMs > 0 && lastReservedAt !== null && admittedAt - lastReservedAt < cfg.minIntervalMs) {
					for (const task of needsAdvice) {
						const advice = noDecision("rate_limited");
						adviceByIndex.set(task.index, advice);
						const writeFailure = await persistAdvice(cfg, sessionId, callId, task, preparations.get(task.index), advice);
						storageUnavailable ??= writeFailure;
					}
				} else {
					// Reserve before the first provider await, including failed calls.
					lastReservedAt = admittedAt;
					const deadline = invocationStartedAt + INVOCATION_BUDGET_MS;
					const budgetSignal = AbortSignal.timeout(Math.max(1, deadline - admittedAt));
					let requests = 0;
					for (const task of needsAdvice) {
						let advice: Advice;
						const remaining = deadline - performance.now();
						if (requests >= MAX_PROVIDER_REQUESTS_PER_INVOCATION) {
						advice = noDecision("batch_limit");
						} else if (remaining <= 0 || budgetSignal.aborted) {
						advice = noDecision("budget_exceeded");
					} else {
						requests++;
						const ctxSignal = isHookRecord(ctx) && isAbortSignal(ctx.signal) ? ctx.signal : undefined;
						const signal = ctxSignal && typeof AbortSignal.any === "function"
							? AbortSignal.any([ctxSignal, budgetSignal])
							: budgetSignal;
						advice = await askDecisionModel(
							cfg,
							task,
							(input, init) => fetch(input, init),
							signal,
							Math.min(cfg.timeoutMs, remaining),
						);
					}
					adviceByIndex.set(task.index, advice);
					const writeFailure = await persistAdvice(cfg, sessionId, callId, task, preparations.get(task.index), advice);
					storageUnavailable ??= writeFailure;
				}
				}
			}

			for (const rejected of extraction.rejected) adviceByIndex.set(rejected.index, noDecision(rejected.reason));
			const ui = isHookRecord(ctx) && isHookRecord(ctx.ui) ? ctx.ui : undefined;
			const summary = summarizeTasks(extraction, adviceByIndex);
			if (storageUnavailable) summary.push(storageWarning(storageUnavailable));
			if (summary.length) {
				try {
					if (typeof ui?.setWidget === "function") ui.setWidget("jev-advisor", summary);
				} catch {}
			}
			if (storageUnavailable) notifyStorageUnavailable(ui, storageUnavailable);

			if (cfg.mode === "enforce") {
				const qualifying = extraction.tasks.find(task => {
					const advice = adviceByIndex.get(task.index);
					return task.complete && task.requestedTier !== null && advice?.status === "decision" &&
						advice.confidence >= cfg.minConfidence && tierRank(task.requestedTier) < tierRank(advice.tier);
				});
				if (qualifying) {
					if (persistent) {
						try {
							const marked = await markInvocationBlocked(version2StateFile(cfg.stateFile), limits, sessionId!, callId!);
							if (marked.status === "unavailable") storageUnavailable = marked.reason;
						} catch {
							storageUnavailable = "io_error";
						}
					}
					if (storageUnavailable) {
						try {
							if (typeof ui?.setWidget === "function") {
								ui.setWidget("jev-advisor", [...summary.filter(line => !line.startsWith("Evidence storage unavailable (")), storageWarning(storageUnavailable)]);
							}
						} catch {}
						notifyStorageUnavailable(ui, storageUnavailable);
					}
					const advice = adviceByIndex.get(qualifying.index) as Extract<Advice, { status: "decision" }>;
					return {
						block: true,
						reason: `jev-advisor: task ${qualifying.index} recommends ${advice.tier} (confidence=${advice.confidence.toFixed(2)}; requested ${qualifying.requestedTier}). ${ENFORCE_GUIDANCE}`,
					};
				}
			}
			if (cfg.mode !== "shadow" && summary.length) {
				try {
					if (typeof ui?.notify === "function") ui.notify(summary.join("\n").slice(0, 1800), cfg.mode === "enforce" ? "warning" : "info");
				} catch {}
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}

async function persistAdvice(
	cfg: AdvisorConfig,
	sessionId: string | null,
	callId: string | null,
	task: TaskInput,
	prepared: TaskPreparation | undefined,
	advice: Advice,
): Promise<string | null> {
	if (!cfg.memoryEnabled || !sessionId || !callId || prepared?.state !== "created" || !prepared.token) return null;
	try {
		const updated = await updateTaskAdvice(
			version2StateFile(cfg.stateFile),
			storeLimits(cfg),
			{ sessionId, toolCallId: callId, taskIndex: task.index },
			prepared.token,
			advice,
		);
		return updated.status === "unavailable" ? updated.reason : null;
	} catch {
		return "io_error";
	}
}

function storageWarning(reason: string): string {
	return `Evidence storage unavailable (${reason}); advice is not persistently correlated.`;
}

function notifyStorageUnavailable(ui: Record<string, any> | undefined, reason: string): void {
	const warning = storageWarning(reason).slice(0, 180);
	try {
		if (typeof ui?.setStatus === "function") ui.setStatus("jev-advisor", warning);
	} catch {}
	try {
		if (typeof ui?.notify === "function") ui.notify(warning, "warning");
	} catch {}
}

function boundedEventId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= 512 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return typeof value === "object" && value !== null && typeof (value as AbortSignal).aborted === "boolean";
}

function isHookRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}

function summarizeTasks(
	extraction: Extraction,
	advice: Map<number, Advice>,
): string[] {
	const lines: string[] = [];
	for (const task of extraction.tasks.slice(0, 20)) {
		const result = advice.get(task.index) ?? noDecision("already_pending");
		const label = task.callerId ? ` [${task.callerId.slice(0, 32)}]` : "";
		const requested = task.requestedTier ? `requested=${task.requestedTier}` : "requested=unspecified";
		const outcome = result.status === "decision"
			? `recommended=${result.tier} confidence=${result.confidence.toFixed(2)}`
			: `no decision (${result.reason})`;
		lines.push(`task ${task.index}${label}: ${requested}; ${outcome}`.slice(0, 180));
	}
	for (const rejected of extraction.rejected.slice(0, Math.max(0, 20 - lines.length))) {
		lines.push(`task ${rejected.index}: no decision (${rejected.reason})`);
	}
	if (extraction.omittedCount > 0) lines.push(`${extraction.omittedCount} additional tasks omitted (batch_limit)`);
	const remaining = Math.max(0, extraction.tasks.length + extraction.rejected.length - lines.length);
	if (remaining > 0) lines.push(`${remaining} task results omitted from this bounded summary`);
	const bounded = lines.join("\n").slice(0, 2200);
	return bounded ? [bounded] : [];
}
