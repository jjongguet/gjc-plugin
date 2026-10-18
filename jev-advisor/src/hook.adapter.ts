// Before-task advisory hook. Provider calls are task-scoped, sequential and
// bounded; persistent state is metadata-only and never supplies prompt evidence.
import { appendPluginOutcome } from '../../shared/lib/results';

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	let lastReservedAt: number | null = null;
	api.on("tool_call", async (event, ctx) => {
		let journalOutcomes: (() => Promise<void>) | undefined;
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
			const adviceByIndex = new Map<number, Advice>();
			const ui = isHookRecord(ctx) && isHookRecord(ctx.ui) ? ctx.ui : undefined;
			journalOutcomes = async () => {
				const taskAdvice = [...adviceByIndex.entries()].filter(([index])=>Number.isInteger(index)&&index>=0&&index<32).map(([index,advice])=>({index,...(advice.status === 'decision' ? {status:advice.status,tier:advice.tier,confidence:advice.confidence,basis:advice.confidenceKind} : {status:advice.status,reason:advice.reason})}));
					const stored = await appendPluginOutcome('jev-advisor', {
						operation:'task_advice', durationMs:Math.round(performance.now()-invocationStartedAt),
					...(callId ? {toolCallDigest:createHash('sha256').update(JSON.stringify([sessionId,callId])).digest('hex')} : {}),
					stateOverrideIgnored:cfg.stateOverrideIgnored,taskAdvice,
					...(!taskAdvice.length ? {advice:{status:'no_decision',reason:'unsupported_input'}} : {}),
						evidenceStorage:{status:persistent ? storageUnavailable ? 'unavailable' : 'ok' : 'disabled', ...(storageUnavailable ? {reason:storageUnavailable} : {})},
					});
					if (!stored.persisted) notifyStorageUnavailable(ui, stored.reason, true);
				if (cfg.stateOverrideIgnored) {
					try { ui?.setStatus?.('jev-advisor','state_override_ignored: results use ~/.gjc-plugin.'); } catch {}
				}
			};
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
			const summary = summarizeTasks(extraction, adviceByIndex, providerPromptLimit(cfg));
			if (storageUnavailable) summary.tail.push(storageWarning(storageUnavailable));
			const widgetText = renderWidgetLines(summary.rows, summary.tail);
			if (widgetText) {
				try {
					if (typeof ui?.setWidget === "function") ui.setWidget("jev-advisor", [widgetText]);
				} catch {}
			}
			// Record the batch this widget describes so the result hook can own
			// its lifecycle — only when a widget was actually drawn; otherwise an
			// empty summary would take ownership without redrawing and the
			// previous batch's receipts would stop matching. taskCount is the raw
			// bounded count (tasks attempted plus rejected entries); it is clamped
			// to the same 32-task admission limit, which is half the 64-id bound
			// of the per-batch job map. Rows stay bounded and carry the task id
			// used to bind observed child jobs for per-row removal.
			if (widgetText && sessionId !== null && callId !== null) {
				const rawCount = extraction.tasks.length + extraction.rejected.length + extraction.omittedCount;
				widgetRecordBatch(sessionId, callId, rawCount, summary.rows, summary.tail);
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
								const tail = summary.tail.filter(line => !line.startsWith("Evidence storage unavailable ("));
								const text = renderWidgetLines(summary.rows, [...tail, storageWarning(storageUnavailable)]);
								if (text) ui.setWidget("jev-advisor", [text]);
							}
						} catch {}
						notifyStorageUnavailable(ui, storageUnavailable);
					}
					// The widget drawn above describes a call that is about to be
					// blocked, so clear it and drop the registry entry before blocking.
					try {
						if (typeof ui?.setWidget === "function") ui.setWidget("jev-advisor", undefined);
					} catch {}
					if (sessionId !== null) widgetDropSession(sessionId);
					const advice = adviceByIndex.get(qualifying.index) as Extract<Advice, { status: "decision" }>;
					return {
						block: true,
						reason: `jev-advisor: task ${qualifying.index} recommends ${advice.tier} (confidence=${advice.confidence.toFixed(2)}; requested ${qualifying.requestedTier}). ${ENFORCE_GUIDANCE}`,
					};
				}
			}
			if (cfg.mode !== "shadow" && widgetText) {
				// Single bounded metadata-only line: notify appends a permanent
				// chat entry, so multi-line payloads are never emitted.
				let topTier = "";
				let topConfidence = 0;
				for (const task of extraction.tasks) {
					const a = adviceByIndex.get(task.index);
					if (a?.status === "decision" && a.confidence > topConfidence) {
						topConfidence = a.confidence;
						topTier = a.tier;
					}
				}
				const line = `jev-advisor: ${extraction.tasks.length} task(s) checked, ${topTier ? `top suggestion ${topTier} (confidence ${topConfidence.toFixed(2)})` : "no suggestion"}`.slice(0, 200);
				try {
					if (typeof ui?.notify === "function") ui.notify(line, cfg.mode === "enforce" ? "warning" : "info");
				} catch {}
			}
			return undefined;
		} catch {
			return undefined;
		} finally {
			if (journalOutcomes) {
				try { await journalOutcomes(); } catch {
					notifyStorageUnavailable(isHookRecord(ctx) ? ctx.ui : undefined, 'store_unavailable', true);
				}
			}
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

function notifyStorageUnavailable(ui: Record<string, any> | undefined, reason: string, journal=false): void {
	const warning = (journal ? `Outcome journal unavailable (${reason}); correlation storage is independent.` : storageWarning(reason)).slice(0, 180);
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
	limit: number,
): { rows: { index: number; label: string | null; text: string }[]; tail: string[] } {
	const rows: { index: number; label: string | null; text: string }[] = [];
	for (const task of extraction.tasks.slice(0, 20)) {
		const result = advice.get(task.index) ?? noDecision("already_pending");
		const label = task.callerId ? ` [${task.callerId.slice(0, 32)}]` : "";
		const requested = task.requestedTier ? `requested=${task.requestedTier}` : "requested=unspecified";
		const outcome = result.status === "decision"
			? `recommended=${result.tier} confidence=${result.confidence.toFixed(2)}`
			: result.reason === "input_too_large"
				? `no decision (input_too_large: ${task.prompt.length} > ${limit} chars)`
				: `no decision (${result.reason})`;
		rows.push({ index: task.index, label: task.callerId, text: `task ${task.index}${label}: ${requested}; ${outcome}`.slice(0, 180) });
	}
	const tail: string[] = [];
	let tailLinesAdded = 0;
	for (const rejected of extraction.rejected.slice(0, Math.max(0, 20 - rows.length))) {
		tail.push(`task ${rejected.index}: no decision (${rejected.reason})`);
		tailLinesAdded++;
	}
	if (extraction.omittedCount > 0) {
		tail.push(`${extraction.omittedCount} additional tasks omitted (batch_limit)`);
		tailLinesAdded++;
	}
	const remaining = Math.max(0, extraction.tasks.length + extraction.rejected.length - rows.length - tailLinesAdded);
	if (remaining > 0) tail.push(`${remaining} task results omitted from this bounded summary`);
	return { rows, tail };
}
