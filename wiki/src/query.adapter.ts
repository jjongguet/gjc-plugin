import { createHash } from "node:crypto";
import { appendPluginOutcome } from "../../shared/lib/results";
import { wikiQueryRun } from "../lib/wiki";

// Read-only canonical-page lookup. Pending proposals stay invisible and
// publication authority never passes through this tool.
export default function wikiQuery(pi: {
	typebox: { Type: { Object: (fields: Record<string, unknown>) => unknown; String: (options?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };
}) {
	return {
		name: "wiki_query",
		label: "Wiki Query",
		description: "Read-only search over the guarded personal wiki: canonical pages only (pending proposals stay invisible), results cite wiki paths and original sources, and not-found is reported explicitly. Wiki text is curated personal knowledge, not verified truth.",
		parameters: pi.typebox.Type.Object({
			query: pi.typebox.Type.String({ description: "Search terms for canonical wiki pages, e.g. 'sunkcost validation'" }),
		}),
		async execute(_toolCallId: string, params: { query?: string }) {
			const query = (params?.query ?? "").trim();
			const finish = async (text: string, isError: boolean, execution?: { status: string; reason: string }) => {
				let journalStorage;
				try {
					journalStorage = await appendPluginOutcome("wiki", {
						operation: "wiki_query",
						toolCallDigest: createHash("sha256").update(_toolCallId).digest("hex"),
						...(execution ? { execution } : {}),
					});
				} catch { journalStorage = { persisted: false, reason: "store_unavailable" }; }
				return { content: [{ type: "text", text: `${text}\n${JSON.stringify({ journalStorage })}` }], ...(isError ? { isError: true } : {}) };
			};
			if (!query) return finish("wiki_query: invalid_input — a non-empty query is required.", true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			if (query.length > 200) return finish("wiki_query: invalid_input — query must be at most 200 characters.", true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			const result = await wikiQueryRun(query);
			if (result.status !== "ok") return finish(`wiki_query: ${result.reason} — ${result.stderr || "no stderr"}`, true, { status: "failed", reason: result.reason === "timeout" ? "timeout" : "runtime_error" });
			return finish(result.stdout || '{"results":[]}', false, { status: "passed", reason: "complete" });
		},
	};
}
