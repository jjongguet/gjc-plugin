// Tool adapter — jev_advise runs as a normal in-process gjc tool, so it passes
// global fetch to the shared decision core. Egress is gated by the core's
// endpoint origin allowlist (isAllowedEndpoint), same as the hook.
// Contract (gjc 0.17.7): default export receives `pi`; returns
// { name, label, description, parameters: pi.typebox.Type.Object(...),
//   async execute(toolCallId, params) → { content: [{ type: "text", text }] } }.
//
// Key resolution (hook and tool alike, one rule): process env first, then the
// single file ~/.gjc/agent/jev-advisor/.env. No other channel exists.

export default function jevAdvise(pi: {
	typebox: {
		Type: {
			Object: (fields: Record<string, unknown>) => unknown;
			String: (options?: Record<string, unknown>) => unknown;
			Optional: (schema: unknown) => unknown;
		};
	};
}) {
	return {
		name: "jev_advise",
		label: "JEV Advise",
		description:
			"Ask the configured decision model (OpenRouter, Typesafe Jev, or a local Ollaya server) whether a subagent assignment " +
			"warrants fast/balanced/strong effort. Read-only advisory.",
		parameters: pi.typebox.Type.Object({
			assignment: pi.typebox.Type.String({ description: "Task assignment text to evaluate" }),
			role: pi.typebox.Type.Optional(
				pi.typebox.Type.String({ description: "Intended subagent role, e.g. executor, planner, architect" }),
			),
		}),
		async execute(_toolCallId: string, params: { assignment: string; role?: string }) {
			const cfg = readConfig();
			if (!isConfigured(cfg)) {
				return {
					content: [
						{
							type: "text",
							text:
								"jev-advisor is not configured. Put your key in the single env file — " +
								"~/.gjc/agent/jev-advisor/.env — e.g. OPENROUTER_API_KEY=sk-or-v1-... " +
								"(the same variable gjc reads for its OpenRouter provider) or " +
								"JEV_ADVISOR_API_KEY (plugin-only, higher priority). Exported env vars " +
								"override the file. A local decision server needs no key: " +
								"JEV_ADVISOR_PROVIDER=ollaya. Disable with JEV_ADVISOR_PROVIDER=off. " +
								"No task text leaves the machine until a key is present.",
						},
					],
				};
			}
			const assignment = [params.role ? `role: ${params.role}` : null, params.assignment]
				.filter(Boolean)
				.join("\n")
				.slice(0, DEFAULTS.maxAssignmentChars);
			try {
				const decision = await askDecisionModel(cfg, assignment, (input, init) => fetch(input, init), AbortSignal.timeout(cfg.timeoutMs));
				if (!decision) {
					return { content: [{ type: "text", text: "jev_advise: could not obtain a decision from the provider." }] };
				}
				return { content: [{ type: "text", text: JSON.stringify(decision, null, 2) }] };
			} catch (error) {
				return {
					isError: true,
					content: [{ type: "text", text: `jev_advise failed: ${error instanceof Error ? error.message : String(error)}` }],
				};
			}
		},
	};
}
