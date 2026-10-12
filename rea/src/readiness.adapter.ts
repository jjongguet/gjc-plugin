import { createHash } from "node:crypto";
import { appendPluginOutcome } from "../../shared/lib/results";
import { readinessReport } from "../lib/readiness";

// Read-only readiness report for the REA integration. Never installs,
// registers, downloads or runs REA; never contacts the network.
export default function reaReadiness(pi: {
	cwd?: string;
	typebox: {
		Type: {
			Object: (fields: Record<string, unknown>) => unknown;
			String: (options?: Record<string, unknown>) => unknown;
			Optional: (schema: unknown) => unknown;
		};
	};
}) {
	return {
		name: "rea_readiness",
		label: "REA Readiness",
		description:
			"Read-only offline readiness report for the REA integration (pinned rea-agents 6.4.0): Node/npx or Bun/bunx availability and REA engine version fit, GJC MCP registration state in user and project scope, loose-skill installation state, and remediation. Never installs, registers, fetches or runs REA, and never contacts the network.",
		parameters: pi.typebox.Type.Object({}),
		async execute(toolCallId: string, _params: Record<string, never>) {
			const finish = async (text: string, isError: boolean, execution?: { status: string; reason: string }) => {
				let journalStorage;
				try {
					journalStorage = await appendPluginOutcome("rea", {
						operation: "rea_readiness",
						toolCallDigest: createHash("sha256").update(toolCallId).digest("hex"),
						...(execution ? { execution } : {}),
					});
				} catch {
					journalStorage = { persisted: false, reason: "store_unavailable" };
				}
				return {
					content: [{ type: "text", text: `${text}\n${JSON.stringify({ journalStorage })}` }],
					...(isError ? { isError: true } : {}),
				};
			};
			try {
				const cwd = typeof pi.cwd === "string" && pi.cwd.length > 0 ? pi.cwd : undefined;
				const report = readinessReport(cwd === undefined ? {} : { cwd });
				const lines = [
					`rea_readiness: ${report.status}`,
					`pinned rea-agents: ${report.pinnedReaAgentsVersion}; fetch channel: ${report.fetchChannel}`,
					`node: ${report.runtimes.node.status}${report.runtimes.node.line ? ` ${report.runtimes.node.line}` : ""}${
						report.runtimes.node.satisfies === null ? "" : report.runtimes.node.satisfies ? " (satisfies)" : " (unsupported)"
					}`,
					`npx: ${report.runtimes.npx.status}; bun: ${report.runtimes.bun.status}; bunx: ${report.runtimes.bunx.status}`,
					...report.registrations.map(
						registration =>
							`mcp registration (${registration.scope} ${registration.path}): ${registration.status}`,
					),
					`skill (${report.skill.path}): ${report.skill.status}`,
				];
				if (report.remediation.length > 0) {
					lines.push("remediation:");
					for (const item of report.remediation) lines.push(`- ${item}`);
				}
				return finish(`${lines.join("\n")}\n${JSON.stringify({ report })}`, false, {
					status: "passed",
					reason: "complete",
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return finish(`rea_readiness: runtime_error — ${message}`, true, {
					status: "failed",
					reason: "runtime_error",
				});
			}
		},
	};
}
