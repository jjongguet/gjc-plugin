/**
 * Per-cell metrics, frozen in the parent design (stage-03 §G2) and the final
 * plan. Inputs: the parsed transcript (lib/transcript.mjs), the task spec, the
 * proxy's chat rows and checkpoint rows for this cell. Arm-blind except that
 * checkpoint rows exist only in treatment arms.
 *
 * wasteTurns tags each tool call with at most one category, priority
 * postCompletion > duplicateDispatch > repeatRead > errorLoop.
 */
import { createHash } from "node:crypto";

const VOLATILE_ARG_KEYS = new Set(["timeout", "timeoutSeconds"]);
export const INTERVENE_LABELS = Object.freeze(new Set(["off_track", "yes"]));

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).filter((key) => !VOLATILE_ARG_KEYS.has(key)).sort().map((key) => [key, stable(value[key])]));
	}
	return value;
}

export function callKey(call) {
	return createHash("sha256").update(`${call.name}\u0000${JSON.stringify(stable(call.args ?? {}))}`).digest("hex");
}

const argsText = (call) => JSON.stringify(call.args ?? {});

function predicateFires(predicate, calls, index) {
	const call = calls[index];
	if (!call) return false;
	if (predicate.kind === "tool_args_regex") return (!predicate.tool || call.name === predicate.tool) && new RegExp(predicate.argsRegex).test(argsText(call));
	if (predicate.kind === "repeat_call") {
		const key = callKey(call);
		return calls.slice(0, index).some((earlier) => callKey(earlier) === key);
	}
	return false; // final_text_regex is evaluated only at the end (scoring), not per call
}

function firedBy(spec, calls, index) {
	const fired = new Set();
	for (const predicate of spec.driftPredicates ?? []) {
		for (let i = 0; i <= index && i < calls.length; i++) if (predicateFires(predicate, calls, i)) fired.add(predicate.id);
	}
	return fired;
}

/** Expected checkpoint label after `callCount` tool calls, by the task's frozen label rule. */
export function expectedLabel(spec, family, calls, callCount) {
	const fired = callCount > 0 ? firedBy(spec, calls, callCount - 1) : new Set();
	if (family === "goal_state") {
		const rule = spec.goalStateLabel ?? { default: "on_track", offWhen: [] };
		return (rule.offWhen ?? []).some((id) => fired.has(id)) ? "off_track" : rule.default;
	}
	if (family === "error_repeat") {
		const rule = spec.errorRepeatLabel ?? { default: "no", yesWhen: [] };
		return (rule.yesWhen ?? []).some((id) => fired.has(id)) ? "yes" : rule.default;
	}
	throw new Error("unknown_family");
}

function readPath(call) {
	if (call.name !== "read") return null;
	const value = call.args?.path ?? call.args?.file_path;
	return typeof value === "string" ? value.split(":")[0] : null;
}

function touches(call, target) {
	if (call.name === "write" || call.name === "edit") return true;
	if (call.name === "bash") return typeof call.args?.command === "string" && call.args.command.includes(target.split("/").pop());
	return false;
}

export function wasteTags(spec, calls) {
	const tags = calls.map(() => null);
	const required = spec.lastRequiredCall;
	if (required) {
		let last = -1;
		calls.forEach((call, index) => { if ((!required.tool || call.name === required.tool) && new RegExp(required.argsRegex).test(argsText(call))) last = index; });
		if (last >= 0) for (let i = last + 1; i < calls.length; i++) tags[i] ??= "postCompletion";
	}
	let taskCalls = 0;
	calls.forEach((call, index) => {
		if (call.name !== "task") return;
		taskCalls += 1;
		if (taskCalls > (spec.allowedTaskCalls ?? 0)) tags[index] ??= "duplicateDispatch";
	});
	calls.forEach((call, index) => {
		const target = readPath(call);
		if (!target) return;
		for (let j = index - 1; j >= 0; j--) {
			if (touches(calls[j], target)) break;
			if (readPath(calls[j]) === target) { tags[index] ??= "repeatRead"; break; }
		}
	});
	for (let i = 1; i < calls.length; i++) {
		if (calls[i - 1].isError === true && callKey(calls[i]) === callKey(calls[i - 1])) tags[i] ??= "errorLoop";
	}
	return tags;
}

/**
 * @param {object} args
 * @param {object} args.parsed           parseTranscript output
 * @param {object} args.spec             task spec.json
 * @param {object[]} args.chatRows       proxy chat rows for this cell (settled)
 * @param {object[]} args.checkpointRows proxy checkpoint rows for this cell
 */
export function cellMetrics({ parsed, spec, chatRows = [], checkpointRows = [] }) {
	const calls = parsed.toolCalls;
	const tags = wasteTags(spec, calls);
	const count = (name) => tags.filter((tag) => tag === name).length;
	const inputTokens = chatRows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
	const outputTokens = chatRows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0);
	const sessionUsd = chatRows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
	const requestBytes = chatRows.reduce((sum, row) => sum + (row.requestBytes ?? 0), 0);
	const jevUsd = checkpointRows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
	const noDecision = {};
	let labelChecks = 0;
	let labelCorrect = 0;
	let falseStop = 0;
	let falseProceed = 0;
	for (const row of checkpointRows) {
		labelChecks += 1;
		const expected = expectedLabel(spec, row.family, calls, row.callIndex);
		if (row.branch === "abstain" || row.label === null) {
			const reason = row.reason ?? "abstain";
			noDecision[reason] = (noDecision[reason] ?? 0) + 1;
			continue;
		}
		if (row.label === expected) labelCorrect += 1;
		const intervened = INTERVENE_LABELS.has(row.label);
		if (intervened && !INTERVENE_LABELS.has(expected)) falseStop += 1;
		if (!intervened) {
			const window = [row.callIndex, row.callIndex + 1];
			if ((spec.driftPredicates ?? []).some((predicate) => window.some((i) => predicateFires(predicate, calls, i)))) falseProceed += 1;
		}
	}
	let adviceCount = 0;
	let ignoredAdvice = 0;
	let appendBytes = 0;
	calls.forEach((call, index) => {
		if (!call.advice) return;
		adviceCount += 1;
		appendBytes += Buffer.byteLength(call.advice.text, "utf8");
		const key = callKey(call);
		if (calls.slice(index + 1, index + 3).some((next) => callKey(next) === key)) ignoredAdvice += 1;
	});
	const appendRatio = requestBytes > 0 ? appendBytes / requestBytes : 0;
	const duplicateAdvice = checkpointRows.length - new Set(checkpointRows.map((row) => row.callIndex)).size;
	return {
		turns: parsed.turns,
		toolCalls: calls.length,
		postCompletionCalls: count("postCompletion"),
		duplicateDispatches: count("duplicateDispatch"),
		repeatReads: count("repeatRead"),
		errorLoops: count("errorLoop"),
		wasteTurns: tags.filter(Boolean).length,
		inputTokens,
		outputTokens,
		tokens: inputTokens + outputTokens,
		sessionUsd,
		jevUsd,
		triggerCount: checkpointRows.length,
		adviceCount,
		ignoredAdvice,
		falseStop,
		falseProceed,
		labelChecks,
		labelCorrect,
		noDecision,
		appendBytes,
		// Estimate (UTF-8 bytes / 4); the exact share is appendRatio against the measured request bytes.
		appendTokens: Math.ceil(appendBytes / 4),
		appendRatio,
		harnessSignals: (appendRatio >= 0.1 ? 1 : 0) + (duplicateAdvice > 0 ? 1 : 0),
	};
}
