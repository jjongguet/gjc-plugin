// Advisory session_start line for the lesson ledger.
//
// One bounded, best-effort `select --cwd <session cwd>` with a short timeout.
// Any missing root, unreadable ledger, timeout or malformed payload is silence:
// the hook never injects model context and never blocks a session.
import {
	START_LIMIT,
	START_MAX_BYTES,
	START_MAX_LINE_CHARS,
	START_TIMEOUT_MS,
	selectLessons,
	type SelectDeps,
	type SelectResult,
} from "./select";

function clipLine(value: string, limit: number): string {
	return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Build the one-line notice from a selector result, or null when there is
 * nothing worth showing (empty, unavailable or failed).
 */
export function startLine(result: SelectResult): string | null {
	if (result.status !== "ok" || result.count === 0) return null;
	const ids = result.lessons.map((lesson) => lesson.id).join(", ");
	return clipLine(`lessons: ${result.count} relevant (${ids}) - lessons_select for detail`, START_MAX_LINE_CHARS);
}

/** Run the bounded start-of-session selection and render its line, or null. */
export async function sessionStartLine(cwd: string | null, deps: SelectDeps = {}): Promise<string | null> {
	try {
		const result = await selectLessons(
			{ cwd: cwd ?? undefined, limit: START_LIMIT, max_bytes: START_MAX_BYTES },
			{ ...deps, timeoutMs: deps.timeoutMs ?? START_TIMEOUT_MS },
		);
		return startLine(result);
	} catch {
		return null;
	}
}
