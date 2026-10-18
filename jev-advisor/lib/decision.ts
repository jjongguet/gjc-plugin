/**
 * jev-advisor shared source. scripts/build.mjs inlines this file into the
 * generated hook and tool surfaces; edit this source, never the generated files.
 */

import {
	closeSync,
	constants as fsConstants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pluginResultsRoot, readPluginOutcomeSnapshot } from "../../shared/lib/results";

export const TIERS = ["fast", "balanced", "strong"] as const;
export type Tier = (typeof TIERS)[number];
export type ConfidenceKind = "provider_choice" | "self_reported";

export type NoDecisionReason =
	| "invalid_task"
	| "unsupported_input"
	| "input_too_large"
	| "batch_limit"
	| "disabled"
	| "unconfigured"
	| "invalid_endpoint"
	| "rate_limited"
	| "budget_exceeded"
	| "already_pending"
	| "timeout"
	| "aborted"
	| "provider_error"
	| "invalid_response";

export type Advice =
	| {
			status: "decision";
			tier: Tier;
			confidence: number;
			probabilities?: Record<Tier, number>;
			confidenceKind: ConfidenceKind;
			rationale?: string;
	  }
	| { status: "no_decision"; reason: NoDecisionReason; httpStatus?: number };

export const CHECK_VERDICTS = ["correct", "incorrect", "unsure"] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

export type CheckAdvice =
	| {
			status: "decision";
			verdict: CheckVerdict;
			confidence: number;
			probabilities?: Record<CheckVerdict, number>;
			confidenceKind: ConfidenceKind;
			rationale?: string;
	  }
	| { status: "no_decision"; reason: NoDecisionReason; httpStatus?: number };

export interface CheckInput {
	question: string;
	artifact: string;
}

export const DEFAULTS = {
	model: "typesafe/jev-1.13",
	timeoutMs: 8000,
	minIntervalMs: 15000,
	minConfidence: 0.6,
	memoryMaxKeys: 200,
	memoryMaxEvents: 10,
} as const;

export const MAX_TASKS_PER_INVOCATION = 32;
export const MAX_PROVIDER_REQUESTS_PER_INVOCATION = 4;
export const INVOCATION_BUDGET_MS = 8000;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_GROUPS = 200;
const MAX_TASKS_PER_GROUP = 10;
const MAX_RETAINED_RECORDS = 2000;
const MAX_LOCK_WAIT_MS = 100;
const MAX_ID_CHARS = 512;

export interface TaskInput {
	index: number;
	callerId: string | null;
	requestedTier: Tier | null;
	fingerprint: string;
	prompt: string;
	complete: boolean;
}

export interface Extraction {
	tasks: TaskInput[];
	rejected: { index: number; reason: NoDecisionReason }[];
	omittedCount: number;
}

export interface DecisionConfig {
	provider: string;
	mode: AdvisorMode;
	endpoint: string;
	apiKey: string;
	model: string;
	timeoutMs: number;
	minIntervalMs: number;
	minConfidence: number;
	memoryEnabled: boolean;
	stateFile: string;
	stateOverrideIgnored: boolean;
	memoryMaxKeys: number;
	memoryMaxEvents: number;
}
export type AdvisorConfig = DecisionConfig;
export type AdvisorMode = "shadow" | "hint" | "enforce";
type Env = Record<string, string | undefined>;

export function tierRank(tier: string): number {
	const index = TIERS.indexOf(String(tier ?? "").trim().toLowerCase() as Tier);
	return index < 0 ? 1 : index;
}

export function pluginEnvFile(): string {
	return path.join(os.homedir(), ".gjc", "agent", "jev-advisor", ".env");
}

/** Result-state base; the v2 store is derived without reading or migrating legacy data. */
export function pluginStateFile(): string {
	return path.join(pluginResultsRoot(), "jev-advisor", "state.json");
}

export function version2StateFile(base: string): string {
	const resolved = path.resolve(base);
	const extension = path.extname(resolved);
	return extension
		? `${resolved.slice(0, -extension.length)}.v2${extension}`
		: `${resolved}.v2`;
}

function loadPluginEnv(): Env {
	try {
		return parseEnvFile(readFileSync(pluginEnvFile(), "utf8"));
	} catch {
		return {};
	}
}

