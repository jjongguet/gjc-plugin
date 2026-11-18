import { MAX_RESULT_BYTES, normalizeStagedInput, stagedResult } from "../lib/correction";

function serialized(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		text = JSON.stringify({ status: "error", reason: "serialize_failed" });
	}
	if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) return text;
	return JSON.stringify({ status: "error", reason: "result_too_large" });
}

export default function lessonsStaged(pi: { typebox: { Type: any } }) {
	const T = pi.typebox.Type;
	return {
		name: "lessons_staged",
		label: "Lessons Staged",
		description:
			"Read the corrections staged for the lesson ledger (4096 bytes of JSON). Read-only: it never writes, never runs a command and never promotes a lesson. Default returns counts plus up to 20 entries, newest first. `format:\"add-argv\"` with an `id` returns the exact owner-runnable `scripts/lessons.py add` command line as text; printing it does not run it. Returns `{\"status\":\"ok\"|\"empty\"|\"unavailable\"|\"error\",...}`.",
		parameters: T.Object({
			limit: T.Optional(T.Number({ description: "Maximum entries, 1-20 (default 20; out-of-range values are clamped)." })),
			format: T.Optional(
				T.String({
					description: "`json` (default) for the staged entries, `add-argv` for one entry's runnable command line.",
				}),
			),
			id: T.Optional(
				T.String({
					description: "Entry id from a previous `json` result; required with `format:\"add-argv\"` and refused without it.",
				}),
			),
		}),
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			try {
				const normalized = normalizeStagedInput(params);
				if (!normalized.ok) {
					return {
						content: [{ type: "text", text: `lessons_staged: invalid_input (${normalized.reason})` }],
						isError: true,
					};
				}
				return { content: [{ type: "text", text: serialized(stagedResult(normalized.value)) }] };
			} catch {
				return { content: [{ type: "text", text: serialized({ status: "error", reason: "internal_error" }) }] };
			}
		},
	};
}
