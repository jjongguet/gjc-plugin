// GENERATED — edit src/, then node self-improve/jev-checkpoint/plugin/scripts/build.mjs. Experiment-only standalone hook.
// jev-checkpoint core: config parsing, trigger logic and state building.
// Pure functions only; the adapter owns IO. The plugin never names a model on
// its own: the model set per mode is this allowlist constant, and the parent
// proxy re-validates it before any transport (rule://decision-models).

export const CHECKPOINT_ALLOWED_MODELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	periodic: Object.freeze(["sionic-ai/jev-omni"]),
	error: Object.freeze(["sionic-ai/jev-omni"]),
	ensemble: Object.freeze(["sionic-ai/jev-omni", "sionic-ai/decider-4b"]),
});
export const CHECKPOINT_CAPS: Readonly<Record<string, number>> = Object.freeze({ periodic: 6, error: 2, ensemble: 6 });
export const PERIOD_K = 8;
export const HISTORY_WINDOW = 6;
export const MAX_STATE_BYTES = 2048;
export const ADVICE_MAX_CHARS = 300;
export const INVOCATION_TIMEOUT_MS = 8000;
const CONFIG_KEYS = new Set(["mode", "k", "trigger", "cap"]);
const MODES = new Set(["off", "periodic", "error", "ensemble"]);
const TRIGGERS = new Set(["periodic", "error"]);

export type CheckpointConfig = { mode: "off" | "periodic" | "error" | "ensemble"; k: number; trigger: "periodic" | "error"; cap: number };
export type ConfigResult = { ok: true; config: CheckpointConfig } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate a config object. Unknown keys and any model selection are refused. */
export function parseConfig(raw: unknown): ConfigResult {
	if (!isRecord(raw)) return { ok: false, reason: "invalid_config" };
	if ("models" in raw || "model" in raw) return { ok: false, reason: "model_selection_forbidden" };
	for (const key of Object.keys(raw)) if (!CONFIG_KEYS.has(key)) return { ok: false, reason: "unknown_key" };
	const mode = raw.mode;
	if (typeof mode !== "string" || !MODES.has(mode)) return { ok: false, reason: "invalid_mode" };
	if (mode === "off") return { ok: true, config: { mode: "off", k: PERIOD_K, trigger: "periodic", cap: 0 } };
	const trigger = mode === "periodic" ? "periodic" : mode === "error" ? "error" : raw.trigger;
	if (typeof trigger !== "string" || !TRIGGERS.has(trigger)) return { ok: false, reason: "invalid_trigger" };
	if ((mode === "periodic" || mode === "error") && raw.trigger !== undefined && raw.trigger !== trigger) return { ok: false, reason: "invalid_trigger" };
	const k = raw.k === undefined ? PERIOD_K : raw.k;
	if (!Number.isInteger(k) || k !== PERIOD_K) return { ok: false, reason: "invalid_k" };
	const maxCap = mode === "ensemble" ? CHECKPOINT_CAPS.ensemble : CHECKPOINT_CAPS[trigger];
	const cap = raw.cap === undefined ? maxCap : raw.cap;
	if (!Number.isInteger(cap) || cap < 1 || cap > maxCap) return { ok: false, reason: "invalid_cap" };
	return { ok: true, config: { mode: mode as CheckpointConfig["mode"], k, trigger: trigger as CheckpointConfig["trigger"], cap } };
}

export function familyFor(config: CheckpointConfig): "goal_state" | "error_repeat" {
	return config.trigger === "error" ? "error_repeat" : "goal_state";
}

export type CallRecord = { name: string; key: string; short: string; isError: boolean; outputHead: string; failureKey: string | null };
export type SessionState = { calls: number; history: CallRecord[]; fired: number; lastWindowKey: string | null; failureCounts: Record<string, number> };

export function newSessionState(): SessionState {
	return { calls: 0, history: [], fired: 0, lastWindowKey: null, failureCounts: {} };
}

// GJC loads each manifest hook entry as its own module and an entry may only
// register its own event (registering another event drops the entry). The
// tool_result and session_shutdown modules therefore share per-session state
// through one process-global map keyed by session id.
const STORE_KEY = Symbol.for("jexp.jev-checkpoint.sessions");
export function sessionIdOf(ctx: any): string {
	try {
		const id = ctx?.sessionManager?.getSessionId?.call(ctx.sessionManager);
		return typeof id === "string" && id ? id : "default";
	} catch {
		return "default";
	}
}