const CHECK_CRITERIA: Record<CheckVerdict, string> = {
	correct: "The artifact satisfies the stated check question",
	incorrect: "The artifact does not satisfy the stated check question",
	unsure: "The available information is insufficient to judge",
};

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
					max_tokens: 2048,
					messages: [
						{
							role: "system",
							content:
								"You are a delegation-effort advisor for a coding agent. Given one complete subagent task assignment, decide how much model effort it warrants. " +
								'Reply with ONLY JSON: {"tier":"fast"|"balanced"|"strong","confidence":<number from 0 to 1>,"rationale":"<max 120 chars>"}. ' +
								"fast = mechanical or small measured edits; balanced = default implementation work; strong = multi-file reasoning, architecture decisions, or high blast radius.",
						},
						{ role: "user", content: assignment },
					],
				}),
			};
		},
		checkRequest(cfg: { model: string; apiKey: string }, check: CheckInput) {
			return {
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${cfg.apiKey}`,
				},
				body: JSON.stringify({
					model: cfg.model,
					temperature: 0,
					max_tokens: 2048,
					messages: [
						{
							role: "system",
							content:
								"You are a checking assistant for a coding agent. Given one check question and one artifact, decide whether the artifact satisfies the question. " +
								'Reply with ONLY JSON: {"verdict":"correct"|"incorrect"|"unsure","confidence":<number from 0 to 1>,"rationale":"<max 120 chars>"}. ' +
								"correct = the artifact satisfies the stated check; incorrect = it does not; unsure = the available information is insufficient to judge.",
						},
						{ role: "user", content: composeCheckPrompt(check) },
					],
				}),
			};
		},
	},
	systemone: {
		request(cfg: { model: string; apiKey: string }, assignment: string) {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
			return {
				headers,
				body: JSON.stringify({
					model: cfg.model,
					state: assignment,
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
		checkRequest(cfg: { model: string; apiKey: string }, check: CheckInput) {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
			return {
				headers,
				body: JSON.stringify({
					model: cfg.model,
					state: check.artifact,
					questions: {
						check: {
							type: "choice",
							instructions: check.question,
							criteria: CHECK_CRITERIA,
						},
					},
				}),
			};
		},
	},
} as const;

export const PROVIDERS: Record<
	string,
	{ endpoint: string; style: keyof typeof REQUEST_STYLES; keyless?: boolean; model?: string }
> = {
	jev: { endpoint: "https://openrouter.ai/api/alpha/decisions", style: "systemone", model: "typesafe/jev-1.13" },
	openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", style: "openai-chat", model: "openai/gpt-5-mini" },
	"typesafe-jev": { endpoint: "https://api.typesafe.ai/v1/systemone", style: "systemone", model: "jev-latest" },
	ollaya: { endpoint: "http://127.0.0.1:11435/v1/systemone", style: "systemone", keyless: true, model: "laya" },
};

const ALLOWED_ORIGINS = new Set(["https://openrouter.ai", "https://api.typesafe.ai"]);
const ATTRIBUTION_HEADERS: Record<string, string> = {
	"http-referer": "https://github.com/jjongguet/gjc-plugin",
	"x-title": "jev-advisor",
};
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isAllowedEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		if (url.username || url.password) return false;
		if (url.protocol === "https:") return ALLOWED_ORIGINS.has(url.origin);
		if (url.protocol === "http:")
			return LOOPBACK_HOSTS.has(url.hostname) && url.username === "" && url.password === "";
		return false;
	} catch {
		return false;
	}
}

export function providerPromptLimit(cfg: Pick<AdvisorConfig, "provider">): 1900 | 4000 {
	return cfg.provider === "ollaya" ? 1900 : 4000;
}

function nonNegativeInteger(raw: string | undefined, fallback: number, cap: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0
		? Math.min(parsed, cap)
		: fallback;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
	const merged: Env = { ...fileEnv };
	for (const [key, value] of Object.entries(env)) if (value !== undefined) merged[key] = value;
	const provider = String(merged.JEV_ADVISOR_PROVIDER ?? "jev").trim().toLowerCase();
	const modeRaw = String(merged.JEV_ADVISOR_MODE ?? "shadow").trim().toLowerCase();
	const mode: AdvisorMode = modeRaw === "hint" || modeRaw === "enforce" ? modeRaw : "shadow";
	const trim = (value: unknown) => (typeof value === "string" ? value.trim() : "");
	const intervalRaw = Number(merged.JEV_ADVISOR_MIN_INTERVAL_MS);
	const confidenceRaw = Number(merged.JEV_ADVISOR_MIN_CONFIDENCE);
	const memoryRaw = String(merged.JEV_ADVISOR_MEMORY ?? "").trim().toLowerCase();
	return {
		provider,
		mode,
		endpoint: trim(merged.JEV_ADVISOR_ENDPOINT) || trim(PROVIDERS[provider]?.endpoint),
		apiKey: trim(merged.JEV_ADVISOR_API_KEY) || trim(merged.OPENROUTER_API_KEY),
		model: trim(merged.JEV_ADVISOR_MODEL) || trim(PROVIDERS[provider]?.model) || DEFAULTS.model,
		timeoutMs: Math.min(positiveNumber(merged.JEV_ADVISOR_TIMEOUT_MS, DEFAULTS.timeoutMs), INVOCATION_BUDGET_MS),
		minIntervalMs: Number.isFinite(intervalRaw) && intervalRaw >= 0 ? intervalRaw : DEFAULTS.minIntervalMs,
		minConfidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : DEFAULTS.minConfidence,
		memoryEnabled:
			memoryRaw === "" || !(memoryRaw === "off" || memoryRaw === "0" || memoryRaw === "false" || memoryRaw === "no"),
		stateFile: pluginStateFile(),
		stateOverrideIgnored: Boolean(trim(merged.JEV_ADVISOR_STATE)),
		memoryMaxKeys: nonNegativeInteger(merged.JEV_ADVISOR_MEMORY_MAX_KEYS, DEFAULTS.memoryMaxKeys, MAX_GROUPS),
		memoryMaxEvents: nonNegativeInteger(merged.JEV_ADVISOR_MEMORY_MAX_EVENTS, DEFAULTS.memoryMaxEvents, MAX_TASKS_PER_GROUP),
	};
}

export function isConfigured(cfg: AdvisorConfig): boolean {
	if (cfg.provider === "off" || !cfg.endpoint) return false;
	if (PROVIDERS[cfg.provider]?.keyless) return true;
	return Boolean(cfg.apiKey) && Boolean(PROVIDERS[cfg.provider] || cfg.endpoint);
}

function normalizeField(value: string): string {
	return value.replace(/\r\n?/g, "\n").trim();
}

function validTier(value: unknown): Tier | null {
	if (typeof value !== "string") return null;
	const tier = value.trim().toLowerCase();
	return TIERS.includes(tier as Tier) ? (tier as Tier) : null;
}

function boundedIdentity(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_ID_CHARS || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
	return normalized;
}

export function fingerprint(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Normalize a supported task batch without aggregating children or truncating
 * provider input. Rejected and omitted entries remain explicit coverage data.
 */
export function extractTasks(input: unknown, maxPromptChars: 1900 | 4000): Extraction {
	const rejected: Extraction["rejected"] = [];
	if (!isRecord(input) || !Array.isArray(input.tasks)) {
		return { tasks: [], rejected: [{ index: -1, reason: "unsupported_input" }], omittedCount: 0 };
	}
	const original = input.tasks as unknown[];
	const boundedCount = Math.min(original.length, MAX_TASKS_PER_INVOCATION);
	const omittedCount = Math.max(0, original.length - boundedCount);
	const agentRaw = Object.prototype.hasOwnProperty.call(input, "agent") ? input.agent : input.role;
	const sharedRaw = input.context;
	const sharedMalformed =
		(Object.prototype.hasOwnProperty.call(input, "agent") && typeof input.agent !== "string") ||
		(Object.prototype.hasOwnProperty.call(input, "role") && typeof input.role !== "string") ||
		(Object.prototype.hasOwnProperty.call(input, "context") && typeof sharedRaw !== "string");
	const role = typeof agentRaw === "string" ? normalizeField(agentRaw) : "";
	const sharedContext = typeof sharedRaw === "string" ? normalizeField(sharedRaw) : "";
	const tasks: TaskInput[] = [];
	for (let index = 0; index < boundedCount; index++) {
		const raw = original[index];
		if (!isRecord(raw) || sharedMalformed) {
			rejected.push({ index, reason: "invalid_task" });
			continue;
		}
		const badDescription = Object.prototype.hasOwnProperty.call(raw, "description") && typeof raw.description !== "string";
		const badAssignment = Object.prototype.hasOwnProperty.call(raw, "assignment") && typeof raw.assignment !== "string";
		if (badDescription || badAssignment) {
			rejected.push({ index, reason: "invalid_task" });
			continue;
		}
		const description = typeof raw.description === "string" ? normalizeField(raw.description) : "";
		const assignment = typeof raw.assignment === "string" ? normalizeField(raw.assignment) : "";
		if (!description && !assignment) {
			rejected.push({ index, reason: "invalid_task" });
			continue;
		}
		const canonical = JSON.stringify({ role, description, assignment, sharedContext });
		const promptParts: string[] = [];
		if (role) promptParts.push(`role:\n${role}`);
		if (sharedContext) promptParts.push(`shared context:\n${sharedContext}`);
		if (description) promptParts.push(`task description:\n${description}`);
		if (assignment) promptParts.push(`task assignment:\n${assignment}`);
		const prompt = promptParts.join("\n\n");
		const callerId = boundedIdentity(raw.id);
		tasks.push({
			index,
			callerId,
			requestedTier: validTier(raw.tier),
			fingerprint: fingerprint(canonical),
			prompt,
			complete: prompt.length <= maxPromptChars,
		});
	}
	return { tasks, rejected, omittedCount };
}

export function composeCheckPrompt(check: CheckInput): string {
	return `check question:\n${check.question}\n\nartifact:\n${check.artifact}`;
}

export type CheckPreparation =
	| { status: "ok"; check: CheckInput }
	| { status: "invalid_task" }
	| { status: "input_too_large" };

/**
 * Normalize one check request without truncating either field. The composed
 * prompt is the admission unit, mirroring the tier path's full-prompt bound.
 */
export function prepareCheck(question: unknown, artifact: unknown, maxPromptChars: 1900 | 4000): CheckPreparation {
	if (typeof question !== "string" || typeof artifact !== "string") return { status: "invalid_task" };
	const normalizedQuestion = normalizeField(question);
	const normalizedArtifact = normalizeField(artifact);
	if (!normalizedQuestion || !normalizedArtifact) return { status: "invalid_task" };
	const check: CheckInput = { question: normalizedQuestion, artifact: normalizedArtifact };
	return composeCheckPrompt(check).length <= maxPromptChars ? { status: "ok", check } : { status: "input_too_large" };
}

export interface TaskRef {
	sessionId: string;
	toolCallId: string;
	taskIndex: number;
}
export interface JobRef {
	sessionId: string;
	jobId: string;
}
export type TerminalStatus = "completed" | "failed" | "cancelled";

export function taskRefKey(ref: TaskRef): string | null {
	const sessionId = boundedIdentity(ref?.sessionId);
	const toolCallId = boundedIdentity(ref?.toolCallId);
	if (!sessionId || !toolCallId || !Number.isInteger(ref.taskIndex) || ref.taskIndex < 0 || ref.taskIndex >= MAX_TASKS_PER_INVOCATION) {
		return null;
	}
	return JSON.stringify([sessionId, toolCallId, ref.taskIndex]);
}

export function jobRefKey(ref: JobRef): string | null {
	const sessionId = boundedIdentity(ref?.sessionId);
	const jobId = boundedIdentity(ref?.jobId);
	return sessionId && jobId ? JSON.stringify([sessionId, jobId]) : null;
}

export interface StoredDecision {
	status: "decision";
	tier: Tier;
	confidence: number;
	probabilities?: Record<Tier, number>;
	confidenceKind: ConfidenceKind;
}
export type StoredAdvice = StoredDecision | Extract<Advice, { status: "no_decision" }>;
export type LaunchDisposition = "not_observed" | "observed" | "blocked";
export interface TaskRecord {
	ref: TaskRef;
	fingerprint: string;
	callerId: string | null;
	requestedTier: Tier | null;
	requestToken: string;
	advice: StoredAdvice | null;
	createdAt: number;
	updatedAt: number;
	launchDisposition: LaunchDisposition;
	jobKey: string | null;
	conflicts: string[];
}
export interface TaskGroup {
	updatedAt: number;
	tasks: Record<string, TaskRecord>;
}
export interface JobRecord {
	ref: JobRef;
	childId?: string;
	status: TerminalStatus;
	statusObservations: TerminalStatus[];
	durationMs?: number;
	durationObservations: number[];
	requestedModel?: string;
	requestedModelObservations: string[];
	effectiveModel?: string;
	effectiveModelObservations: string[];
	allocatedChildIds: string[];
	actualTier: Tier | null;
	observedAt: number;
	taskKey: string | null;
	conflicts: string[];
}
export interface EvidenceV2 {
	version: 2;
	groups: Record<string, TaskGroup>;
	jobs: Record<string, JobRecord>;
}
export interface StoreLimits {
	memoryMaxKeys: number;
	memoryMaxEvents: number;
}
export type StoreUnavailableReason =
	| "locked"
	| "corrupt"
	| "unsupported_version"
	| "oversized"
	| "unsafe_path"
	| "io_error";
export type StoreResult<T> =
	| { status: "ok"; value: T }
	| { status: "unavailable"; reason: StoreUnavailableReason };
export type StoreReadResult =
	| { status: "ok"; value: EvidenceV2 }
	| { status: "missing" }
	| { status: "unavailable"; reason: StoreUnavailableReason };

export function storeLimits(cfg: Pick<AdvisorConfig, "memoryMaxKeys" | "memoryMaxEvents">): StoreLimits {
	const keys = Number.isInteger(cfg.memoryMaxKeys) && cfg.memoryMaxKeys >= 0 ? Math.min(cfg.memoryMaxKeys, MAX_GROUPS) : DEFAULTS.memoryMaxKeys;
	const events = Number.isInteger(cfg.memoryMaxEvents) && cfg.memoryMaxEvents >= 0 ? Math.min(cfg.memoryMaxEvents, MAX_TASKS_PER_GROUP) : DEFAULTS.memoryMaxEvents;
	return { memoryMaxKeys: keys, memoryMaxEvents: events };
}

export function emptyEvidenceV2(): EvidenceV2 {
	return { version: 2, groups: {}, jobs: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(record).every(key => allowed.includes(key));
}

function validTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validProbabilityRecord(value: unknown): value is Record<Tier, number> {
	if (!isRecord(value) || Object.keys(value).length !== TIERS.length || !TIERS.every(tier => Object.prototype.hasOwnProperty.call(value, tier))) return false;
	const values = TIERS.map(tier => value[tier]);
	if (!values.every(number => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1)) return false;
	const sum = (values as number[]).reduce((a, b) => a + b, 0);
	return Math.abs(sum - 1) <= 0.001 + 1e-9;
}

function validateStoredAdvice(value: unknown): value is StoredAdvice {
	if (!isRecord(value)) return false;
	if (value.status === "no_decision") {
		const allowed = ["status", "reason", "httpStatus"];
		return hasOnlyKeys(value, allowed) && typeof value.reason === "string" && isNoDecisionReason(value.reason) &&
			(value.httpStatus === undefined || (typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599));
	}
	if (value.status !== "decision" || !validTier(value.tier) || typeof value.confidence !== "number" ||
		!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
		(value.confidenceKind !== "provider_choice" && value.confidenceKind !== "self_reported")) return false;
		if (!hasOnlyKeys(value, ["status", "tier", "confidence", "probabilities", "confidenceKind"])) return false;
	return value.probabilities === undefined || validProbabilityRecord(value.probabilities);
}

function isNoDecisionReason(value: string): value is NoDecisionReason {
	return [
		"invalid_task", "unsupported_input", "input_too_large", "batch_limit", "disabled", "unconfigured",
		"invalid_endpoint", "rate_limited", "budget_exceeded", "already_pending", "timeout", "aborted",
		"provider_error", "invalid_response",
	].includes(value);
}

function validTaskRef(value: unknown): value is TaskRef {
	if (!isRecord(value) || !hasOnlyKeys(value, ["sessionId", "toolCallId", "taskIndex"])) return false;
	return boundedIdentity(value.sessionId) !== null && boundedIdentity(value.toolCallId) !== null &&
		Number.isInteger(value.taskIndex) && Number(value.taskIndex) >= 0 && Number(value.taskIndex) < MAX_TASKS_PER_INVOCATION;
}

function validJobRef(value: unknown): value is JobRef {
	return isRecord(value) && hasOnlyKeys(value, ["sessionId", "jobId"]) &&
		boundedIdentity(value.sessionId) !== null && boundedIdentity(value.jobId) !== null;
}

function validStringArray(value: unknown, maxCount: number, maxLength: number): value is string[] {
	return Array.isArray(value) && value.length <= maxCount && value.every(item => typeof item === "string" && item.length <= maxLength && item.trim() === item);
}

const CONFLICT_FLAGS = new Set([
	"identity_input_conflict",
	"launch_mapping_evicted",
	"multiple_job_associations",
	"actual_tier_conflict",
	"multiple_task_associations",
	"status_conflict",
	"duration_conflict",
	"requested_model_conflict",
	"effective_model_conflict",
	"child_id_conflict",
	"stale_job_mapping",
]);

function validConflictArray(value: unknown): value is string[] {
	return validStringArray(value, 8, 64) && value.every(flag => CONFLICT_FLAGS.has(flag));
}

function validJobKeyForSession(value: unknown, sessionId: string): value is string {
	if (typeof value !== "string") return false;
	try {
		const tuple: unknown = JSON.parse(value);
		return Array.isArray(tuple) && tuple.length === 2 && tuple[0] === sessionId &&
			boundedIdentity(tuple[1]) !== null && jobRefKey({ sessionId, jobId: tuple[1] as string }) === value;
	} catch {
		return false;
	}
}

function validateStore(value: unknown): value is EvidenceV2 {
	if (!isRecord(value) || value.version !== 2 || !hasOnlyKeys(value, ["version", "groups", "jobs"]) || !isRecord(value.groups) || !isRecord(value.jobs)) return false;
	const seenTasks = new Set<string>();
	for (const [fingerprintKey, rawGroup] of Object.entries(value.groups)) {
		if (!/^[0-9a-f]{64}$/.test(fingerprintKey) || !isRecord(rawGroup) || !hasOnlyKeys(rawGroup, ["updatedAt", "tasks"]) ||
			!validTime(rawGroup.updatedAt) || !isRecord(rawGroup.tasks)) return false;
		for (const [key, rawTask] of Object.entries(rawGroup.tasks)) {
			if (!isRecord(rawTask) || !hasOnlyKeys(rawTask, ["ref", "fingerprint", "callerId", "requestedTier", "requestToken", "advice", "createdAt", "updatedAt", "launchDisposition", "jobKey", "conflicts"])) return false;
			if (!validTaskRef(rawTask.ref) || taskRefKey(rawTask.ref) !== key || rawTask.fingerprint !== fingerprintKey ||
				(rawTask.callerId !== null && boundedIdentity(rawTask.callerId) === null) ||
				(rawTask.requestedTier !== null && !validTier(rawTask.requestedTier)) ||
				typeof rawTask.requestToken !== "string" || !/^[0-9a-f-]{36}$/i.test(rawTask.requestToken) ||
				(rawTask.advice !== null && !validateStoredAdvice(rawTask.advice)) || !validTime(rawTask.createdAt) || !validTime(rawTask.updatedAt) ||
				!(["not_observed", "observed", "blocked"] as unknown[]).includes(rawTask.launchDisposition) ||
				(rawTask.jobKey !== null && !validJobKeyForSession(rawTask.jobKey, rawTask.ref.sessionId)) || !validConflictArray(rawTask.conflicts)) return false;
			if (seenTasks.has(key)) return false;
			seenTasks.add(key);
		}
	}
	for (const [key, rawJob] of Object.entries(value.jobs)) {
		if (!isRecord(rawJob) || !hasOnlyKeys(rawJob, ["ref", "childId", "status", "statusObservations", "durationMs", "durationObservations", "requestedModel", "requestedModelObservations", "effectiveModel", "effectiveModelObservations", "allocatedChildIds", "actualTier", "observedAt", "taskKey", "conflicts"])) return false;
		if (!validJobRef(rawJob.ref) || jobRefKey(rawJob.ref) !== key ||
			!(["completed", "failed", "cancelled"] as unknown[]).includes(rawJob.status) ||
			!Array.isArray(rawJob.statusObservations) || rawJob.statusObservations.length < 1 || rawJob.statusObservations.length > 3 ||
			!rawJob.statusObservations.every(status => ["completed", "failed", "cancelled"].includes(String(status))) ||
			(rawJob.durationMs !== undefined && !(typeof rawJob.durationMs === "number" && Number.isFinite(rawJob.durationMs) && rawJob.durationMs > 0)) ||
			!Array.isArray(rawJob.durationObservations) || rawJob.durationObservations.length > 4 ||
			!rawJob.durationObservations.every(duration => typeof duration === "number" && Number.isFinite(duration) && duration > 0) ||
			(rawJob.requestedModel !== undefined && (typeof rawJob.requestedModel !== "string" || rawJob.requestedModel.length > 128)) ||
			(rawJob.effectiveModel !== undefined && (typeof rawJob.effectiveModel !== "string" || rawJob.effectiveModel.length > 128)) ||
			!validStringArray(rawJob.requestedModelObservations, 4, 128) || !validStringArray(rawJob.effectiveModelObservations, 4, 128) ||
			!validStringArray(rawJob.allocatedChildIds, 4, MAX_ID_CHARS) || (rawJob.actualTier !== null && !validTier(rawJob.actualTier)) || !validTime(rawJob.observedAt) ||
			(rawJob.childId !== undefined && boundedIdentity(rawJob.childId) === null) ||
			(rawJob.taskKey !== null && typeof rawJob.taskKey !== "string") || !validConflictArray(rawJob.conflicts)) return false;
	}
	const tasksByKey = new Map<string, TaskRecord>();
	for (const group of Object.values(value.groups)) {
		for (const [key, task] of Object.entries(group.tasks)) tasksByKey.set(key, task);
	}
	for (const [jobKey, job] of Object.entries(value.jobs)) {
		if (job.taskKey === null) continue;
		const task = tasksByKey.get(job.taskKey);
		if (!task || task.ref.sessionId !== job.ref.sessionId || task.jobKey !== jobKey) return false;
	}
	return true;
}

function normalizeLimits(limits: StoreLimits): { groups: number; perGroup: number; total: number } {
	const groups = Number.isInteger(limits.memoryMaxKeys) && limits.memoryMaxKeys >= 0 ? Math.min(limits.memoryMaxKeys, MAX_GROUPS) : DEFAULTS.memoryMaxKeys;
	const perGroup = Number.isInteger(limits.memoryMaxEvents) && limits.memoryMaxEvents >= 0 ? Math.min(limits.memoryMaxEvents, MAX_TASKS_PER_GROUP) : DEFAULTS.memoryMaxEvents;
	return { groups, perGroup, total: Math.min(groups * perGroup, MAX_RETAINED_RECORDS) };
}

function appendConflict(conflicts: string[], flag: string): void {
	if (!conflicts.includes(flag) && conflicts.length < 8) conflicts.push(flag);
}

function clearTaskAssociations(state: EvidenceV2, removedKey: string): void {
	for (const job of Object.values(state.jobs)) {
		if (job.taskKey === removedKey) {
			job.taskKey = null;
			appendConflict(job.conflicts, "launch_mapping_evicted");
		}
	}
}

function deleteTask(state: EvidenceV2, groupKey: string, key: string): void {
	const group = state.groups[groupKey];
	if (!group || !group.tasks[key]) return;
	delete group.tasks[key];
	clearTaskAssociations(state, key);
	if (Object.keys(group.tasks).length === 0) delete state.groups[groupKey];
}

function encodedBytes(state: EvidenceV2): number {
	return Buffer.byteLength(JSON.stringify(state), "utf8");
}

function capStore(state: EvidenceV2, limits: StoreLimits): boolean {
	const cap = normalizeLimits(limits);
	for (const [groupKey, group] of Object.entries(state.groups)) {
		const taskEntries = Object.entries(group.tasks);
		taskEntries.sort(([keyA, a], [keyB, b]) => a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : keyA.localeCompare(keyB));
		for (const [key] of taskEntries.slice(0, Math.max(0, taskEntries.length - cap.perGroup))) deleteTask(state, groupKey, key);
	}
	let groupKeys = Object.keys(state.groups);
	groupKeys.sort((a, b) => state.groups[a].updatedAt !== state.groups[b].updatedAt ? state.groups[a].updatedAt - state.groups[b].updatedAt : a.localeCompare(b));
	for (const key of groupKeys.slice(0, Math.max(0, groupKeys.length - cap.groups))) {
		for (const taskKey of Object.keys(state.groups[key]?.tasks ?? {})) clearTaskAssociations(state, taskKey);
		delete state.groups[key];
	}
	const allTasks = () => Object.entries(state.groups).flatMap(([groupKey, group]) => Object.entries(group.tasks).map(([key, task]) => ({ groupKey, key, time: task.createdAt })));
	let tasks = allTasks();
	tasks.sort((a, b) => a.time !== b.time ? a.time - b.time : a.key.localeCompare(b.key));
	for (const entry of tasks.slice(0, Math.max(0, tasks.length - cap.total))) deleteTask(state, entry.groupKey, entry.key);
	const jobLimit = cap.total;
	const jobs = Object.entries(state.jobs).sort(([keyA, a], [keyB, b]) => a.observedAt !== b.observedAt ? a.observedAt - b.observedAt : keyA.localeCompare(keyB));
	for (const [key] of jobs.slice(0, Math.max(0, jobs.length - jobLimit))) delete state.jobs[key];
	while (encodedBytes(state) > MAX_STORE_BYTES) {
		const candidates: Array<{ kind: "task" | "job"; groupKey?: string; key: string; time: number }> = [];
		for (const [groupKey, group] of Object.entries(state.groups)) {
			for (const [key, task] of Object.entries(group.tasks)) candidates.push({ kind: "task", groupKey, key, time: task.createdAt });
		}
		for (const [key, job] of Object.entries(state.jobs)) candidates.push({ kind: "job", key, time: job.observedAt });
		if (!candidates.length) return false;
		candidates.sort((a, b) => a.time !== b.time ? a.time - b.time : a.key.localeCompare(b.key) || a.kind.localeCompare(b.kind));
		const oldest = candidates[0];
		if (oldest.kind === "task") deleteTask(state, oldest.groupKey!, oldest.key);
		else delete state.jobs[oldest.key];
	}
	return true;
}

function statePath(file: string): { file: string; directory: string; lock: string } | null {
	if (typeof file !== "string" || !file.trim()) return null;
	const resolved = path.resolve(file);
	const basename = path.basename(resolved);
	if (!basename || basename === "." || basename === "..") return null;
	return { file: resolved, directory: path.dirname(resolved), lock: `${resolved}.lock` };
}

function isMissingError(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

type StateDirectoryIdentity = { path: string; dev: number; ino: number };

type StateFileMetadata = {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	uid: number;
	mode: number;
	nlink: number;
};

function sameStateFileMetadata(a: StateFileMetadata, b: StateFileMetadata): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink;
}

function verifyStateDirectory(directory: string, create: boolean, expected?: StateDirectoryIdentity[]): StateDirectoryIdentity[] {
	const absolute = path.resolve(directory);
	let current = path.parse(absolute).root;
	let pluginOwned = false;
	const identities: StateDirectoryIdentity[] = [];
	for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		pluginOwned ||= part === ".gjc-plugin";
		let created = false;
		try { lstatSync(current); } catch (error) {
			if (!create || !isMissingError(error)) throw error;
			mkdirSync(current, { mode: 0o700 });
			created = true;
		}
		const info = lstatSync(current);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe_path");
		if ((created || pluginOwned || current === absolute) && (info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)) throw new Error("unsafe_path");
		const fd = openSync(current, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
		try {
			const opened = fstatSync(fd);
			if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("unsafe_path");
		} finally { closeSync(fd); }
		identities.push({ path: current, dev: info.dev, ino: info.ino });
	}
	if (expected && (identities.length !== expected.length || identities.some((identity, index) => identity.path !== expected[index].path || identity.dev !== expected[index].dev || identity.ino !== expected[index].ino))) throw new Error("unsafe_path");
	return identities;
}

function readStoreFile(file: string): StoreReadResult {
	let fd: number | undefined;
	try {
		let info: ReturnType<typeof lstatSync>;
		try {
			info = lstatSync(file);
		} catch (error) {
			if (isMissingError(error)) return { status: "missing" };
			throw error;
		}
		if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) return { status: "unavailable", reason: "unsafe_path" };
		if ((info.mode & 0o7777) !== 0o600) return { status: "unavailable", reason: "unsafe_path" };
		if (info.size > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
		const noFollow = fsConstants.O_NOFOLLOW ?? 0;
		fd = openSync(file, fsConstants.O_RDONLY | noFollow);
		const opened = fstatSync(fd);
		if (!opened.isFile() || !sameStateFileMetadata(info, opened) || opened.nlink !== 1 || opened.uid !== process.getuid?.() || (opened.mode & 0o7777) !== 0o600) return { status: "unavailable", reason: "unsafe_path" };
		if (opened.size > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
		// Bounded descriptor read: at most MAX_STORE_BYTES plus one overflow-
		// detection byte are consumed before any decode or unbounded allocation.
		// A pre-read size check alone is insufficient when the file grows between
		// stat and read; growth is caught at the descriptor read itself and still
		// yields the existing oversized result before any decode of excess bytes.
		const bounded = new Uint8Array(MAX_STORE_BYTES + 1);
		let total = 0;
		while (total < bounded.length) {
			const read = readSync(fd, bounded, total, bounded.length - total, total);
			if (read === 0) break;
			total += read;
		}
		if (total > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
		if (total !== opened.size) return { status: "unavailable", reason: "unsafe_path" };
		const afterOpened = fstatSync(fd);
		if (!afterOpened.isFile() || !sameStateFileMetadata(opened, afterOpened) || afterOpened.nlink !== 1 || afterOpened.uid !== process.getuid?.() || (afterOpened.mode & 0o7777) !== 0o600) {
			return { status: "unavailable", reason: "unsafe_path" };
		}
		let afterPath: ReturnType<typeof lstatSync>;
		try {
			afterPath = lstatSync(file);
		} catch {
			return { status: "unavailable", reason: "unsafe_path" };
		}
		if (afterPath.isSymbolicLink() || !afterPath.isFile() || !sameStateFileMetadata(opened, afterPath)) {
			return { status: "unavailable", reason: "unsafe_path" };
		}
		const text = Buffer.from(bounded.buffer, bounded.byteOffset, total).toString("utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { status: "unavailable", reason: "corrupt" };
		}
		if (isRecord(parsed) && parsed.version !== 2) return { status: "unavailable", reason: "unsupported_version" };
		if (!validateStore(parsed)) return { status: "unavailable", reason: "corrupt" };
		return { status: "ok", value: parsed };
	} catch (error) {
		if (error instanceof Error && error.message === "unsafe_path") return { status: "unavailable", reason: "unsafe_path" };
		return { status: "unavailable", reason: "io_error" };
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
	}
}

function stateLockResult(lockFile: string): StoreReadResult | null {
	try {
		const lockInfo = lstatSync(lockFile);
		if (lockInfo.isSymbolicLink() || !lockInfo.isFile() || lockInfo.nlink !== 1 || lockInfo.uid !== process.getuid?.() || (lockInfo.mode & 0o7777) !== 0o600) {
			return { status: "unavailable", reason: "unsafe_path" };
		}
		return { status: "unavailable", reason: "locked" };
	} catch (error) {
		return isMissingError(error) ? null : { status: "unavailable", reason: "io_error" };
	}
}

export function readEvidenceV2(file: string): StoreReadResult {
	const paths = statePath(file);
	if (!paths) return { status: "unavailable", reason: "unsafe_path" };
	let directoryIdentity: StateDirectoryIdentity[];
	try { directoryIdentity = verifyStateDirectory(paths.directory, false); } catch (error) {
		return isMissingError(error) ? { status: "missing" } : { status: "unavailable", reason: "unsafe_path" };
	}
	// Public read-only lock rejection lives here, outside transaction-owned
	// readStoreFile: an existing transaction owns its lock and calls
	// readStoreFile directly, so it must not reject its own lock.
	const lockBeforeRead = stateLockResult(paths.lock);
	if (lockBeforeRead) return lockBeforeRead;
	const result = readStoreFile(paths.file);
	try { verifyStateDirectory(paths.directory, false, directoryIdentity); } catch { return { status: "unavailable", reason: "unsafe_path" }; }
	const lockAfterRead = stateLockResult(paths.lock);
	if (lockAfterRead) return lockAfterRead;
	return result;
}


function releaseOwnedLock(lockFile: string, lockFd: number, token: string, directoryIdentity: StateDirectoryIdentity[]): void {
	try {
		verifyStateDirectory(path.dirname(lockFile), false, directoryIdentity);
		const original = fstatSync(lockFd);
		const current = lstatSync(lockFile);
		if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid?.() || (current.mode & 0o7777) !== 0o600 || current.dev !== original.dev || current.ino !== original.ino) return;
		const checkFd = openSync(lockFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		try {
			const opened = fstatSync(checkFd);
			if (opened.dev !== original.dev || opened.ino !== original.ino || opened.nlink !== 1) return;
			if (readFileSync(checkFd, "utf8") === token) {
				verifyStateDirectory(path.dirname(lockFile), false, directoryIdentity);
				const latest = lstatSync(lockFile);
				if (latest.dev === original.dev && latest.ino === original.ino && latest.nlink === 1) unlinkSync(lockFile);
			}
		} finally {
			closeSync(checkFd);
		}
	} catch {}
}

function writeStateAtomically(file: string, state: EvidenceV2, directoryIdentity: StateDirectoryIdentity[]): void {
	const tmp = `${file}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	let temporaryIdentity: { dev: number; ino: number } | undefined;
	try {
		verifyStateDirectory(path.dirname(file), false, directoryIdentity);
		fd = openSync(tmp, "wx", 0o600);
		const created = fstatSync(fd);
		temporaryIdentity = { dev: created.dev, ino: created.ino };
		verifyStateDirectory(path.dirname(file), false, directoryIdentity);
		fchmodSync(fd, 0o600);
		writeSync(fd, JSON.stringify(state), undefined, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		verifyStateDirectory(path.dirname(file), false, directoryIdentity);
		const existing = readStoreFile(file);
		if (existing.status === "unavailable") throw new Error("unsafe state target");
		verifyStateDirectory(path.dirname(file), false, directoryIdentity);
		const currentTemporary = lstatSync(tmp);
		if (!currentTemporary.isFile() || currentTemporary.isSymbolicLink() || currentTemporary.dev !== temporaryIdentity.dev || currentTemporary.ino !== temporaryIdentity.ino || currentTemporary.nlink !== 1 || currentTemporary.uid !== process.getuid?.() || (currentTemporary.mode & 0o7777) !== 0o600) throw new Error("unsafe_path");
		renameSync(tmp, file);
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
		try {
			verifyStateDirectory(path.dirname(file), false, directoryIdentity);
			const currentTemporary = lstatSync(tmp);
			if (temporaryIdentity && currentTemporary.isFile() && !currentTemporary.isSymbolicLink() && currentTemporary.dev === temporaryIdentity.dev && currentTemporary.ino === temporaryIdentity.ino && currentTemporary.nlink === 1) unlinkSync(tmp);
		} catch {}
		throw error;
	}
}

/**
 * Fresh synchronous store transaction. The only await is bounded lock retry;
 * mutation callbacks must be synchronous and no snapshot escapes the lock.
 */
export async function transaction<T>(
	file: string,
	limits: StoreLimits,
	mutate: (latest: EvidenceV2) => T,
): Promise<StoreResult<T>> {
	const paths = statePath(file);
	if (!paths) return { status: "unavailable", reason: "unsafe_path" };
	const lockToken = randomUUID();
	const waitStarted = performance.now();
	let lockFd: number | undefined;
	let ownedDev = 0;
	let ownedIno = 0;
	let directoryIdentity: StateDirectoryIdentity[] | undefined;
	try {
		try {
			directoryIdentity = verifyStateDirectory(paths.directory, true);
		} catch {
			return { status: "unavailable", reason: "unsafe_path" };
		}
		while (lockFd === undefined) {
			try { verifyStateDirectory(paths.directory, false, directoryIdentity); } catch { return { status: "unavailable", reason: "unsafe_path" }; }
			try {
				lockFd = openSync(paths.lock, "wx", 0o600);
				const owner = fstatSync(lockFd);
				ownedDev = owner.dev;
				ownedIno = owner.ino;
				verifyStateDirectory(paths.directory, false, directoryIdentity);
				fchmodSync(lockFd, 0o600);
				writeSync(lockFd, lockToken, undefined, "utf8");
				fsyncSync(lockFd);
			} catch (error) {
				if (lockFd !== undefined) {
					let createdByThisTransaction = false;
					try {
						const owner = fstatSync(lockFd);
						createdByThisTransaction = owner.dev === ownedDev && owner.ino === ownedIno;
					} catch {}
					try { closeSync(lockFd); } catch {}
					lockFd = undefined;
					if (createdByThisTransaction) {
						try {
							verifyStateDirectory(paths.directory, false, directoryIdentity);
							const currentLock = lstatSync(paths.lock);
						if (currentLock.isFile() && !currentLock.isSymbolicLink() && currentLock.nlink === 1 && currentLock.dev === ownedDev && currentLock.ino === ownedIno) unlinkSync(paths.lock);
						} catch {}
					}
				}
				if (!isRecord(error) || error.code !== "EEXIST") return { status: "unavailable", reason: "io_error" };
				try {
					verifyStateDirectory(paths.directory, false, directoryIdentity);
					const lockInfo = lstatSync(paths.lock);
					if (lockInfo.isSymbolicLink() || !lockInfo.isFile() || lockInfo.nlink !== 1 || lockInfo.uid !== process.getuid?.() || (lockInfo.mode & 0o7777) !== 0o600) return { status: "unavailable", reason: "unsafe_path" };
				} catch {
					return { status: "unavailable", reason: "io_error" };
				}
				if (performance.now() - waitStarted >= MAX_LOCK_WAIT_MS) return { status: "unavailable", reason: "locked" };
				await new Promise<void>(resolve => setTimeout(resolve, 5));
			}
		}
		try { verifyStateDirectory(paths.directory, false, directoryIdentity); } catch { return { status: "unavailable", reason: "unsafe_path" }; }
		const current = readStoreFile(paths.file);
		try { verifyStateDirectory(paths.directory, false, directoryIdentity); } catch { return { status: "unavailable", reason: "unsafe_path" }; }
		if (current.status === "unavailable") return current;
		const latest = current.status === "missing" ? emptyEvidenceV2() : current.value;
		let value: T;
		try {
			value = mutate(latest);
			if (isRecord(value) && typeof value.then === "function") return { status: "unavailable", reason: "io_error" };
		} catch {
			return { status: "unavailable", reason: "io_error" };
		}
		if (!capStore(latest, limits)) return { status: "unavailable", reason: "oversized" };
		if (encodedBytes(latest) > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
		try {
			verifyStateDirectory(paths.directory, false, directoryIdentity);
			writeStateAtomically(paths.file, latest, directoryIdentity);
		} catch {
			return { status: "unavailable", reason: "io_error" };
		}
		return { status: "ok", value };
	} finally {
		if (lockFd !== undefined) {
			try {
				const stat = fstatSync(lockFd);
				if (directoryIdentity && stat.dev === ownedDev && stat.ino === ownedIno) releaseOwnedLock(paths.lock, lockFd, lockToken, directoryIdentity);
			} catch {}
			try { closeSync(lockFd); } catch {}
		}
	}
}

export function taskRefFor(sessionId: string, toolCallId: string, task: Pick<TaskInput, "index">): TaskRef | null {
	const ref = { sessionId, toolCallId, taskIndex: task.index };
	return taskRefKey(ref) ? ref : null;
}

export interface TaskPreparation {
	index: number;
	state: "created" | "reused" | "conflict";
	token: string | null;
	advice: StoredAdvice | null;
}

function findTask(state: EvidenceV2, key: string): { groupKey: string; task: TaskRecord } | null {
	for (const [groupKey, group] of Object.entries(state.groups)) {
		const task = group.tasks[key];
		if (task) return { groupKey, task };
	}
	return null;
}

function storedAdvice(advice: Advice): StoredAdvice {
	if (advice.status === "no_decision") return { ...advice };
	const result: StoredDecision = {
		status: "decision",
		tier: advice.tier,
		confidence: advice.confidence,
		confidenceKind: advice.confidenceKind,
	};
	if (advice.probabilities) result.probabilities = { ...advice.probabilities };
	return result;
}

export async function prepareTaskRecords(
	file: string,
	limits: StoreLimits,
	sessionId: string,
	toolCallId: string,
	tasks: TaskInput[],
	now = Date.now(),
): Promise<StoreResult<TaskPreparation[]>> {
	const baseRef = { sessionId, toolCallId, taskIndex: 0 };
	if (!taskRefKey(baseRef)) return { status: "unavailable", reason: "unsafe_path" };
	return transaction(file, limits, state => {
		const prepared: TaskPreparation[] = [];
		for (const task of tasks) {
			const ref: TaskRef = { sessionId, toolCallId, taskIndex: task.index };
			const key = taskRefKey(ref);
			if (!key) {
				prepared.push({ index: task.index, state: "conflict", token: null, advice: null });
				continue;
			}
			const existing = findTask(state, key);
			if (existing) {
				if (existing.task.fingerprint !== task.fingerprint ||
					existing.task.requestedTier !== task.requestedTier || existing.task.callerId !== task.callerId ||
					existing.task.conflicts.includes("identity_input_conflict")) {
					appendConflict(existing.task.conflicts, "identity_input_conflict");
					existing.task.updatedAt = now;
					state.groups[existing.groupKey].updatedAt = now;
					prepared.push({ index: task.index, state: "conflict", token: null, advice: null });
				} else if (!task.complete) {
					existing.task.requestToken = randomUUID();
					existing.task.advice = { status: "no_decision", reason: "input_too_large" };
					existing.task.updatedAt = now;
					state.groups[existing.groupKey].updatedAt = now;
					prepared.push({ index: task.index, state: "reused", token: existing.task.requestToken, advice: existing.task.advice });
				} else {
					prepared.push({ index: task.index, state: "reused", token: existing.task.requestToken, advice: existing.task.advice });
				}
				continue;
			}
			const token = randomUUID();
			const advice: StoredAdvice | null = task.complete ? null : { status: "no_decision", reason: "input_too_large" };
			const record: TaskRecord = {
				ref,
				fingerprint: task.fingerprint,
				callerId: task.callerId,
				requestedTier: task.requestedTier,
				requestToken: token,
				advice,
				createdAt: now,
				updatedAt: now,
				launchDisposition: "not_observed",
				jobKey: null,
				conflicts: [],
			};
			const group = (state.groups[task.fingerprint] ??= { updatedAt: now, tasks: {} });
			group.tasks[key] = record;
			group.updatedAt = now;
			prepared.push({ index: task.index, state: "created", token, advice });
		}
		return prepared;
	});
}

export async function updateTaskAdvice(
	file: string,
	limits: StoreLimits,
	ref: TaskRef,
	token: string,
	advice: Advice,
	now = Date.now(),
): Promise<StoreResult<boolean>> {
	const key = taskRefKey(ref);
	if (!key) return { status: "unavailable", reason: "unsafe_path" };
	return transaction(file, limits, state => {
		const found = findTask(state, key);
		if (!found || found.task.requestToken !== token || found.task.conflicts.includes("identity_input_conflict")) return false;
		found.task.advice = storedAdvice(advice);
		found.task.updatedAt = now;
		state.groups[found.groupKey].updatedAt = now;
		return true;
	});
}

export async function markInvocationBlocked(
	file: string,
	limits: StoreLimits,
	sessionId: string,
	toolCallId: string,
	now = Date.now(),
): Promise<StoreResult<number>> {
	return transaction(file, limits, state => {
		let count = 0;
		for (const group of Object.values(state.groups)) {
			for (const task of Object.values(group.tasks)) {
				if (task.ref.sessionId !== sessionId || task.ref.toolCallId !== toolCallId) continue;
				task.launchDisposition = "blocked";
				task.updatedAt = now;
				group.updatedAt = now;
				count++;
			}
		}
		return count;
	});
}

function associateTaskWithJob(state: EvidenceV2, task: TaskRecord, taskKey: string, ref: JobRef): void {
	const key = jobRefKey(ref);
	if (!key) return;
	const job = state.jobs[key];
	if (job?.conflicts.includes("launch_mapping_evicted")) {
		appendConflict(task.conflicts, "stale_job_mapping");
		return;
	}
	if (task.jobKey && task.jobKey !== key) {
		appendConflict(task.conflicts, "multiple_job_associations");
		return;
	}
	task.jobKey = key;
	if (job) {
		if (job.taskKey && job.taskKey !== taskKey) appendConflict(job.conflicts, "multiple_task_associations");
		else job.taskKey = taskKey;
	}
}

export async function observeTaskLaunch(
	file: string,
	limits: StoreLimits,
	sessionId: string,
	toolCallId: string,
	invocationObserved: boolean,
	singletonTaskIndex: number | null,
	job: JobRef | null,
	now = Date.now(),
): Promise<StoreResult<number>> {
	return transaction(file, limits, state => {
		let count = 0;
		for (const [groupKey, group] of Object.entries(state.groups)) {
			for (const [key, task] of Object.entries(group.tasks)) {
				if (task.ref.sessionId !== sessionId || task.ref.toolCallId !== toolCallId) continue;
				if (task.launchDisposition === "blocked") continue;
				if (task.launchDisposition === "observed") {
					if (singletonTaskIndex === task.ref.taskIndex && job) associateTaskWithJob(state, task, key, job);
					continue;
				}
				if (invocationObserved) {
					task.launchDisposition = "observed";
					if (singletonTaskIndex === task.ref.taskIndex && job) associateTaskWithJob(state, task, key, job);
				} else {
					task.launchDisposition = "not_observed";
				}
				task.updatedAt = now;
				group.updatedAt = now;
				count++;
			}
		}
		return count;
	});
}

export interface TerminalObservation {
	status: TerminalStatus;
	childId?: string;
	durationMs?: number;
	requestedModel?: string;
	effectiveModel?: string;
	actualTier?: Tier;
}

function addDistinct<T>(values: T[], value: T, limit: number): void {
	if (!values.includes(value) && values.length < limit) values.push(value);
}

function boundedModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const model = value.trim();
	if (!model || model.length > 128 || /[\u0000-\u001f\u007f]/.test(model)) return undefined;
	return model;
}

function findMappedTasks(state: EvidenceV2, key: string): string[] {
	const matches: string[] = [];
	for (const group of Object.values(state.groups)) {
		for (const [taskKey, task] of Object.entries(group.tasks)) if (task.jobKey === key) matches.push(taskKey);
	}
	return matches;
}

function applyTerminal(state: EvidenceV2, ref: JobRef, observation: TerminalObservation, now: number): void {
	const key = jobRefKey(ref)!;
	let job = state.jobs[key];
	if (!job) {
		const firstDuration = typeof observation.durationMs === "number" && Number.isFinite(observation.durationMs) && observation.durationMs > 0
			? observation.durationMs : undefined;
		const requestedModel = boundedModel(observation.requestedModel);
		const effectiveModel = boundedModel(observation.effectiveModel);
		job = {
			ref,
			...(observation.childId && boundedIdentity(observation.childId) ? { childId: boundedIdentity(observation.childId)! } : {}),
			status: observation.status,
			statusObservations: [observation.status],
			...(firstDuration === undefined ? {} : { durationMs: firstDuration }),
			durationObservations: firstDuration === undefined ? [] : [firstDuration],
			...(requestedModel ? { requestedModel } : {}),
			requestedModelObservations: requestedModel ? [requestedModel] : [],
			...(effectiveModel ? { effectiveModel } : {}),
			effectiveModelObservations: effectiveModel ? [effectiveModel] : [],
			allocatedChildIds: observation.childId && boundedIdentity(observation.childId) ? [boundedIdentity(observation.childId)!] : [],
			actualTier: observation.actualTier && validTier(observation.actualTier) ? observation.actualTier : null,
			observedAt: now,
			taskKey: null,
			conflicts: [],
		};
		const mappings = findMappedTasks(state, key);
		if (mappings.length === 1) job.taskKey = mappings[0];
		else if (mappings.length > 1) appendConflict(job.conflicts, "multiple_task_associations");
		state.jobs[key] = job;
		return;
	}
	addDistinct(job.statusObservations, observation.status, 3);
	if (job.statusObservations.length > 1) appendConflict(job.conflicts, "status_conflict");
	const duration = observation.durationMs;
	if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
		addDistinct(job.durationObservations, duration, 4);
		if (job.durationObservations.length > 1) appendConflict(job.conflicts, "duration_conflict");
		if (job.durationMs === undefined) job.durationMs = duration;
	}
	const requestedModel = boundedModel(observation.requestedModel);
	if (requestedModel) {
		addDistinct(job.requestedModelObservations, requestedModel, 4);
		if (job.requestedModelObservations.length > 1) appendConflict(job.conflicts, "requested_model_conflict");
		if (job.requestedModel === undefined) job.requestedModel = requestedModel;
	}
	const effectiveModel = boundedModel(observation.effectiveModel);
	if (effectiveModel) {
		addDistinct(job.effectiveModelObservations, effectiveModel, 4);
		if (job.effectiveModelObservations.length > 1) appendConflict(job.conflicts, "effective_model_conflict");
		if (job.effectiveModel === undefined) job.effectiveModel = effectiveModel;
	}
	const childId = boundedIdentity(observation.childId);
	if (childId) {
		addDistinct(job.allocatedChildIds, childId, 4);
		if (job.allocatedChildIds.length > 1) appendConflict(job.conflicts, "child_id_conflict");
		if (job.childId === undefined) job.childId = childId;
	}
	if (observation.actualTier && validTier(observation.actualTier)) {
		if (job.actualTier === null) job.actualTier = observation.actualTier;
		else if (job.actualTier !== observation.actualTier) appendConflict(job.conflicts, "actual_tier_conflict");
	}
	const mappings = findMappedTasks(state, key);
	if (mappings.length > 1) appendConflict(job.conflicts, "multiple_task_associations");
	else if (mappings.length === 1) {
		const mapped = mappings[0];
		if (job.taskKey && job.taskKey !== mapped) appendConflict(job.conflicts, "multiple_task_associations");
		else if (!job.conflicts.includes("launch_mapping_evicted")) job.taskKey = mapped;
	}
}

export async function observeTerminalJob(
	file: string,
	limits: StoreLimits,
	ref: JobRef,
	observation: TerminalObservation,
	now = Date.now(),
): Promise<StoreResult<void>> {
	if (!jobRefKey(ref) || !["completed", "failed", "cancelled"].includes(observation.status)) {
		return { status: "unavailable", reason: "unsafe_path" };
	}
	return transaction(file, limits, state => {
		applyTerminal(state, ref, observation, now);
	});
}

export interface CalibrationSummary {
	window: "retained_v2_metadata";
	retainedGroups: number;
	retainedTaskRecords: number;
	conflictedTaskRecords: number;
	advice: { decisions: number; noDecisions: Record<string, number> };
	launch: { observed: number; blocked: number; notObserved: number };
	agreement: { agree: number; denominator: number; rate: number | null };
	terminalJobs: {
		count: number;
		joined: number;
		unjoined: number;
		conflicted: number;
		batchMapped: number;
		exactJoin: number;
		byStatus: Record<TerminalStatus, number>;
		byRecommendation: Record<string, { jobs: number; byStatus: Record<TerminalStatus, number>; durationMs: { sum: number; measured: number; average: number | null } }>;
		byEffectiveModel: Record<string, { jobs: number; byStatus: Record<TerminalStatus, number>; durationMs: { sum: number; measured: number; average: number | null } }>;
		effectiveModel: { known: number; unknown: number };
		requestedModel: { known: number; unknown: number };
		durationMs: { sum: number; measured: number; average: number | null };
		actualTier: { known: number; unknown: number; byTier: Record<Tier, number> };
		quality: null;
	};
	coverage: { unknownIdentityObservationsNotRetained: true; unobservedTerminalsOutsideCoverage: true };
}

function emptyStatusCounts(): Record<TerminalStatus, number> {
	return { completed: 0, failed: 0, cancelled: 0 };
}

function emptyTierStats() {
	return { jobs: 0, byStatus: emptyStatusCounts(), durationMs: { sum: 0, measured: 0, average: null as number | null } };
}

export function calibrationSummary(state: EvidenceV2): { json: CalibrationSummary; text: string } {
	const taskRecords = Object.values(state.groups).flatMap(group => Object.entries(group.tasks).map(([key, task]) => ({ key, task })));
	const byTaskKey = new Map(taskRecords.map(entry => [entry.key, entry.task]));
	const invocationLaunches = new Map<string, LaunchDisposition>();
	const summary: CalibrationSummary = {
		window: "retained_v2_metadata",
		retainedGroups: Object.keys(state.groups).length,
		retainedTaskRecords: taskRecords.length,
		conflictedTaskRecords: taskRecords.filter(entry => entry.task.conflicts.length > 0).length,
		advice: { decisions: 0, noDecisions: {} },
		launch: { observed: 0, blocked: 0, notObserved: 0 },
		agreement: { agree: 0, denominator: 0, rate: null },
		terminalJobs: {
			count: Object.keys(state.jobs).length,
			joined: 0,
			unjoined: 0,
			conflicted: 0,
			batchMapped: 0,
			exactJoin: 0,
			byStatus: emptyStatusCounts(),
			byRecommendation: {},
			byEffectiveModel: {},
			effectiveModel: { known: 0, unknown: 0 },
			requestedModel: { known: 0, unknown: 0 },
			durationMs: { sum: 0, measured: 0, average: null },
			actualTier: { known: 0, unknown: 0, byTier: { fast: 0, balanced: 0, strong: 0 } },
			quality: null,
		},
		coverage: { unknownIdentityObservationsNotRetained: true, unobservedTerminalsOutsideCoverage: true },
	};
	for (const { task } of taskRecords) {
		if (task.advice?.status === "decision") {
			summary.advice.decisions++;
			if (task.requestedTier !== null && task.conflicts.length === 0) {
				summary.agreement.denominator++;
				if (task.requestedTier === task.advice.tier) summary.agreement.agree++;
			}
		} else if (task.advice?.status === "no_decision") {
			const reason = task.advice.reason;
			summary.advice.noDecisions[reason] = (summary.advice.noDecisions[reason] ?? 0) + 1;
		}
		const invocationKey = JSON.stringify([task.ref.sessionId, task.ref.toolCallId]);
		const prior = invocationLaunches.get(invocationKey);
		if (prior !== "blocked" && (task.launchDisposition === "blocked" || prior === undefined || task.launchDisposition === "observed")) {
			invocationLaunches.set(invocationKey, task.launchDisposition);
		}
	}
	for (const disposition of invocationLaunches.values()) {
		if (disposition === "observed") summary.launch.observed++;
		else if (disposition === "blocked") summary.launch.blocked++;
		else summary.launch.notObserved++;
	}
	summary.agreement.rate = summary.agreement.denominator ? summary.agreement.agree / summary.agreement.denominator : null;
	for (const job of Object.values(state.jobs)) {
		const task = job.taskKey ? byTaskKey.get(job.taskKey) : undefined;
		const joined = task !== undefined && task.jobKey === jobRefKey(job.ref) &&
			!job.conflicts.includes("multiple_task_associations") && !job.conflicts.includes("launch_mapping_evicted") &&
			task.conflicts.length === 0;
		if (joined) summary.terminalJobs.joined++;
		else summary.terminalJobs.unjoined++;
		if (job.conflicts.length) summary.terminalJobs.conflicted++;
		const statusConflict = job.conflicts.includes("status_conflict");
		if (!statusConflict) summary.terminalJobs.byStatus[job.status]++;
		const effectiveConflict = job.conflicts.includes("effective_model_conflict");
		if (job.effectiveModel && !effectiveConflict) summary.terminalJobs.effectiveModel.known++;
		else summary.terminalJobs.effectiveModel.unknown++;
		const requestedConflict = job.conflicts.includes("requested_model_conflict");
		if (job.requestedModel && !requestedConflict) summary.terminalJobs.requestedModel.known++;
		else summary.terminalJobs.requestedModel.unknown++;
		const tierConflict = job.conflicts.includes("actual_tier_conflict");
		if (job.actualTier && !tierConflict) {
			summary.terminalJobs.actualTier.known++;
			summary.terminalJobs.actualTier.byTier[job.actualTier]++;
		} else summary.terminalJobs.actualTier.unknown++;
		const durationConflict = job.conflicts.includes("duration_conflict");
		if (!durationConflict && job.durationMs !== undefined) {
			summary.terminalJobs.durationMs.sum += job.durationMs;
			summary.terminalJobs.durationMs.measured++;
		}
		if (job.effectiveModel && !effectiveConflict) {
			const modelStats = (summary.terminalJobs.byEffectiveModel[job.effectiveModel] ??= emptyTierStats());
			modelStats.jobs++;
			if (!statusConflict) modelStats.byStatus[job.status]++;
			if (!durationConflict && job.durationMs !== undefined) {
				modelStats.durationMs.sum += job.durationMs;
				modelStats.durationMs.measured++;
			}
		}
		if (!joined || !task?.advice || task.advice.status !== "decision") continue;
		const tier = task.advice.tier;
		const stats = (summary.terminalJobs.byRecommendation[tier] ??= emptyTierStats());
		stats.jobs++;
		if (!statusConflict) stats.byStatus[job.status]++;
		if (!durationConflict && job.durationMs !== undefined) {
			stats.durationMs.sum += job.durationMs;
			stats.durationMs.measured++;
		}
	}
	const totalDuration = summary.terminalJobs.durationMs;
	if (totalDuration.measured) totalDuration.average = totalDuration.sum / totalDuration.measured;
	summary.terminalJobs.exactJoin = summary.terminalJobs.joined;
	for (const stats of [...Object.values(summary.terminalJobs.byRecommendation), ...Object.values(summary.terminalJobs.byEffectiveModel)]) {
		if (stats.durationMs.measured) stats.durationMs.average = stats.durationMs.sum / stats.durationMs.measured;
	}
	const textLines = [
		"jev-advisor retained v2 coverage report (metadata only; not quality or correctness).",
		`retained task records: ${summary.retainedTaskRecords} across ${summary.retainedGroups} semantic groups; conflicted task records: ${summary.conflictedTaskRecords}; decisions: ${summary.advice.decisions}; no-decisions: ${JSON.stringify(summary.advice.noDecisions)}.`,
		`task-call launch invocations: ${summary.launch.observed} observed, ${summary.launch.blocked} blocked, ${summary.launch.notObserved} not observed; observations do not attribute batch children or establish terminal outcomes.`,
		`requested/recommended agreement: ${summary.agreement.agree}/${summary.agreement.denominator}${summary.agreement.rate === null ? " (no comparable records)" : ` (${Math.round(summary.agreement.rate * 100)}%; not correctness)`}.`,
		`terminal jobs: ${summary.terminalJobs.count}, joined by exact session+job mapping: ${summary.terminalJobs.joined}, batchMapped: ${summary.terminalJobs.batchMapped}, exactJoin: ${summary.terminalJobs.exactJoin}, unjoined: ${summary.terminalJobs.unjoined}, conflicted: ${summary.terminalJobs.conflicted}; status counts exclude conflicts: ${JSON.stringify(summary.terminalJobs.byStatus)}.`,
		`duration: ${totalDuration.measured ? `${totalDuration.sum} ms across ${totalDuration.measured} measured jobs; average ${totalDuration.average} ms` : "unknown (no positive non-conflicted measurements)"}; effective model known/unknown ${summary.terminalJobs.effectiveModel.known}/${summary.terminalJobs.effectiveModel.unknown}; requested model known/unknown ${summary.terminalJobs.requestedModel.known}/${summary.terminalJobs.requestedModel.unknown}; actual tier known/unknown ${summary.terminalJobs.actualTier.known}/${summary.terminalJobs.actualTier.unknown} (${JSON.stringify(summary.terminalJobs.actualTier.byTier)}).`,
		"Task quality is unknown. Actual tier is host-supplied only; the plugin never infers it from a model or a requested tier. Batch-level mapping is not inferred. Missing-identity observations are not retained, and unobserved terminals are outside coverage. This report describes only the bounded retained window.",
	];
	for (const [tier, stats] of Object.entries(summary.terminalJobs.byRecommendation)) {
		const duration = stats.durationMs.measured
			? `${stats.durationMs.sum} ms across ${stats.durationMs.measured} measured jobs; average ${stats.durationMs.average} ms`
			: "duration unknown";
		textLines.push(`${tier} recommendation (exactly joined): ${stats.jobs} jobs, statuses ${JSON.stringify(stats.byStatus)}, ${duration}.`);
	}
	for (const [model, stats] of Object.entries(summary.terminalJobs.byEffectiveModel)) {
		const duration = stats.durationMs.measured
			? `${stats.durationMs.sum} ms across ${stats.durationMs.measured} measured jobs; average ${stats.durationMs.average} ms`
			: "duration unknown";
		textLines.push(`effective model ${model}: ${stats.jobs} jobs, statuses ${JSON.stringify(stats.byStatus)}, ${duration} (observational, not causal).`);
	}
	const text = textLines.join("\n");
	return { json: summary, text };
}


// ─── plugin_metrics: offline descriptive report (plan S06/S07/S08) ───────────
// Read-only orchestration over the shared journals and the retained v2 state.
// Never appends a journal record, never loads credentials, never touches the
// network. All helpers below are pure except the snapshot reads themselves.

export type MetricsFrequency = Record<string, number>;

export interface MetricsFraction {
	numerator: number;
	denominator: number;
	rate: number | null;
}

export interface MetricsDuration {
	measured: number;
	sum: number | null;
	average: number | null;
}

export interface MetricsFieldCounts {
	present: number;
	byStatus: MetricsFrequency;
	byReason: MetricsFrequency;
}

export type MetricsOperation =
	| "run" | "status" | "advise" | "calibration" | "task_advice" | "task_launch" | "subagent_terminal";

export interface RunStatusMetrics {
	operations: MetricsFrequency;
	run: OperationMetrics;
	status: OperationMetrics;
}

export interface OperationMetrics {
	invocations: number;
	execution: MetricsFieldCounts;
	executionMissing: number;
	passedFraction: MetricsFraction;
	assessment: MetricsFieldCounts;
	assessmentAnswers: {
		coverage_alignment: { present: number; choices: MetricsFrequency };
		boundary_evidence: { present: number; choices: MetricsFrequency };
	};
	freshness: { present: number; counts: MetricsFrequency };
	cleanup: { present: number; counts: MetricsFrequency };
	receiptStorage: {
		present: number; persisted: number; notPersisted: number;
		byReason: MetricsFrequency; nearCapacityPresent: number; nearCapacityTrue: number;
	};
	recordedReceiptDurationMs: MetricsDuration | null;
	nativeCounts: null | { contributingRecords: number; totals: Record<string, number> };
	assertions: null | { contributingRecords: number; entries: number; byKind: MetricsFrequency; byStatus: MetricsFrequency };
}

export interface JevMetrics {
	operations: MetricsFrequency;
	manualAdvice: {
		invocations: number; present: number;
		byStatus: MetricsFrequency; byTier: MetricsFrequency;
		confidenceBasis: MetricsFrequency; byReason: MetricsFrequency;
	};
	checkAdvice: {
		invocations: number; present: number;
		byStatus: MetricsFrequency; byVerdict: MetricsFrequency;
		confidenceBasis: MetricsFrequency; byReason: MetricsFrequency;
	};
	taskAdvice: {
		batches: number; batchesWithEntries: number; entries: number;
		byStatus: MetricsFrequency; byTier: MetricsFrequency;
		confidenceBasis: MetricsFrequency; byReason: MetricsFrequency;
		recordedPreJournalHookDurationMs: MetricsDuration;
	};
	evidenceObservations: Partial<Record<MetricsOperation, {
		contributingRecords: number; completed: number; failed: number;
		cancelled: number; stored: number; unavailable: number;
	}>>;
	evidenceStorage: MetricsFieldCounts;
}

export type JournalSourceReason = "store_busy" | "store_corrupt" | "unsafe_path" | "resource_limit" | "changed_during_read" | "store_unavailable";

export interface JournalSource<T> {
	status: "ok" | "missing" | "unavailable";
	reason: JournalSourceReason | null;
	readStartedAt: string;
	readCompletedAt: string;
	retention: { maxRecordBytes: 4096; maxSegmentBytes: 1048576; maxSegments: 8 };
	snapshot: { segments: number; bytes: number; records: number; oldestObservedAt: string | null; newestObservedAt: string | null } | null;
	metrics: T | null;
}

export type CalibrationReport = Omit<CalibrationSummary, "terminalJobs"> & {
	terminalJobs: Omit<CalibrationSummary["terminalJobs"], "durationMs" | "byRecommendation" | "byEffectiveModel"> & {
		durationMs: MetricsDuration;
		byRecommendation: Record<string, Omit<CalibrationSummary["terminalJobs"]["byRecommendation"][string], "durationMs"> & { durationMs: MetricsDuration }>;
		byEffectiveModel: Record<string, Omit<CalibrationSummary["terminalJobs"]["byEffectiveModel"][string], "durationMs"> & { durationMs: MetricsDuration }>;
	};
};

export interface CorrelationSource {
	status: "ok" | "missing" | "unavailable";
	reason: StoreUnavailableReason | null;
	readStartedAt: string;
	readCompletedAt: string;
	window: "retained_v2_metadata";
	metrics: CalibrationReport | null;
}

export interface PluginMetricsReport {
	schemaVersion: 1;
	report: "plugin_metrics";
	mode: "offline_descriptive";
	window: "all_retained";
	scope: "current_process_home_all_repositories";
	generatedAt: string;
	status: "complete" | "partial" | "unavailable";
	plugins: {
		"jev-advisor": JournalSource<JevMetrics>;
		"verification-receipts": JournalSource<RunStatusMetrics>;
		"ui-regression": JournalSource<RunStatusMetrics>;
	};
	correlation: CorrelationSource;
	unavailableMeasures: {
		pluginOverheadMs: null; providerLatencyMs: null; assessmentLatencyMs: null;
		endToEndInvocationMs: null; providerCost: null; tokenUsage: null;
		quality: null; accuracy: null; causalRoi: null;
	};
	limitations: string[];
}

function metricsFreq(): MetricsFrequency { return {}; }
function metricsBump(freq: MetricsFrequency, key: string): void {
	if (!Number.isSafeInteger(freq[key] ?? 0) || (freq[key] ?? 0) + 1 > Number.MAX_SAFE_INTEGER) throw new Error("resource_limit");
	freq[key] = (freq[key] ?? 0) + 1;
}
function metricsDuration(): MetricsDuration { return { measured: 0, sum: null, average: null }; }
function metricsDurationAdd(d: MetricsDuration, value: number): void {
	if (!Number.isSafeInteger(value)) throw new Error("resource_limit");
	d.measured++;
	d.sum = (d.sum ?? 0) + value;
	if (d.sum > Number.MAX_SAFE_INTEGER) throw new Error("resource_limit");
	d.average = d.sum / d.measured;
}
function metricsFraction(numerator: number, denominator: number): MetricsFraction {
	return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}
function metricsEmptyFieldCounts(): MetricsFieldCounts { return { present: 0, byStatus: metricsFreq(), byReason: metricsFreq() }; }
function metricsEmptyOperation(statusDurationNull: boolean): OperationMetrics {
	return {
		invocations: 0,
		execution: metricsEmptyFieldCounts(),
		executionMissing: 0,
		passedFraction: metricsFraction(0, 0),
		assessment: metricsEmptyFieldCounts(),
		assessmentAnswers: {
			coverage_alignment: { present: 0, choices: metricsFreq() },
			boundary_evidence: { present: 0, choices: metricsFreq() },
		},
		freshness: { present: 0, counts: metricsFreq() },
		cleanup: { present: 0, counts: metricsFreq() },
		receiptStorage: { present: 0, persisted: 0, notPersisted: 0, byReason: metricsFreq(), nearCapacityPresent: 0, nearCapacityTrue: 0 },
		recordedReceiptDurationMs: statusDurationNull ? null : metricsDuration(),
		nativeCounts: null,
		assertions: null,
	};
}

const RESULTS_COUNT_KEYS = ["tests", "suites", "topLevel", "passed", "failed", "skipped", "todo", "cancelled"];
const RESULTS_ASSESSMENT_ANSWERS = ["coverage_alignment", "boundary_evidence"] as const;

/** Run/status journals (verification-receipts, ui-regression) → RunStatusMetrics. Plan S07. */
export function aggregateRunStatusMetrics(
	records: Record<string, unknown>[],
	source: "verification-receipts" | "ui-regression",
): RunStatusMetrics {
	const report: RunStatusMetrics = {
		operations: metricsFreq(),
		run: metricsEmptyOperation(false),
		status: metricsEmptyOperation(true),
	};
	for (const record of records) {
		const op = String(record.operation);
		metricsBump(report.operations, op);
		if (op !== "run" && op !== "status") continue;
		const bucket = op === "run" ? report.run : report.status;
		bucket.invocations++;
		const execution = record.execution as Record<string, unknown> | undefined;
		if (execution === undefined) {
			bucket.executionMissing++;
		} else {
			bucket.execution.present++;
			metricsBump(bucket.execution.byStatus, String(execution.status));
			metricsBump(bucket.execution.byReason, String(execution.reason));
			if (execution.status === "passed") bucket.passedFraction.numerator++;
			bucket.passedFraction.denominator++;
			const counts = execution.counts as Record<string, number> | null | undefined;
			if (source === "verification-receipts" && op === "run" && counts) {
				if (bucket.nativeCounts === null) bucket.nativeCounts = { contributingRecords: 0, totals: Object.fromEntries(RESULTS_COUNT_KEYS.map(key => [key, 0])) };
				bucket.nativeCounts.contributingRecords++;
				for (const key of RESULTS_COUNT_KEYS) {
					const value = counts[key];
					if (typeof value === "number") {
						if (!Number.isSafeInteger(bucket.nativeCounts.totals[key]! + value)) throw new Error("resource_limit");
						bucket.nativeCounts.totals[key]! += value;
					}
				}
			}
			const assertions = execution.assertions as Record<string, unknown>[] | undefined;
			if (source === "ui-regression" && op === "run" && Array.isArray(assertions)) {
				if (bucket.assertions === null) bucket.assertions = { contributingRecords: 0, entries: 0, byKind: metricsFreq(), byStatus: metricsFreq() };
				bucket.assertions.contributingRecords++;
				for (const assertion of assertions) {
					bucket.assertions.entries++;
					metricsBump(bucket.assertions.byKind, String(assertion.kind));
					metricsBump(bucket.assertions.byStatus, String(assertion.status));
				}
			}
		}
		const assessment = record.assessment as Record<string, unknown> | undefined;
		if (assessment !== undefined) {
			bucket.assessment.present++;
			metricsBump(bucket.assessment.byStatus, String(assessment.status));
			metricsBump(bucket.assessment.byReason, String(assessment.reason));
			const answers = assessment.answers as Record<string, Record<string, unknown>> | undefined;
			if (answers !== undefined) {
				for (const answerKey of RESULTS_ASSESSMENT_ANSWERS) {
					const answer = answers[answerKey];
					if (answer === undefined) continue;
					bucket.assessmentAnswers[answerKey].present++;
					metricsBump(bucket.assessmentAnswers[answerKey].choices, String(answer.choice));
				}
			}
		}
		if (record.freshness !== undefined) {
			bucket.freshness.present++;
			metricsBump(bucket.freshness.counts, String(record.freshness));
		}
		const executionCleanup = execution?.cleanup;
		if (executionCleanup !== undefined) {
			bucket.cleanup.present++;
			metricsBump(bucket.cleanup.counts, String(executionCleanup));
		}
		const storage = record.receiptStorage as Record<string, unknown> | undefined;
		if (storage !== undefined) {
			bucket.receiptStorage.present++;
			if (storage.persisted === true) bucket.receiptStorage.persisted++;
			else bucket.receiptStorage.notPersisted++;
			metricsBump(bucket.receiptStorage.byReason, String(storage.reason));
			if (storage.nearCapacity !== undefined) {
				bucket.receiptStorage.nearCapacityPresent++;
				if (storage.nearCapacity === true) bucket.receiptStorage.nearCapacityTrue++;
			}
		}
		if (op === "run" && record.durationMs !== undefined) {
			if (bucket.recordedReceiptDurationMs === null) bucket.recordedReceiptDurationMs = metricsDuration();
			metricsDurationAdd(bucket.recordedReceiptDurationMs, Number(record.durationMs));
		}
	}
	for (const op of ["run", "status"] as const) {
		const bucket = op === "run" ? report.run : report.status;
		bucket.passedFraction = metricsFraction(bucket.passedFraction.numerator, bucket.execution.present);
	}
	return report;
}

/** Jev journal → JevMetrics. Manual advise, task_advice and check buckets stay separate, plan S07. */
export function aggregateJevMetrics(records: Record<string, unknown>[]): JevMetrics {
	const report: JevMetrics = {
		operations: metricsFreq(),
		manualAdvice: { invocations: 0, present: 0, byStatus: metricsFreq(), byTier: metricsFreq(), confidenceBasis: metricsFreq(), byReason: metricsFreq() },
		checkAdvice: { invocations: 0, present: 0, byStatus: metricsFreq(), byVerdict: metricsFreq(), confidenceBasis: metricsFreq(), byReason: metricsFreq() },
		taskAdvice: {
			batches: 0, batchesWithEntries: 0, entries: 0,
			byStatus: metricsFreq(), byTier: metricsFreq(), confidenceBasis: metricsFreq(), byReason: metricsFreq(),
			recordedPreJournalHookDurationMs: metricsDuration(),
		},
		evidenceObservations: {},
		evidenceStorage: metricsEmptyFieldCounts(),
	};

	for (const record of records) {
		const op = String(record.operation);
		metricsBump(report.operations, op);
		const advice = record.advice as Record<string, unknown> | undefined;
		if (op === "advise") {
			report.manualAdvice.invocations++;
			if (advice !== undefined) {
				report.manualAdvice.present++;
				metricsBump(report.manualAdvice.byStatus, String(advice.status));
				if (advice.tier !== undefined) metricsBump(report.manualAdvice.byTier, String(advice.tier));
				if (advice.confidenceKind !== undefined) metricsBump(report.manualAdvice.confidenceBasis, String(advice.confidenceKind));
				if (advice.reason !== undefined) metricsBump(report.manualAdvice.byReason, String(advice.reason));
			}
		}
		const check = record.check as Record<string, unknown> | undefined;
		if (op === "check") {
			report.checkAdvice.invocations++;
			if (check !== undefined) {
				report.checkAdvice.present++;
				metricsBump(report.checkAdvice.byStatus, String(check.status));
				if (check.verdict !== undefined) metricsBump(report.checkAdvice.byVerdict, String(check.verdict));
				if (check.confidenceKind !== undefined) metricsBump(report.checkAdvice.confidenceBasis, String(check.confidenceKind));
				if (check.reason !== undefined) metricsBump(report.checkAdvice.byReason, String(check.reason));
			}
		}
		const taskAdvice = record.taskAdvice as Record<string, unknown>[] | undefined;
		if (op === "task_advice") {
			report.taskAdvice.batches++;
			if (record.durationMs !== undefined) metricsDurationAdd(report.taskAdvice.recordedPreJournalHookDurationMs, Number(record.durationMs));
			if (Array.isArray(taskAdvice) && taskAdvice.length > 0) {
				report.taskAdvice.batchesWithEntries++;
				for (const task of taskAdvice) {
					report.taskAdvice.entries++;
					metricsBump(report.taskAdvice.byStatus, String(task.status));
					if (task.tier !== undefined) metricsBump(report.taskAdvice.byTier, String(task.tier));
					if (task.basis !== undefined) metricsBump(report.taskAdvice.confidenceBasis, String(task.basis));
					if (task.reason !== undefined) metricsBump(report.taskAdvice.byReason, String(task.reason));
				}
			}
		}
		const observations = record.evidenceObservations as Record<string, number> | undefined;
		if (observations !== undefined) {
			const bucket = report.evidenceObservations[op] ??= { contributingRecords: 0, completed: 0, failed: 0, cancelled: 0, stored: 0, unavailable: 0 };
			bucket.contributingRecords++;
			for (const key of ["completed", "failed", "cancelled", "stored", "unavailable"] as const) {
				const value = observations[key];
				if (typeof value === "number") {
					if (!Number.isSafeInteger(bucket[key] + value)) throw new Error("resource_limit");
					bucket[key] += value;
				}
			}
		}
		const evidenceStorage = record.evidenceStorage as Record<string, unknown> | undefined;
		if (evidenceStorage !== undefined) {
			report.evidenceStorage.present++;
			metricsBump(report.evidenceStorage.byStatus, String(evidenceStorage.status));
			if (evidenceStorage.reason !== undefined) metricsBump(report.evidenceStorage.byReason, String(evidenceStorage.reason));
		}
	}
	return report;
}

/** Presentation-only validation/null projection. Calibration arithmetic unchanged. */
export function projectCalibrationForReport(summary: CalibrationSummary): StoreResult<CalibrationReport> {
	const durationIsRepresentable = (d: CalibrationSummary["terminalJobs"]["durationMs"]) =>
		Number.isFinite(d.sum) && (!Number.isInteger(d.sum) || Number.isSafeInteger(d.sum)) &&
		(d.average === null || Number.isFinite(d.average));
	if (!durationIsRepresentable(summary.terminalJobs.durationMs) ||
		Object.values(summary.terminalJobs.byRecommendation).some(stats => !durationIsRepresentable(stats.durationMs)) ||
		Object.values(summary.terminalJobs.byEffectiveModel).some(stats => !durationIsRepresentable(stats.durationMs))) {
		return { status: "unavailable", reason: "corrupt" };
	}
	const project = (d: CalibrationSummary["terminalJobs"]["durationMs"]): MetricsDuration =>
		d.measured === 0 ? { ...d, sum: null } : d;
	return {
		status: "ok",
		value: {
			...summary,
			terminalJobs: {
				...summary.terminalJobs,
				durationMs: project(summary.terminalJobs.durationMs),
				byRecommendation: Object.fromEntries(
					Object.entries(summary.terminalJobs.byRecommendation).map(([tier, stats]) => [
						tier,
						{ ...stats, durationMs: project(stats.durationMs) },
					]),
				),
				byEffectiveModel: Object.fromEntries(
					Object.entries(summary.terminalJobs.byEffectiveModel).map(([model, stats]) => [
						model,
						{ ...stats, durationMs: project(stats.durationMs) },
					]),
				),
			},
		},
	};
}

const METRICS_BASE_LIMITATIONS = [
	"retained_not_lifetime",
	"unrecorded_invocations_unknown",
	"independent_source_snapshots",
	"wall_clock_not_event_authority",
	"run_observations_not_unique_executions",
	"status_not_reexecution",
	"terminal_sightings_not_unique_jobs",
	"correlation_window_independent",
	"unknown_identity_and_unobserved_terminals",
	"receipt_duration_excludes_storage_assessment_journal",
	"hook_duration_excludes_journal",
	"provider_assessment_latency_unmeasured",
	"end_to_end_and_isolated_overhead_unmeasured",
	"historical_version_unidentified",
	"smoke_real_workload_unidentified",
	"counts_not_coverage",
	"assessment_not_quality",
	"causal_effect_unmeasured",
] as const;

type MetricsJournalSnapshot = {
	status: string;
	reason: string | null;
	records: Record<string, unknown>[];
	segments: number;
	bytes: number;
};

function aggregateJournalSnapshot<T>(
	snapshot: MetricsJournalSnapshot,
	aggregate: (records: Record<string, unknown>[]) => T,
): { snapshot: MetricsJournalSnapshot; metrics: T | null } {
	if (snapshot.status !== "ok") return { snapshot, metrics: null };
	try {
		return { snapshot, metrics: aggregate(snapshot.records) };
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "resource_limit") throw error;
		return {
			snapshot: { status: "unavailable", reason: "resource_limit", records: [], segments: 0, bytes: 0 },
			metrics: null,
		};
	}
}

