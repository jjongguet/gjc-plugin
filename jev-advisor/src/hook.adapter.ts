// Hook adapter — legacy plugin hook running in the gjc host realm.
// Contract (verified against the installed gjc v0.18.0 binary and a live
// ctx trace): a plugin hook WITHOUT
// declared capabilities/networkDestinations/filesystemRoots loads as a legacy
// extension hook — sdk/session.ts:1039-1052 registers api.on("tool_call", …)
// and calls handler(event, ctx) only for the manifest target tool. The event
// is the ToolCallEvent { type, toolName, toolCallId, input }; the task tool's
// params live under event.input. Returning { block: true, reason } blocks the
// task call; any other value — including undefined — continues.
//
// Declaring capabilities would flip the hook to a "function hook", which
// v0.18.0 refuses to execute in the host realm ("requires an isolated
// runtime") — hooks then never dispatch, so legacy is the only loadable
// form. Network egress is instead restricted by the core's
// endpoint origin allowlist (isAllowedEndpoint) — the same gate that guards
// the jev_advise tool.
//
// The legacy ctx carries a full ui surface (notify, setStatus, setWidget,
// …, hasUI: true in interactive sessions).
//
// Fail-open on purpose: gjc treats hook errors as fail-closed, and an advisor
// that blocks delegation on its own failure is worse than no advisor.

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	let lastAdvisoryAt = 0;
	api.on("tool_call", async (event, ctx) => {
		try {
			const call = event as { type?: string; toolName?: string; input?: unknown } | undefined;
			if (!call || call.type !== "tool_call" || call.toolName !== "task") return undefined;
			const cfg = readConfig();
			if (!isConfigured(cfg)) return undefined;
			const extraction = extractAssignment(call.input);
			if (!extraction) return undefined;
			const now = Date.now();
			if (cfg.minIntervalMs > 0 && now - lastAdvisoryAt < cfg.minIntervalMs) return undefined;
			const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
			const decision = await askDecisionModel(cfg, extraction.text, (input, init) => fetch(input, init), signal);
			lastAdvisoryAt = Date.now();
			if (!decision) return undefined; // provider/parse failure → fail-open
			const ui = (ctx as {
				ui?: {
					notify?: (message: string, type?: "info" | "warning" | "error") => void;
				setStatus?: (key: string, text: string | undefined) => void;
				setWidget?: (key: string, content: string[]) => void;
				};
			} | undefined)?.ui;
			const summary = formatSummary(decision);
			try {
				ui?.setStatus?.("jev-advisor", `tier=${decision.tier} conf=${decision.confidence.toFixed(2)}`);
			} catch {}
			// Persistent above-editor advisory: the only terminal surface that
			// stays in the operator's eyeline for the rest of the session
			// (ui.notify dims into the transcript; ui.setStatus lives at the
			// bottom edge). Mode-independent — shadow invisibility is the bug.
			try {
				ui?.setWidget?.("jev-advisor", [summary]);
			} catch {}
			// Enforce blocks only when the caller under-provisioned a tier AND
			// the recommendation clears the confidence gate — never on provider
			// failure, already-compliant calls, or low-confidence advice.
			const underprovisioned = extraction.requestedTiers.some(t => tierRank(t) < tierRank(decision.tier));
			if (cfg.mode === "enforce" && decision.confidence >= cfg.minConfidence && underprovisioned) {
				// An unspecified tier never blocks: the underprovisioned test needs an
				// explicitly requested (weaker) tier to compare against.
				const requested = [...new Set(extraction.requestedTiers)].join("/");
				return {
					block: true,
					// Tier+confidence only: the model-authored rationale stays out of
					// host-visible block reasons (prompt-injection ceiling).
					reason: `jev-advisor: tier=${decision.tier} confidence=${decision.confidence.toFixed(2)}. Requested tier: ${requested}. ${ENFORCE_GUIDANCE}`,
				};
			}
			if (cfg.mode !== "shadow") {
				try {
					ui?.notify?.(summary, cfg.mode === "enforce" ? "warning" : "info");
				} catch {}
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}
