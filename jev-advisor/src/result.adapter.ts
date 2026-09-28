// Outcome-review adapter — legacy plugin hook running in the gjc host realm.
// Contract (gajae-code hooks/events.ts, constrainedPost): a tool_result plugin
// hook receives ToolResultEvent { type, toolName, toolCallId, input, content,
// details, isError } after the task tool resolved; runtime event name is
// "tool_result"; 30s budget, errors isolated, canCancel false. Returning
// { content, details, isError } would rewrite the result — this adapter always
// returns undefined: it observes and reports, never mutates.
//
// The decision model is asked the same single question as the pre-call
// advisor, through the same code path (askDecisionModel): given the completed
// delegation's assignment plus its outcome (statuses, durations, error flag,
// result head), which effort tier should the NEXT identical delegation use?
// No local thresholds — the judgment belongs to the decision model.
//
// Fail-open on purpose (same rationale as hook.adapter.ts): an outcome
// reviewer that disturbs the tool pipeline is worse than no reviewer.

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	let lastAdvisoryAt = 0;
	api.on("tool_result", async (event, ctx) => {
		try {
			const result = event as
				| {
						type?: string;
						toolName?: string;
						input?: unknown;
						content?: unknown;
						details?: unknown;
						isError?: boolean;
				  }
				| undefined;
			if (!result || result.type !== "tool_result" || result.toolName !== "task") return undefined;
			const cfg = readConfig();
			if (!isConfigured(cfg)) return undefined;
			const extraction = extractAssignment(result.input);
			if (!extraction) return undefined; // unrecognized call shape → nothing to review
			// G4: record the post event (error flag, total subagent time) and
			// resolve G5 pairing BEFORE the rate-limit gate — outcomes are
			// recorded even when the re-tier advisory is rate-limited out.
			// Memory failures are swallowed; the handler always returns undefined.
			let state: MemoryState | null = null;
			let fp = "";
			if (cfg.memoryEnabled) {
				try {
					state = loadState(cfg.stateFile);
					fp = fingerprint(extraction.text);
					const post: MemoryEvent = {
						kind: "post",
						t: Date.now(),
						error: result.isError === true,
						durationMs: totalSubagentMs(result.details),
					};
					joinPostToPre(state, fp, post);
					recordEvent(state, fp, memoryHead(extraction.text, cfg), post, cfg);
					saveState(cfg.stateFile, state, cfg);
				} catch {
					state = null;
				}
			}
			const question = summarizeOutcome(result);
			if (!question) return undefined;
			const now = Date.now();
			if (cfg.minIntervalMs > 0 && now - lastAdvisoryAt < cfg.minIntervalMs) return undefined;
			const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
			const decision = await askDecisionModel(cfg, question, (input, init) => fetch(input, init), signal);
			lastAdvisoryAt = Date.now();
			// Enrich the recorded post with the re-tier advice that answered it.
			if (state && decision) {
				try {
					enrichLastPost(state, fp, decision.tier, decision.confidence);
					saveState(cfg.stateFile, state, cfg);
				} catch {}
			}
			if (!decision) return undefined; // provider/parse failure → fail-open
			const ui = (ctx as {
				ui?: {
					notify?: (message: string, type?: "info" | "warning" | "error") => void;
					setStatus?: (key: string, text: string | undefined) => void;
				setWidget?: (key: string, content: string[]) => void;
				};
			} | undefined)?.ui;
			const rationale = decision.rationale ? ` — ${decision.rationale}` : "";
			const summary = `jev-advisor: re-tier ${decision.tier} confidence=${decision.confidence.toFixed(2)}${rationale}`;
			try {
				ui?.setStatus?.("jev-advisor", `outcome → tier=${decision.tier} conf=${decision.confidence.toFixed(2)}`);
			} catch {}
			// Same widget key as the pre-call advisory: one line, the advisor's
			// latest word — spawn-time recommendation or outcome-driven re-tier.
			try {
				ui?.setWidget?.("jev-advisor", [summary]);
			} catch {}
			if (cfg.mode !== "shadow") {
				try {
					ui?.notify?.(summary, "info");
				} catch {}
			}
			return undefined; // never rewrite the tool result
		} catch {
			return undefined;
		}
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function entryStatus(entry: unknown): string {
	if (isRecord(entry) && typeof entry.status === "string" && entry.status.trim()) return entry.status.trim();
	return "";
}

function entryDurationMs(entry: unknown): number {
	if (isRecord(entry) && typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)) {
		return entry.durationMs;
	}
	return Number.NaN;
}


/** Total subagent time: sum of finite positive subagent durations — effort, not wall clock. */
function totalSubagentMs(details: unknown): number | undefined {
	const record = isRecord(details) ? details : {};
	const subagents = Array.isArray(record.subagents) ? record.subagents : [];
	const total = subagents
		.map(entryDurationMs)
		.filter(n => Number.isFinite(n) && n > 0)
		.reduce((sum, n) => sum + n, 0);
	return total > 0 ? total : undefined;
}
/** First ~400 chars of text from a tool-result content block (string or parts array). */
function contentHead(content: unknown): string {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.map(part =>
				isRecord(part) && typeof part.text === "string" ? part.text : "",
			)
			.join(" ");
	}
	return text.replace(/\s+/g, " ").trim().slice(0, 400);
}

/**
 * Compose the decision-model question from a task tool_result. The assignment
 * side reuses extractAssignment (same flattening as the pre-call advisor);
 * the outcome side tolerates the host's detail shapes (progress[] /
 * subagents[] with status/durationMs) and degrades to whatever is present.
 * The systemone wire format truncates state at 1900 chars, so the assignment
 * head is bounded to keep the outcome section inside budget.
 */
function summarizeOutcome(event: {
	input?: unknown;
	content?: unknown;
	details?: unknown;
	isError?: boolean;
}): string | null {
	const extraction = extractAssignment(event.input);
	if (!extraction) return null; // unrecognized call shape → nothing to review
	const outcome: string[] = [];
	if (event.isError === true) outcome.push("result flagged as error");
	const details = isRecord(event.details) ? event.details : {};
	const progress = Array.isArray(details.progress) ? details.progress : [];
	const subagents = Array.isArray(details.subagents) ? details.subagents : [];
	const statuses = [...progress, ...subagents].map(entryStatus).filter(Boolean);
	if (statuses.length) outcome.push(`statuses: ${[...new Set(statuses)].join(",")}`);
	const durations = subagents
		.map(entryDurationMs)
		.filter(n => Number.isFinite(n) && n > 0)
		.map(n => `${Math.round(n / 1000)}s`);
	if (durations.length) outcome.push(`durations: ${durations.join(",")}`);
	const head = contentHead(event.content);
	const parts = [
		"Delegation outcome review — recommend the effort tier for the NEXT identical delegation.",
		`assignment:\n${extraction.text.slice(0, 1100)}`,
	];
	if (extraction.requestedTiers.length) {
		parts.push(`requested tiers: ${[...new Set(extraction.requestedTiers)].join("/")}`);
	}
	parts.push(`outcome:\n${outcome.length ? outcome.join("; ") : "no structured outcome fields"}`);
	if (head) parts.push(`result head:\n${head}`);
	return parts.join("\n\n");
}
