import { createHash } from "node:crypto";
import { appendPluginOutcome } from "../../shared/lib/results";
import { WIKI_PAGE_PATH, WIKI_SOURCE_ID, WIKI_TEXT_LIMIT, wikiProposeRun } from "../lib/wiki";

// Capture one owner-approved source and submit draft pages as a pending
// proposal. Never approves, never publishes: the returned digest exists so the
// writer can act on that exact digest via wiki.py — after a per-digest human
// approval, or under the owner standing approval recorded in REVIEW.md.
const WIKI_MAX_PAGES = 8;
const WIKI_MAX_TITLE = 200;

export default function wikiPropose(pi: {
	typebox: { Type: { Object: (fields: Record<string, unknown>) => unknown; String: (options?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };
}) {
	return {
		name: "wiki_propose",
		label: "Wiki Propose",
		description: "Capture one owner-approved source and submit draft wiki pages as a pending proposal; returns the exact content digest. This tool never approves or publishes — publication happens on the configured writer via wiki.py — after a per-digest human approval, or under the owner standing approval recorded in the wiki's REVIEW.md. Owner-approved personal/public inputs only; employer sources are refused.",
		parameters: pi.typebox.Type.Object({
			id: pi.typebox.Type.String({ description: "Stable lowercase source id (letters, digits, hyphens), e.g. 'jev-advisor-efficacy-20261008'" }),
			title: pi.typebox.Type.String({ description: "Human-readable source title" }),
			origin: pi.typebox.Type.String({ description: 'Source origin: "personal" or "public"' }),
			source_text: pi.typebox.Type.String({ description: "Complete source text to capture (the approved original)" }),
			changes_json: pi.typebox.Type.String({ description: "JSON object mapping canonical page paths (concepts|entities|references|synthesis|journal/<slug>.md) to complete UTF-8 page text; at least one page must cite [[_raw/<id>/original]]" }),
		}),
		async execute(_toolCallId: string, params: { id?: string; title?: string; origin?: string; source_text?: string; changes_json?: string }) {
			const id = (params?.id ?? "").trim();
			const title = (params?.title ?? "").trim();
			const origin = (params?.origin ?? "").trim();
			const sourceText = params?.source_text ?? "";
			const changesJson = params?.changes_json ?? "";
			const finish = async (text: string, isError: boolean, execution?: { status: string; reason: string }) => {
				let journalStorage;
				try {
					journalStorage = await appendPluginOutcome("wiki", {
						operation: "wiki_propose",
						toolCallDigest: createHash("sha256").update(_toolCallId).digest("hex"),
						...(execution ? { execution } : {}),
					});
				} catch { journalStorage = { persisted: false, reason: "store_unavailable" }; }
				return { content: [{ type: "text", text: `${text}\n${JSON.stringify({ journalStorage })}` }], ...(isError ? { isError: true } : {}) };
			};
			const invalid = (detail: string) => finish(`wiki_propose: invalid_input — ${detail}`, true, { status: "not_run", reason: "invalid_or_unavailable_input" });
			if (!WIKI_SOURCE_ID.test(id)) return invalid("id must be a lowercase slug of letters, digits and hyphens.");
			if (!title || title.length > WIKI_MAX_TITLE) return invalid(`title is required (max ${WIKI_MAX_TITLE} characters).`);
			if (origin !== "personal" && origin !== "public") return invalid('origin must be "personal" or "public"; employer sources are refused.');
			if (!sourceText.trim() || sourceText.length > WIKI_TEXT_LIMIT) return invalid(`source_text must be non-empty and at most ${WIKI_TEXT_LIMIT} characters.`);
			let changes: Record<string, unknown>;
			try {
				const parsed = JSON.parse(changesJson) as unknown;
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error("not a plain object");
				changes = parsed as Record<string, unknown>;
			} catch { return invalid("changes_json must be a JSON object mapping page paths to page text."); }
			const paths = Object.keys(changes);
			if (paths.length < 1 || paths.length > WIKI_MAX_PAGES) return invalid(`changes must contain 1..${WIKI_MAX_PAGES} pages.`);
			for (const pagePath of paths) {
				if (!WIKI_PAGE_PATH.test(pagePath)) return invalid(`page path '${pagePath}' must match (concepts|entities|references|synthesis|journal)/<slug>.md.`);
				const pageText = changes[pagePath];
				if (typeof pageText !== "string" || !pageText.trim() || pageText.length > WIKI_TEXT_LIMIT) return invalid(`page '${pagePath}' text must be non-empty and at most ${WIKI_TEXT_LIMIT} characters.`);
			}
			const citation = `[[_raw/${id}/original]]`;
			if (!paths.some(pagePath => String(changes[pagePath]).includes(citation))) return invalid(`at least one page must cite ${citation}.`);
			const result = await wikiProposeRun({
				id,
				title,
				origin: origin as "personal" | "public",
				sourceText,
				changes: changes as Record<string, string>,
			});
			if (result.status !== "submitted") return finish(`wiki_propose: ${result.stage} failed (${result.reason}) — ${result.stderr || "no stderr"}`, true, { status: "failed", reason: result.reason === "timeout" ? "timeout" : "runtime_error" });
			return finish(`wiki_propose: submitted. digest=${result.digest}\nPending until the writer's approval evidence covers this exact digest (per-digest human approval, or the owner standing approval in REVIEW.md); this tool cannot publish.`, false, { status: "passed", reason: "complete" });
		},
	};
}
