import { readinessReport } from "../lib/readiness";

// Read-only readiness report for the EGM install written by
// `scripts/install.ts` (bundle + loose skills and reviewers). Never installs,
// fetches or runs EGM; never contacts the network; writes nothing.
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
			"Read-only offline readiness report for the Elephant-Goldfish Model (EGM) installed natively by `bun run egm:install`: one command writes the pinned EGM v0.1.1 release (31 sha256-pinned upstream files at commit dea7761de06c) under the GJC agent directory, composes the 7 `/skill:egm-*` skills with 3 references, registers 8 read-only reviewers (`tools: read, search, find`) and records ownership in bundle.json. Reports the ownership journal, a sha256 comparison of every bundle and loose file, extra egm-* agents, the session settings that can disable the task subagent or a reviewer, `task`-tool visibility, and remediation. Never installs, fetches or runs EGM, writes nothing and never contacts the network.",
		parameters: pi.typebox.Type.Object({}),
		async execute(
			_toolCallId: string,
			params: unknown,
			_onUpdate?: unknown,
			ctx?: {
				settings?: { get(key: string): unknown };
				sessionManager?: { getBranch?: () => unknown };
			},
		) {
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
				let entries: unknown;
				try {
					entries = ctx?.sessionManager?.getBranch?.();
				} catch {
					entries = undefined;
				}
				const report = readinessReport({ settings: ctx?.settings, argv: process.argv, entries });
				const lines = [
					`egm_readiness: ${report.status}`,
					`pinned: ${report.pinned.repository} ${report.pinned.tag} (${report.pinned.commit.slice(0, 12)}, ${report.pinned.files} files)`,
					`agent dir: ${report.agentDir.dir} (${report.agentDir.source})`,
					`journal: ${report.journal}`,
					`plugin bundle: ${report.plugin.status}${report.plugin.enabled === false ? " (disabled)" : ""}${report.plugin.source ? ` — ${report.plugin.source}` : ""}${report.plugin.manifestHash ? ` (${report.plugin.manifestHash.slice(0, 12)})` : ""} (registration only; not byte-compared to a checkout)`,
					`bundle: ${report.bundle.status} (${report.bundle.matched}/${report.bundle.checked} match the pin)`,
					`loose: ${report.loose.status} (skills ${report.loose.skills.matched}/${report.loose.skills.checked}, references ${report.loose.references.matched}/${report.loose.references.checked}, reviewers ${report.loose.agents.matched}/${report.loose.agents.checked})`,
					`skills: ${report.skills.map(skill => skill.invocation).join(", ")}`,
					`reviewers: ${report.reviewers.length} read-only — ${report.reviewers.map(reviewer => reviewer.name).join(", ")}`,
					`session: ${report.session.status}${report.session.status === "observed" ? ` (task.maxRecursionDepth ${report.session.maxRecursionDepth})` : ""}`,
					`task: ${report.task.state}${report.task.source ? ` (${report.task.source})` : ""}`,
					`install: ${report.installCommand}`,
				];
				for (const mismatch of [...report.bundle.mismatches, ...report.loose.mismatches]) {
					lines.push(`- ${mismatch.status}: ${mismatch.path}${mismatch.detail ? ` — ${mismatch.detail}` : ""}`);
				}
				const omitted = report.bundle.mismatchesOmitted + report.loose.mismatchesOmitted;
				if (omitted > 0) lines.push(`- … ${omitted} more`);
				for (const file of report.loose.extraAgents) lines.push(`- extra egm-* agent: ${file}`);
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
