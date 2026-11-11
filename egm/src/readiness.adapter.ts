import { readinessReport } from "../lib/readiness";

// Read-only readiness report for the EGM skills installed through GJC's
// marketplace path. Never installs, fetches or runs EGM; never contacts the
// network; writes nothing.
export default function egmReadiness(pi: {
	typebox: {
		Type: {
			Object: (fields: Record<string, unknown>) => unknown;
		};
	};
}) {
	return {
		name: "egm_readiness",
		label: "EGM Readiness",
		description:
			"Read-only offline readiness report for the Elephant-Goldfish Model (EGM) skills installed natively with `gjc plugin install egm@egm`, pinned to EGM v0.1.1: marketplace and user-scope install state, the commit the marketplace source names, a sha256 comparison of every runtime file (skills, reviewer personas, document standards) with the pinned release, the egm:egm-* skill names and the session settings that can disable marketplace skills, the task subagent tool or the reviewer personas, with remediation. Never installs, fetches or runs EGM, writes nothing and never contacts the network.",
		parameters: pi.typebox.Type.Object({}),
		async execute(_toolCallId: string, params: unknown, _onUpdate?: unknown, ctx?: { settings?: { get(key: string): unknown } }) {
			// The contract is exactly {}; extra keys are rejected before anything is read.
			const exactEmptyObject =
				params === undefined ||
				(typeof params === "object" &&
					params !== null &&
					!Array.isArray(params) &&
					Object.getPrototypeOf(params) === Object.prototype &&
					Reflect.ownKeys(params).length === 0);
			if (!exactEmptyObject) {
				return {
					content: [{ type: "text", text: "egm_readiness: invalid_input — this tool accepts exactly {} (no paths or options)." }],
					isError: true,
				};
			}
			try {
				const report = readinessReport({ settings: ctx?.settings });
				const lines = [
					`egm_readiness: ${report.status}`,
					`pinned: ${report.pinned.repository} ${report.pinned.tag} (${report.pinned.commit.slice(0, 12)})`,
					`marketplace: ${report.marketplace.status}${report.marketplace.sourceType ? ` ${report.marketplace.sourceType}` : ""}${
						report.marketplace.commit ? ` @ ${report.marketplace.commit.slice(0, 12)}${report.marketplace.commitMatchesPin ? " (pinned commit)" : " (not the pinned commit)"}` : ""
					}`,
					`install (user): ${report.installation.status}${report.installation.version ? ` ${report.installation.version}` : ""}`,
					`runtime files: ${report.content.status} (${report.content.matched}/${report.content.checked} match the pin)`,
					`skills: ${report.skills.filter(skill => skill.present).length}/${report.skills.length} present — ${report.skills.map(skill => skill.invocation).join(", ")}`,
					`reviewer personas: ${report.personas.filter(persona => persona.present).length}/${report.personas.length} present`,
					`session: ${report.session.status}${
						report.session.status === "observed"
							? ` (marketplace provider ${report.session.marketplaceProvider}, task tool ${report.session.taskTool})`
							: ""
					}`,
				];
				for (const mismatch of report.content.mismatches) lines.push(`- ${mismatch.status}: ${mismatch.path}`);
				if (report.content.mismatchesOmitted > 0) lines.push(`- … ${report.content.mismatchesOmitted} more`);
				if (report.remediation.length > 0) {
					lines.push("remediation:");
					for (const item of report.remediation) lines.push(`- ${item}`);
				}
				return { content: [{ type: "text", text: `${lines.join("\n")}\n${JSON.stringify({ report })}` }] };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `egm_readiness: runtime_error — ${message}` }], isError: true };
			}
		},
	};
}