function journalSourceEnvelope<T>(
	startedAt: Date,
	completedAt: Date,
	snapshot: MetricsJournalSnapshot | null,
	metrics: T | null,
): JournalSource<T> {
	const status = (snapshot?.status ?? "unavailable") as JournalSource<T>["status"];
	let oldestObservedAt: string | null = null;
	let newestObservedAt: string | null = null;
	let oldestObservedAtMs = Number.POSITIVE_INFINITY;
	let newestObservedAtMs = Number.NEGATIVE_INFINITY;
	if (status === "ok" && snapshot) {
		for (const record of snapshot.records) {
			const observedAt = record.observedAt as string;
			const observedAtMs = Date.parse(observedAt);
			if (observedAtMs < oldestObservedAtMs) {
				oldestObservedAt = observedAt;
				oldestObservedAtMs = observedAtMs;
			}
			if (observedAtMs > newestObservedAtMs) {
				newestObservedAt = observedAt;
				newestObservedAtMs = observedAtMs;
			}
		}
	}
	return {
		status,
		reason: status === "ok" || status === "missing" ? null : ((snapshot?.reason ?? "store_unavailable") as JournalSourceReason),
		readStartedAt: startedAt.toISOString(),
		readCompletedAt: completedAt.toISOString(),
		retention: { maxRecordBytes: 4096, maxSegmentBytes: 1048576, maxSegments: 8 },
		snapshot: status === "ok" && snapshot ? {
			segments: snapshot.segments,
			bytes: snapshot.bytes,
			records: snapshot.records.length,
			oldestObservedAt,
			newestObservedAt,
		} : null,
		metrics: status === "ok" ? metrics : null,
	};
}

