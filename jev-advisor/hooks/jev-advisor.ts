// GENERATED FILE — do not edit by hand.
// Core: lib/decision.ts + adapter: src/hook.adapter.ts
// Rebuild with: bun scripts/build.mjs

/**
 * jev-advisor core — single source of truth.
 *
 * This file is NOT installed as-is: the gjc plugin installer copies only the
 * manifest-declared surface files (compiler.ts builds `files` from the
 * manifest; installer.ts copies exactly that set). `scripts/build.mjs`
 * inlines this core into the generated surfaces:
 *
 *   hooks/jev-advisor.ts = banner + THIS FILE + src/hook.adapter.ts
 *   tools/jev-advise.ts  = banner + THIS FILE + src/tool.adapter.ts
 *
 * Edit here (or in the adapters), then rebuild. Never edit the generated
 * surface files directly — the next build overwrites them.
 *
 * Extension points:
 *   - PROVIDERS            add a provider entry (+ its HTTPS origin to
 *                          ALLOWED_ORIGINS — the code-enforced egress
 *                          allowlist, the single gate for hook AND tool)
 *   - REQUEST_STYLES       add a non-OpenAI-compatible wire format
 *   - DEFAULTS / readConfig  new tunables in exactly one place
 *   - TIERS                gjc task tiers; changing this changes the contract
 *                          vocabulary, not just advice wording
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
export const TIERS = ["fast", "balanced", "strong"] as const;

/** Weak→strong ordering; a tier not in TIERS ranks as balanced. */
export function tierRank(tier: string): number {
	const index = TIERS.indexOf(String(tier ?? "").trim().toLowerCase() as Tier);
	return index === -1 ? 1 : index;
}
export type Tier = (typeof TIERS)[number];

export interface Decision {
	tier: Tier | string;
	confidence: number;
	rationale?: string;
}

export const DEFAULTS = {
	model: "typesafe/jev-1.13",
	timeoutMs: 8000,
	minIntervalMs: 15000,
	minConfidence: 0.6,
	maxAssignmentChars: 4000,
} as const;

/**
 * The single key/config file: `~/.gjc/agent/jev-advisor/.env` (KEY=VALUE
 * lines). It lives OUTSIDE the installed plugin directory because gjc's
 * installer replaces the installed tree wholesale on every install/upgrade
 * ("the installed tree equals the validated set" — installer.ts), which would
 * wipe anything placed next to the surfaces. Process env still wins over the
 * file. There is no other registration channel by design.
 */
export function pluginEnvFile(): string {
	return path.join(os.homedir(), ".gjc", "agent", "jev-advisor", ".env");
}

function loadPluginEnv(): Env {
	try {
		return parseEnvFile(readFileSync(pluginEnvFile(), "utf8"));
	} catch {
		return {};
	}
}

