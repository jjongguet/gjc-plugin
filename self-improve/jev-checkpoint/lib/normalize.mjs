/**
 * Declared S0b normalization set (final plan, S0b 정규화 집합): before two chat
 * request bodies are compared byte-for-byte, values that legitimately differ
 * between cells are replaced by fixed tokens. Anything not listed here stays.
 *
 *   cell root path → <ROOT>, cell id → <CELL>, proxy port → <PORT>,
 *   session/attempt ids (UUID) → <UUID>, dates/times → <TIME>,
 *   commit SHAs (12–40 hex) → <SHA>, relative mtimes → <MTIME>
 */

const ISO_TIME = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?UTC[+-]\d{2}:\d{2})?\b/g;
const WEEKDAY = /\((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\)/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SHA = /\b[0-9a-f]{12,40}\b/g;
const MTIME = /\b(?:just now|\d+\s?(?:s|m|h|d|sec|min|hr)s? ago)\b/g;

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeText(text, { root = null, cellId = null, port = null, extra = [] } = {}) {
	let out = text;
	const literals = [];
	if (root) literals.push([root, "<ROOT>"], [`/private${root}`, "<ROOT>"], [root.replace(/^\/private/, ""), "<ROOT>"]);
	if (cellId) literals.push([cellId, "<CELL>"]);
	if (port) literals.push([`127.0.0.1:${port}`, "127.0.0.1:<PORT>"]);
	for (const pair of extra) literals.push(pair);
	literals.sort((a, b) => b[0].length - a[0].length);
	for (const [literal, token] of literals) if (literal) out = out.replace(new RegExp(escapeRegExp(literal), "g"), token);
	return out.replace(UUID, "<UUID>").replace(ISO_TIME, "<TIME>").replace(CLOCK, "<TIME>").replace(WEEKDAY, "(<DAY>)").replace(SHA, "<SHA>").replace(MTIME, "<MTIME>");
}

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	return value;
}

/** Canonical JSON of a chat body with the declared normalization applied to every string. */
export function normalizeBody(body, normalization = {}) {
	const walk = (value) => {
		if (typeof value === "string") return normalizeText(value, normalization);
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
		return value;
	};
	return JSON.stringify(canonical(walk(body)));
}