/**
 * Offline orchestration: three journal snapshots + one canonical calibration
 * projection. Strictly read-only — no append, no lock, no credential, no network.
 */
export async function buildPluginMetricsReport(): Promise<PluginMetricsReport> {
	const startedAt = new Date();
	const plugins: PluginMetricsReport["plugins"] = {
		"jev-advisor": null as unknown as JournalSource<JevMetrics>,
		"verification-receipts": null as unknown as JournalSource<RunStatusMetrics>,
		"ui-regression": null as unknown as JournalSource<RunStatusMetrics>,
	};
	for (const plugin of ["jev-advisor", "verification-receipts", "ui-regression"] as const) {
		const sourceStartedAt = new Date();
		const snapshot = await readPluginOutcomeSnapshot(plugin);
		const completedAt = new Date();
		if (plugin === "jev-advisor") {
			const source = aggregateJournalSnapshot(snapshot, aggregateJevMetrics);
			plugins[plugin] = journalSourceEnvelope(sourceStartedAt, completedAt, source.snapshot, source.metrics);
		} else {
			const source = aggregateJournalSnapshot(snapshot, records => aggregateRunStatusMetrics(records, plugin));
			plugins[plugin] = journalSourceEnvelope(sourceStartedAt, completedAt, source.snapshot, source.metrics);
		}
	}
	const stateStartedAt = new Date();
	const stateRead = readEvidenceV2(version2StateFile(pluginStateFile()));
	const stateCompletedAt = new Date();
	const correlationRead = stateRead.status === "ok"
		? projectCalibrationForReport(calibrationSummary(stateRead.value).json)
		: stateRead;
	const correlation: CorrelationSource = {
		status: correlationRead.status,
		reason: correlationRead.status === "unavailable" ? correlationRead.reason : null,
		readStartedAt: stateStartedAt.toISOString(),
		readCompletedAt: stateCompletedAt.toISOString(),
		window: "retained_v2_metadata",
		metrics: correlationRead.status === "ok" ? correlationRead.value : null,
	};
	const statuses = [plugins["jev-advisor"].status, plugins["verification-receipts"].status, plugins["ui-regression"].status, correlation.status];
	const okCount = statuses.filter(status => status === "ok").length;
	const status: PluginMetricsReport["status"] = okCount === 4 ? "complete" : okCount === 0 ? "unavailable" : "partial";
	const limitations: string[] = [...METRICS_BASE_LIMITATIONS];
	if (statuses.includes("missing")) limitations.push("source_missing");
	if (statuses.includes("unavailable")) limitations.push("source_unavailable");
	return {
		schemaVersion: 1,
		report: "plugin_metrics",
		mode: "offline_descriptive",
		window: "all_retained",
		scope: "current_process_home_all_repositories",
		generatedAt: startedAt.toISOString(),
		status,
		plugins,
		correlation,
		unavailableMeasures: {
			pluginOverheadMs: null, providerLatencyMs: null, assessmentLatencyMs: null,
			endToEndInvocationMs: null, providerCost: null, tokenUsage: null,
			quality: null, accuracy: null, causalRoi: null,
		},
		limitations,
	};
}

