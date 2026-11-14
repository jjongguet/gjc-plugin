/**
 * Parse one `gjc --print --mode json` JSONL transcript into the bounded form
 * the oracles and metrics consume. Unknown event types are ignored; a line that
 * is not JSON makes the transcript invalid (the cell becomes an error cell).
 */

export const ADVICE_PREFIX = "[jev-checkpoint]";
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

const textOf = (content) => (Array.isArray(content) ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text) : typeof content === "string" ? [content] : []);

export function parseTranscript(jsonl) {
	if (typeof jsonl !== "string") throw new Error("transcript_not_text");
	if (Buffer.byteLength(jsonl, "utf8") > MAX_TRANSCRIPT_BYTES) throw new Error("transcript_too_large");
	const events = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw new Error("transcript_invalid_json");
		}
		events.push(event);
	}
	const assistantMessages = [];
	const toolCalls = [];
	const byId = new Map();
	let finalText = "";
	let ended = false;
	const usage = { input: 0, output: 0, costUsd: 0 };
	for (const event of events) {
		if (event?.type === "agent_end") ended = true;
		if (event?.type !== "message_end" || !event.message) continue;
		const message = event.message;
		if (message.role === "assistant") {
			assistantMessages.push(message);
			const u = message.usage ?? {};
			usage.input += Number.isFinite(u.input) ? u.input : 0;
			usage.output += Number.isFinite(u.output) ? u.output : 0;
			usage.costUsd += Number.isFinite(u.cost?.total) ? u.cost.total : 0;
			const texts = [];
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part?.type === "toolCall") {
					const call = { index: toolCalls.length, id: String(part.id ?? ""), name: String(part.name ?? ""), args: part.arguments ?? {}, isError: null, resultText: null, advice: null, turn: assistantMessages.length - 1 };
					toolCalls.push(call);
					if (call.id) byId.set(call.id, call);
				} else if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
			}
			if (texts.length) finalText = texts.join("\n");
		} else if (message.role === "toolResult") {
			const call = byId.get(String(message.toolCallId ?? ""));
			if (!call) continue;
			// Advice arrives as its own text part on success, but GJC folds an error
			// result into one text part, so split at the marker wherever it appears.
			const result = [];
			const advice = [];
			for (const text of textOf(message.content)) {
				const at = text.indexOf(ADVICE_PREFIX);
				if (at === -1) { result.push(text); continue; }
				if (at > 0) result.push(text.slice(0, at).replace(/\n$/, ""));
				advice.push(text.slice(at));
			}
			call.isError = message.isError === true;
			call.resultText = result.join("\n");
			if (advice.length) {
				const text = advice.join("\n");
				const match = /label=([a-z_]+)/.exec(text);
				call.advice = { text, label: match ? match[1] : null };
			}
		}
	}
	return { events, assistantMessages, toolCalls, finalText, usage, ended, turns: assistantMessages.length };
}
