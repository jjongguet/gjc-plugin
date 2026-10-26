import { homedir } from "node:os";

import { auditSkills } from "../lib/report";

export default function skillAuditTool(pi: {
	typebox: { Type: { Object: (fields: Record<string, unknown>, options?: Record<string, unknown>) => unknown } };
}) {
	return {
		name: "skill_audit",
		label: "Skill Audit",
		description:
			"Read-only installed-vs-used audit of the GJC skill catalog: per-skill used_count, last_used and install source from retained session transcripts, plus unused, duplicate and stale candidates with their basis. Skill tool calls and /skill: invocations count as use; catalog exposure and skill_discovery do not. Missing transcript coverage reports unknown, never zero uses, and a corrupt line degrades the report instead of hiding it. It does not prove skill quality or effect, never installs or deletes skills, changes no configuration and writes nothing.",
		parameters: pi.typebox.Type.Object({}, { additionalProperties: false }),
		execute(_toolCallId: string, params: unknown) {
			const exactEmptyObject =
				typeof params === "object" && params !== null && !Array.isArray(params) && Object.keys(params as object).length === 0;
			if (!exactEmptyObject) {
				return {
					content: [
						{
							type: "text",
							text: "skill_audit: invalid_input. This tool accepts exactly {} — no paths or options; run the CLI for a written report.",
						},
					],
					isError: true,
				};
			}
			try {
				const report = auditSkills({ home: process.env.HOME || homedir(), cwd: process.cwd() });
				return { content: [{ type: "text", text: JSON.stringify(report) }], isError: false };
			} catch {
				return { content: [{ type: "text", text: "skill_audit: unexpected_error. The report could not be produced." }], isError: true };
			}
		},
	};
}
