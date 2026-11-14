// jev-checkpoint tool_result hook. Experiment-only, default off, never installed
// on operational hosts. Fail-open: any error returns undefined and leaves the
// tool result untouched. It never blocks a tool call (no tool_call hook exists).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CHECKPOINT_ALLOWED_MODELS, INVOCATION_TIMEOUT_MS, buildDecisionState, familyFor, fnv, isLoopbackEndpoint, latestUserText, newSessionState, observe, parseConfig, sessionIdOf, sessionStore, validAdvice } from "./core";
import type { CheckpointConfig, ConfigResult } from "./core";

let cachedConfig: ConfigResult | null = null;

function configPath(): string {
	const override = process.env.JEV_CHECKPOINT_CONFIG;
	if (override) return override;
	const agentDir = process.env.GJC_CODING_AGENT_DIR || path.join(process.env.HOME ?? "", ".gjc", "agent");
	return path.join(agentDir, "jev-checkpoint", "config.json");
}

function loadConfig(): ConfigResult {
	if (cachedConfig) return cachedConfig;
	try {
		cachedConfig = parseConfig(JSON.parse(readFileSync(configPath(), "utf8")));
	} catch {
		cachedConfig = { ok: false, reason: "config_unreadable" };
	}
	return cachedConfig;
}

function goalOf(ctx: any): { goal: string | null; goalSource: "branch" | "absent" } {
	try {
		const branch = ctx?.sessionManager?.getBranch?.call(ctx.sessionManager);
		const goal = latestUserText(branch);
		return goal ? { goal, goalSource: "branch" } : { goal: null, goalSource: "absent" };
	} catch {
		return { goal: null, goalSource: "absent" };
	}
}

function journal(row: Record<string, unknown>): void {
	try {
		const dir = path.join(process.env.HOME ?? "", ".gjc-plugin", "jev-checkpoint", "journal", "v1");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		appendFileSync(path.join(dir, "checkpoint.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
	} catch { /* journaling is best-effort */ }
}

export default function register(api: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) {
	api.on("tool_result", async (event: any, ctx: any) => {
		try {
			if (process.env.JEV_CHECKPOINT === "off") return undefined;
			if (!event || event.type !== "tool_result") return undefined;
			const loaded = loadConfig();
			if (!loaded.ok || loaded.config.mode === "off") return undefined;
			const config: CheckpointConfig = loaded.config;
			const endpoint = process.env.JEV_CHECKPOINT_ENDPOINT;
			if (!isLoopbackEndpoint(endpoint)) return undefined;
			const sessions = sessionStore();
			const sid = sessionIdOf(ctx);
			let state = sessions.get(sid);
			if (!state) { state = newSessionState(); sessions.set(sid, state); }
			if (!observe(state, config, event)) return undefined;
			const { goal, goalSource } = goalOf(ctx);
			const family = familyFor(config);
			const body = {
				mode: config.mode,
				family,
				trigger: config.trigger,
				callIndex: state.calls,
				models: CHECKPOINT_ALLOWED_MODELS[config.mode],
				state: buildDecisionState(goal, state.history),
				goalSource,
			};
			const started = Date.now();
			const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(INVOCATION_TIMEOUT_MS), redirect: "error" });
			const reply: any = response.ok ? await response.json() : null;
			const advice = validAdvice(reply?.advice);
			journal({ at: new Date().toISOString(), session: fnv(sid), callIndex: state.calls, mode: config.mode, family, httpStatus: response.status, branch: reply?.branch ?? null, label: reply?.label ?? null, signal: reply?.signal ?? null, reason: reply?.reason ?? null, latencyMs: Date.now() - started, goalSource, appended: advice ? fnv(advice) : null });
			if (!advice) return undefined;
			const content = Array.isArray(event.content) ? event.content : [];
			return { content: [...content, { type: "text", text: advice }] };
		} catch {
			return undefined;
		}
	});
}
