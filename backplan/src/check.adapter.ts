import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { appendPluginOutcome } from "../../shared/lib/results";
import { BACKPLAN_PLAN_BYTES, checkBackplanPlan } from "../lib/backplan";

// Validation gate and Linear-payload renderer for backward-derived work plans.
// Deterministic, offline and keyless: this tool never writes to Linear, reads
// credentials, or contacts any network service — registration stays with the
// agent's Linear MCP tooling.
export default function backplanCheck(pi: {
	typebox: { Type: { Object: (fields: Record<string, unknown>) => unknown; String: (options?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };
}) {
	return {
		name: "backplan_check",
		label: "Backplan Check",
		description: "Validate a backward-derived work plan (end state, success criteria, per-issue objective/scope/completion criteria, Linear project mapping, policy decisions, automation candidates) against the fixed contract and render Linear-ready project/issue payloads plus a stable content digest. Deterministic, offline and keyless: it never writes to Linear or touches the network; registration stays with the agent's Linear MCP or linear-trace.py path.",
		parameters: pi.typebox.Type.Object({
			plan: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Inline plan JSON (mutually exclusive with plan_path)" })),
			plan_path: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Path to a JSON file containing the plan (mutually exclusive with plan)" })),
			session: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Session ID rendered into each issue's execution line" })),
			worktree: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Owned worktree path rendered into each issue's execution line" })),
			branch: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Branch rendered into each issue's execution line" })),
		}),
		async execute(_toolCallId: string, params: { plan?: string; plan_path?: string; session?: string; worktree?: string; branch?: string }) {
			const finish = async (text: string, isError: boolean, execution?: { status: string; reason: string }) => {
				let journalStorage;
				try {
					journalStorage = await appendPluginOutcome("backplan", {
						operation: "backplan_check",
						toolCallDigest: createHash("sha256").update(_toolCallId).digest("hex"),
						...(execution ? { execution } : {}),
					});
				} catch { journalStorage = { persisted: false, reason: "store_unavailable" }; }
				return { content: [{ type: "text", text: `${text}\n${JSON.stringify({ journalStorage })}` }], ...(isError ? { isError: true } : {}) };
			};
			const context: { session?: string; worktree?: string; branch?: string } = {};
			for (const key of ["session", "worktree", "branch"] as const) {
				const value = (params?.[key] ?? "").trim();
				if (value.length > 500) return finish(`backplan_check: invalid_input — ${key} must be at most 500 characters.`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
				if (value) context[key] = value;
			}
			const inline = (params?.plan ?? "").trim();
			const planPath = (params?.plan_path ?? "").trim();
			if (inline && planPath) return finish("backplan_check: invalid_input — provide exactly one of plan or plan_path.", true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			if (!inline && !planPath) return finish("backplan_check: invalid_input — provide plan (inline JSON) or plan_path (JSON file).", true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			let text = inline;
			if (planPath) {
				let info;
				try { info = await lstat(planPath); }
				catch { return finish(`backplan_check: invalid_input — plan_path is not readable: ${planPath}`, true, { status: "not_run", reason: "invalid_or_unavailable_input" }); }
				if (!info.isFile() || info.isSymbolicLink()) return finish(`backplan_check: invalid_input — plan_path must be a regular file (no symlinks): ${planPath}`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
				if (info.size > BACKPLAN_PLAN_BYTES) return finish(`backplan_check: invalid_input — plan file exceeds the ${BACKPLAN_PLAN_BYTES}-byte limit.`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
				try { text = await readFile(planPath, "utf8"); }
				catch { return finish(`backplan_check: invalid_input — plan_path could not be read: ${planPath}`, true, { status: "not_run", reason: "invalid_or_unavailable_input" }); }
			} else if (Buffer.byteLength(text, "utf8") > BACKPLAN_PLAN_BYTES) {
				return finish(`backplan_check: invalid_input — plan exceeds the ${BACKPLAN_PLAN_BYTES}-byte limit.`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			}
			let raw: unknown;
			try { raw = JSON.parse(text); }
			catch (error) {
				const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
				return finish(`backplan_check: invalid_input — plan is not valid JSON: ${message}`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			}
			const report = checkBackplanPlan(raw, context);
			if (report.status === "ok") return finish(`backplan_check: ok\n${JSON.stringify(report)}`, false, { status: "passed", reason: "complete" });
			return finish(`backplan_check: invalid\n${JSON.stringify(report)}`, true, { status: "failed", reason: "assertion_failed" });
		},
	};
}
