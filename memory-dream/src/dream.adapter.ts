import { runDream } from "../lib/dream";

const ALLOWED = new Set([
	"memory_dir",
	"project_root",
	"jev",
	"max_claims",
	"max_jev_calls",
	"confidence_threshold",
]);

function invalid(message: string) {
	return {
		content: [{ type: "text", text: `memory_dream: invalid_input (${message})` }],
		isError: true,
	};
}

export default function memoryDream(pi: { cwd: string; typebox: { Type: any } }) {
	const T = pi.typebox.Type;
	return {
		name: "memory_dream",
		label: "Memory Dream",
		description:
			"Read GJC's project memory notes (memory_summary.md and MEMORY.md), decompose them into claims, check injection budgets, dead rule:// references, missing paths, stale dated facts and secret shapes, retrieve bounded canonical evidence (SYSTEM.md, RULES.md, AGENTS.md, rules/*.md first, then repo docs, then a recent transcript excerpt), and optionally ask the advisory Jev decision model whether each evidence-bearing claim is consistent with that evidence. Writes one private JSON+MD report under ~/.gjc-plugin/memory-dream/ and never edits, deletes or enqueues GJC memory or session files. Jev receives only a bounded claim and cited excerpts; secret-shaped claims are not sent. A report is not proof that a note is true, and the session_start notice is bounded to contradicted notes. Runs only when explicitly invoked; no timer.",
		parameters: T.Object({
			memory_dir: T.Optional(
				T.String({
					description:
						"Existing GJC memory scope under the agent memories directory, absolute or ~-prefixed; defaults to the current project's scope. Read-only.",
				}),
			),
			project_root: T.Optional(
				T.String({
					description:
						"Repository root whose SYSTEM.md, RULES.md, AGENTS.md, rules/*.md and docs/*.md are canonical evidence; absolute or relative to the session directory. Defaults to the session directory.",
				}),
			),
			jev: T.Optional(
				T.Boolean({
					description:
						"Opt in to the advisory Jev model for evidence-bearing claims (default false until the golden adoption threshold is measured). Without a configured key the verdict is no-decision, never supported.",
				}),
			),
			max_claims: T.Optional(T.Number({ description: "Maximum claims analyzed, 1-200 (default 100)." })),
			max_jev_calls: T.Optional(T.Number({ description: "Maximum Jev calls in this run, 1-120 (default 60)." })),
			confidence_threshold: T.Optional(
				T.Number({
					description:
						"Minimum Jev confidence for an incorrect verdict to become contradicted, 0-1 (default 0.7).",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_update?: unknown,
			_ctx?: unknown,
			signal?: AbortSignal,
		) {
			try {
				if (!params || typeof params !== "object" || Array.isArray(params)) return invalid("expected an object");
				for (const key of Object.keys(params)) {
					if (!ALLOWED.has(key)) return invalid(`unknown field ${key}`);
				}
				const memoryDir = params.memory_dir;
				const projectRoot = params.project_root;
				const jev = params.jev;
				const maxClaims = params.max_claims;
				const maxJevCalls = params.max_jev_calls;
				const threshold = params.confidence_threshold;
				if (memoryDir !== undefined && (typeof memoryDir !== "string" || memoryDir.length === 0 || memoryDir.length > 4096 || memoryDir.includes("\0"))) {
					return invalid("memory_dir must be a non-empty string under 4096 characters");
				}
				if (projectRoot !== undefined && (typeof projectRoot !== "string" || projectRoot.length === 0 || projectRoot.length > 4096 || projectRoot.includes("\0"))) {
					return invalid("project_root must be a non-empty string under 4096 characters");
				}
				if (jev !== undefined && typeof jev !== "boolean") return invalid("jev must be a boolean");
				if (maxClaims !== undefined && (!Number.isSafeInteger(maxClaims) || (maxClaims as number) < 1 || (maxClaims as number) > 200)) {
					return invalid("max_claims must be an integer from 1 to 200");
				}
				if (maxJevCalls !== undefined && (!Number.isSafeInteger(maxJevCalls) || (maxJevCalls as number) < 1 || (maxJevCalls as number) > 120)) {
					return invalid("max_jev_calls must be an integer from 1 to 120");
				}
				if (
					threshold !== undefined &&
					(typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)
				) {
					return invalid("confidence_threshold must be a finite number from 0 to 1");
				}
				const result = await runDream({
					cwd: pi.cwd,
					memoryDir: memoryDir as string | undefined,
					projectRoot: projectRoot as string | undefined,
					jev: jev === true,
					maxClaims: maxClaims as number | undefined,
					maxJevCalls: maxJevCalls as number | undefined,
					confidenceThreshold: threshold as number | undefined,
					signal,
				});
				const { report } = result;
				const firstNoDecision = report.claims.find(claim => claim.verdict === "no-decision");
				const jevReason =
					firstNoDecision?.jev?.status === "no_decision"
						? firstNoDecision.jev.reason
						: (firstNoDecision?.reason ?? "not_requested");
				const lines = [
					"memory_dream: ok",
					`claims=${report.counts.claims} supported=${report.counts.supported} contradicted=${report.counts.contradicted} unverified=${report.counts.unverified} no-decision=${report.counts.noDecision}`,
					`sent_to_jev=${report.counts.sentToJev} jev=${report.model} jev_reason=${jevReason} prompt=${report.promptVersion}`,
					`memory_unchanged=${report.memory.unchanged ? "yes" : "NO"}`,
					`report=${result.reportPath ?? "not_written"}`,
					`latest=${result.latestPath ?? "not_written"}`,
				];
				const contradicted = report.claims.filter(claim => claim.verdict === "contradicted").slice(0, 5);
				for (const claim of contradicted) {
					const citation = claim.evidence.find(item => item.kind === "canonical")?.citation ?? claim.sources[0]?.file ?? "unknown";
					lines.push(`- contradicted: ${claim.text.slice(0, 180)} (${citation})`);
				}
				const budget = report.budgets.filter(item => item.status === "over");
				for (const item of budget) lines.push(`- budget_over: ${item.file} ${item.bytes}B/${item.lines} lines`);
				const dead = report.deterministic.deadReferences;
				if (dead.length > 0) lines.push(`- dead_references=${dead.length}`);
				lines.push("limited: advisory report, not proof; memory files are never edited.");
				return { content: [{ type: "text", text: lines.join("\n") }] };
			} catch (error) {
				const reason = error instanceof Error ? error.message : "unknown_error";
				const safe = reason.replace(/[^\w .:-]/g, "").slice(0, 160);
				return invalid(safe || "unknown_error");
			}
		},
	};
}