export function readSessionId(ctx: unknown): string | null {
	if (!isRecord(ctx) || !isRecord(ctx.sessionManager) || typeof ctx.sessionManager.getSessionId !== "function") return null;
	try {
		return boundedIdentity(ctx.sessionManager.getSessionId.call(ctx.sessionManager));
	} catch {
		return null;
	}
}

export function noDecision(reason: NoDecisionReason, httpStatus?: number): Advice {
	return httpStatus === undefined ? { status: "no_decision", reason } : { status: "no_decision", reason, httpStatus };
}

export function noCheckDecision(reason: NoDecisionReason, httpStatus?: number): CheckAdvice {
	return httpStatus === undefined ? { status: "no_decision", reason } : { status: "no_decision", reason, httpStatus };
}

/**
 * A probability map is valid only when its sum stays within the documented
 * 0.001 bound. The added tolerance is a few ulps of 1.0 to absorb decimal
 * rounding noise, not an admission margin: a deviation of 1e-12 or more over
 * the bound is still rejected.
 */
function probabilitySumWithinBound(sum: number): boolean {
	return Math.abs(sum - 1) <= 0.001 + Number.EPSILON * 4;
}

function parseProbabilityMap(value: unknown): Record<Tier, number> | null {
	if (!isRecord(value) || Object.keys(value).length !== TIERS.length || !TIERS.every(tier => Object.prototype.hasOwnProperty.call(value, tier))) return null;
	const probabilities = {} as Record<Tier, number>;
	for (const tier of TIERS) {
		const probability = value[tier];
		if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
		probabilities[tier] = probability;
	}
	const sum = TIERS.reduce((total, tier) => total + probabilities[tier], 0);
	return probabilitySumWithinBound(sum) ? probabilities : null;
}