/** Wire formats for decision calls. `"openai-chat"` covers OpenRouter and Typesafe Jev. */
const REQUEST_STYLES = {
	"openai-chat": {
		request(cfg: { model: string; apiKey: string }, assignment: string) {
			return {
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${cfg.apiKey}`,
				},
			body: JSON.stringify({
				model: cfg.model,
				temperature: 0,
				// Reasoning tokens count against max_tokens and are NOT returned by
				// OpenAI-family models, so a small budget can yield content:null
				// with finish_reason "length". 2048 leaves room for reasoning.
				max_tokens: 2048,
				messages: [
						{
							role: "system",
							content:
								"You are a delegation-effort advisor for a coding agent. " +
								"Given a subagent task assignment, decide how much model effort it warrants. " +
								'Reply with ONLY minified JSON: {"tier":"fast"|"balanced"|"strong","confidence":<0..1>,"rationale":"<max 120 chars>"}. ' +
								"fast = mechanical or small measured edits; balanced = default implementation work; " +
								"strong = multi-file reasoning, architecture decisions, or high blast radius.",
						},
						{ role: "user", content: assignment },
					],
				}),
			};
		},
		parse(data: unknown): string {
			const first = (data as { choices?: Array<{ message?: Record<string, unknown>; error?: { message?: unknown } }> })?.choices?.[0];
			// Choice-level errors ride inside HTTP 200 responses (OpenRouter
			// normalization): surface as no-decision rather than empty completion.
			if (first?.error) return "";
			const message = first?.message;
			const content = message?.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.map(part => (typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : ""))
								.join("")
						: "";
			if (text.trim()) return text;
			// Reasoning-model fallback: some providers return the final answer only
			// inside `reasoning` when the completion budget is exhausted.
			return typeof message?.reasoning === "string" ? message.reasoning : "";
		},
	},
	/**
	 * TypeSafe "systemone" wire format — the documented shape of
	 * api.typesafe.ai/v1/systemone, of OpenRouter's /api/alpha/decisions, and of
	 * Ollaya's drop-in local server (ollaya.dev): one `state` plus typed
	 * `questions`; answers come back calibrated per question.
	 */
	systemone: {
		request(cfg: { model: string; apiKey: string }, assignment: string) {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
			return {
				headers,
				body: JSON.stringify({
					model: cfg.model,
					// Ollaya's normative contract fails with 422 STATE_TRUNCATED when
					// state exceeds the model context (laya:en ≈ 2000 chars); 1900 keeps
					// every systemone target inside budget. The head of an assignment
					// (role + first tasks) carries the signal for a classifier.
					state: assignment.slice(0, 1900),
					questions: {
						tier: {
							type: "choice",
							instructions: "How much model effort does this subagent task assignment warrant?",
							criteria: {
								fast: "Mechanical or small measured edits",
								balanced: "Default implementation work",
								strong: "Multi-file reasoning, architecture decisions, or high blast radius",
							},
						},
					},
				}),
			};
		},
		parse(data: unknown): string {
			const answer = ((data as { answers?: Record<string, unknown> })?.answers?.tier ?? {}) as {
				choice?: unknown;
				confidence?: unknown;
			};
			if (typeof answer.choice !== "string") return "";
			// A missing/non-finite confidence is an abnormal response: treat it as
			// no-decision instead of fabricating a plausible middle value.
			if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) return "";
			// Reuse parseDecision's tier/confidence validation downstream.
			return JSON.stringify({ tier: answer.choice, confidence: answer.confidence });
		},
	},
} as const;

/**
 * Provider registry. Origins here must also be listed in ALLOWED_ORIGINS —
 * the code-enforced egress allowlist below (gjc v0.17.7 function hooks would
 * be quarantined, so there is no platform sandbox allowlist to lean on).
 */
export const PROVIDERS: Record<
	string,
	{ endpoint: string; style: keyof typeof REQUEST_STYLES; keyless?: boolean; model?: string }
> = {
	// TypeSafe Jev on OpenRouter, via the decisions API (a decisions model is
	// rejected by chat/completions with HTTP 400). Wire format is the TypeSafe
	// systemone shape. ~$0.042/M input tokens, $0/M output — ~$0.000015/call.
	jev: { endpoint: "https://openrouter.ai/api/alpha/decisions", style: "systemone", model: "typesafe/jev-1.13" },
	// Generic OpenRouter chat models (any /api/v1/chat/completions model id).
	openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", style: "openai-chat", model: "openai/gpt-5-mini" },
	// TypeSafe's hosted systemone API directly.
	// TypeSafe's hosted systemone API directly (bare model ids, not the
	// OpenRouter typesafe/ namespace).
	"typesafe-jev": { endpoint: "https://api.typesafe.ai/v1/systemone", style: "systemone", model: "jev-latest" },
	// Local Ollaya server (ollaya.dev): TypeSafe-compatible /v1/systemone on
	// loopback, no key, millisecond open decision models (default: laya).
	ollaya: { endpoint: "http://127.0.0.1:11435/v1/systemone", style: "systemone", keyless: true, model: "laya" },
};

const ALLOWED_ORIGINS = new Set(["https://openrouter.ai", "https://api.typesafe.ai"]);

/** Loopback hosts where plaintext HTTP still never leaves the machine. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Single egress gate: every fetch URL must be an allowlisted HTTPS origin, or
 * a loopback HTTP origin — local runtimes such as Ollama/Ollaya serve plain
 * HTTP on 127.0.0.1, from which data cannot leave the machine.
 */
export function isAllowedEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		if (url.protocol === "https:") return ALLOWED_ORIGINS.has(url.origin);
		if (url.protocol === "http:")
			return LOOPBACK_HOSTS.has(url.hostname) && url.username === "" && url.password === "";
		return false;
	} catch {
		return false;
	}
}

export type AdvisorMode = "shadow" | "hint" | "enforce";

export interface AdvisorConfig {
	provider: string;
	mode: AdvisorMode;
	endpoint: string;
	apiKey: string;
	model: string;
	timeoutMs: number;
	minIntervalMs: number;
	minConfidence: number;
}

type Env = Record<string, string | undefined>;

function positiveNumber(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse a `.env`-style file body (`KEY=VALUE` lines, `#` comments, optional
 * matching quotes). Exported so adapters can load plugin-local files without
 * the core (and therefore the sandboxed hook) importing node:fs.
 */
export function parseEnvFile(text: string): Env {
	const out: Env = {};
	for (const rawLine of String(text ?? "").split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		let key = line.slice(0, eq).trim();
		if (key.startsWith("export ")) key = key.slice("export ".length).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		} else {
			// Unquoted: drop an inline trailing comment ("KEY=value # note").
			const hash = value.indexOf(" #");
			if (hash !== -1) value = value.slice(0, hash).trim();
		}
		if (key) out[key] = value;
	}
	return out;
}

export function readConfig(
	env: Env = (globalThis as { process?: { env: Env } }).process?.env ?? {},
	fileEnv: Env = loadPluginEnv(),
): AdvisorConfig {
	// Precedence: process env wins over the single ~/.gjc/agent/jev-advisor/.env file.
	const merged: Env = { ...fileEnv };
	for (const [key, value] of Object.entries(env)) if (value !== undefined) merged[key] = value;
	// Provider defaults to "jev" — TypeSafe Jev via OpenRouter's decisions API,
	// the canonical decision model (inert until a key exists — env or the .env
	// file). "ollaya" is keyless (local server). JEV_ADVISOR_PROVIDER=off
	// forces it inert.
	const provider = String(merged.JEV_ADVISOR_PROVIDER ?? "jev")
		.trim()
		.toLowerCase();
	const modeRaw = String(merged.JEV_ADVISOR_MODE ?? "shadow")
		.trim()
		.toLowerCase();
	const mode: AdvisorMode = modeRaw === "hint" || modeRaw === "enforce" ? (modeRaw as AdvisorMode) : "shadow";
	// Blank overrides (empty export / blank .env line) fall through to the next
	// source instead of sticking and silently defeating the fallback chain.
	const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	const endpoint = trim(merged.JEV_ADVISOR_ENDPOINT) || trim(PROVIDERS[provider]?.endpoint);
	const apiKey = trim(merged.JEV_ADVISOR_API_KEY) || trim(merged.OPENROUTER_API_KEY);
	// 0 is meaningful for the interval: it disables rate limiting entirely.
	const intervalRaw = Number(merged.JEV_ADVISOR_MIN_INTERVAL_MS);
	// 0 is meaningful for the gate too: it disables tier-gating in enforce mode.
	const confidenceRaw = Number(merged.JEV_ADVISOR_MIN_CONFIDENCE);
	return {
		provider,
		mode,
		endpoint,
		apiKey,
		model: trim(merged.JEV_ADVISOR_MODEL) || trim(PROVIDERS[provider]?.model) || DEFAULTS.model,
		timeoutMs: positiveNumber(merged.JEV_ADVISOR_TIMEOUT_MS, DEFAULTS.timeoutMs),
		minIntervalMs: Number.isFinite(intervalRaw) && intervalRaw >= 0 ? intervalRaw : DEFAULTS.minIntervalMs,
		minConfidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : DEFAULTS.minConfidence,
	};
}

export function isConfigured(cfg: AdvisorConfig): boolean {
	if (cfg.provider === "off" || !cfg.endpoint) return false;
	if (PROVIDERS[cfg.provider]?.keyless) return true;
	return Boolean(cfg.apiKey) && Boolean(PROVIDERS[cfg.provider] || cfg.endpoint);
}

export interface AssignmentExtraction {
	text: string;
	/** Per-task tiers explicitly requested by the caller ("fast"|"balanced"|"strong"). */
	requestedTiers: string[];
}

/**
 * Flatten a `task` tool payload into advisory text. The v0.17.7 task schema
 * nests the actual work under `tasks[]` ({id, description, assignment, tier});
 * the top level only carries `agent`, `context`, `spawnPlan`, `schema`. Tiers
 * are returned separately so enforce mode can compare requested vs recommended
 * instead of blocking on confidence alone.
 */
export function extractAssignment(input: unknown, maxChars = DEFAULTS.maxAssignmentChars): AssignmentExtraction | null {
	if (!input || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	const parts: string[] = [];
	const requestedTiers: string[] = [];
	const role = typeof record.agent === "string" ? record.agent.trim() : "";
	if (role) parts.push(`role: ${role}`);
	const sharedContext = typeof record.context === "string" ? record.context.trim() : "";
	const tasks = Array.isArray(record.tasks) ? record.tasks : [];
	let included = 0;
	let skipped = 0;
	for (const entry of tasks) {
		if (!entry || typeof entry !== "object") {
			skipped += 1;
			continue;
		}
		const task = entry as Record<string, unknown>;
		const id = typeof task.id === "string" && task.id.trim() ? task.id.trim() : "";
		const description = typeof task.description === "string" ? task.description.trim() : "";
		const assignment = typeof task.assignment === "string" ? task.assignment.trim() : "";
		const tier = typeof task.tier === "string" ? task.tier.trim().toLowerCase() : "";
		if (TIERS.includes(tier as Tier)) requestedTiers.push(tier);
		if (!id && !description && !assignment) {
			skipped += 1;
			continue;
		}
		included += 1;
		const head = `#${id || `task${included}`}${tier ? ` [requested tier: ${tier}]` : ""}`;
		const label = description ? `${head} ${description}` : head;
		parts.push(assignment ? `${label}\n${assignment}` : label);
	}
	if (skipped > 0) parts.push(`(${skipped} unparseable task entr${skipped === 1 ? "y" : "ies"} skipped)`);
	if (sharedContext) parts.push(`shared context: ${sharedContext}`);
	if (parts.length === 0) {
		// Unexpected payload shape: bounded flat fallback so the advisor sees
		// something honest about the call instead of silently advising on air.
		const flat = Object.entries(record)
			.filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
			.map(([k, v]) => `${k}: ${String(v)}`)
			.join(" | ");
		if (!flat) return null;
		parts.push(flat);
	}
	const joined = parts.join("\n\n").slice(0, maxChars);
	return joined.trim() ? { text: joined, requestedTiers } : null;
}

export function parseDecision(raw: string): Decision | null {
	try {
		let text = String(raw ?? "").trim();
		const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fence) text = fence[1].trim();
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start === -1 || end === -1 || end <= start) return null;
		const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
		const tier = String(parsed.tier ?? "")
			.trim()
			.toLowerCase();
		if (!TIERS.includes(tier as Tier)) return null;
		const confidence = Math.max(0, Math.min(1, Number(parsed.confidence)));
		if (!Number.isFinite(confidence)) return null;
		const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 200) : undefined;
		return { tier, confidence, rationale };
	} catch {
		return null;
	}
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Single decision code path for every surface: only the fetch implementation differs. */
export async function askDecisionModel(
	cfg: AdvisorConfig,
	assignment: string,
	fetchImpl: FetchLike | undefined,
	signal?: AbortSignal,
): Promise<Decision | null> {
	if (typeof fetchImpl !== "function") return null;
	const provider = PROVIDERS[cfg.provider] ?? (cfg.endpoint ? { endpoint: cfg.endpoint, style: "openai-chat" as const } : undefined);
	if (!provider) return null;
	// Egress gate — the endpoint origin must be allowlisted, no exceptions.
	const url = cfg.endpoint || provider.endpoint;
	if (!isAllowedEndpoint(url)) return null;
	const style = REQUEST_STYLES[provider.style];
	const wire = style.request({ model: cfg.model, apiKey: cfg.apiKey }, assignment);
	const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
	const composedSignal =
		signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const response = await fetchImpl(url, {
		method: "POST",
		// The origin gate covers exactly this URL; redirects would re-send the
		// assignment body off-origin, so refuse them instead of following.
		redirect: "error",
		headers: wire.headers,
		body: wire.body,
		signal: composedSignal,
	});
	// Transport-level failure: surface the HTTP status so operators can tell a
	// bad key (401) from a provider outage (5xx). Parse-level failures still
	// return null ("no decision") to keep the advisor silent-but-open.
	if (!response?.ok) throw new Error(`provider returned HTTP ${response?.status ?? "unknown"}`);
	return parseDecision(style.parse(await response.json()));
}

export function formatSummary(decision: Decision): string {
	const rationale = decision.rationale ? ` — ${decision.rationale}` : "";
	return `jev-advisor: tier=${decision.tier} confidence=${decision.confidence.toFixed(2)}${rationale}`;
}

export const ENFORCE_GUIDANCE =
	"Re-issue this task call with the recommended tier, or set JEV_ADVISOR_MODE=hint for non-blocking advisories.";

// Keyless build. Activation: ~/.gjc/agent/jev-advisor/.env or JEV_ADVISOR_API_KEY /
// OPENROUTER_API_KEY env (env wins over the file), or JEV_ADVISOR_PROVIDER=ollaya (local, no key).

// Hook adapter — legacy plugin hook running in the gjc host realm.
// Contract (verified against gjc v0.17.7 source): a plugin hook WITHOUT
// declared capabilities/networkDestinations/filesystemRoots loads as a legacy
// extension hook — sdk/session.ts:1039-1052 registers api.on("tool_call", …)
// and calls handler(event, ctx) only for the manifest target tool. The event
// is the ToolCallEvent { type, toolName, toolCallId, input }; the task tool's
// params live under event.input. Returning { block: true, reason } blocks the
// task call; any other value — including undefined — continues.
//
// Declaring capabilities would flip the hook to a "function hook", which
// v0.17.7 quarantines in every session (no capability-enforcing isolate
// runtime exists yet), so network egress is instead restricted by the core's
// endpoint origin allowlist (isAllowedEndpoint) — the same gate that guards
// the jev_advise tool.
//
// Fail-open on purpose: gjc treats hook errors as fail-closed, and an advisor
// that blocks delegation on its own failure is worse than no advisor.

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	let lastAdvisoryAt = 0;
	api.on("tool_call", async (event, ctx) => {
		try {
			const call = event as { type?: string; toolName?: string; input?: unknown } | undefined;
			if (!call || call.type !== "tool_call" || call.toolName !== "task") return undefined;
			const cfg = readConfig();
			if (!isConfigured(cfg)) return undefined;
			const extraction = extractAssignment(call.input);
			if (!extraction) return undefined;
			const now = Date.now();
			if (cfg.minIntervalMs > 0 && now - lastAdvisoryAt < cfg.minIntervalMs) return undefined;
			const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
			const decision = await askDecisionModel(cfg, extraction.text, (input, init) => fetch(input, init), signal);
			lastAdvisoryAt = Date.now();
			if (!decision) return undefined; // provider/parse failure → fail-open
			const ui = (ctx as {
				ui?: {
					notify?: (message: string, type?: "info" | "warning" | "error") => void;
					setStatus?: (key: string, text: string | undefined) => void;
				};
			} | undefined)?.ui;
			const summary = formatSummary(decision);
			try {
				ui?.setStatus?.("jev-advisor", `tier=${decision.tier} conf=${decision.confidence.toFixed(2)}`);
			} catch {}
			// Enforce blocks only when the caller under-provisioned a tier AND
			// the recommendation clears the confidence gate — never on provider
			// failure, already-compliant calls, or low-confidence advice.
			const underprovisioned = extraction.requestedTiers.some(t => tierRank(t) < tierRank(decision.tier));
			if (cfg.mode === "enforce" && decision.confidence >= cfg.minConfidence && underprovisioned) {
				// An unspecified tier never blocks: the underprovisioned test needs an
				// explicitly requested (weaker) tier to compare against.
				const requested = [...new Set(extraction.requestedTiers)].join("/");
				return {
					block: true,
					// Tier+confidence only: the model-authored rationale stays out of
					// host-visible block reasons (prompt-injection ceiling).
					reason: `jev-advisor: tier=${decision.tier} confidence=${decision.confidence.toFixed(2)}. Requested tier: ${requested}. ${ENFORCE_GUIDANCE}`,
				};
			}
			if (cfg.mode !== "shadow") {
				try {
					ui?.notify?.(summary, cfg.mode === "enforce" ? "warning" : "info");
				} catch {}
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}
