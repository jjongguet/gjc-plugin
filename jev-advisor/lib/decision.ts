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

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
	memoryMaxKeys: 200,
	memoryMaxEvents: 10,
	memoryHeadChars: 120,
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
/**
 * The evidence-memory store: `~/.gjc/agent/jev-advisor/state.json`, sibling of
 * the `.env` file (outside the installed tree, survives upgrades). Holds
 * bounded per-assignment delegation history; never leaves the machine.
 */
export function pluginStateFile(): string {
	return path.join(os.homedir(), ".gjc", "agent", "jev-advisor", "state.json");
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

/**
 * OpenRouter identifies the calling app via these headers; without them plugin
 * calls land in the account's anonymous "Unknown" app bucket on the dashboard.
 * Sent only to the OpenRouter origin, never to other targets.
 */
const ATTRIBUTION_HEADERS: Record<string, string> = {
	"http-referer": "https://github.com/jjongguet/gjc-plugin",
	"x-title": "jev-advisor",
};

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
	/** Evidence-memory kill switch (JEV_ADVISOR_MEMORY=off). Default on. */
	memoryEnabled: boolean;
	/** Evidence-memory store file (JEV_ADVISOR_STATE override; test isolation). */
	stateFile: string;
	memoryMaxKeys: number;
	memoryMaxEvents: number;
	memoryHeadChars: number;
}

type Env = Record<string, string | undefined>;

function positiveNumber(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Like positiveNumber but 0 is meaningful (e.g. HEAD_CHARS=0 → fingerprints only). */
function nonNegativeNumber(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
	const memoryRaw = String(merged.JEV_ADVISOR_MEMORY ?? "")
		.trim()
		.toLowerCase();
	return {
		provider,
		mode,
		endpoint,
		apiKey,
		model: trim(merged.JEV_ADVISOR_MODEL) || trim(PROVIDERS[provider]?.model) || DEFAULTS.model,
		timeoutMs: positiveNumber(merged.JEV_ADVISOR_TIMEOUT_MS, DEFAULTS.timeoutMs),
		minIntervalMs: Number.isFinite(intervalRaw) && intervalRaw >= 0 ? intervalRaw : DEFAULTS.minIntervalMs,
		minConfidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : DEFAULTS.minConfidence,
		memoryEnabled: memoryRaw !== "" ? memoryRaw !== "off" && memoryRaw !== "0" && memoryRaw !== "false" && memoryRaw !== "no" : true,
		stateFile: trim(merged.JEV_ADVISOR_STATE) || pluginStateFile(),
		memoryMaxKeys: nonNegativeNumber(merged.JEV_ADVISOR_MEMORY_MAX_KEYS, DEFAULTS.memoryMaxKeys),
		memoryMaxEvents: nonNegativeNumber(merged.JEV_ADVISOR_MEMORY_MAX_EVENTS, DEFAULTS.memoryMaxEvents),
		memoryHeadChars: nonNegativeNumber(merged.JEV_ADVISOR_MEMORY_HEAD_CHARS, DEFAULTS.memoryHeadChars),
	};
}

export function isConfigured(cfg: AdvisorConfig): boolean {
	if (cfg.provider === "off" || !cfg.endpoint) return false;
	if (PROVIDERS[cfg.provider]?.keyless) return true;
	return Boolean(cfg.apiKey) && Boolean(PROVIDERS[cfg.provider] || cfg.endpoint);
}

// -----------------------------------------------------------------------------
// Evidence memory — bounded local delegation history.
//
// GUARDRAIL: no module-level mutable state anywhere in this file or the
// adapters. Each generated surface (two hooks + one tool) inlines its OWN copy
// of this core, so in-memory state cannot be shared across surfaces — the
// disk store below is the ONLY cross-surface channel. A future memo/cache
// here would silently diverge across the three copies and pass single-surface
// tests. Last-writer-wins across surfaces is accepted for advisory evidence.
// -----------------------------------------------------------------------------

/** One delegation event. `pre` = advisory asked; `post` = outcome observed. */
export interface MemoryEvent {
	kind: "pre" | "post";
	t: number;
	/** pre: tiers explicitly requested by the caller, if any. */
	requested?: string[];
	/** Recommendation (pre) or re-tier advice (post); present only when the provider answered. */
	tier?: string;
	conf?: number;
	/** pre: already joined by a post event (G5 pairing). */
	joined?: boolean;
	/** post: the delegation errored. */
	error?: boolean;
	/** post: total subagent time (sum of finite positive durations) — NOT wall clock. */
	durationMs?: number;
	/** post: `t` of the joined pre event. */
	preT?: number;
}

export interface MemoryRecord {
	/** Ring buffer, oldest first, capped at memoryMaxEvents. */
	events: MemoryEvent[];
	updatedAt: number;
	/** Bounded assignment head (memoryHeadChars; empty when HEAD_CHARS=0). */
	head?: string;
}

export interface MemoryState {
	version: 1;
	keys: Record<string, MemoryRecord>;
}

function freshState(): MemoryState {
	return { version: 1, keys: {} };
}

/**
 * Deterministic assignment fingerprint: sha256 (first 16 hex chars) of the
 * trimmed, whitespace-collapsed text. Coverage: the input is exactly the
 * `extractAssignment` output (already capped at maxAssignmentChars = first
 * 4000 chars), so identical delegations collide and small edits deliberately
 * do not — identical-delegation semantics is the point (no fuzzy matching).
 */
export function fingerprint(text: string): string {
	const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Missing or corrupt store → fresh empty state (fail-open). */
export function loadState(file: string): MemoryState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			(parsed as MemoryState).version === 1 &&
			typeof (parsed as MemoryState).keys === "object" &&
			(parsed as MemoryState).keys !== null
		) {
			return parsed as MemoryState;
		}
	} catch {}
	return freshState();
}