/** Strict JSON parser. It accepts a whole JSON document or one complete JSON fence, never a partial object. */
export function parseDecision(raw: string, confidenceKind: ConfidenceKind = "self_reported"): Advice {
	try {
		let text = String(raw ?? "").trim();
		if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return noDecision("invalid_response");
		const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
		if (fence) text = fence[1].trim();
		if (!text.startsWith("{") || !text.endsWith("}")) return noDecision("invalid_response");
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["tier", "confidence", "probabilities", "rationale"])) return noDecision("invalid_response");
		const tier = validTier(parsed.tier);
		if (!tier || typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
			return noDecision("invalid_response");
		}
		let probabilities: Record<Tier, number> | undefined;
		if (Object.prototype.hasOwnProperty.call(parsed, "probabilities")) {
			const candidate = parseProbabilityMap(parsed.probabilities);
			if (!candidate) return noDecision("invalid_response");
			probabilities = candidate;
		}
		if (Object.prototype.hasOwnProperty.call(parsed, "rationale") && typeof parsed.rationale !== "string") return noDecision("invalid_response");
		const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 120) : undefined;
		return {
			status: "decision",
			tier,
			confidence: parsed.confidence,
			...(probabilities ? { probabilities } : {}),
			confidenceKind,
			...(rationale ? { rationale } : {}),
		};
	} catch {
		return noDecision("invalid_response");
	}
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function validVerdict(value: unknown): CheckVerdict | null {
	if (typeof value !== "string") return null;
	const verdict = value.trim().toLowerCase();
	return CHECK_VERDICTS.includes(verdict as CheckVerdict) ? (verdict as CheckVerdict) : null;
}

