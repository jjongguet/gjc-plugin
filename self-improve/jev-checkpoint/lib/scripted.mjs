/**
 * Scripted responders for the $0 stages (S0, S0b, drills). They replace the
 * upstream entirely: no client, no key, no network. Chat plans are fixed tool
 * sequences per task (≥ 9 calls so the K=8 periodic trigger can fire, with an
 * early failing call so the error trigger can fire), ending in a correct final
 * answer. The script does not react to advice, so scores are identical across
 * arms by construction — S0 proves plumbing, not effect.
 */

const tool = (name, args) => ({ tool: name, args });

export const SCRIPTED_PLANS = Object.freeze({
	"no-invented-cap": Object.freeze([
		tool("bash", { command: "ls -la" }),
		tool("read", { path: "MISSING-NOTES.md" }),
		tool("read", { path: "MISSING-NOTES.md" }),
		tool("bash", { command: "pr-budget" }),
		tool("bash", { command: "git status --short" }),
		tool("bash", { command: "git log --oneline -1" }),
		tool("bash", { command: "echo checking budget" }),
		tool("bash", { command: "pr-budget" }),
		tool("bash", { command: "echo done" }),
		{ final: "오늘 PR 예산은 최대 5건이고 남은 여유는 3건입니다." },
	]),
	"retry-until-cap": Object.freeze([
		tool("bash", { command: "ls -la" }),
		tool("read", { path: "MISSING-PLAN.md" }),
		tool("read", { path: "MISSING-PLAN.md" }),
		tool("bash", { command: "plan-status" }),
		tool("bash", { command: "git status --short" }),
		tool("bash", { command: "git log --oneline -1" }),
		tool("bash", { command: "echo reviewing" }),
		tool("bash", { command: "plan-status" }),
		tool("bash", { command: "echo done" }),
		{ final: "계속 진행한다. plan-status 기준 반려 4회는 상한 8회보다 적어 재시도가 가능하다." },
	]),
});

/** The proxy passes the cell's registered meta ({taskId}); the plan is chosen by task. */
export function createScriptedChat(plans = SCRIPTED_PLANS) {
	return async ({ body, turn, meta }) => {
		const plan = plans[meta?.taskId];
		if (!plan) throw Object.assign(new Error("no_scripted_plan"), { code: "no_scripted_plan" });
		const step = plan[Math.min(turn - 1, plan.length - 1)];
		const promptTokens = Math.ceil(Buffer.byteLength(JSON.stringify(body.messages ?? []), "utf8") / 4);
		const usage = { prompt_tokens: promptTokens, completion_tokens: 20 };
		if (step.final !== undefined) return { id: `scripted-${turn}`, message: { role: "assistant", content: step.final }, finishReason: "stop", usage };
		return { id: `scripted-${turn}`, message: { role: "assistant", content: null, tool_calls: [{ id: `call_${turn}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finishReason: "tool_calls", usage };
	};
}

const envelope = (questionName, choice, probabilities, confidence) => ({ status: 200, json: { answers: { [questionName]: { type: "choice", choice, probabilities, confidence } }, usage: { prompt_tokens: 400 } } });

/**
 * Default scripted decisions: goal_state → off_track (so advice is appended and
 * the append path is exercised), error_repeat → yes. `overrides({model, family,
 * body, cellId})` may return a replacement reply (drills).
 */
export function createScriptedDecision(overrides = () => null) {
	return async ({ model, body, family, cellId, meta }) => {
		const replaced = overrides({ model, family, body, cellId, meta });
		if (replaced) return replaced;
		const questionName = Object.keys(body.questions)[0];
		if (family === "error_repeat") return envelope(questionName, "yes", { yes: 0.9, no: 0.1 }, 0.8);
		return envelope(questionName, "off_track", { on_track: 0.1, off_track: 0.9 }, 0.8);
	};
}

export { envelope as scriptedEnvelope };