export function sessionStore(): Map<string, SessionState> {
	const holder = globalThis as any;
	if (!(holder[STORE_KEY] instanceof Map)) holder[STORE_KEY] = new Map<string, SessionState>();
	return holder[STORE_KEY];
}

/** Small deterministic string hash (FNV-1a 32-bit) for keys; not a security digest. */
export function fnv(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function stableArgs(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableArgs);
	if (isRecord(value)) return Object.fromEntries(Object.keys(value).filter(key => key !== "timeout").sort().map(key => [key, stableArgs(value[key])]));
	return value;
}

function textContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.filter(part => isRecord(part) && part.type === "text" && typeof part.text === "string").map(part => (part as any).text).join("\n");
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Record one tool result; returns whether this result fires a checkpoint. */
export function observe(state: SessionState, config: CheckpointConfig, event: Record<string, any>): boolean {
	const name = typeof event.toolName === "string" ? event.toolName : "unknown";
	const argsJson = JSON.stringify(stableArgs(event.input ?? {}));
	const output = textContent(event.content);
	const isError = event.isError === true;
	const failureKey = isError ? fnv(`${name}\u0000${output.slice(0, 400)}`) : null;
	const record: CallRecord = { name, key: fnv(`${name}\u0000${argsJson}`), short: clip(argsJson, 160), isError, outputHead: clip(output.replace(/\s+/g, " ").trim(), 160), failureKey };
	const previous = state.history[state.history.length - 1];
	state.calls += 1;
	state.history.push(record);
	if (state.history.length > HISTORY_WINDOW) state.history.shift();
	if (failureKey) state.failureCounts[failureKey] = (state.failureCounts[failureKey] ?? 0) + 1;
	if (config.mode === "off" || state.fired >= config.cap) return false;
	if (config.trigger === "periodic") {
		if (state.calls % config.k !== 0) return false;
		const windowKey = fnv(state.history.map(entry => entry.key).join(","));
		if (windowKey === state.lastWindowKey) return false;
		state.lastWindowKey = windowKey;
		state.fired += 1;
		return true;
	}
	const repeated = previous !== undefined && previous.key === record.key;
	const sameFailureTwice = failureKey !== null && state.failureCounts[failureKey] >= 2;
	if (isError || repeated || sameFailureTwice) {
		state.fired += 1;
		return true;
	}
	return false;
}

/** Bounded decision state: the goal line plus the recent tool window. */
export function buildDecisionState(goal: string | null, history: CallRecord[]): string {
	const lines = [`Goal: ${goal ? clip(goal.replace(/\s+/g, " ").trim(), 400) : "(unavailable)"}`, "Recent actions (oldest first):"];
	history.forEach((entry, index) => {
		lines.push(`${index + 1}. ${entry.name} ${entry.short} → ${entry.isError ? "error" : "ok"}: ${entry.outputHead}`);
	});
	let text = lines.join("\n");
	while (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES && lines.length > 3) {
		lines.splice(2, 1);
		text = lines.join("\n");
	}
	if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) text = Buffer.from(text, "utf8").subarray(0, MAX_STATE_BYTES - 4).toString("utf8").replace(/\uFFFD+$/, "");
	return text;
}

/** Latest user entry from the host branch (same entry shapes jev-advisor reads). */
export function latestUserText(branch: unknown): string | null {
	const list = Array.isArray(branch) ? branch : isRecord(branch) && Array.isArray(branch.entries) ? branch.entries : [];
	for (let i = list.length - 1; i >= 0; i--) {
		const entry = list[i];
		if (!isRecord(entry)) continue;
		const message = isRecord(entry.message) ? entry.message : entry;
		if (message.role !== "user") continue;
		const content = message.content;
		const text = typeof content === "string" ? content : textContent(content);
		if (text.trim()) return text.trim();
	}
	return null;
}

export function validAdvice(advice: unknown): string | null {
	if (typeof advice !== "string") return null;
	if (!advice.startsWith("[jev-checkpoint]")) return null;
	return advice.length > ADVICE_MAX_CHARS ? advice.slice(0, ADVICE_MAX_CHARS) : advice;
}

export function isLoopbackEndpoint(endpoint: unknown): endpoint is string {
	if (typeof endpoint !== "string") return false;
	try {
		const url = new URL(endpoint);
		return url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password;
	} catch {
		return false;
	}
}

// jev-checkpoint tool_result hook. Experiment-only, default off, never installed
// on operational hosts. Fail-open: any error returns undefined and leaves the
// tool result untouched. It never blocks a tool call (no tool_call hook exists).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

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