function parseCheckProbabilityMap(value: unknown): Record<CheckVerdict, number> | null {
	if (!isRecord(value) || Object.keys(value).length !== CHECK_VERDICTS.length || !CHECK_VERDICTS.every(verdict => Object.prototype.hasOwnProperty.call(value, verdict))) return null;
	const probabilities = {} as Record<CheckVerdict, number>;
	for (const verdict of CHECK_VERDICTS) {
		const probability = value[verdict];
		if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
		probabilities[verdict] = probability;
	}
	const sum = CHECK_VERDICTS.reduce((total, verdict) => total + probabilities[verdict], 0);
	return probabilitySumWithinBound(sum) ? probabilities : null;
}

/** Strict JSON parser for check responses; same fence/document discipline as parseDecision. */
export function parseCheckDecision(raw: string, confidenceKind: ConfidenceKind = "self_reported"): CheckAdvice {
	try {
		let text = String(raw ?? "").trim();
		if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return noCheckDecision("invalid_response");
		const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
		if (fence) text = fence[1].trim();
		if (!text.startsWith("{") || !text.endsWith("}")) return noCheckDecision("invalid_response");
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["verdict", "confidence", "probabilities", "rationale"])) return noCheckDecision("invalid_response");
		const verdict = validVerdict(parsed.verdict);
		if (!verdict || typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
			return noCheckDecision("invalid_response");
		}
		let probabilities: Record<CheckVerdict, number> | undefined;
		if (Object.prototype.hasOwnProperty.call(parsed, "probabilities")) {
			const candidate = parseCheckProbabilityMap(parsed.probabilities);
			if (!candidate) return noCheckDecision("invalid_response");
			probabilities = candidate;
		}
		if (Object.prototype.hasOwnProperty.call(parsed, "rationale") && typeof parsed.rationale !== "string") return noCheckDecision("invalid_response");
		const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 120) : undefined;
		return {
			status: "decision",
			verdict,
			confidence: parsed.confidence,
			...(probabilities ? { probabilities } : {}),
			confidenceKind,
			...(rationale ? { rationale } : {}),
		};
	} catch {
		return noCheckDecision("invalid_response");
	}
}

function extractChatFinal(data: unknown): string | null {
	if (!isRecord(data) || !Array.isArray(data.choices)) return null;
	const first = data.choices[0];
	if (!isRecord(first) || first.error !== undefined) return null;
	const message = isRecord(first.message) ? first.message : null;
	if (!message) return null;
	const content = message.content;
	if (typeof content === "string") return content.trim() ? content : null;
	if (Array.isArray(content)) {
		const chunks = content.map(part => isRecord(part) && typeof part.text === "string" ? part.text : "");
		const joined = chunks.join("");
		return joined.trim() ? joined : null;
	}
	return null;
}

function extractSystemoneFinal(data: unknown): string | null {
	if (!isRecord(data) || !isRecord(data.answers) || !isRecord(data.answers.tier)) return null;
	const answer = data.answers.tier;
	if (typeof answer.choice !== "string" || typeof answer.confidence !== "number") return null;
	const payload: Record<string, unknown> = { tier: answer.choice, confidence: answer.confidence };
	if (Object.prototype.hasOwnProperty.call(answer, "probabilities")) payload.probabilities = answer.probabilities;
	if (Object.prototype.hasOwnProperty.call(answer, "rationale")) payload.rationale = answer.rationale;
	return JSON.stringify(payload);
}

function extractSystemoneCheckFinal(data: unknown): string | null {
	if (!isRecord(data) || !isRecord(data.answers) || !isRecord(data.answers.check)) return null;
	const answer = data.answers.check;
	if (typeof answer.choice !== "string" || typeof answer.confidence !== "number") return null;
	const payload: Record<string, unknown> = { verdict: answer.choice, confidence: answer.confidence };
	if (Object.prototype.hasOwnProperty.call(answer, "probabilities")) payload.probabilities = answer.probabilities;
	if (Object.prototype.hasOwnProperty.call(answer, "rationale")) payload.rationale = answer.rationale;
	return JSON.stringify(payload);
}