/**
 * Enforce caps and persist atomically: write a uniquely-suffixed tmp file
 * (pid + time — the three inlined surfaces must not share a tmp inode) with
 * mode 0o600, then rename (the mode survives rename). No .tmp residue on
 * success. Throws on IO failure; callers wrap in try/catch (fail-open).
 */
export function saveState(file: string, state: MemoryState, limits: { memoryMaxKeys: number; memoryMaxEvents: number }): void {
	for (const key of Object.keys(state.keys)) {
		const record = state.keys[key];
		if (!record || !Array.isArray(record.events)) {
			delete state.keys[key];
			continue;
		}
		if (record.events.length > limits.memoryMaxEvents) {
			record.events = record.events.slice(record.events.length - limits.memoryMaxEvents);
		}
	}
	const keys = Object.keys(state.keys);
	if (keys.length > limits.memoryMaxKeys) {
		// Deterministic eviction: oldest updatedAt first, then key ascending.
		const ranked = keys.sort((a, b) => {
			const ra = state.keys[a].updatedAt ?? 0;
			const rb = state.keys[b].updatedAt ?? 0;
			return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0;
		});
		const excess = keys.length - limits.memoryMaxKeys;
		for (const key of ranked.slice(0, excess)) delete state.keys[key];
	}
	const tmp = `${file}.${(globalThis as { process?: { pid?: number } }).process?.pid ?? 0}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
	try {
		renameSync(tmp, file);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {}
		throw error;
	}
}

/** Append an event to a fingerprint's ring; refresh head and updatedAt. Mutates `state`. */
export function recordEvent(
	state: MemoryState,
	fp: string,
	head: string,
	event: MemoryEvent,
	limits: { memoryMaxEvents: number },
): void {
	const record = (state.keys[fp] ??= { events: [], updatedAt: 0 });
	record.events.push(event);
	if (record.events.length > limits.memoryMaxEvents) {
		record.events = record.events.slice(record.events.length - limits.memoryMaxEvents);
	}
	if (head) record.head = head;
	record.updatedAt = event.t;
}

/** Enrich the most recent pre of a fingerprint with the decision that answered it. Mutates `state`. */
export function enrichLastPre(state: MemoryState, fp: string, tier: string, conf: number): void {
	const events = state.keys[fp]?.events;
	if (!events) return;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].kind === "pre" && events[i].tier === undefined) {
			events[i].tier = tier;
			events[i].conf = conf;
			return;
		}
	}
}

/** Enrich the most recent post of a fingerprint with the re-tier decision. Mutates `state`. */
export function enrichLastPost(state: MemoryState, fp: string, tier: string, conf: number): void {
	const events = state.keys[fp]?.events;
	if (!events) return;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].kind === "post" && events[i].tier === undefined) {
			events[i].tier = tier;
			events[i].conf = conf;
			return;
		}
	}
}

/**
 * G5 pairing: a post joins the most recent prior same-fingerprint pre that
 * carries a recommendation and is not already joined. Unmatched posts and
 * recommendation-less pres count in calibration totals only. Mutates both.
 */
export function joinPostToPre(state: MemoryState, fp: string, post: MemoryEvent): void {
	const events = state.keys[fp]?.events;
	if (!events) return;
	for (let i = events.length - 1; i >= 0; i--) {
		const candidate = events[i];
		if (candidate.kind !== "pre" || candidate.joined || candidate.tier === undefined) continue;
		if (candidate.t > post.t) continue;
		candidate.joined = true;
		post.preT = candidate.t;
		return;
	}
}

/** Bounded assignment head; empty string when HEAD_CHARS=0 (fingerprints only). */
export function memoryHead(text: string, cfg: { memoryHeadChars: number }): string {
	return cfg.memoryHeadChars > 0 ? text.slice(0, cfg.memoryHeadChars) : "";
}

/** Number of recorded outcomes for a fingerprint (drives the `· n prior` suffix). */
export function priorPostCount(record: MemoryRecord | undefined): number {
	if (!record || !Array.isArray(record.events)) return 0;
	return record.events.filter(event => event.kind === "post").length;
}

/**
 * Prepend a bounded evidence block (hard cap 200 chars) so the decision model
 * grounds its tier recommendation in observed prior outcomes of the IDENTICAL
 * assignment. Prepended (not appended) so it survives the systemone wire
 * format's 1900-char state slice. Pass-through when there is no evidence.
 */
export function withEvidence(text: string, record: MemoryRecord | undefined): string {
	const posts = (record?.events ?? []).filter(event => event.kind === "post");
	if (posts.length === 0) return text;
	const outcomes = posts
		.map(post => {
			const duration = typeof post.durationMs === "number" && Number.isFinite(post.durationMs) && post.durationMs > 0
				? ` ${Math.round(post.durationMs / 1000)}s`
				: "";
			return `${post.tier ?? "?"}→${post.error ? "error" : "ok"}${duration}`;
		})
		.join(", ");
	const lastReTier = [...posts].reverse().find(post => post.tier !== undefined);
	const block =
		`prior outcomes (n=${posts.length}): [${outcomes}]` +
		(lastReTier ? ` last re-tier: ${lastReTier.tier}(${(lastReTier.conf ?? 0).toFixed(2)})` : "");
	return `${block.slice(0, 200)}\n${text}`;
}

export interface CalibrationSummary {
	delegations: number;
	pairs: {
		total: number;
		withRequestedTier: number;
		agreed: number;
		agreementRate: number | null;
		byTier: Record<string, { count: number; errors: number; avgDurationMs: number | null }>;
	};
	reTier: Record<string, number>;
	totalsOnly: { unmatchedPosts: number; recommendationlessPres: number };
}

/** Pure function over the store: predicted-tier-vs-outcome statistics for `jev_advise report="calibration"`. */
export function calibrationSummary(state: MemoryState): { json: CalibrationSummary; text: string } {
	const summary: CalibrationSummary = {
		delegations: 0,
		pairs: { total: 0, withRequestedTier: 0, agreed: 0, agreementRate: null, byTier: {} },
		reTier: {},
		totalsOnly: { unmatchedPosts: 0, recommendationlessPres: 0 },
	};
	for (const record of Object.values(state.keys)) {
		for (const event of record.events ?? []) {
			if (event.kind !== "pre") continue;
			summary.delegations += 1;
			const post = (record.events ?? []).find(candidate => candidate.kind === "post" && candidate.preT === event.t);
			if (event.tier === undefined || !post) {
				if (event.tier === undefined) summary.totalsOnly.recommendationlessPres += 1;
				continue;
			}
			summary.pairs.total += 1;
			if (event.requested?.length) {
				summary.pairs.withRequestedTier += 1;
				if (event.requested.includes(event.tier)) summary.pairs.agreed += 1;
			}
			const tier = summary.pairs.byTier[event.tier] ?? (summary.pairs.byTier[event.tier] = { count: 0, errors: 0, avgDurationMs: null });
			tier.count += 1;
			if (post.error) tier.errors += 1;
			if (typeof post.durationMs === "number" && Number.isFinite(post.durationMs) && post.durationMs > 0) {
				tier.avgDurationMs = (tier.avgDurationMs ?? 0) + post.durationMs;
			}
		}
		for (const event of record.events ?? []) {
			if (event.kind !== "post") continue;
			if (event.tier !== undefined) summary.reTier[event.tier] = (summary.reTier[event.tier] ?? 0) + 1;
			if (event.preT === undefined) summary.totalsOnly.unmatchedPosts += 1;
		}
	}
	for (const tier of Object.values(summary.pairs.byTier)) {
		if (tier.avgDurationMs !== null) tier.avgDurationMs = Math.round(tier.avgDurationMs / tier.count);
	}
	summary.pairs.agreementRate = summary.pairs.withRequestedTier > 0 ? summary.pairs.agreed / summary.pairs.withRequestedTier : null;
	const lines = [
		`jev-advisor calibration (local store)`,
		`delegations recorded: ${summary.delegations}`,
		`matched pairs: ${summary.pairs.total}` +
			(summary.pairs.agreementRate !== null
				? `, requested-vs-recommended agreement: ${summary.pairs.agreed}/${summary.pairs.withRequestedTier} (${Math.round(summary.pairs.agreementRate * 100)}%)`
				: ""),
	];
	for (const [tier, stats] of Object.entries(summary.pairs.byTier)) {
		lines.push(
			`  ${tier}: ${stats.count} run${stats.count === 1 ? "" : "s"}, ${stats.errors} error${stats.errors === 1 ? "" : "s"}` +
				(stats.avgDurationMs !== null ? `, avg total subagent time ${Math.round(stats.avgDurationMs / 1000)}s` : ""),
		);
	}
	const reTierEntries = Object.entries(summary.reTier);
	if (reTierEntries.length) lines.push(`re-tier advice: ${reTierEntries.map(([tier, n]) => `${tier}×${n}`).join(", ")}`);
	lines.push(
		`totals only: ${summary.totalsOnly.unmatchedPosts} unmatched outcome${summary.totalsOnly.unmatchedPosts === 1 ? "" : "s"}, ${summary.totalsOnly.recommendationlessPres} advisory call${summary.totalsOnly.recommendationlessPres === 1 ? "" : "s"} without a recommendation`,
	);
	return { json: summary, text: lines.join("\n") };
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
	const headers =
		new URL(url).origin === "https://openrouter.ai" ? { ...wire.headers, ...ATTRIBUTION_HEADERS } : wire.headers;
	const response = await fetchImpl(url, {
		method: "POST",
		// The origin gate covers exactly this URL; redirects would re-send the
		// assignment body off-origin, so refuse them instead of following.
		redirect: "error",
		headers,
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
