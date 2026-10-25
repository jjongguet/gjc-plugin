// GENERATED FILE — do not edit by hand.
// Core: lib/decision.ts + adapter: src/hook.adapter.ts
// Rebuild with: bun scripts/build.mjs

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
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

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

/** Legacy state base; the v2 store is always derived and never migrates this file. */
export function pluginStateFile(): string {
	return path.join(os.homedir(), ".gjc", "agent", "jev-advisor", "state.json");
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
		stateFile: trim(merged.JEV_ADVISOR_STATE) || pluginStateFile(),
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
	actualTier: null;
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
	return Math.abs(sum - 1) <= 0.001;
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
			!validStringArray(rawJob.allocatedChildIds, 4, MAX_ID_CHARS) || rawJob.actualTier !== null || !validTime(rawJob.observedAt) ||
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

function readStoreFile(file: string): StoreReadResult {
	let fd: number | undefined;
	try {
		const info = lstatSync(file);
		if (info.isSymbolicLink() || !info.isFile()) return { status: "unavailable", reason: "unsafe_path" };
		if ((info.mode & 0o077) !== 0) return { status: "unavailable", reason: "unsafe_path" };
		if (info.size > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
		const noFollow = fsConstants.O_NOFOLLOW ?? 0;
		fd = openSync(file, fsConstants.O_RDONLY | noFollow);
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) return { status: "unavailable", reason: "unsafe_path" };
		if (opened.size > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
		const text = readFileSync(fd, "utf8");
		if (Buffer.byteLength(text, "utf8") > MAX_STORE_BYTES) return { status: "unavailable", reason: "oversized" };
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
		if (isMissingError(error)) return { status: "missing" };
		return { status: "unavailable", reason: "io_error" };
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
	}
}

export function readEvidenceV2(file: string): StoreReadResult {
	const paths = statePath(file);
	if (!paths) return { status: "unavailable", reason: "unsafe_path" };
	return readStoreFile(paths.file);
}

function releaseOwnedLock(lockFile: string, lockFd: number, token: string): void {
	try {
		const original = fstatSync(lockFd);
		const current = lstatSync(lockFile);
		if (!current.isFile() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino) return;
		const checkFd = openSync(lockFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		try {
			if (readFileSync(checkFd, "utf8") === token) unlinkSync(lockFile);
		} finally {
			closeSync(checkFd);
		}
	} catch {}
}

function writeStateAtomically(file: string, state: EvidenceV2): void {
	const tmp = `${file}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(tmp, "wx", 0o600);
		fchmodSync(fd, 0o600);
		writeSync(fd, JSON.stringify(state), undefined, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		const existing = readStoreFile(file);
		if (existing.status === "unavailable") throw new Error("unsafe state target");
		renameSync(tmp, file);
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
		try { unlinkSync(tmp); } catch {}
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
	try {
		try {
			mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
			const directoryInfo = lstatSync(paths.directory);
			if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return { status: "unavailable", reason: "unsafe_path" };
		} catch {
			return { status: "unavailable", reason: "io_error" };
		}
		while (lockFd === undefined) {
			try {
				lockFd = openSync(paths.lock, "wx", 0o600);
				const owner = fstatSync(lockFd);
				ownedDev = owner.dev;
				ownedIno = owner.ino;
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
							const currentLock = lstatSync(paths.lock);
						if (currentLock.isFile() && !currentLock.isSymbolicLink() && currentLock.dev === ownedDev && currentLock.ino === ownedIno) unlinkSync(paths.lock);
						} catch {}
					}
				}
				if (!isRecord(error) || error.code !== "EEXIST") return { status: "unavailable", reason: "io_error" };
				try {
					const lockInfo = lstatSync(paths.lock);
					if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) return { status: "unavailable", reason: "unsafe_path" };
				} catch {
					return { status: "unavailable", reason: "io_error" };
				}
				if (performance.now() - waitStarted >= MAX_LOCK_WAIT_MS) return { status: "unavailable", reason: "locked" };
				await new Promise<void>(resolve => setTimeout(resolve, 5));
			}
		}
		const current = readStoreFile(paths.file);
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
			writeStateAtomically(paths.file, latest);
		} catch {
			return { status: "unavailable", reason: "io_error" };
		}
		return { status: "ok", value };
	} finally {
		if (lockFd !== undefined) {
			try {
				const stat = fstatSync(lockFd);
				if (stat.dev === ownedDev && stat.ino === ownedIno) releaseOwnedLock(paths.lock, lockFd, lockToken);
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
			actualTier: null,
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
		byStatus: Record<TerminalStatus, number>;
		byRecommendation: Record<string, { jobs: number; byStatus: Record<TerminalStatus, number>; durationMs: { sum: number; measured: number; average: number | null } }>;
		effectiveModel: { known: number; unknown: number };
		requestedModel: { known: number; unknown: number };
		durationMs: { sum: number; measured: number; average: number | null };
		actualTier: null;
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
			byStatus: emptyStatusCounts(),
			byRecommendation: {},
			effectiveModel: { known: 0, unknown: 0 },
			requestedModel: { known: 0, unknown: 0 },
			durationMs: { sum: 0, measured: 0, average: null },
			actualTier: null,
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
		const durationConflict = job.conflicts.includes("duration_conflict");
		if (!durationConflict && job.durationMs !== undefined) {
			summary.terminalJobs.durationMs.sum += job.durationMs;
			summary.terminalJobs.durationMs.measured++;
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
	for (const stats of Object.values(summary.terminalJobs.byRecommendation)) {
		if (stats.durationMs.measured) stats.durationMs.average = stats.durationMs.sum / stats.durationMs.measured;
	}
	const textLines = [
		"jev-advisor retained v2 coverage report (metadata only; not quality or correctness).",
		`retained task records: ${summary.retainedTaskRecords} across ${summary.retainedGroups} semantic groups; conflicted task records: ${summary.conflictedTaskRecords}; decisions: ${summary.advice.decisions}; no-decisions: ${JSON.stringify(summary.advice.noDecisions)}.`,
		`task-call launch invocations: ${summary.launch.observed} observed, ${summary.launch.blocked} blocked, ${summary.launch.notObserved} not observed; observations do not attribute batch children or establish terminal outcomes.`,
		`requested/recommended agreement: ${summary.agreement.agree}/${summary.agreement.denominator}${summary.agreement.rate === null ? " (no comparable records)" : ` (${Math.round(summary.agreement.rate * 100)}%; not correctness)`}.`,
		`terminal jobs: ${summary.terminalJobs.count}, joined by exact session+job mapping: ${summary.terminalJobs.joined}, unjoined: ${summary.terminalJobs.unjoined}, conflicted: ${summary.terminalJobs.conflicted}; status counts exclude conflicts: ${JSON.stringify(summary.terminalJobs.byStatus)}.`,
		`duration: ${totalDuration.measured ? `${totalDuration.sum} ms across ${totalDuration.measured} measured jobs; average ${totalDuration.average} ms` : "unknown (no positive non-conflicted measurements)"}; effective model known/unknown ${summary.terminalJobs.effectiveModel.known}/${summary.terminalJobs.effectiveModel.unknown}; requested model known/unknown ${summary.terminalJobs.requestedModel.known}/${summary.terminalJobs.requestedModel.unknown}.`,
		"Actual tier and task quality are unknown. Missing-identity observations are not retained, and unobserved terminals are outside coverage. This report describes only the bounded retained window.",
	];
	for (const [tier, stats] of Object.entries(summary.terminalJobs.byRecommendation)) {
		const duration = stats.durationMs.measured
			? `${stats.durationMs.sum} ms across ${stats.durationMs.measured} measured jobs; average ${stats.durationMs.average} ms`
			: "duration unknown";
		textLines.push(`${tier} recommendation (exactly joined): ${stats.jobs} jobs, statuses ${JSON.stringify(stats.byStatus)}, ${duration}.`);
	}
	const text = textLines.join("\n");
	return { json: summary, text };
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

function parseProbabilityMap(value: unknown): Record<Tier, number> | null {
	if (!isRecord(value) || Object.keys(value).length !== TIERS.length || !TIERS.every(tier => Object.prototype.hasOwnProperty.call(value, tier))) return null;
	const probabilities = {} as Record<Tier, number>;
	for (const tier of TIERS) {
		const probability = value[tier];
		if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
		probabilities[tier] = probability;
	}
	const sum = TIERS.reduce((total, tier) => total + probabilities[tier], 0);
	return Math.abs(sum - 1) <= 0.001 ? probabilities : null;
}

/** Strict JSON parser. It accepts a whole JSON document or one complete JSON fence, never a partial object. */
export function parseDecision(raw: string, confidenceKind: ConfidenceKind = "self_reported"): Advice {
	try {
		let text = String(raw ?? "").trim();
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

function timeoutDecision(signal: AbortSignal | undefined, timeoutSignal: AbortSignal): Advice {
	if (signal?.aborted) return noDecision("aborted");
	if (timeoutSignal.aborted) return noDecision("timeout");
	return noDecision("provider_error");
}

export async function askDecisionModel(
	cfg: AdvisorConfig,
	task: TaskInput,
	fetchImpl: FetchLike | undefined,
	signal?: AbortSignal,
	timeoutLimitMs = cfg.timeoutMs,
): Promise<Advice> {
	if (!task.complete) return noDecision("input_too_large");
	if (typeof fetchImpl !== "function") return noDecision("provider_error");
	if (cfg.provider === "off") return noDecision("disabled");
	if (!isConfigured(cfg)) return noDecision("unconfigured");
	const provider = PROVIDERS[cfg.provider] ?? (cfg.endpoint ? { endpoint: cfg.endpoint, style: "openai-chat" as const } : undefined);
	if (!provider) return noDecision("unconfigured");
	const url = cfg.endpoint || provider.endpoint;
	if (!isAllowedEndpoint(url)) return noDecision("invalid_endpoint");
	const style = REQUEST_STYLES[provider.style];
	const timeoutMs = Math.max(1, Math.min(INVOCATION_BUDGET_MS, cfg.timeoutMs, timeoutLimitMs));
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (signal?.aborted) return noDecision("aborted");
	const composedSignal = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const wire = style.request({ model: cfg.model, apiKey: cfg.apiKey }, task.prompt);
	const headers = new URL(url).origin === "https://openrouter.ai" ? { ...wire.headers, ...ATTRIBUTION_HEADERS } : wire.headers;
	try {
		const response = await fetchImpl(url, {
			method: "POST",
			redirect: "error",
			headers,
			body: wire.body,
			signal: composedSignal,
		});
		if (!response?.ok) return noDecision("provider_error", Number.isInteger(response?.status) ? response.status : undefined);
		const text = await readBoundedResponse(response);
		if (text === null) return noDecision("invalid_response");
		let data: unknown;
		try { data = JSON.parse(text); } catch { return noDecision("invalid_response"); }
		const final = provider.style === "systemone" ? extractSystemoneFinal(data) : extractChatFinal(data);
		if (!final) return noDecision("invalid_response");
		return parseDecision(final, provider.style === "systemone" ? "provider_choice" : "self_reported");
	} catch {
		return timeoutDecision(signal, timeoutSignal);
	}
}

export function formatSummary(advice: Advice): string {
	if (advice.status === "no_decision") return `jev-advisor: no decision (${advice.reason})`;
	return `jev-advisor: tier=${advice.tier} confidence=${advice.confidence.toFixed(2)}`;
}

export const ENFORCE_GUIDANCE =
	"Re-issue this task call with the recommended tier, or set JEV_ADVISOR_MODE=hint for non-blocking advisories.";

// Keyless build. Activation: ~/.gjc/agent/jev-advisor/.env or JEV_ADVISOR_API_KEY /
// OPENROUTER_API_KEY env (env wins over the file), or JEV_ADVISOR_PROVIDER=ollaya (local, no key).

// Before-task advisory hook. Provider calls are task-scoped, sequential and
// bounded; persistent state is metadata-only and never supplies prompt evidence.

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	let lastReservedAt: number | null = null;
	api.on("tool_call", async (event, ctx) => {
		try {
			const call = isHookRecord(event) ? event : null;
			if (!call || call.type !== "tool_call" || call.toolName !== "task") return undefined;
			const invocationStartedAt = performance.now();
			const cfg = readConfig();
			const limits = storeLimits(cfg);
			const extraction = extractTasks(call.input, providerPromptLimit(cfg));
			const callId = boundedEventId(call.toolCallId);
			const sessionId = readSessionId(ctx);
			const configured = isConfigured(cfg);
			const persistent = cfg.memoryEnabled && configured && sessionId !== null && callId !== null;
			let storageUnavailable: string | null = null;
			const preparations = new Map<number, TaskPreparation>();
			if (cfg.memoryEnabled && configured && sessionId !== null && callId !== null && extraction.tasks.length > 0) {
				const prepared = await prepareTaskRecords(
					version2StateFile(cfg.stateFile),
					limits,
					sessionId,
					callId,
					extraction.tasks,
				);
				if (prepared.status === "ok") {
					for (const item of prepared.value) preparations.set(item.index, item);
				} else {
					storageUnavailable = prepared.reason;
				}
			}
			const adviceByIndex = new Map<number, Advice>();
			const needsAdvice: TaskInput[] = [];
			for (const task of extraction.tasks) {
				const prepared = preparations.get(task.index);
				if (prepared?.state === "conflict") {
					adviceByIndex.set(task.index, noDecision("invalid_task"));
				} else if (prepared?.state === "reused") {
					adviceByIndex.set(
						task.index,
						prepared.advice ?? noDecision("already_pending"),
					);
				} else if (!task.complete) {
					adviceByIndex.set(task.index, noDecision("input_too_large"));
				} else {
					needsAdvice.push(task);
				}
			}

			if (needsAdvice.length && !configured) {
				const reason: NoDecisionReason = cfg.provider === "off" ? "disabled" : "unconfigured";
				for (const task of needsAdvice) {
					const advice = noDecision(reason);
					adviceByIndex.set(task.index, advice);
					const writeFailure = await persistAdvice(cfg, sessionId, callId, task, preparations.get(task.index), advice);
					storageUnavailable ??= writeFailure;
				}
			} else if (needsAdvice.length && !isAllowedEndpoint(cfg.endpoint)) {
				for (const task of needsAdvice) {
					const advice = noDecision("invalid_endpoint");
					adviceByIndex.set(task.index, advice);
					const writeFailure = await persistAdvice(cfg, sessionId, callId, task, preparations.get(task.index), advice);
					storageUnavailable ??= writeFailure;
				}
			} else if (needsAdvice.length) {
				const admittedAt = performance.now();
				if (cfg.minIntervalMs > 0 && lastReservedAt !== null && admittedAt - lastReservedAt < cfg.minIntervalMs) {
					for (const task of needsAdvice) {
						const advice = noDecision("rate_limited");
						adviceByIndex.set(task.index, advice);
						const writeFailure = await persistAdvice(cfg, sessionId, callId, task, preparations.get(task.index), advice);
						storageUnavailable ??= writeFailure;
					}
				} else {
					// Reserve before the first provider await, including failed calls.
					lastReservedAt = admittedAt;
					const deadline = invocationStartedAt + INVOCATION_BUDGET_MS;
					const budgetSignal = AbortSignal.timeout(Math.max(1, deadline - admittedAt));
					let requests = 0;
					for (const task of needsAdvice) {
						let advice: Advice;
						const remaining = deadline - performance.now();
						if (requests >= MAX_PROVIDER_REQUESTS_PER_INVOCATION) {
						advice = noDecision("batch_limit");
						} else if (remaining <= 0 || budgetSignal.aborted) {
						advice = noDecision("budget_exceeded");
					} else {
						requests++;
						const ctxSignal = isHookRecord(ctx) && isAbortSignal(ctx.signal) ? ctx.signal : undefined;
						const signal = ctxSignal && typeof AbortSignal.any === "function"
							? AbortSignal.any([ctxSignal, budgetSignal])
							: budgetSignal;
						advice = await askDecisionModel(
							cfg,
							task,
							(input, init) => fetch(input, init),
							signal,
							Math.min(cfg.timeoutMs, remaining),
						);
					}
					adviceByIndex.set(task.index, advice);
					const writeFailure = await persistAdvice(cfg, sessionId, callId, task, preparations.get(task.index), advice);
					storageUnavailable ??= writeFailure;
				}
				}
			}

			for (const rejected of extraction.rejected) adviceByIndex.set(rejected.index, noDecision(rejected.reason));
			const ui = isHookRecord(ctx) && isHookRecord(ctx.ui) ? ctx.ui : undefined;
			const summary = summarizeTasks(extraction, adviceByIndex);
			if (storageUnavailable) summary.push(storageWarning(storageUnavailable));
			if (summary.length) {
				try {
					if (typeof ui?.setWidget === "function") ui.setWidget("jev-advisor", summary);
				} catch {}
			}
			if (storageUnavailable) notifyStorageUnavailable(ui, storageUnavailable);

			if (cfg.mode === "enforce") {
				const qualifying = extraction.tasks.find(task => {
					const advice = adviceByIndex.get(task.index);
					return task.complete && task.requestedTier !== null && advice?.status === "decision" &&
						advice.confidence >= cfg.minConfidence && tierRank(task.requestedTier) < tierRank(advice.tier);
				});
				if (qualifying) {
					if (persistent) {
						try {
							const marked = await markInvocationBlocked(version2StateFile(cfg.stateFile), limits, sessionId!, callId!);
							if (marked.status === "unavailable") storageUnavailable = marked.reason;
						} catch {
							storageUnavailable = "io_error";
						}
					}
					if (storageUnavailable) {
						try {
							if (typeof ui?.setWidget === "function") {
								ui.setWidget("jev-advisor", [...summary.filter(line => !line.startsWith("Evidence storage unavailable (")), storageWarning(storageUnavailable)]);
							}
						} catch {}
						notifyStorageUnavailable(ui, storageUnavailable);
					}
					const advice = adviceByIndex.get(qualifying.index) as Extract<Advice, { status: "decision" }>;
					return {
						block: true,
						reason: `jev-advisor: task ${qualifying.index} recommends ${advice.tier} (confidence=${advice.confidence.toFixed(2)}; requested ${qualifying.requestedTier}). ${ENFORCE_GUIDANCE}`,
					};
				}
			}
			if (cfg.mode !== "shadow" && summary.length) {
				try {
					if (typeof ui?.notify === "function") ui.notify(summary.join("\n").slice(0, 1800), cfg.mode === "enforce" ? "warning" : "info");
				} catch {}
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}

async function persistAdvice(
	cfg: AdvisorConfig,
	sessionId: string | null,
	callId: string | null,
	task: TaskInput,
	prepared: TaskPreparation | undefined,
	advice: Advice,
): Promise<string | null> {
	if (!cfg.memoryEnabled || !sessionId || !callId || prepared?.state !== "created" || !prepared.token) return null;
	try {
		const updated = await updateTaskAdvice(
			version2StateFile(cfg.stateFile),
			storeLimits(cfg),
			{ sessionId, toolCallId: callId, taskIndex: task.index },
			prepared.token,
			advice,
		);
		return updated.status === "unavailable" ? updated.reason : null;
	} catch {
		return "io_error";
	}
}

function storageWarning(reason: string): string {
	return `Evidence storage unavailable (${reason}); advice is not persistently correlated.`;
}

function notifyStorageUnavailable(ui: Record<string, any> | undefined, reason: string): void {
	const warning = storageWarning(reason).slice(0, 180);
	try {
		if (typeof ui?.setStatus === "function") ui.setStatus("jev-advisor", warning);
	} catch {}
	try {
		if (typeof ui?.notify === "function") ui.notify(warning, "warning");
	} catch {}
}

function boundedEventId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= 512 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return typeof value === "object" && value !== null && typeof (value as AbortSignal).aborted === "boolean";
}

function isHookRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}

function summarizeTasks(
	extraction: Extraction,
	advice: Map<number, Advice>,
): string[] {
	const lines: string[] = [];
	for (const task of extraction.tasks.slice(0, 20)) {
		const result = advice.get(task.index) ?? noDecision("already_pending");
		const label = task.callerId ? ` [${task.callerId.slice(0, 32)}]` : "";
		const requested = task.requestedTier ? `requested=${task.requestedTier}` : "requested=unspecified";
		const outcome = result.status === "decision"
			? `recommended=${result.tier} confidence=${result.confidence.toFixed(2)}`
			: `no decision (${result.reason})`;
		lines.push(`task ${task.index}${label}: ${requested}; ${outcome}`.slice(0, 180));
	}
	for (const rejected of extraction.rejected.slice(0, Math.max(0, 20 - lines.length))) {
		lines.push(`task ${rejected.index}: no decision (${rejected.reason})`);
	}
	if (extraction.omittedCount > 0) lines.push(`${extraction.omittedCount} additional tasks omitted (batch_limit)`);
	const remaining = Math.max(0, extraction.tasks.length + extraction.rejected.length - lines.length);
	if (remaining > 0) lines.push(`${remaining} task results omitted from this bounded summary`);
	const bounded = lines.join("\n").slice(0, 2200);
	return bounded ? [bounded] : [];
}
