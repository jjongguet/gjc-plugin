// Explicit one-task advice and an offline, metadata-only retained-coverage report.

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
			"Ask the configured decision model for a bounded, task-scoped fast/balanced/strong effort recommendation, or pass report=\"calibration\" for an offline descriptive report of retained metadata. No quality or correctness is inferred.",
		parameters: pi.typebox.Type.Object({
			assignment: pi.typebox.Type.Optional(
				pi.typebox.Type.String({ description: "One complete task assignment to evaluate" }),
			),
			role: pi.typebox.Type.Optional(
				pi.typebox.Type.String({ description: "Intended subagent role, e.g. executor, planner, architect" }),
			),
			report: pi.typebox.Type.Optional(
				pi.typebox.Type.String({ description: 'Local read-only report; only "calibration" is valid' }),
			),
		}),
		async execute(_toolCallId: string, params: { assignment?: string; role?: string; report?: string }) {
			if (params.report === "calibration") {
				try {
					const cfg = readConfig();
					const result = readEvidenceV2(version2StateFile(cfg.stateFile));
					if (result.status === "unavailable") {
						return { content: [{ type: "text", text: `jev_advise: retained v2 report unavailable (${result.reason}); the store was not changed.` }] };
					}
					const state = result.status === "missing" ? emptyEvidenceV2() : result.value;
					const { text } = calibrationSummary(state);
					const prefix = result.status === "missing" ? "No v2 store exists yet. " : "";
					return { content: [{ type: "text", text: prefix + text }] };
				} catch {
					return { content: [{ type: "text", text: "jev_advise: retained v2 report unavailable (io_error); the store was not changed." }] };
				}
			}
			if (params.report !== undefined && params.report !== "") {
				return {
					content: [{ type: "text", text: 'jev_advise: unknown report. The only valid value is report="calibration".' }],
				};
			}
			if (typeof params.assignment !== "string" || !params.assignment.trim()) {
				return {
					content: [{ type: "text", text: JSON.stringify(noDecision("invalid_task"), null, 2) }],
				};
			}
			if (params.role !== undefined && typeof params.role !== "string") {
				return { content: [{ type: "text", text: JSON.stringify(noDecision("invalid_task"), null, 2) }] };
			}
			const cfg = readConfig();
			const extraction = extractTasks(
				{ agent: params.role ?? "", tasks: [{ assignment: params.assignment }] },
				providerPromptLimit(cfg),
			);
			const task = extraction.tasks[0];
			if (!task) {
				return { content: [{ type: "text", text: JSON.stringify(noDecision("invalid_task"), null, 2) }] };
			}
			try {
				const advice = await askDecisionModel(cfg, task, (input, init) => fetch(input, init));
				return { content: [{ type: "text", text: JSON.stringify(advice, null, 2) }] };
			} catch {
				return { content: [{ type: "text", text: JSON.stringify(noDecision("provider_error"), null, 2) }] };
			}
		},
	};
}