async function readBoundedResponse(response: Response): Promise<string | null> {
	const length = response.headers?.get?.("content-length");
	if (length && Number.isFinite(Number(length)) && Number(length) > MAX_RESPONSE_BYTES) return null;
	if (!response.body || typeof response.body.getReader !== "function") return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				try { await reader.cancel(); } catch {}
				return null;
			}
			chunks.push(value);
		}
	} finally {
		try { reader.releaseLock(); } catch {}
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

type DecisionTransportFailure = { status: "no_decision"; reason: NoDecisionReason; httpStatus?: number };

/**
 * Shared bounded transport for tier and check questions. Provider resolution,
 * egress validation, timeout composition and response reading are identical
 * for both question kinds; only the wire body and the response parser differ.
 */
async function requestDecision(
	cfg: AdvisorConfig,
	kind: "tier" | "check",
	payload: string | CheckInput,
	fetchImpl: FetchLike | undefined,
	signal: AbortSignal | undefined,
	timeoutLimitMs: number,
): Promise<{ status: "ok"; text: string; style: keyof typeof REQUEST_STYLES } | DecisionTransportFailure> {
	if (typeof fetchImpl !== "function") return { status: "no_decision", reason: "provider_error" };
	if (cfg.provider === "off") return { status: "no_decision", reason: "disabled" };
	if (!isConfigured(cfg)) return { status: "no_decision", reason: "unconfigured" };
	const provider = PROVIDERS[cfg.provider] ?? (cfg.endpoint ? { endpoint: cfg.endpoint, style: "openai-chat" as const } : undefined);
	if (!provider) return { status: "no_decision", reason: "unconfigured" };
	const url = cfg.endpoint || provider.endpoint;
	if (!isAllowedEndpoint(url)) return { status: "no_decision", reason: "invalid_endpoint" };
	const style = REQUEST_STYLES[provider.style];
	const timeoutMs = Math.max(1, Math.min(INVOCATION_BUDGET_MS, cfg.timeoutMs, timeoutLimitMs));
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (signal?.aborted) return { status: "no_decision", reason: "aborted" };
	const composedSignal = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const wire = kind === "check"
		? style.checkRequest({ model: cfg.model, apiKey: cfg.apiKey }, payload as CheckInput)
		: style.request({ model: cfg.model, apiKey: cfg.apiKey }, payload as string);
	const headers = new URL(url).origin === "https://openrouter.ai" ? { ...wire.headers, ...ATTRIBUTION_HEADERS } : wire.headers;
	try {
		const response = await fetchImpl(url, {
			method: "POST",
			redirect: "error",
			headers,
			body: wire.body,
			signal: composedSignal,
		});
		if (!response?.ok) {
			return Number.isInteger(response?.status)
				? { status: "no_decision", reason: "provider_error", httpStatus: response.status }
				: { status: "no_decision", reason: "provider_error" };
		}
		const text = await readBoundedResponse(response);
		if (text === null) return { status: "no_decision", reason: "invalid_response" };
		return { status: "ok", text, style: provider.style };
	} catch {
		if (signal?.aborted) return { status: "no_decision", reason: "aborted" };
		if (timeoutSignal.aborted) return { status: "no_decision", reason: "timeout" };
		return { status: "no_decision", reason: "provider_error" };
	}
}

export async function askDecisionModel(
	cfg: AdvisorConfig,
	task: TaskInput,
	fetchImpl: FetchLike | undefined,
	signal?: AbortSignal,
	timeoutLimitMs = cfg.timeoutMs,
): Promise<Advice> {
	if (!task.complete) return noDecision("input_too_large");
	const result = await requestDecision(cfg, "tier", task.prompt, fetchImpl, signal, timeoutLimitMs);
	if (result.status === "no_decision") return noDecision(result.reason, result.httpStatus);
	let data: unknown;
	try { data = JSON.parse(result.text); } catch { return noDecision("invalid_response"); }
	const final = result.style === "systemone" ? extractSystemoneFinal(data) : extractChatFinal(data);
	if (!final) return noDecision("invalid_response");
	return parseDecision(final, result.style === "systemone" ? "provider_choice" : "self_reported");
}

export async function askCheckModel(
	cfg: AdvisorConfig,
	check: CheckInput,
	fetchImpl: FetchLike | undefined,
	signal?: AbortSignal,
	timeoutLimitMs = cfg.timeoutMs,
): Promise<CheckAdvice> {
	const result = await requestDecision(cfg, "check", check, fetchImpl, signal, timeoutLimitMs);
	if (result.status === "no_decision") return noCheckDecision(result.reason, result.httpStatus);
	let data: unknown;
	try { data = JSON.parse(result.text); } catch { return noCheckDecision("invalid_response"); }
	const final = result.style === "systemone" ? extractSystemoneCheckFinal(data) : extractChatFinal(data);
	if (!final) return noCheckDecision("invalid_response");
	return parseCheckDecision(final, result.style === "systemone" ? "provider_choice" : "self_reported");
}

export function formatSummary(advice: Advice): string {
	if (advice.status === "no_decision") return `jev-advisor: no decision (${advice.reason})`;
	return `jev-advisor: tier=${advice.tier} confidence=${advice.confidence.toFixed(2)}`;
}

export const ENFORCE_GUIDANCE =
	"Re-issue this task call with the recommended tier, or set JEV_ADVISOR_MODE=hint for non-blocking advisories.";

/**
 * Widget lifecycle registry — in-process, metadata-only UI bookkeeping.
 * The two generated hook surfaces live in separate modules (build.mjs
 * concatenates lib/decision.ts into each) but are imported into one host
 * realm, so a namespaced globalThis slot is genuinely shared. The slot must
 * be resolved inside function bodies: a module-level binding would be
 * per-generated-file and would not be shared across the two surfaces.
 */
export const WIDGET_LIFECYCLE_SLOT = "gjc.jev-advisor.widget-lifecycle";
export const WIDGET_LIFECYCLE_VERSION = 2;
/** Session entries kept at once; the oldest session is evicted past this. */
export const WIDGET_LIFECYCLE_MAX_SESSIONS = 8;
/**
 * Job ids tracked per batch entry. MAX_TASKS_PER_INVOCATION (32) is the
 * admission clamp on input.tasks.length, but historical/resumed jobs and
 * foreign same-session terminals can push more distinct ids past the fold,
 * so the map bound is deliberately 2x the admission clamp (64).
 */
export const WIDGET_LIFECYCLE_MAX_JOB_IDS = 64;
/** Bound for the rendered widget text; mirrors the pre-hook summary bound. */
export const WIDGET_SUMMARY_MAX_CHARS = 2200;
/** Bound for one stored task row; the pre-hook renders each row at 180 chars. */
export const WIDGET_ROW_MAX_CHARS = 240;
/** Bound for non-row summary lines kept across redraws. */
export const WIDGET_TAIL_MAX_LINES = 32;

export type WidgetJobStatus = "terminal" | "nonTerminal" | "unknown";

export interface WidgetJobState {
	status: WidgetJobStatus;
	everNonTerminal: boolean;
}

/** One per-task widget row; only valid task rows are removable. */
export interface WidgetRow {
	index: number;
	/** Task id (input.tasks[].id) when bounded; null makes the row unmappable. */
	label: string | null;
	text: string;
}

export interface WidgetBatchState {
	toolCallId: string;
	/** Clamp(raw input.tasks.length, 1, 32); fallback tasks+rejected. */
	taskCount: number;
	awaitingAsync: boolean;
	primaryJobId: string | null;
	jobs: Record<string, WidgetJobState>;
	/** Remaining per-task rows; terminal observations remove them. */
	rows: WidgetRow[];
	/** Non-row summary lines (rejected/omitted/storage) preserved on redraw. */
	tail: string[];
	/** jobId -> task index. null pins a contradictory/ambiguous job out of removal. */
	jobRows: Record<string, number | null>;
	/**
	 * Allocation counter expected for task index 0, anchored from the primary
	 * job id (`${counter}-${taskId}`). null means no structured anchor; row
	 * removals then require a unique id/label match only.
	 */
	counterBase: number | null;
}

export interface WidgetSnapshotEntry {
	jobId: unknown;
	status: unknown;
	/** Allocated task id from a subagent snapshot (structured match only). */
	id?: unknown;
	/** Job label from a subagent snapshot; same allocated id when present. */
	label?: unknown;
}

export interface WidgetSnapshotOutcome {
	removedRows: number;
	/** Redraw text when at least one row was removed and rows remain; null otherwise. */
	remainingText: string | null;
}

interface WidgetLifecycleState {
	version: number;
	sessions: Record<string, WidgetBatchState>;
}

function lifecycleSlot(): { state: WidgetLifecycleState } | null {
	const holder = globalThis as { [key: symbol]: unknown };
	const key = Symbol.for(WIDGET_LIFECYCLE_SLOT);
	return typeof holder[key] === "object" && holder[key] !== null
		? (holder[key] as { state: WidgetLifecycleState })
		: null;
}

function ensureLifecycleSlot(): { state: WidgetLifecycleState } {
	const existing = lifecycleSlot();
	if (existing) return existing;
	const holder = globalThis as { [key: symbol]: unknown };
	const key = Symbol.for(WIDGET_LIFECYCLE_SLOT);
	const slot = { state: { version: WIDGET_LIFECYCLE_VERSION, sessions: {} } as WidgetLifecycleState };
	holder[key] = slot;
	return slot;
}

/** Fail-toward-keeping: a missing/mismatched-version/malformed slot reads as empty. */
function lifecycleState(): WidgetLifecycleState {
	const slot = lifecycleSlot();
	if (!slot) return { version: WIDGET_LIFECYCLE_VERSION, sessions: {} };
	const state = slot.state;
	if (
		typeof state !== "object" || state === null ||
		state.version !== WIDGET_LIFECYCLE_VERSION ||
		typeof state.sessions !== "object" || state.sessions === null
	) {
		return { version: WIDGET_LIFECYCLE_VERSION, sessions: {} };
	}
	return state;
}

function boundedJobId(value: unknown): string | null {
	return boundedIdentity(value);
}

function boundedWidgetText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text && text.length <= WIDGET_ROW_MAX_CHARS && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

/** Copy bounded rows from the pre-hook; duplicate indexes keep the first. */
function boundedWidgetRows(value: unknown): WidgetRow[] {
	if (!Array.isArray(value)) return [];
	const rows: WidgetRow[] = [];
	const seen = new Set<number>();
	for (const raw of value.slice(0, MAX_TASKS_PER_INVOCATION)) {
		if (!isRecord(raw)) continue;
		const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0 && raw.index < MAX_TASKS_PER_INVOCATION
			? raw.index
			: null;
		if (index === null || seen.has(index)) continue;
		const text = boundedWidgetText(raw.text);
		if (!text) continue;
		seen.add(index);
		rows.push({ index, label: boundedIdentity(raw.label), text });
	}
	return rows;
}

function boundedWidgetTail(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const tail: string[] = [];
	for (const raw of value.slice(0, WIDGET_TAIL_MAX_LINES)) {
		const text = boundedWidgetText(raw);
		if (text) tail.push(text);
	}
	return tail;
}

/** Single bounded renderer for the pre-hook draw and every per-row redraw. */
export function renderWidgetLines(rows: { text: string }[], tail: string[]): string {
	return [...rows.map(row => row.text), ...tail].join("\n").slice(0, WIDGET_SUMMARY_MAX_CHARS);
}

/**
 * Match a subagent snapshot's allocated id/label to a task id without
 * trusting free-form text. The host allocates `${counter}-${taskId}` (nested
 * prefixes join with dots), so a suffix match is accepted only when the
 * remaining prefix is purely numeric.
 */
function allocatedIdMatchesTaskId(candidate: string, taskId: string): boolean {
	if (candidate === taskId) return true;
	const suffix = `-${taskId}`;
	if (!candidate.endsWith(suffix)) return false;
	return /^\d+(?:\.\d+)*$/.test(candidate.slice(0, candidate.length - suffix.length));
}

/** Split an allocated id (`${counter}-${taskId}`) for batch-generation checks. */
function parseAllocatedId(value: string): { counter: number; taskId: string } | null {
	const match = /^([\d.]+)-(.+)$/.exec(value);
	if (!match) return null;
	const parts = match[1].split(".");
	const counter = Number(parts[parts.length - 1]);
	return Number.isSafeInteger(counter) && counter >= 0 ? { counter, taskId: match[2] } : null;
}

interface WidgetEntryMatch {
	row: WidgetRow;
	counter: number | null;
}

/** Unique row for one snapshot entry across its structured job id/id/label. */
function uniqueWidgetRowForEntry(batch: WidgetBatchState, entry: WidgetSnapshotEntry): WidgetEntryMatch | null {
	const matches = new Map<number, WidgetEntryMatch>();
	for (const raw of [entry.id, entry.label, entry.jobId]) {
		const candidate = boundedIdentity(raw);
		if (!candidate) continue;
		const matched = batch.rows.filter(row => row.label !== null && allocatedIdMatchesTaskId(candidate, row.label));
		if (matched.length > 1) return null; // duplicate label: retention is safer
		if (matched.length !== 1) continue;
		const row = matched[0];
		const counter = parseAllocatedId(candidate)?.counter ?? null;
		const existing = matches.get(row.index);
		if (existing && existing.counter !== null && counter !== null && existing.counter !== counter) return null;
		matches.set(row.index, { row, counter: counter ?? existing?.counter ?? null });
	}
	return matches.size === 1 ? [...matches.values()][0] : null;
}

/** The counter must agree with the primary-anchored batch generation when known. */
function counterMatchesBatch(batch: WidgetBatchState, match: WidgetEntryMatch): boolean {
	const base = batch.counterBase ?? null;
	if (base === null || match.counter === null) return true;
	return match.counter === base + match.row.index;
}

function pruneWidgetJobRows(batch: WidgetBatchState): void {
	const ids = Object.keys(batch.jobRows);
	if (ids.length <= WIDGET_LIFECYCLE_MAX_JOB_IDS) return;
	for (const id of ids.slice(0, ids.length - WIDGET_LIFECYCLE_MAX_JOB_IDS)) delete batch.jobRows[id];
}

/**
 * Bind one observed job to a task index. Existing bindings win until a
 * contradictory snapshot pins the job out of removal; a row can belong to
 * only one job, and an ambiguous/unknown match returns null (retention).
 */
function bindWidgetJobRow(batch: WidgetBatchState, jobId: string, entry: WidgetSnapshotEntry): number | null {
	const existing = batch.jobRows[jobId];
	if (existing === null) return null;
	const derived = uniqueWidgetRowForEntry(batch, entry);
	if (existing !== undefined) {
		if (derived && (derived.row.index !== existing || !counterMatchesBatch(batch, derived))) {
			batch.jobRows[jobId] = null; // contradiction: never remove on either claim
			return null;
		}
		return batch.rows.some(row => row.index === existing) ? existing : null;
	}
	if (!derived || !counterMatchesBatch(batch, derived)) return null;
	for (const [otherJob, mapped] of Object.entries(batch.jobRows)) {
		if (otherJob !== jobId && mapped === derived.row.index) return null;
	}
	batch.jobRows[jobId] = derived.row.index;
	pruneWidgetJobRows(batch);
	return derived.row.index;
}

function removeWidgetRow(batch: WidgetBatchState, rowIndex: number): boolean {
	const before = batch.rows.length;
	batch.rows = batch.rows.filter(row => row.index !== rowIndex);
	if (batch.rows.length === before) return false;
	for (const [mappedJob, mappedRow] of Object.entries(batch.jobRows)) {
		if (mappedRow === rowIndex) delete batch.jobRows[mappedJob];
	}
	return true;
}

function clampTaskCount(raw: number): number {
	return Math.min(Math.max(raw, 1), MAX_TASKS_PER_INVOCATION);
}

function evictOldestSessions(sessions: Record<string, WidgetBatchState>): void {
	const ids = Object.keys(sessions);
	if (ids.length <= WIDGET_LIFECYCLE_MAX_SESSIONS) return;
	for (const id of ids.slice(0, ids.length - WIDGET_LIFECYCLE_MAX_SESSIONS)) delete sessions[id];
}

export function widgetSessionEntry(sessionId: unknown): WidgetBatchState | null {
	const id = boundedIdentity(sessionId);
	if (!id) return null;
	return lifecycleState().sessions[id] ?? null;
}

export function widgetLifecycleResetForTests(): void {
	const slot = lifecycleSlot();
	if (slot) slot.state = { version: WIDGET_LIFECYCLE_VERSION, sessions: {} };
}

/**
 * Record the batch the pre-hook just drew. Replaces any prior entry for the
 * session (supersede); the new entry owns the widget from this point on.
 * `rows` are the per-task lines that can be removed one by one; `tail` keeps
 * non-row lines across redraws.
 */
export function widgetRecordBatch(
	sessionId: string,
	toolCallId: string,
	taskCount: number,
	rows: unknown = [],
	tail: unknown = [],
): void {
	const session = boundedIdentity(sessionId);
	const call = boundedIdentity(toolCallId);
	if (!session || !call) return;
	const slot = ensureLifecycleSlot();
	slot.state.sessions[session] = {
		toolCallId: call,
		taskCount: clampTaskCount(taskCount),
		awaitingAsync: false,
		primaryJobId: null,
		jobs: {},
		rows: boundedWidgetRows(rows),
		tail: boundedWidgetTail(tail),
		jobRows: {},
		counterBase: null,
	};
	evictOldestSessions(slot.state.sessions);
}

/**
 * Latest-observation-wins fold with no regression: a terminal sighting is
 * never undone by a later non-terminal or unknown sighting; running/paused/
 * queued set nonTerminal + everNonTerminal; unknown/absent statuses record
 * `unknown` (blocks a clear, contributes nothing to the terminal count).
 *
 * The same pass binds observed job ids to task rows using structured snapshot
 * job-id/id/label fields only. A terminal child removes its row immediately; an
 * unknown, unmappable, or contradictory observation never removes one.
 * Excess job ids past the map bound evict the oldest entries (bounded memory);
 * a dropped ever-non-terminal id can weaken the closure check in extreme
 * corners (advisory-only residual).
 */
export function widgetFoldSnapshot(
	sessionId: unknown,
	entries: WidgetSnapshotEntry[],
): WidgetSnapshotOutcome {
	const session = boundedIdentity(sessionId);
	if (!session) return { removedRows: 0, remainingText: null };
	const state = lifecycleState();
	const batch = state.sessions[session];
	if (!batch) return { removedRows: 0, remainingText: null };
	const removed = new Set<number>();
	// Rows belong to the async batch only after its launch receipt establishes
	// ownership; a snapshot observed before that point is never this widget's
	// child and must not remove a row.
	const canRemoveRows = batch.awaitingAsync === true;
	for (const item of entries) {
		const jobId = boundedJobId(item.jobId);
		if (!jobId) continue;
		const existing = batch.jobs[jobId];
		const status = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
		const terminal = status === "completed" || status === "failed" || status === "cancelled";
		const nonTerminal = status === "running" || status === "paused" || status === "queued";
		let rowIndex: number | null = null;
		if (canRemoveRows && (terminal || nonTerminal)) rowIndex = bindWidgetJobRow(batch, jobId, item);
		if (terminal) {
			batch.jobs[jobId] = { status: "terminal", everNonTerminal: existing?.everNonTerminal ?? false };
			if (canRemoveRows && rowIndex !== null && removeWidgetRow(batch, rowIndex)) removed.add(rowIndex);
		} else if (nonTerminal) {
			if (existing?.status === "terminal") continue; // no regression
			batch.jobs[jobId] = { status: "nonTerminal", everNonTerminal: true };
		} else if (existing?.status === "terminal") {
			continue; // unknown/absent never regresses a terminal id
		} else {
			batch.jobs[jobId] = {
				status: "unknown",
				everNonTerminal: existing?.everNonTerminal ?? false,
			};
		}
	}
	const ids = Object.keys(batch.jobs);
	if (ids.length > WIDGET_LIFECYCLE_MAX_JOB_IDS) {
		for (const id of ids.slice(0, ids.length - WIDGET_LIFECYCLE_MAX_JOB_IDS)) {
			delete batch.jobs[id];
			delete batch.jobRows[id];
		}
	}
	if (removed.size === 0) return { removedRows: 0, remainingText: null };
	return {
		removedRows: removed.size,
		remainingText: batch.rows.length > 0 ? renderWidgetLines(batch.rows, batch.tail) : null,
	};
}

/**
 * Mark the batch as waiting on an async envelope and pin the primary job.
 * `progress` is the launch receipt's structured per-child list; it can confirm
 * or invalidate the task-id labels drawn by the pre-hook. When the envelope
 * job id carries the host's `${counter}-${taskId}` allocation label, it also
 * anchors the batch generation used to reject stale jobs from older batches;
 * a plain job id falls back to mapping only a singleton batch to index 0.
 */
export function widgetMarkAwaitingAsync(
	sessionId: string,
	toolCallId: string,
	jobId: string,
	progress: { index: unknown; id: unknown }[] = [],
): void {
	const session = boundedIdentity(sessionId);
	const call = boundedIdentity(toolCallId);
	const job = boundedJobId(jobId);
	if (!session || !call || !job) return;
	const batch = lifecycleState().sessions[session];
	if (!batch || batch.toolCallId !== call) return;
	batch.awaitingAsync = true;
	batch.primaryJobId = job;
	if (Array.isArray(progress)) {
		for (const raw of progress.slice(0, MAX_TASKS_PER_INVOCATION)) {
			if (!isRecord(raw)) continue;
			const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0 && raw.index < MAX_TASKS_PER_INVOCATION
				? raw.index
				: null;
			if (index === null) continue;
			const id = boundedIdentity(raw.id);
			if (!id) continue;
			const row = batch.rows.find(candidate => candidate.index === index);
			if (!row) continue;
			// Conflicting structured signals make this row unmappable (retention);
			// an allocated-id progress value still confirms the same task id.
			if (row.label === null) row.label = id;
			else if (row.label !== id && !allocatedIdMatchesTaskId(id, row.label)) row.label = null;
		}
	}
	// The primary job id carries the allocated `${counter}-${taskId}` label in
	// the host, which anchors the counter expected for every row in this batch.
	const anchor = parseAllocatedId(job);
	const anchorRows = anchor
		? batch.rows.filter(row => row.label !== null && allocatedIdMatchesTaskId(job, row.label))
		: [];
	if (anchor && anchorRows.length === 1) {
		batch.counterBase = anchor.counter - anchorRows[0].index;
		if (batch.jobRows[job] === undefined) batch.jobRows[job] = anchorRows[0].index;
		else if (batch.jobRows[job] !== anchorRows[0].index) batch.jobRows[job] = null;
	} else if (batch.rows.length === 1 && batch.taskCount === 1 && batch.rows[0].index === 0) {
		if (batch.jobRows[job] === undefined) batch.jobRows[job] = 0;
		else if (batch.jobRows[job] !== 0) batch.jobRows[job] = null;
	}
}

/** Drop a session entry without touching the widget (caller clears the UI). */
export function widgetDropSession(sessionId: unknown): void {
	const session = boundedIdentity(sessionId);
	if (!session) return;
	const state = lifecycleState();
	delete state.sessions[session];
}

/**
 * CLEAR predicate (Design 3). All of (a)-(f) must hold:
 * (a) a registry entry exists for this session with awaitingAsync === true
 *     (supersede resets awaitingAsync, so this also proves the entry's
 *     toolCallId is still the one whose widget was drawn);
 * (b) the snapshot lists at least 1 entry with a bounded jobId;
 * (c) every listed entry resolves terminal (non-terminal or unknown blocks);
 * (d) every ever-non-terminal id in the window is now terminal (closure);
 * (e) count of terminal ids in the window >= taskCount;
 * (f) primaryJobId === null OR the primary job is terminal.
 */
export function widgetShouldClear(
	sessionId: unknown,
	listedEntries: { jobId: unknown; status: unknown }[],
): boolean {
	// (a) registry entry for this session, awaiting async, same toolCallId
	const session = boundedIdentity(sessionId);
	if (!session) return false;
	const batch = lifecycleState().sessions[session];
	if (!batch || !batch.awaitingAsync) return false;
	// (b) at least one listed entry with a bounded jobId
	const normalized = listedEntries.map(item => ({
		jobId: boundedJobId(item?.jobId),
		status: typeof item?.status === "string" ? item.status.trim().toLowerCase() : "",
	}));
	const listed = normalized.filter(item => item.jobId !== null);
	if (listed.length === 0) return false;
	// (c) every listed entry resolves terminal — including entries whose jobId is
	// not bounded (they cannot join the count, but a non-terminal one must not be
	// skipped away to let an untracked running child slip past the clear)
	for (const item of normalized) {
		if (item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled") return false;
	}
	// (d) closure: every ever-non-terminal id must now be terminal
	for (const job of Object.values(batch.jobs)) {
		if (job.everNonTerminal && job.status !== "terminal") return false;
	}
	// (e) terminal count reaches the raw task count
	const terminalIds = new Set(
		Object.entries(batch.jobs)
			.filter(([, job]) => job.status === "terminal")
			.map(([id]) => id),
	);
	if (terminalIds.size < batch.taskCount) return false;
	// (f) primary job (first child) must be terminal
	if (batch.primaryJobId !== null && !terminalIds.has(batch.primaryJobId)) return false;
	return true;
}
