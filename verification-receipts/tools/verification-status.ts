// GENERATED — edit lib/ and src/, then bun scripts/build.mjs. Keyless standalone tool.
/**
 * Shared contract for decision-endpoint calls.
 *
 * Every plugin that asks a decision model for a typed answer records the same
 * facts here: which provider and exact model id it may call, which endpoint is
 * allowed, which environment variable carries the credential, how confidence is
 * produced, and which answers mean "no decision" rather than a low score.
 *
 * The table is a record of verified provider facts, not a routing policy. A
 * candidate entry is not integrated anywhere until a consumer names it and its
 * envelope is verified against the provider; an unknown mapping is unavailable,
 * never an alias of another model.
 */

export type DecisionProviderStatus = "baseline" | "candidate_unverified";

export type DecisionProvider = {
	/** Stable contract id: `<vendor>/<model>` exactly as the provider names it. */
	id: string;
	provider: string;
	/** Exact model id sent in the request body. */
	model: string;
	endpoint: string;
	/** Credential environment variables, highest precedence first. */
	authEnv: readonly string[];
	status: DecisionProviderStatus;
	/** Published context window, kept beside the id and never appended to it. */
	contextTokens?: number;
	/** Consumers and limits recorded for this provider. */
	note: string;
};

export const DECISION_PROVIDERS: readonly DecisionProvider[] = [
	{
		id: "openrouter/typesafe/jev-1.13",
		provider: "openrouter",
		model: "typesafe/jev-1.13",
		endpoint: "https://openrouter.ai/api/alpha/decisions",
		authEnv: ["JEV_ADVISOR_API_KEY", "OPENROUTER_API_KEY"],
		status: "baseline",
		note: "Current advisor tier/check and verification adequacy baseline. OpenRouter's public catalog lists no per-token price for this alpha route, so no cost ceiling can be derived from it.",
	},
	{
		id: "opengateway/sionic-ai/jev-omni",
		provider: "opengateway",
		model: "sionic-ai/jev-omni",
		endpoint: "https://apis.opengateway.ai/v1/decisions",
		authEnv: ["OPEN_GATEWAY_API_KEY", "OPENAI_API_KEY"],
		status: "candidate_unverified",
		contextTokens: 32768,
		note: "Catalog candidate (openai-compatible decisions endpoint, input text/image/audio/video). Envelope and confidence semantics are not yet verified; unusable until a consumer verifies them.",
	},
	{
		id: "opengateway/sionic-ai/decider-4b",
		provider: "opengateway",
		model: "sionic-ai/decider-4b",
		endpoint: "https://apis.opengateway.ai/v1/decisions",
		authEnv: ["OPEN_GATEWAY_API_KEY", "OPENAI_API_KEY"],
		status: "candidate_unverified",
		contextTokens: 65536,
		note: "Catalog candidate (openai-compatible decisions endpoint, text input). Envelope and confidence semantics are not yet verified.",
	},
];

const DECISION_ORIGINS = new Set(["https://openrouter.ai", "https://apis.opengateway.ai", "https://api.typesafe.ai"]);
const DECISION_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * HTTPS origins allowed for a decision call, plus loopback for local fixtures.
 * A consumer may narrow the set to the providers it actually implements; it
 * never widens beyond the recorded contract.
 */
export function isAllowedDecisionEndpoint(endpoint: string, options: { origins?: readonly string[] } = {}): boolean {
	const origins = options.origins === undefined ? DECISION_ORIGINS : new Set(options.origins);
	try {
		const url = new URL(endpoint);
		if (url.username || url.password) return false;
		if (url.protocol === "https:") return origins.has(url.origin);
		if (url.protocol === "http:") return DECISION_LOOPBACK_HOSTS.has(url.hostname);
		return false;
	} catch {
		return false;
	}
}

export function decisionProvider(id: string): DecisionProvider | undefined {
	return DECISION_PROVIDERS.find(entry => entry.id === id);
}

/**
 * `provider_choice` means the provider itself reported the answer choice;
 * `self_reported` means the model stated a confidence in prose. They are never
 * merged into one comparable probability.
 */
export const CONFIDENCE_KINDS = ["provider_choice", "self_reported"] as const;
export type DecisionConfidenceKind = (typeof CONFIDENCE_KINDS)[number];

/** Deterministic outcomes that are not a decision, and never a scoring signal. */
export const NO_DECISION_REASONS = [
	"off",
	"missing_key",
	"missing_context",
	"insufficient_evidence",
	"invalid_context",
	"invalid_facts",
	"invalid_answer",
	"request_cap",
	"response_cap",
	"redirect",
	"timeout",
	"transport",
	"http_auth",
	"http_credit",
	"http_rate",
	"http_server",
	"http_error",
] as const;
export type DecisionNoDecisionReason = (typeof NO_DECISION_REASONS)[number];

export type ProbabilityCheck =
	| { ok: true; probabilities: Record<string, number> }
	| { ok: false; reason: "not_object" | "unknown_label" | "out_of_range" | "missing_label" | "sum" };

/**
 * Validate a choice distribution. `complete` requires every label exactly once
 * and a normalised sum; without it, a partial map is accepted as long as each
 * value is a finite probability in [0, 1] and a supplied subset sums to <= 1.
 */
export function validateProbabilityMap(labels: readonly string[], value: unknown, options: { complete?: boolean } = {}): ProbabilityCheck {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "not_object" };
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) return { ok: false, reason: "missing_label" };
	const probabilities: Record<string, number> = {};
	for (const [label, raw] of entries) {
		if (!labels.includes(label)) return { ok: false, reason: "unknown_label" };
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) return { ok: false, reason: "out_of_range" };
		probabilities[label] = raw;
	}
	if (options.complete && labels.some(label => probabilities[label] === undefined)) return { ok: false, reason: "missing_label" };
	const total = Object.values(probabilities).reduce((sum, number) => sum + number, 0);
	if (options.complete ? Math.abs(total - 1) > 1e-6 : total > 1 + 1e-6) return { ok: false, reason: "sum" };
	return { ok: true, probabilities };
}

import { constants as resultsConstants, promises as resultsFs } from 'node:fs';
import type { Stats as ResultsStats } from 'node:fs';
import type { FileHandle as ResultsFileHandle } from 'node:fs/promises';
import { homedir as resultsHomedir } from 'node:os';
import { dirname as resultsDirname, join as resultsJoin, parse as resultsParse, resolve as resultsResolve, sep as resultsSep } from 'node:path';
import { createHash as resultsHash, randomUUID as resultsUUID } from 'node:crypto';
import { performance as resultsClock } from 'node:perf_hooks';

export type PluginOutcome = {
  operation: 'run' | 'status' | 'advise' | 'calibration' | 'check' | 'task_advice' | 'task_launch' | 'subagent_terminal' | 'wiki_query' | 'wiki_propose' | 'rea_readiness' | 'backplan_check' | 'gate_emitted' | 'loop_run' | 'capture' | 'import' | 'dream';
  repositoryDigest?: string | null;
  receiptId?: string | null;
  toolCallDigest?: string;
  durationMs?: number;
  freshness?: 'fresh' | 'stale' | 'changed_during_run' | 'unavailable';
  stateOverrideIgnored?: boolean;
  execution?: { status: string; reason: string; counts?: Record<string, number> | null; assertions?: { step: number; id: string; kind: string; status: string }[]; cleanup?: string };
  assessment?: { status: string; reason: string; answers?: { coverage_alignment: { type: 'choice'; choice: string; confidence?: number; probabilities?: Partial<Record<string, number>> }; boundary_evidence: { type: 'choice'; choice: string; confidence?: number; probabilities?: Partial<Record<string, number>> } } };
  advice?: { status: string; tier?: string; confidence?: number; confidenceKind?: string; probabilities?: Record<string, number>; reason?: string };
  check?: { status: string; verdict?: string; confidence?: number; confidenceKind?: string; probabilities?: Record<string, number>; reason?: string };
  taskAdvice?: { index:number; status:string; tier?:string; confidence?:number; basis?:string; reason?:string }[];
  evidenceObservations?: {completed:number;failed:number;cancelled:number;stored:number;unavailable:number};
  receiptStorage?: { persisted: boolean; reason: string; count?: number; bytes?: number; nearCapacity?: boolean };
  evidenceStorage?: { status: string; reason?: string };
  gate?: { trigger: 'task' | 'task_async' | 'subagent_terminal' | 'job_terminal'; facts: 'available' | 'partial' | 'unavailable'; baselinePresent: boolean; binding: 'none' | 'bound' | 'unknown'; stateWrite: 'ok' | 'drop'; persistence?: 'applied' | 'no_changes' | 'recovery_available'; changedFiles: number; commits?: number; receiptState: 'none' | 'present' | 'fresh_passed' | 'unavailable' };
  loop?: { status: 'clean' | 'gaps' | 'blocked'; openGates: number; resolvedGates: number; scannedSessionFiles: number; scanTruncated: boolean; silentPending: number; gapKinds: LoopGapKind[] };
  rrsi?: { action: RrsiAction; episodes?: number; attempts?: number; imported?: number; policies?: number; storage: 'ok' | 'missing' | 'unavailable' | 'invalid' };
};
export type RrsiAction = 'capture' | 'import' | 'dream' | 'status';
export type LoopGapKind = 'no_receipt_after_gate' | 'receipt_not_passed' | 'receipt_no_tests' | 'receipt_incomplete' | 'receipt_stale' | 'receipt_changed_during_run' | 'receipt_freshness_unavailable' | 'changed_test_uncovered' | 'state_unavailable' | 'not_a_repository';
type ResultsPlugin = 'jev-advisor' | 'verification-receipts' | 'ui-regression' | 'wiki' | 'rea' | 'backplan' | 'rrsi';
type ResultsAppend = { persisted: boolean; reason: string; id?: string; rotated?: number; retainedSegments?: number };
type ResultsDependencies = { baseDir?: string; maxRecordBytes?: number; maxSegmentBytes?: number; maxSegments?: number; lockTimeoutMs?: number };
const resultsPlugins = ['jev-advisor', 'verification-receipts', 'ui-regression', 'wiki', 'rea', 'backplan', 'rrsi'];
const resultsOperations = ['run', 'status', 'advise', 'calibration', 'check', 'task_advice', 'task_launch', 'subagent_terminal', 'wiki_query', 'wiki_propose', 'rea_readiness', 'backplan_check', 'gate_emitted', 'loop_run', 'capture', 'import', 'dream'];
const resultsRrsiActions = ['capture', 'import', 'dream', 'status'];
const resultsGapKinds = ['no_receipt_after_gate', 'receipt_not_passed', 'receipt_no_tests', 'receipt_incomplete', 'receipt_stale', 'receipt_changed_during_run', 'receipt_freshness_unavailable', 'changed_test_uncovered', 'state_unavailable', 'not_a_repository'];
const resultsHex = /^[a-f0-9]{64}$/;
const resultsId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const resultsCountKeys = ['tests', 'suites', 'topLevel', 'passed', 'failed', 'skipped', 'todo', 'cancelled'];
const resultsExecutionReasons = [
  'not_run', 'invalid_or_unavailable_input', 'receipt_unavailable', 'invalid_file_count', 'invalid_root', 'invalid_test_path',
  'path_escape', 'symlink_test_path', 'invalid_test_file', 'missing_test_file', 'duplicate_test_file', 'invalid_timeout',
  'cancelled', 'process_groups_unavailable', 'node_unavailable', 'invalid_node_version', 'unsupported_node_version',
  'cleanup_unresolved', 'cleanup_unconfirmed', 'timeout', 'output_limit', 'spawn_unavailable', 'missing_summary',
  'invalid_summary_frame', 'runner_crash', 'native_failure', 'no_actual_passes', 'native_success', 'runner_setup_failed',
  'complete', 'origin_drift', 'missing_target', 'ambiguous_target', 'hidden_target', 'assertion_failed', 'unsupported_control',
  'runtime_error', 'missing_observations', 'output_overflow', 'malformed_observations', 'runner_exit', 'partial_observations',
  'missing_account', 'unsafe_lock', 'busy', 'lock_unavailable', 'runner_signal', 'missing_cli', 'runner_unavailable',
];
const resultsAssessmentReasons = ['scored', 'optional_scores_missing', 'unknown_choice', 'missing_context', 'insufficient_evidence', 'invalid_context', 'invalid_facts', 'off', 'missing_key', 'request_cap', 'response_cap', 'invalid_answer', 'http_auth', 'http_credit', 'http_rate', 'http_server', 'http_error', 'redirect', 'timeout', 'transport'];
const resultsAdviceReasons = ['invalid_task', 'unsupported_input', 'input_too_large', 'batch_limit', 'disabled', 'unconfigured', 'invalid_endpoint', 'rate_limited', 'budget_exceeded', 'already_pending', 'timeout', 'aborted', 'provider_error', 'invalid_response'];
const resultsReceiptReasons = ['stored', 'invalid_metadata', 'store_busy', 'store_corrupt', 'store_full', 'store_unavailable', 'no_receipt', 'not_requested'];
const resultsEvidenceReasons = ['locked', 'corrupt', 'unsupported_version', 'oversized', 'unsafe_path', 'io_error', 'invalid_input'];

function resultsFail(reason: string): never { throw new Error(reason); }
function resultsObject(value: unknown, keys: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) resultsFail('invalid_metadata');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))) resultsFail('invalid_metadata');
  const projected: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor) || !descriptor.enumerable) resultsFail('invalid_metadata');
    if (descriptor.value !== undefined) projected[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(projected, key))) resultsFail('invalid_metadata');
  return projected;
}
function resultsEnum(value: unknown, choices: readonly string[]): string {
  if (typeof value !== 'string' || !choices.includes(value)) resultsFail('invalid_metadata');
  return value;
}
function resultsInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) resultsFail('invalid_metadata');
  return value;
}
function resultsBoolean(value: unknown): boolean { if (typeof value !== 'boolean') resultsFail('invalid_metadata'); return value; }
function resultsProbability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) resultsFail('invalid_metadata');
  return value;
}
function resultsPattern(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) resultsFail('invalid_metadata'); return value; }
function resultsArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) resultsFail('invalid_metadata');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) resultsFail('invalid_metadata');
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) resultsFail('invalid_metadata');
    output.push(descriptor.value);
  }
  return output;
}
function resultsChoice(value: unknown, labels: readonly string[]): Record<string, unknown> {
  const raw = resultsObject(value, ['type', 'choice', 'confidence', 'probabilities'], ['type', 'choice']);
  const output: Record<string, unknown> = { type: resultsEnum(raw.type, ['choice']), choice: resultsEnum(raw.choice, labels) };
  if (raw.confidence !== undefined) output.confidence = resultsProbability(raw.confidence);
  if (raw.probabilities !== undefined) {
    const probabilities = resultsObject(raw.probabilities, labels);
    output.probabilities = Object.fromEntries(Object.entries(probabilities).map(([label, probability]) => [label, resultsProbability(probability)]));
  }
  return output;
}
function resultsAdvice(value:unknown):Record<string,unknown> {
  const a = resultsObject(value, ['status', 'tier', 'confidence', 'confidenceKind', 'probabilities', 'reason'], ['status']);
  const advice: Record<string, unknown> = { status: resultsEnum(a.status, ['decision', 'no_decision']) };
  if (a.tier !== undefined) advice.tier = resultsEnum(a.tier, ['fast', 'balanced', 'strong']);
  if (a.confidence !== undefined) advice.confidence = resultsProbability(a.confidence);
  if (a.confidenceKind !== undefined) advice.confidenceKind = resultsEnum(a.confidenceKind, ['provider_choice', 'self_reported']);
  if (a.probabilities !== undefined) {
    const probabilities = resultsObject(a.probabilities, ['fast', 'balanced', 'strong'], ['fast', 'balanced', 'strong']);
    advice.probabilities = Object.fromEntries(Object.entries(probabilities).map(([tier, probability]) => [tier, resultsProbability(probability)]));
  }
  if (a.reason !== undefined) advice.reason = resultsEnum(a.reason, resultsAdviceReasons);
  return advice;
}
const resultsCheckVerdicts = ['correct', 'incorrect', 'unsure'];
function resultsCheck(value: unknown): Record<string, unknown> {
  const c = resultsObject(value, ['status', 'verdict', 'confidence', 'confidenceKind', 'probabilities', 'reason'], ['status']);
  const check: Record<string, unknown> = { status: resultsEnum(c.status, ['decision', 'no_decision']) };
  if (c.verdict !== undefined) check.verdict = resultsEnum(c.verdict, resultsCheckVerdicts);
  if (c.confidence !== undefined) check.confidence = resultsProbability(c.confidence);
  if (c.confidenceKind !== undefined) check.confidenceKind = resultsEnum(c.confidenceKind, ['provider_choice', 'self_reported']);
  if (c.probabilities !== undefined) {
    const probabilities = resultsObject(c.probabilities, resultsCheckVerdicts, resultsCheckVerdicts);
    check.probabilities = Object.fromEntries(Object.entries(probabilities).map(([verdict, probability]) => [verdict, resultsProbability(probability)]));
  }
  if (c.reason !== undefined) check.reason = resultsEnum(c.reason, resultsAdviceReasons);
  return check;
}
function resultsGate(value: unknown): Record<string, unknown> {
  const g = resultsObject(value, ['trigger', 'facts', 'baselinePresent', 'binding', 'stateWrite', 'persistence', 'changedFiles', 'commits', 'receiptState'], ['trigger', 'facts', 'baselinePresent', 'binding', 'stateWrite', 'changedFiles', 'receiptState']);
  const gate: Record<string, unknown> = {
    trigger: resultsEnum(g.trigger, ['task', 'task_async', 'subagent_terminal', 'job_terminal']),
    facts: resultsEnum(g.facts, ['available', 'partial', 'unavailable']),
    baselinePresent: resultsBoolean(g.baselinePresent),
    binding: resultsEnum(g.binding, ['none', 'bound', 'unknown']),
    stateWrite: resultsEnum(g.stateWrite, ['ok', 'drop']),
    changedFiles: resultsInteger(g.changedFiles, 100000),
    receiptState: resultsEnum(g.receiptState, ['none', 'present', 'fresh_passed', 'unavailable']),
  };
  if (g.persistence !== undefined) gate.persistence = resultsEnum(g.persistence, ['applied', 'no_changes', 'recovery_available']);
  if (g.commits !== undefined) gate.commits = resultsInteger(g.commits, 100000);
  return gate;
}
function resultsLoop(value: unknown): Record<string, unknown> {
  const l = resultsObject(value, ['status', 'openGates', 'resolvedGates', 'scannedSessionFiles', 'scanTruncated', 'silentPending', 'gapKinds'], ['status', 'openGates', 'resolvedGates', 'scannedSessionFiles', 'scanTruncated', 'silentPending', 'gapKinds']);
  const loop: Record<string, unknown> = {
    status: resultsEnum(l.status, ['clean', 'gaps', 'blocked']),
    openGates: resultsInteger(l.openGates, 10000),
    resolvedGates: resultsInteger(l.resolvedGates, 10000),
    scannedSessionFiles: resultsInteger(l.scannedSessionFiles, 1000),
    scanTruncated: resultsBoolean(l.scanTruncated),
    silentPending: resultsInteger(l.silentPending, 10000),
    gapKinds: resultsArray(l.gapKinds, 10).map(value => resultsEnum(value, resultsGapKinds)),
  };
  return loop;
}
function resultsProject(value: unknown): Record<string, unknown> {
  const raw = resultsObject(value, ['operation', 'repositoryDigest', 'receiptId', 'toolCallDigest', 'durationMs', 'freshness', 'stateOverrideIgnored', 'execution', 'assessment', 'advice', 'check', 'taskAdvice', 'evidenceObservations', 'receiptStorage', 'evidenceStorage', 'gate', 'loop', 'rrsi'], ['operation']);
  const output: Record<string, unknown> = { operation: resultsEnum(raw.operation, resultsOperations) };
  for (const key of ['repositoryDigest', 'receiptId']) if (raw[key] !== undefined) output[key] = raw[key] === null ? null : resultsPattern(raw[key], key === 'receiptId' ? resultsId : resultsHex);
  if (raw.toolCallDigest !== undefined) output.toolCallDigest = resultsPattern(raw.toolCallDigest, resultsHex);
  if (raw.durationMs !== undefined) output.durationMs = resultsInteger(raw.durationMs);
  if (raw.freshness !== undefined) output.freshness = resultsEnum(raw.freshness, ['fresh', 'stale', 'changed_during_run', 'unavailable']);
  if (raw.stateOverrideIgnored !== undefined) output.stateOverrideIgnored = resultsBoolean(raw.stateOverrideIgnored);
  if (raw.execution !== undefined) {
    const ex = resultsObject(raw.execution, ['status', 'reason', 'counts', 'assertions', 'cleanup'], ['status', 'reason']);
    const execution: Record<string, unknown> = { status: resultsEnum(ex.status, ['passed', 'failed', 'no_tests', 'incomplete', 'not_run', 'unavailable']), reason: resultsEnum(ex.reason, resultsExecutionReasons) };
    if (ex.counts !== undefined) {
      const counts = ex.counts === null ? null : resultsObject(ex.counts, resultsCountKeys, resultsCountKeys);
      execution.counts = counts === null ? null : Object.fromEntries(resultsCountKeys.map(key => [key, resultsInteger(counts[key], 10000)]));
    }
    if (ex.cleanup !== undefined) execution.cleanup = resultsEnum(ex.cleanup, ['confirmed', 'unconfirmed']);
    if (ex.assertions !== undefined) {
      const seen = new Set<number>();
      execution.assertions = resultsArray(ex.assertions, 20).map(value => {
        const assertion = resultsObject(value, ['step', 'id', 'kind', 'status'], ['step', 'id', 'kind', 'status']);
        const step = resultsInteger(assertion.step, 19);
        if (seen.has(step) || assertion.id !== 'step-' + step) resultsFail('invalid_metadata');
        seen.add(step);
        return { step, id: 'step-' + step, kind: resultsEnum(assertion.kind, ['visible', 'text_exact', 'text_substring']), status: resultsEnum(assertion.status, ['passed', 'failed']) };
      });
    }
    output.execution = execution;
  }
  if (raw.assessment !== undefined) {
    const a = resultsObject(raw.assessment, ['status', 'reason', 'answers'], ['status', 'reason']);
    const assessment: Record<string, unknown> = { status: resultsEnum(a.status, ['scored', 'unscored', 'unknown', 'unavailable', 'invalid_input', 'invalid_response']), reason: resultsEnum(a.reason, resultsAssessmentReasons) };
    if (a.answers !== undefined) {
      const answers = resultsObject(a.answers, ['coverage_alignment', 'boundary_evidence'], ['coverage_alignment', 'boundary_evidence']);
      assessment.answers = { coverage_alignment: resultsChoice(answers.coverage_alignment, ['aligned', 'gap', 'none', 'unknown']), boundary_evidence: resultsChoice(answers.boundary_evidence, ['present', 'missing', 'none', 'unknown']) };
    }
    output.assessment = assessment;
  }
  if (raw.advice !== undefined) output.advice = resultsAdvice(raw.advice);
  if (raw.check !== undefined) output.check = resultsCheck(raw.check);
  if (raw.taskAdvice !== undefined) {
    const seen = new Set<number>();
    output.taskAdvice = resultsArray(raw.taskAdvice,32).map(value=>{
      const task=resultsObject(value,['index','status','tier','confidence','basis','reason'],['index','status']);
      const index=resultsInteger(task.index,31);if(seen.has(index))resultsFail('invalid_metadata');seen.add(index);
      // The compact batch field keeps all32 full-precision decisions within the 4KiB record budget.
      const {index:rawIndex,basis,...advice}=task;
      const {confidenceKind,...projected}=resultsAdvice({...advice,...(basis!==undefined?{confidenceKind:basis}:{})});
      return {index,...projected,...(confidenceKind!==undefined?{basis:confidenceKind}:{})};
    });
  }
  if (raw.evidenceObservations !== undefined) {
    const keys=['completed','failed','cancelled','stored','unavailable'];
    const counts=resultsObject(raw.evidenceObservations,keys,keys);
    output.evidenceObservations=Object.fromEntries(keys.map(key=>[key,resultsInteger(counts[key])]));
  }
  if (raw.receiptStorage !== undefined) {
    const s = resultsObject(raw.receiptStorage, ['persisted', 'reason', 'count', 'bytes', 'nearCapacity'], ['persisted', 'reason']);
    const storage: Record<string, unknown> = { persisted: resultsBoolean(s.persisted), reason: resultsEnum(s.reason, resultsReceiptReasons) };
    for (const key of ['count', 'bytes']) if (s[key] !== undefined) storage[key] = resultsInteger(s[key]);
    if (s.nearCapacity !== undefined) storage.nearCapacity = resultsBoolean(s.nearCapacity);
    output.receiptStorage = storage;
  }
  if (raw.evidenceStorage !== undefined) {
    const s = resultsObject(raw.evidenceStorage, ['status', 'reason'], ['status']);
    const storage: Record<string, unknown> = { status: resultsEnum(s.status, ['ok', 'missing', 'unavailable', 'disabled', 'not_requested']) };
    if (s.reason !== undefined) storage.reason = resultsEnum(s.reason, resultsEvidenceReasons);
    output.evidenceStorage = storage;
  }
  if (raw.gate !== undefined) output.gate = resultsGate(raw.gate);
  if (raw.loop !== undefined) output.loop = resultsLoop(raw.loop);
  if (raw.rrsi !== undefined) {
    const r = resultsObject(raw.rrsi, ['action', 'episodes', 'attempts', 'imported', 'policies', 'storage'], ['action', 'storage']);
    const rrsi: Record<string, unknown> = {
      action: resultsEnum(r.action, resultsRrsiActions),
      storage: resultsEnum(r.storage, ['ok', 'missing', 'unavailable', 'invalid']),
    };
    for (const key of ['episodes', 'attempts', 'imported', 'policies']) {
      if (r[key] !== undefined) rrsi[key] = resultsInteger(r[key], 100000);
    }
    output.rrsi = rrsi;
  }
  return output;
}

export function pluginResultsRoot(): string {
  // Bun can cache os.homedir across HOME changes; honor the process-owned home for isolated consumers.
  const home = process.env.HOME || resultsHomedir();
  return resultsJoin(home, '.gjc-plugin');
}
type ResultsDirectory = { path: string; info: ResultsStats };
function resultsSame(a: ResultsStats, b: ResultsStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode; }
function resultsPrivateFile(info: ResultsStats, allowReleased = false): void {
  const links = info.nlink === 1 || (allowReleased && info.nlink === 0);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600 || !links) resultsFail('unsafe_path');
}
async function resultsCheckFile(file: string, expected: ResultsStats): Promise<ResultsStats> {
  const current = await resultsFs.lstat(file);
  resultsPrivateFile(current);
  if (!resultsSame(expected, current)) resultsFail('unsafe_path');
  return current;
}
function resultsPrivateBoundary(dir: string): string {
  const absolute = resultsResolve(dir);
  const parts = absolute.slice(resultsParse(absolute).root.length).split(resultsSep);
  const index = parts.indexOf('.gjc-plugin');
  return index < 0 ? absolute : resultsJoin(resultsParse(absolute).root, ...parts.slice(0, index + 1));
}
async function resultsCheckDirectories(entries: ResultsDirectory[]): Promise<void> {
  for (const entry of entries) {
    const now = await resultsFs.lstat(entry.path);
    if (!now.isDirectory() || now.isSymbolicLink() || !resultsSame(entry.info, now)) resultsFail('unsafe_path');
  }
}
async function resultsDirectories(dir: string, create: boolean, boundary = resultsPrivateBoundary(dir)): Promise<ResultsDirectory[]> {
  if (typeof dir !== 'string' || dir.includes('\0') || dir.split(resultsSep).includes('..')) resultsFail('unsafe_path');
  const absolute = resultsResolve(dir);
  boundary = resultsResolve(boundary);
  if (absolute !== boundary && !absolute.startsWith(boundary + resultsSep)) resultsFail('unsafe_path');
  const root = resultsParse(absolute).root;
  const paths = [root];
  let current = root;
  for (const part of absolute.slice(root.length).split(resultsSep).filter(Boolean)) { current = resultsJoin(current, part); paths.push(current); }
  const entries: ResultsDirectory[] = [];
  for (const path of paths) {
    const privatePath = path === boundary || path.startsWith(boundary + resultsSep);
    let info: ResultsStats;
    try { info = await resultsFs.lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create || !privatePath) throw error;
      await resultsCheckDirectories(entries);
      try { await resultsFs.mkdir(path, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      info = await resultsFs.lstat(path);
      // A concurrent creator is subject to the same ownership/mode checks, never repaired.
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (privatePath && (info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700))) resultsFail('unsafe_path');
    const handle = await resultsFs.open(path, resultsConstants.O_RDONLY | resultsConstants.O_DIRECTORY | resultsConstants.O_NOFOLLOW);
    try { if (!resultsSame(info, await handle.stat())) resultsFail('unsafe_path'); }
    finally { await handle.close(); }
    entries.push({ path, info });
  }
  await resultsCheckDirectories(entries);
  return entries;
}
export async function ensurePrivateResultDirectory(dir: string, create = true): Promise<void> { await resultsDirectories(dir, create); }
async function resultsOpenChecked(file: string, flags: number, directories: ResultsDirectory[]): Promise<ResultsFileHandle> {
  await resultsCheckDirectories(directories);
  const before = await resultsFs.lstat(file);
  resultsPrivateFile(before);
  const handle = await resultsFs.open(file, flags | resultsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    resultsPrivateFile(opened);
    if (!resultsSame(before, opened)) resultsFail('unsafe_path');
    await resultsCheckFile(file, opened);
    await resultsCheckDirectories(directories);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
// Read-only probe of a foreign lock during the bounded wait. A generation change
// between observations is ordinary contention — the holder released and the next
// waiter recreated the lock — so this probe never re-validates the live path:
// it adopts and mutates nothing, and identity is enforced strictly only once this
// process actually holds the lock. A link count of zero is the same contention:
// the holder unlinked its lock while this probe observed it. Unsafe plants
// (symlink, foreign owner, wrong mode, extra links) still fail closed.
async function resultsProbeBusyLock(file: string): Promise<void> {
  resultsPrivateFile(await resultsFs.lstat(file), true);
  const handle = await resultsFs.open(file, resultsConstants.O_RDONLY | resultsConstants.O_NOFOLLOW);
  try { resultsPrivateFile(await handle.stat(), true); }
  finally { await handle.close(); }
}
export async function readPrivateResultFile(file: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) resultsFail('resource_limit');
  const directories = await resultsDirectories(resultsDirname(file), false);
  const handle = await resultsOpenChecked(file, resultsConstants.O_RDONLY, directories);
  try {
    const before = await handle.stat();
    resultsPrivateFile(before);
    if (before.size > maxBytes) resultsFail('resource_limit');
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    resultsPrivateFile(after);
    if (!resultsSame(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || offset !== before.size) resultsFail('unsafe_path');
    const current = await resultsCheckFile(file, after);
    if (after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) resultsFail('unsafe_path');
    await resultsCheckDirectories(directories);
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
async function resultsSyncDirectory(path: string, directories: ResultsDirectory[]): Promise<void> {
  await resultsCheckDirectories(directories);
  const handle = await resultsFs.open(path, resultsConstants.O_RDONLY | resultsConstants.O_DIRECTORY | resultsConstants.O_NOFOLLOW);
  try {
    const expected = directories.find(entry => entry.path === path);
    if (!expected || !resultsSame(expected.info, await handle.stat())) resultsFail('unsafe_path');
    await handle.sync();
  } finally { await handle.close(); }
  await resultsCheckDirectories(directories);
}
async function resultsCreate(file: string, body: string, directories: ResultsDirectory[]): Promise<ResultsStats> {
  await resultsCheckDirectories(directories);
  const handle = await resultsFs.open(file, resultsConstants.O_WRONLY | resultsConstants.O_CREAT | resultsConstants.O_EXCL | resultsConstants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat(); resultsPrivateFile(info);
    await resultsCheckFile(file, info);
    await resultsCheckDirectories(directories);
    await handle.writeFile(body); await handle.sync();
    const after = await handle.stat(); resultsPrivateFile(after);
    if (!resultsSame(info, after) || after.size !== Buffer.byteLength(body)) resultsFail('unsafe_path');
    await resultsCheckFile(file, after);
    await resultsCheckDirectories(directories);
    return after;
  } finally { await handle.close(); }
}
type ResultsSegment = { name: string; bytes: number; digest: string };
type ResultsInventory = { schemaVersion: 1; plugin: ResultsPlugin; owner: string; next: number; segments: ResultsSegment[] };
function resultsDigest(body: string | Buffer): string { return resultsHash('sha256').update(body).digest('hex'); }
function resultsInventory(value: unknown, plugin: ResultsPlugin, maxSegments: number, maxSegmentBytes: number): ResultsInventory {
  const raw = resultsObject(value, ['schemaVersion', 'plugin', 'owner', 'next', 'segments'], ['schemaVersion', 'plugin', 'owner', 'next', 'segments']);
  if (raw.schemaVersion !== 1 || raw.plugin !== plugin) resultsFail('store_corrupt');
  const owner = resultsPattern(raw.owner, resultsId);
  const next = resultsInteger(raw.next);
  const segments = resultsArray(raw.segments, maxSegments).map(value => {
    const s = resultsObject(value, ['name', 'bytes', 'digest'], ['name', 'bytes', 'digest']);
    if (typeof s.name !== 'string') resultsFail('store_corrupt');
    return { name: s.name, bytes: resultsInteger(s.bytes, maxSegmentBytes), digest: resultsPattern(s.digest, resultsHex) };
  });
  if (!segments.length || next < segments.length || segments.some((s, i) => s.name !== `${owner}-${next - segments.length + i}.jsonl` || s.bytes === 0)) resultsFail('store_corrupt');
  return { schemaVersion: 1, plugin, owner, next, segments };
}
type ResultsDecodedRecord = { id: string; observedAt: string; record: Record<string, unknown> };
// The single canonical decoder. The writer and the snapshot reader share this
// exact projection, so the reader never keeps a second permissive parser.
function resultsDecodeSegment(body: Buffer, plugin: ResultsPlugin, maxRecordBytes: number): ResultsDecodedRecord[] {
  const text = body.toString('utf8');
  if (!text.endsWith('\n')) resultsFail('store_corrupt');
  const decoded: ResultsDecodedRecord[] = [];
  for (const line of text.slice(0, -1).split('\n')) {
    if (Buffer.byteLength(line + '\n') > maxRecordBytes) resultsFail('store_corrupt');
    const raw = JSON.parse(line);
    const record = resultsObject(raw, ['schemaVersion', 'plugin', 'id', 'observedAt', 'operation', 'repositoryDigest', 'receiptId', 'toolCallDigest', 'durationMs', 'freshness', 'stateOverrideIgnored', 'execution', 'assessment', 'advice', 'check', 'taskAdvice', 'evidenceObservations', 'receiptStorage', 'evidenceStorage', 'gate', 'loop', 'rrsi'], ['schemaVersion', 'plugin', 'id', 'observedAt', 'operation']);
    if (record.schemaVersion !== 1 || record.plugin !== plugin) resultsFail('store_corrupt');
    const id = resultsPattern(record.id, resultsId);
    if (typeof record.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.observedAt) || !Number.isFinite(Date.parse(record.observedAt))) resultsFail('store_corrupt');
    const { schemaVersion, plugin: storedPlugin, id: storedId, observedAt, ...outcome } = record;
    const canonical = { schemaVersion, plugin: storedPlugin, id: storedId, observedAt, ...resultsProject(outcome) };
    if (JSON.stringify(canonical) !== line) resultsFail('store_corrupt');
    decoded.push({ id, observedAt, record: canonical });
  }
  return decoded;
}
function resultsValidateSegment(body: Buffer, plugin: ResultsPlugin, maxRecordBytes: number): void { resultsDecodeSegment(body, plugin, maxRecordBytes); }
function resultsFailure(error: unknown): ResultsAppend {
  const reason = error instanceof Error ? error.message : '';
  return { persisted: false, reason: ['unsafe_path', 'resource_limit', 'store_corrupt', 'store_busy'].includes(reason) ? reason : 'store_unavailable' };
}

/** Append metadata only. A partial publication is deliberately not repaired or adopted. */
export async function appendPluginOutcome(plugin: ResultsPlugin, outcome: PluginOutcome, deps: ResultsDependencies = {}): Promise<ResultsAppend> {
  let projected: Record<string, unknown>;
  try { resultsEnum(plugin, resultsPlugins); projected = resultsProject(outcome); }
  catch { return { persisted: false, reason: 'invalid_metadata' }; }
  const maxRecordBytes = deps.maxRecordBytes ?? 4096;
  const maxSegmentBytes = deps.maxSegmentBytes ?? 1024 * 1024;
  const maxSegments = deps.maxSegments ?? 8;
  const lockTimeoutMs = deps.lockTimeoutMs ?? 100;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 || maxRecordBytes > 4096 || !Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 1 || maxSegmentBytes > 1024 * 1024 || !Number.isSafeInteger(maxSegments) || maxSegments < 1 || maxSegments > 8 || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 100) return { persisted: false, reason: 'invalid_limits' };
  const id = resultsUUID();
  const body = JSON.stringify({ schemaVersion: 1, plugin, id, observedAt: new Date().toISOString(), ...projected }) + '\n';
  const size = Buffer.byteLength(body);
  if (size > maxRecordBytes || size > maxSegmentBytes) return { persisted: false, reason: 'record_too_large' };
  const base = resultsResolve(deps.baseDir ?? pluginResultsRoot());
  const dir = resultsJoin(base, plugin, 'journal', 'v1');
  const lockPath = resultsJoin(dir, '.append.lock');
  let directories: ResultsDirectory[] = [];
  let lock: ResultsFileHandle | undefined;
  let lockInfo: ResultsStats | undefined;
  let result: ResultsAppend = { persisted: false, reason: 'store_unavailable' };
  try {
    directories = await resultsDirectories(dir, true, base);
    const deadline = resultsClock.now() + lockTimeoutMs;
    while (!lock) {
      await resultsCheckDirectories(directories);
      try { lock = await resultsFs.open(lockPath, resultsConstants.O_WRONLY | resultsConstants.O_CREAT | resultsConstants.O_EXCL | resultsConstants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try { await resultsProbeBusyLock(lockPath); }
        catch (checkError) { if ((checkError as NodeJS.ErrnoException).code !== 'ENOENT') throw checkError; }
        if (resultsClock.now() >= deadline) resultsFail('store_busy');
        await new Promise(resolve => setTimeout(resolve, Math.min(5, Math.max(0, deadline - resultsClock.now()))));
      }
    }
    lockInfo = await lock.stat(); resultsPrivateFile(lockInfo);
    await resultsCheckFile(lockPath, lockInfo);
    await resultsCheckDirectories(directories);
    await lock.sync();
    const names: string[] = [];
    const listing = await resultsFs.opendir(dir);
    for await (const entry of listing) {
      names.push(entry.name);
      if (names.length > maxSegments + 2) resultsFail('store_corrupt');
    }
    const markerPath = resultsJoin(dir, 'inventory.json');
    let inventory: ResultsInventory;
    let activeBody = Buffer.alloc(0);
    let markerInfo: ResultsStats | undefined;
    if (names.length === 1 && names[0] === '.append.lock') {
      inventory = { schemaVersion: 1, plugin, owner: resultsUUID(), next: 0, segments: [] };
    } else {
      if (!names.includes('inventory.json')) resultsFail('store_corrupt');
      try { inventory = resultsInventory(JSON.parse((await readPrivateResultFile(markerPath, 8192)).toString('utf8')), plugin, maxSegments, maxSegmentBytes); }
      catch (error) { if (error instanceof Error && error.message === 'unsafe_path') throw error; resultsFail('store_corrupt'); }
      markerInfo = await resultsFs.lstat(markerPath);
      const expected = new Set(['.append.lock', 'inventory.json', ...inventory.segments.map(segment => segment.name)]);
      if (names.length !== expected.size || names.some(name => !expected.has(name))) resultsFail('store_corrupt');
      for (const segment of inventory.segments) {
        const bytes = await readPrivateResultFile(resultsJoin(dir, segment.name), maxSegmentBytes);
        if (bytes.length !== segment.bytes || resultsDigest(bytes) !== segment.digest) resultsFail('store_corrupt');
        try { resultsValidateSegment(bytes, plugin, maxRecordBytes); } catch { resultsFail('store_corrupt'); }
        activeBody = bytes;
      }
    }
    const retired: { segment: ResultsSegment; info: ResultsStats }[] = [];
    const active = inventory.segments.at(-1);
    if (active && active.bytes + size <= maxSegmentBytes) {
      const path = resultsJoin(dir, active.name);
      const handle = await resultsOpenChecked(path, resultsConstants.O_WRONLY | resultsConstants.O_APPEND, directories);
      try {
        if ((await handle.stat()).size !== active.bytes) resultsFail('store_corrupt');
        await handle.writeFile(body); await handle.sync();
        const after = await handle.stat(); resultsPrivateFile(after);
        if (after.size !== active.bytes + size) resultsFail('unsafe_path');
        await resultsCheckFile(path, after);
      } finally { await handle.close(); }
      active.bytes += size;
      active.digest = resultsDigest(Buffer.concat([activeBody, Buffer.from(body)]));
      if (resultsDigest(await readPrivateResultFile(path, maxSegmentBytes)) !== active.digest) resultsFail('store_corrupt');
    } else {
      if (!Number.isSafeInteger(inventory.next + 1)) resultsFail('resource_limit');
      const name = `${inventory.owner}-${inventory.next++}.jsonl`;
      await resultsCreate(resultsJoin(dir, name), body, directories);
      inventory.segments.push({ name, bytes: size, digest: resultsDigest(body) });
      while (inventory.segments.length > maxSegments) {
        const segment = inventory.segments.shift()!;
        const info = await resultsFs.lstat(resultsJoin(dir, segment.name)); resultsPrivateFile(info);
        retired.push({ segment, info });
      }
    }
    // Fixed pending name makes interrupted publication detectable; never clean up/adopt it.
    const pending = resultsJoin(dir, '.inventory.pending');
    const pendingInfo = await resultsCreate(pending, JSON.stringify(inventory), directories);
    await resultsSyncDirectory(dir, directories);
    if (markerInfo) {
      const current = await resultsCheckFile(markerPath, markerInfo);
      if (markerInfo.size !== current.size || markerInfo.mtimeMs !== current.mtimeMs || markerInfo.ctimeMs !== current.ctimeMs) resultsFail('store_corrupt');
    } else {
      try { await resultsFs.lstat(markerPath); resultsFail('store_corrupt'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await resultsCheckDirectories(directories);
    await resultsCheckFile(pending, pendingInfo);
    await resultsFs.rename(pending, markerPath);
    await resultsCheckFile(markerPath, pendingInfo);
    await resultsSyncDirectory(dir, directories);
    // Only the previously validated, marker-bound closed segments can retire.
    for (const { segment, info } of retired) {
      const path = resultsJoin(dir, segment.name);
      await resultsCheckDirectories(directories);
      if (resultsDigest(await readPrivateResultFile(path, maxSegmentBytes)) !== segment.digest) resultsFail('store_corrupt');
      const current = await resultsCheckFile(path, info);
      if (info.size !== current.size || info.mtimeMs !== current.mtimeMs || info.ctimeMs !== current.ctimeMs) resultsFail('store_corrupt');
      await resultsFs.unlink(path);
    }
    await resultsSyncDirectory(dir, directories);
    // Persist the newly created hierarchy, not just its final directory entry.
    for (const entry of directories.filter(entry => entry.path === base || entry.path.startsWith(base + resultsSep)).reverse()) await resultsSyncDirectory(resultsDirname(entry.path), directories);
    result = { persisted: true, reason: 'stored', id, rotated: retired.length, retainedSegments: inventory.segments.length };
  } catch (error) { result = resultsFailure(error); }
  finally {
    if (lock) {
      try {
        await resultsCheckDirectories(directories);
        const current = await resultsFs.lstat(lockPath); resultsPrivateFile(current);
        if (!lockInfo || !resultsSame(lockInfo, current) || !resultsSame(lockInfo, await lock.stat())) resultsFail('unsafe_path');
        await resultsFs.unlink(lockPath);
        await resultsSyncDirectory(dir, directories);
      } catch (error) { result = resultsFailure(error); }
      try { await lock.close(); } catch { result = { persisted: false, reason: 'store_unavailable' }; }
    }
  }
  return result;
}
export type ResultsSnapshotReason = 'store_busy' | 'store_corrupt' | 'unsafe_path' | 'resource_limit' | 'changed_during_read' | 'store_unavailable';
export type ResultsSnapshot = {
  status: 'ok' | 'missing' | 'unavailable';
  reason: ResultsSnapshotReason | null;
  records: Record<string, unknown>[];
  segments: number;
  bytes: number;
};
type ResultsSnapshotDependencies = { baseDir?: string };
type ResultsDirectoryIdentity = { path: string; dev: number; ino: number; mode: number };
function resultsIdentity(info: ResultsStats): ResultsDirectoryIdentity { return { path: '', dev: info.dev, ino: info.ino, mode: info.mode }; }
function resultsStable(a: ResultsStats, b: ResultsStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink;
}
function resultsIdentityStable(list: ResultsDirectoryIdentity[], directories: ResultsDirectory[]): boolean {
  return list.length === directories.length && list.every((entry, index) => entry.path === directories[index].path && entry.dev === directories[index].info.dev && entry.ino === directories[index].info.ino && entry.mode === directories[index].info.mode);
}
function resultsSnapshotFailure(error: unknown): ResultsSnapshot {
  const reason = error instanceof Error ? error.message : '';
  if (['store_busy', 'store_corrupt', 'unsafe_path', 'resource_limit', 'changed_during_read'].includes(reason)) return { status: 'unavailable', reason: reason as ResultsSnapshotReason, records: [], segments: 0, bytes: 0 };
  return { status: 'unavailable', reason: 'store_unavailable', records: [], segments: 0, bytes: 0 };
}
function resultsSafeMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
/**
 * One bounded optimistic snapshot attempt. Never creates, repairs, deletes or
 * locks anything: an existing safe append lock means store_busy. A safe empty
 * journal directory is missing; a nonempty directory without an inventory is
 * unavailable rather than synthesized empty. All identities are rechecked
 * before any record is published, so a generation that changed mid-read is
 * discarded whole (changed_during_read), never salvaged as a prefix.
 */
export async function readPluginOutcomeSnapshot(plugin: ResultsPlugin, deps: ResultsSnapshotDependencies = {}): Promise<ResultsSnapshot> {
  const maxRecordBytes = 4096, maxSegmentBytes = 1024 * 1024, maxSegments = 8;
  try {
    resultsEnum(plugin, resultsPlugins);
    const base = resultsResolve(deps.baseDir ?? pluginResultsRoot());
    const dir = resultsJoin(base, plugin, 'journal', 'v1');
    let directories: ResultsDirectory[];
    try { directories = await resultsDirectories(dir, false, base); }
    catch (error) {
      if (resultsSafeMissing(error)) return { status: 'missing', reason: null, records: [], segments: 0, bytes: 0 };
      throw error;
    }
    const identities = directories.map(entry => ({ ...resultsIdentity(entry.info), path: entry.path }));
    // Bounded exact-name listing before any content read.
    const names: string[] = [];
    const listing = await resultsFs.opendir(dir);
    for await (const entry of listing) {
      names.push(entry.name);
      if (names.length > maxSegments + 2) resultsFail('store_corrupt');
    }
    if (names.includes('.append.lock')) {
      const lockPath = resultsJoin(dir, '.append.lock');
      const lockInfo = await resultsFs.lstat(lockPath);
      resultsPrivateFile(lockInfo);
      resultsFail('store_busy');
    }
    if (names.includes('.inventory.pending')) resultsFail('store_corrupt');
    const markerPath = resultsJoin(dir, 'inventory.json');
    if (!names.includes('inventory.json')) {
      if (names.length === 0) return { status: 'missing', reason: null, records: [], segments: 0, bytes: 0 };
      resultsFail('store_corrupt');
    }
    const markerInfo = await resultsFs.lstat(markerPath);
    resultsPrivateFile(markerInfo);
    const markerText = (await readPrivateResultFile(markerPath, 8192)).toString('utf8');
    let inventory: ResultsInventory;
    try { inventory = resultsInventory(JSON.parse(markerText), plugin, maxSegments, maxSegmentBytes); }
    catch { resultsFail('store_corrupt'); }
    const expected = new Set(['inventory.json', ...inventory.segments.map(segment => segment.name)]);
    if (names.length !== expected.size || names.some(name => !expected.has(name))) resultsFail('store_corrupt');
    const records: Record<string, unknown>[] = [];
    const segmentInfos: { name: string; info: ResultsStats }[] = [];
    let bytes = 0;
    const seenIds = new Set<string>();
    for (const segment of inventory.segments) {
      const path = resultsJoin(dir, segment.name);
      const info = await resultsFs.lstat(path);
      resultsPrivateFile(info);
      const body = await readPrivateResultFile(path, maxSegmentBytes);
      if (body.length !== segment.bytes || resultsDigest(body) !== segment.digest) resultsFail('store_corrupt');
      let decodedRecords: ResultsDecodedRecord[];
      try { decodedRecords = resultsDecodeSegment(body, plugin, maxRecordBytes); }
      catch { resultsFail('store_corrupt'); }
      for (const decoded of decodedRecords) {
        if (seenIds.has(decoded.id)) resultsFail('store_corrupt');
        seenIds.add(decoded.id);
        records.push(decoded.record);
      }
      bytes += body.length;
      segmentInfos.push({ name: segment.name, info });
    }
    // Recheck every identity, name, lock/pending absence and the marker before publishing.
    if (!resultsIdentityStable(identities, await resultsDirectories(dir, false, base))) resultsFail('changed_during_read');
    const after: string[] = [];
    const relisting = await resultsFs.opendir(dir);
    for await (const entry of relisting) {
      after.push(entry.name);
      if (after.length > maxSegments + 2) resultsFail('store_corrupt');
    }
    if (after.length !== names.length || after.some(name => !names.includes(name))) resultsFail('changed_during_read');
    if (after.includes('.append.lock') || after.includes('.inventory.pending')) resultsFail('changed_during_read');
    let currentMarker: ResultsStats;
    try { currentMarker = await resultsCheckFile(markerPath, markerInfo); }
    catch { resultsFail('changed_during_read'); }
    if (!resultsStable(markerInfo, currentMarker)) resultsFail('changed_during_read');
    const recheckText = (await readPrivateResultFile(markerPath, 8192)).toString('utf8');
    let recheckInventory: unknown;
    try { recheckInventory = resultsInventory(JSON.parse(recheckText), plugin, maxSegments, maxSegmentBytes); } catch { resultsFail('changed_during_read'); }
    if (JSON.stringify(recheckInventory) !== JSON.stringify(inventory)) resultsFail('changed_during_read');
    for (const { name, info } of segmentInfos) {
      const path = resultsJoin(dir, name);
      let current: ResultsStats;
      try { current = await resultsCheckFile(path, info); }
      catch { resultsFail('changed_during_read'); }
      if (!resultsStable(info, current)) resultsFail('changed_during_read');
      if (resultsDigest(await readPrivateResultFile(path, maxSegmentBytes)) !== inventory.segments.find(segment => segment.name === name)!.digest) resultsFail('changed_during_read');
    }
    return { status: 'ok', reason: null, records, segments: inventory.segments.length, bytes };
  } catch (error) { return resultsSnapshotFailure(error); }
}

import * as receiptFs from 'node:fs/promises';
import { constants as receiptConstants } from 'node:fs';
import * as receiptPath from 'node:path';
import { createHash as receiptHash, randomUUID as receiptUUID } from 'node:crypto';
import { execFile as receiptExecFile } from 'node:child_process';
import { promisify as receiptPromisify } from 'node:util';

const receiptExec = receiptPromisify(receiptExecFile);
export const RECEIPT_EXCLUSIONS = ['.git', '.gjc', '.gjc-plugin', 'node_modules', '.next', 'dist', 'coverage', '.env*', '*credentials*', '*.pem', '*.key', '*secret*', '*cookie*', '*private*'];
const receiptDigest = (data: string | Uint8Array) => receiptHash('sha256').update(data).digest('hex');
const receiptHex = /^[a-f0-9]{64}$/;
const receiptIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const receiptChildEnv = () => ({ PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' });
export type SourceFingerprint = { status: 'available' | 'unavailable'; digest: string | null; reason: string; files: number; bytes: number; exclusions: string[] };
export type ReceiptFreshness = 'fresh' | 'stale' | 'changed_during_run' | 'unavailable';
export type VerificationReceipt = {
 schemaVersion: 1; plugin: 'verification-receipts' | 'ui-regression'; pluginVersion: '0.0.1'; id: string;
 toolCallDigest: string; sessionId: string | null; repositoryDigest: string; observedAt: string; durationMs: number;
 specDigest: string; before: SourceFingerprint; after: SourceFingerprint; freshness: ReceiptFreshness;
 execution: Record<string, unknown>; advisoryOnly: true; warnings: string[]; limitations: string[];
};
export async function actualRepository(cwd: string): Promise<string> {
 const { stdout } = await receiptExec('git', ['rev-parse', '--show-toplevel'], { cwd, env: receiptChildEnv(), timeout: 5000, maxBuffer: 8192 });
 return receiptFs.realpath(stdout.trim());
}
export async function repositoryDigest(root: string): Promise<string> { return receiptDigest(await receiptFs.realpath(root)); }
function excludedReceiptPath(name: string): boolean {
 return name.split('/').some(p => ['.git', '.gjc', '.gjc-plugin', 'node_modules', '.next', 'dist', 'coverage'].includes(p) || /^\.env/i.test(p) || /credentials|secret|cookie|private/i.test(p) || /\.(pem|key)$/i.test(p));
}
function receiptPlainData(value: unknown, depth = 0): boolean {
 if (depth > 8) return false;
 if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
 if (typeof value === 'number') return Number.isFinite(value);
 if (!value || typeof value !== 'object') return false;
 const array = Array.isArray(value);
 if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
 const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
 if (keys.length > 65 || (array && value.length > 64)) return false;
 for (const key of keys) {
  if (array && key === 'length') continue;
  if (typeof key !== 'string' || (array && !/^(?:0|[1-9]\d*)$/.test(key))) return false;
  const descriptor = descriptors[key];
  if (!descriptor.enumerable || !('value' in descriptor) || !receiptPlainData(descriptor.value, depth + 1)) return false;
 }
 return !array || keys.length === value.length + 1;
}
function normalizedReceiptInputs(files: unknown): string[] | null {
 if (!receiptPlainData(files) || !Array.isArray(files) || files.length > 32) return null;
 const normalized: string[] = [];
 for (const file of files) {
  if (typeof file !== 'string' || !file || file.length > 4096 || /[\x00-\x1f\x7f\\]/.test(file) || receiptPath.posix.isAbsolute(file) || receiptPath.win32.isAbsolute(file) || file.split('/').some(p => p === '..' || p.startsWith('-')) || !/\.(?:js|mjs|cjs)$/.test(file)) return null;
  const name = receiptPath.posix.normalize(file);
  if (excludedReceiptPath(name) || normalized.includes(name)) return null;
  normalized.push(name);
 }
 return normalized.sort();
}
export async function fingerprintSource(root: string, specDigest: string, files: string[] = []): Promise<SourceFingerprint> {
 const unavailable = (reason: string): SourceFingerprint => ({ status: 'unavailable', digest: null, reason, files: 0, bytes: 0, exclusions: RECEIPT_EXCLUSIONS });
 try {
  if (!receiptHex.test(specDigest)) return unavailable('invalid_spec_digest');
  const selected = normalizedReceiptInputs(files);
  if (!selected) return unavailable('invalid_selected_inputs');
  const selectedSet = new Set(selected);
  const rootStat = await receiptFs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await receiptFs.realpath(root) !== receiptPath.resolve(root)) return unavailable('unsafe_root');
  const options = { cwd: root, env: receiptChildEnv(), timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' as const };
  const head = (await receiptExec('git', ['rev-parse', 'HEAD'], options)).stdout;
  const index = (await receiptExec('git', ['ls-files', '--stage', '-z'], options)).stdout;
  const names = (await receiptExec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], options)).stdout;
  const paths = [...new Set([...names.toString('utf8').split('\0').filter(n => n && !excludedReceiptPath(n)), ...selected])].sort();
  if (paths.length > 20000) return unavailable('file_limit');
  const h = receiptHash('sha256');
  const add = (x: string | Uint8Array) => { h.update(String(Buffer.byteLength(x))); h.update(':'); h.update(x); };
  add(specDigest); add(head);
  // Include only non-private index entries; secret content/paths are explicitly excluded.
  for (const item of index.toString('utf8').split('\0').filter(Boolean)) {
   const split = item.indexOf('\t');
   if (split < 0) return unavailable('invalid_index');
   const name = item.slice(split + 1);
   if (excludedReceiptPath(name)) continue;
   if (item.startsWith('160000 ')) return unavailable('unsupported_submodule');
   add(item);
  }
  let bytes = 0;
  for (const name of paths) {
   if (receiptPath.isAbsolute(name) || name.split('/').some(p => p === '..' || p === '.' || !p)) return unavailable('unsafe_path');
   const file = receiptPath.join(root, name);
   // Do not follow symlinked parent directories into unrelated source.
   let parent = root;
   const parents = [{ path: root, stat: rootStat }];
   for (const part of name.split('/').slice(0, -1)) {
    parent = receiptPath.join(parent, part);
    try {
     const stat = await receiptFs.lstat(parent);
     if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable('symlink_parent');
     parents.push({ path: parent, stat });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || selectedSet.has(name)) return unavailable('selected_input_unavailable'); }
   }
   add(name);
   let st;
   try { st = await receiptFs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (selectedSet.has(name)) return unavailable('selected_input_unavailable'); add('deleted'); continue; } throw error; }
   add(String(st.mode & 0o777));
   if (selectedSet.has(name) && !st.isFile()) return unavailable('unsafe_selected_input');
   if (!st.isFile() && !st.isSymbolicLink()) return unavailable('unsupported_file');
   if (bytes + st.size > 128 * 1024 * 1024) return unavailable('byte_limit');
   let data: Buffer;
   if (st.isSymbolicLink()) data = Buffer.from(await receiptFs.readlink(file));
   else {
    const handle = await receiptFs.open(file, receiptConstants.O_RDONLY | receiptConstants.O_NOFOLLOW);
    try {
     const current = await handle.stat();
     if (current.dev !== st.dev || current.ino !== st.ino || current.size !== st.size || current.mtimeMs !== st.mtimeMs || current.ctimeMs !== st.ctimeMs || !current.isFile()) return unavailable('changed_while_hashing');
     data = Buffer.alloc(current.size);
     let offset = 0;
     while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, offset);
      if (!read.bytesRead) return unavailable('changed_while_hashing');
      offset += read.bytesRead;
     }
     if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) return unavailable('changed_while_hashing');
     const last = await handle.stat();
     if (current.size !== last.size || current.mtimeMs !== last.mtimeMs || current.ctimeMs !== last.ctimeMs) return unavailable('changed_while_hashing');
    } finally { await handle.close(); }
   }
   const lastPath = await receiptFs.lstat(file);
   if (lastPath.dev !== st.dev || lastPath.ino !== st.ino || lastPath.mode !== st.mode || lastPath.size !== st.size || lastPath.mtimeMs !== st.mtimeMs || lastPath.ctimeMs !== st.ctimeMs) return unavailable('changed_while_hashing');
   for (const entry of parents) {
    const last = await receiptFs.lstat(entry.path);
    if (!last.isDirectory() || last.isSymbolicLink() || last.dev !== entry.stat.dev || last.ino !== entry.stat.ino) return unavailable('changed_while_hashing');
   }
   bytes += data.length;
   if (bytes > 128 * 1024 * 1024) return unavailable('byte_limit');
   add(data);
  }
  return { status: 'available', digest: h.digest('hex'), reason: 'observed_source', files: paths.length, bytes, exclusions: RECEIPT_EXCLUSIONS };
 } catch { return unavailable('source_unavailable'); }
}
export function specFingerprint(spec: unknown): string { return receiptDigest(JSON.stringify(spec)); }
export function freshnessFor(before: SourceFingerprint, after: SourceFingerprint): ReceiptFreshness {
 return !before.digest || !after.digest ? 'unavailable' : before.digest === after.digest ? 'fresh' : 'changed_during_run';
}
export function createReceipt(input: Omit<VerificationReceipt, 'schemaVersion' | 'pluginVersion' | 'id' | 'observedAt' | 'advisoryOnly' | 'toolCallDigest' | 'sessionId'> & {toolCallId: string}): VerificationReceipt {
 const { toolCallId, ...rest } = input;
 return { ...rest, schemaVersion: 1, pluginVersion: '0.0.1', id: receiptUUID(), observedAt: new Date().toISOString(), toolCallDigest: receiptDigest(toolCallId), sessionId: null, advisoryOnly: true };
}
export function staticReceiptGuidance(execution: Record<string, unknown>, freshness: ReceiptFreshness, assessment?: {status: string; answers?: Record<string, {choice:string;confidence?:number;probabilities?:Record<string,number|undefined>}>}) {
 const warnings: string[] = [], recommendedNextActions: string[] = [];
 if (execution.status !== 'passed') { warnings.push('execution_not_passed'); recommendedNextActions.push('Inspect the relevant failing or incomplete tests locally.'); }
 if (freshness !== 'fresh') { warnings.push('source_not_fresh'); recommendedNextActions.push('Run verification again against the current source.'); }
 if (assessment && (assessment.status !== 'scored' || Object.values(assessment.answers ?? {}).some(a => a.confidence === undefined || a.confidence < 0.8 || a.probabilities?.[a.choice] === undefined || Number(a.probabilities[a.choice]) < 0.8))) { warnings.push('adequacy_unknown'); recommendedNextActions.push('Inspect coverage and boundary evidence; no confident adequacy claim is available.'); }
 else if (assessment && Object.values(assessment.answers ?? {}).some(a => ['gap', 'missing'].includes(a.choice))) { warnings.push('adequacy_gap'); recommendedNextActions.push('Inspect changed behavior and add relevant boundary tests.'); }
 return { warnings, recommendedNextActions: recommendedNextActions.slice(0, 3), advisoryOnly: true };
}

export function receiptStoreBase(): string { return receiptPath.join(pluginResultsRoot(), 'verification-receipts', 'receipts', 'v1'); }
async function readPrivateReceiptFile(file: string): Promise<Buffer> {
 return readPrivateResultFile(file, 32768);
}
export function validReceiptMetadata(value: unknown, repo: string): value is VerificationReceipt {
 if (!receiptPlainData(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
 const r = value as VerificationReceipt;
 const allowed = ['schemaVersion','plugin','pluginVersion','id','toolCallDigest','sessionId','repositoryDigest','observedAt','durationMs','specDigest','before','after','freshness','execution','advisoryOnly','warnings','limitations'];
 if (Object.keys(r).some(k => !allowed.includes(k))) return false;
 if (r.schemaVersion !== 1 || r.pluginVersion !== '0.0.1' || !['verification-receipts','ui-regression'].includes(r.plugin) || !receiptIdPattern.test(r.id) || r.repositoryDigest !== repo || !receiptHex.test(r.toolCallDigest) || r.sessionId !== null || !receiptHex.test(r.specDigest) || r.advisoryOnly !== true || !Number.isFinite(r.durationMs) || r.durationMs < 0 || !Number.isFinite(Date.parse(r.observedAt))) return false;
 if (!['fresh','stale','changed_during_run','unavailable'].includes(r.freshness)) return false;
 for (const fp of [r.before, r.after]) {
  if (!fp || typeof fp !== 'object' || Array.isArray(fp) || Object.keys(fp).length !== 6 || Object.keys(fp).some(k => !['status','digest','reason','files','bytes','exclusions'].includes(k)) || !['available','unavailable'].includes(fp.status) || !Number.isSafeInteger(fp.files) || fp.files < 0 || fp.files > 20000 || !Number.isSafeInteger(fp.bytes) || fp.bytes < 0 || fp.bytes > 128 * 1024 * 1024 || JSON.stringify(fp.exclusions) !== JSON.stringify(RECEIPT_EXCLUSIONS) || typeof fp.reason !== 'string' || !/^[a-z_]+$/.test(fp.reason)) return false;
  if (fp.status === 'available' ? typeof fp.digest !== 'string' || !receiptHex.test(fp.digest) : fp.digest !== null || fp.files !== 0 || fp.bytes !== 0) return false;
 }
 if (![r.warnings,r.limitations].every(a => Array.isArray(a) && a.length <= 20 && a.every(s => typeof s === 'string' && s.length <= 300))) return false;
 const ex = r.execution;
 if (!ex || typeof ex !== 'object' || Array.isArray(ex) || !['passed','failed','no_tests','incomplete','not_run','unavailable'].includes(String(ex.status)) || typeof ex.reason !== 'string' || !/^[a-z_]+$/.test(ex.reason)) return false;
 const exKeys = ['status','reason','exitCode','signal','runnerVersion','counts',...(r.plugin === 'ui-regression' ? ['assertions','steps','cleanup','currentUiState','browserBuildBinding','scenarioDigest'] : [])];
 if (Object.keys(ex).length !== exKeys.length || Object.keys(ex).some(k => !exKeys.includes(k))) return false;
 if (!(ex.exitCode === null || (Number.isSafeInteger(ex.exitCode) && Number(ex.exitCode) >= 0 && Number(ex.exitCode) <= 255)) || !(ex.signal === null || (typeof ex.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(ex.signal))) || !(ex.runnerVersion === null || (typeof ex.runnerVersion === 'string' && /^v?\d+\.\d+\.\d+(?:\.\d+)?$/.test(ex.runnerVersion)))) return false;
 if (r.plugin === 'ui-regression') {
  if (ex.counts !== null || !['confirmed','unconfirmed'].includes(String(ex.cleanup)) || ex.currentUiState !== 'not_reobserved' || ex.browserBuildBinding !== 'unverified' || !receiptHex.test(String(ex.scenarioDigest)) || !Array.isArray(ex.assertions) || ex.assertions.length > 20) return false;
  if (!Array.isArray(ex.steps) || ex.steps.length > 20 || ex.steps.some((s,i) => !s || typeof s !== 'object' || Object.keys(s).length !== 3 || Object.keys(s).some(k => !['step','action','status'].includes(k)) || s.step !== i || !['goto','click','fill','assert'].includes(s.action) || !['passed','failed'].includes(s.status))) return false;
  const seen = new Set<number>();
  for (const item of ex.assertions) {
   if (!item || typeof item !== 'object' || Object.keys(item).length !== 4 || Object.keys(item).some(k => !['step','id','kind','status'].includes(k)) || !Number.isSafeInteger(item.step) || item.step < 0 || item.step >= 20 || item.id !== 'step-'+item.step || !['visible','text_exact','text_substring'].includes(item.kind) || seen.has(item.step) || !['passed','failed'].includes(item.status)) return false;
   seen.add(item.step);
   const step=ex.steps[item.step];
   if (!step || step.action !== 'assert' || step.status !== item.status) return false;
  }
  if (ex.steps.filter(s => s.action === 'assert').length !== ex.assertions.length) return false;
  if (ex.status === 'passed' && (ex.exitCode !== 0 || ex.signal !== null || ex.cleanup !== 'confirmed' || ex.assertions.length === 0 || ex.steps.some(s => s.status !== 'passed') || ex.assertions.some(a => a.status !== 'passed'))) return false;
 }
 if (ex.counts !== null) {
  if (!ex.counts || typeof ex.counts !== 'object' || Array.isArray(ex.counts)) return false;
  const counts = ex.counts as Record<string,unknown>;
  if (Object.keys(counts).length !== 8 || Object.keys(counts).some(k => !['tests','suites','topLevel','passed','failed','skipped','todo','cancelled'].includes(k)) || Object.values(counts).some(n => !Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > 10000)) return false;
 }
 if (r.plugin === 'verification-receipts' && ex.status === 'passed') {
  const counts = ex.counts as Record<string,number> | null;
  if (ex.exitCode !== 0 || ex.signal !== null || !counts || counts.tests <= 0 || counts.topLevel <= 0 || counts.passed <= 0 || counts.failed !== 0 || counts.cancelled !== 0) return false;
 }
 return true;
}
type ReceiptInputManifest = { receiptId: string; repositoryDigest: string; specDigest: string; files: string[]; digest: string };
type ReceiptEnvelope = { storageSchemaVersion: 1; receipt: VerificationReceipt; selectedInputs: ReceiptInputManifest };
export type ReceiptPersistence = { persisted: boolean; reason: string; count?: number; bytes?: number; nearCapacity?: boolean };
function receiptInputDigest(receipt: VerificationReceipt, files: string[]): string {
 return receiptDigest(JSON.stringify([receipt.id, receipt.repositoryDigest, receipt.specDigest, files]));
}
function validReceiptEnvelope(value: unknown, repo: string): value is ReceiptEnvelope {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const envelope = value as ReceiptEnvelope;
 if (Object.keys(envelope).length !== 3 || Object.keys(envelope).some(k => !['storageSchemaVersion','receipt','selectedInputs'].includes(k)) || envelope.storageSchemaVersion !== 1 || !validReceiptMetadata(envelope.receipt, repo)) return false;
 const manifest = envelope.selectedInputs;
 if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).length !== 5 || Object.keys(manifest).some(k => !['receiptId','repositoryDigest','specDigest','files','digest'].includes(k))) return false;
 const files = normalizedReceiptInputs(manifest.files);
 return files !== null && JSON.stringify(files) === JSON.stringify(manifest.files) && manifest.receiptId === envelope.receipt.id && manifest.repositoryDigest === repo && manifest.specDigest === envelope.receipt.specDigest && manifest.digest === receiptInputDigest(envelope.receipt, files);
}
export async function persistReceipt(receipt: VerificationReceipt, base = receiptStoreBase(), files: string[] = []): Promise<ReceiptPersistence> {
 let lock: receiptFs.FileHandle | undefined; let lockFile = ''; let temp = '';
 let lockIdentity: {dev: number; ino: number} | undefined; let tempIdentity: {dev: number; ino: number} | undefined;
 let count: number | null = null, bytes: number | null = null;
 const result = (persisted: boolean, reason: string): ReceiptPersistence => count === null || bytes === null ? { persisted, reason } : { persisted, reason, count, bytes, nearCapacity: count >= 180 || bytes >= 2 * 1024 * 1024 * 0.9 };
 const removeOwned = async (file: string, identity: {dev: number; ino: number} | undefined) => {
  if (!identity) return;
  try {
   await ensurePrivateResultDirectory(receiptPath.dirname(file), false);
   const stat = await receiptFs.lstat(file);
   if (stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino && stat.uid === process.getuid?.()) await receiptFs.unlink(file);
  } catch {}
 };
 try {
  if (!receiptPlainData(receipt) || !receipt || !validReceiptMetadata(receipt, receipt.repositoryDigest) || !receiptHex.test(receipt.repositoryDigest)) return result(false, 'invalid_metadata');
  receipt = JSON.parse(JSON.stringify(receipt));
  const normalized = normalizedReceiptInputs(files);
  if (!normalized) return result(false, 'invalid_metadata');
  const envelope: ReceiptEnvelope = { storageSchemaVersion: 1, receipt, selectedInputs: { receiptId: receipt.id, repositoryDigest: receipt.repositoryDigest, specDigest: receipt.specDigest, files: normalized, digest: receiptInputDigest(receipt, normalized) } };
  const body = JSON.stringify(envelope), bodyBytes = Buffer.byteLength(body);
  await ensurePrivateResultDirectory(base, true);
  const dir = receiptPath.join(base, receipt.repositoryDigest); await ensurePrivateResultDirectory(dir, true);
  const directoryIdentity = await receiptFs.lstat(dir);
  const checkDirectory = async () => {
   await ensurePrivateResultDirectory(base, false); await ensurePrivateResultDirectory(dir, false);
   const current = await receiptFs.lstat(dir);
   if (current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino) throw new Error('changed_store');
  };
  lockFile = receiptPath.join(dir, '.admission.lock');
  try { lock = await receiptFs.open(lockFile, receiptConstants.O_WRONLY | receiptConstants.O_CREAT | receiptConstants.O_EXCL | receiptConstants.O_NOFOLLOW, 0o600); } catch (error) { return result(false, (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'store_busy' : 'store_unavailable'); }
  const lockStat = await lock.stat(); lockIdentity = lockStat;
  if (!lockStat.isFile() || lockStat.nlink !== 1 || (lockStat.mode & 0o7777) !== 0o600 || lockStat.uid !== process.getuid?.()) return result(false, 'store_unavailable');
  await checkDirectory();
  const entries = await receiptFs.readdir(dir); count = 0; bytes = 0;
  if (entries.length > 201) { count = null; bytes = null; return result(false, 'store_full'); }
  for (const name of entries) {
   if (name === '.admission.lock') continue;
   if (!receiptIdPattern.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) { count = null; bytes = null; return result(false, 'store_corrupt'); }
   try {
    const data = await readPrivateReceiptFile(receiptPath.join(dir, name));
    const prior = JSON.parse(data.toString());
    if (!validReceiptEnvelope(prior, receipt.repositoryDigest) || prior.receipt.id + '.json' !== name) throw new Error('invalid_envelope');
    count++; bytes += data.length;
   } catch { count = null; bytes = null; return result(false, 'store_corrupt'); }
  }
  if (bodyBytes > 32768 || count >= 200 || bytes + bodyBytes > 2 * 1024 * 1024) return result(false, 'store_full');
  await checkDirectory();
  temp = receiptPath.join(dir, '.' + receiptUUID() + '.tmp');
  const handle = await receiptFs.open(temp, receiptConstants.O_WRONLY | receiptConstants.O_CREAT | receiptConstants.O_EXCL | receiptConstants.O_NOFOLLOW, 0o600);
  try {
   const stat = await handle.stat(); tempIdentity = stat;
   if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('unsafe_store_file');
   await handle.writeFile(body); await handle.sync();
  } finally { await handle.close(); }
  await checkDirectory();
  const staged = await readPrivateReceiptFile(temp);
  if (staged.toString() !== body) throw new Error('changed_store_file');
  const stagedStat = await receiptFs.lstat(temp);
  if (stagedStat.dev !== tempIdentity.dev || stagedStat.ino !== tempIdentity.ino) throw new Error('changed_store_file');
  // link publishes atomically without replacing an existing receipt.
  const published = receiptPath.join(dir, receipt.id + '.json');
  await receiptFs.link(temp, published); await receiptFs.unlink(temp); temp = '';
  await checkDirectory();
  if ((await readPrivateReceiptFile(published)).toString() !== body) throw new Error('changed_store_file');
  const directory = await receiptFs.open(dir, receiptConstants.O_RDONLY | receiptConstants.O_DIRECTORY | receiptConstants.O_NOFOLLOW);
  try {
   const current = await directory.stat();
   if (current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino) throw new Error('changed_store');
   await directory.sync();
  } finally { await directory.close(); }
  await checkDirectory();
  count++; bytes += bodyBytes;
  return result(true, 'stored');
 } catch { count = null; bytes = null; return result(false, 'store_unavailable'); }
 finally { if (temp) await removeOwned(temp, tempIdentity); if (lock) { await lock.close().catch(() => {}); await removeOwned(lockFile, lockIdentity); } }
}
async function loadReceiptEnvelope(root: string, id: string, base: string): Promise<ReceiptEnvelope | null> {
 try {
  if (!receiptIdPattern.test(id)) return null;
  const repo = await repositoryDigest(root); const dir = receiptPath.join(base, repo);
  await ensurePrivateResultDirectory(base, false); await ensurePrivateResultDirectory(dir, false);
  const data = await readPrivateReceiptFile(receiptPath.join(dir, id + '.json')); const result = JSON.parse(data.toString());
  return validReceiptEnvelope(result, repo) && result.receipt.id === id ? result : null;
 } catch { return null; }
}
export async function loadReceipt(root: string, id: string, base = receiptStoreBase()): Promise<VerificationReceipt | null> {
 return (await loadReceiptEnvelope(root, id, base))?.receipt ?? null;
}
export async function loadReceiptInputs(root: string, id: string, base = receiptStoreBase()): Promise<string[] | null> {
 return (await loadReceiptEnvelope(root, id, base))?.selectedInputs.files ?? null;
}
export async function currentReceiptFreshness(root: string, receipt: VerificationReceipt, base = receiptStoreBase()): Promise<ReceiptFreshness> {
 try {
  if (!receiptPlainData(receipt) || !receipt || !validReceiptMetadata(receipt, receipt.repositoryDigest)) return 'unavailable';
  const snapshot = JSON.stringify(receipt);
  const envelope = await loadReceiptEnvelope(root, receipt.id, base);
  if (!envelope || JSON.stringify(envelope.receipt) !== snapshot) return 'unavailable';
  const stored = envelope.receipt;
  const now = await fingerprintSource(root, stored.specDigest, envelope.selectedInputs.files);
  if (!now.digest || !stored.after.digest || !stored.before.digest) return 'unavailable';
  if (now.digest !== stored.after.digest) return 'stale';
  return stored.freshness === 'changed_during_run' ? 'changed_during_run' : 'fresh';
 } catch { return 'unavailable'; }
}

import { readFileSync as adequacyReadFileSync } from "node:fs";
import { homedir as adequacyHomedir } from "node:os";
import { join as adequacyJoin } from "node:path";

export type AssessmentInput = { changeSummary: string; expectedBehavior: string; caseNotes?: { id: string; note: string }[] };
export type AdequacyChoice<L extends string> = { type: "choice"; choice: L; confidence?: number; probabilities?: Partial<Record<L, number>> };
export type AssessmentResult = {
 status: "scored" | "unscored" | "unknown" | "unavailable" | "invalid_input" | "invalid_response";
 reason: "scored" | "optional_scores_missing" | "unknown_choice" | "missing_context" | "insufficient_evidence" | "invalid_context" | "invalid_facts" | "off" | "missing_key" | "request_cap" | "response_cap" | "invalid_answer" | "http_auth" | "http_credit" | "http_rate" | "http_server" | "http_error" | "redirect" | "timeout" | "transport";
 answers?: { coverage_alignment: AdequacyChoice<"aligned" | "gap" | "none" | "unknown">; boundary_evidence: AdequacyChoice<"present" | "missing" | "none" | "unknown"> };
};
const adequacyLabels = { coverage_alignment: ["aligned", "gap", "none", "unknown"], boundary_evidence: ["present", "missing", "none", "unknown"] } as const;
function adequacyObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function adequacySafeText(value: unknown, limit: number): value is string {
 return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\x00-\x08\x0b-\x1f]|(?:bearer\s|sk-[\w-]+|-----BEGIN|(?:api[_ -]?key|password|secret|token|cookie|authorization|account[_ -]?id|fill|raw[_ -]?(?:source|logs?|diff)|snapshot)\s*[:=]|https?:\/\/|(?:\/(?:Users|home|tmp|var|etc)\/|[A-Z]:\\)|(?:^|\n)(?:diff --git|@@|\+\+\+|--- |\s*at .*:\d+|\s*(?:export |import |function\s|const\s+\w+\s*=|console\.|\[?(?:INFO|DEBUG|ERROR)\]?\s))|```|[a-f0-9]{40,}|[A-Za-z0-9+/=_-]{48,})/i.test(value);
}
function adequacyInput(value: unknown, caseIds: string[] = []): value is AssessmentInput {
 if (!adequacyObject(value) || Object.keys(value).some(k => !["changeSummary", "expectedBehavior", "caseNotes"].includes(k)) || !adequacySafeText(value.changeSummary, 2000) || !adequacySafeText(value.expectedBehavior, 2000)) return false;
 if (value.caseNotes === undefined) return true;
 if (!Array.isArray(value.caseNotes) || value.caseNotes.length > 8) return false;
 const seen = new Set<string>();
 return value.caseNotes.every(n => {
  if (!adequacyObject(n) || Object.keys(n).some(k => !["id", "note"].includes(k)) || typeof n.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(n.id) || !adequacySafeText(n.id, 64) || !adequacySafeText(n.note, 300) || seen.has(n.id) || !caseIds.includes(n.id)) return false;
  seen.add(n.id); return true;
 });
}
function adequacyFacts(facts: unknown): { status: string; freshness: string; counts: Record<string, number> | null; assertions?: {step:number;id:string;kind:string;status:string}[] } | undefined {
 if (!adequacyObject(facts) || typeof facts.status !== "string" || typeof facts.freshness !== "string" || !["passed", "failed", "no_tests", "incomplete", "not_run", "unavailable"].includes(facts.status) || !["fresh", "stale", "changed_during_run", "unavailable"].includes(facts.freshness)) return;
 if (facts.caseIds !== undefined && (!Array.isArray(facts.caseIds) || facts.caseIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)))) return;
 let counts: Record<string, number> | null = null;
 if (facts.counts !== null) {
  if (!adequacyObject(facts.counts)) return;
  counts = {};
  for (const key of ["tests", "suites", "topLevel", "passed", "failed", "skipped", "todo", "cancelled"]) {
   const number = facts.counts[key];
   if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return;
   counts[key] = number;
  }
 }
 let assertions: {step:number;id:string;kind:string;status:string}[] | undefined;
 if (facts.assertions !== undefined) {
  if (!Array.isArray(facts.assertions) || facts.assertions.length > 20 || facts.assertions.some(a => !adequacyObject(a) || !Number.isSafeInteger(a.step) || Number(a.step) < 0 || Number(a.step) >= 20 || a.id !== 'step-'+a.step || !['visible','text_exact','text_substring'].includes(String(a.kind)) || !['passed','failed'].includes(String(a.status))) || new Set(facts.assertions.map(a => a.step)).size !== facts.assertions.length) return;
  assertions = facts.assertions.map(a => ({step:a.step,id:a.id,kind:a.kind,status:a.status}));
 }
 return { status: facts.status as string, freshness: facts.freshness as string, counts, ...(assertions ? {assertions} : {}) };
}
function adequacyEnv(file: string): Record<string, string> {
 const result: Record<string, string> = {};
 try {
  const text = adequacyReadFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
   const match = /^\s*(JEV_ADVISOR_PROVIDER|JEV_ADVISOR_API_KEY|OPENROUTER_API_KEY)\s*=\s*(.*?)\s*$/.exec(line);
   if (match) result[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
 } catch { /* Missing existing credential file is not an error receipt. */ }
 return result;
}
function adequacyScore(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function adequacyAnswer(value: unknown, labels: readonly string[]): AdequacyChoice<string> | undefined {
 if (!adequacyObject(value) || value.type !== "choice" || typeof value.choice !== "string" || !labels.includes(value.choice)) return;
 const result: AdequacyChoice<string> = { type: "choice", choice: value.choice };
 if (value.confidence !== undefined) { if (!adequacyScore(value.confidence)) return; result.confidence = value.confidence; }
 if (value.probabilities !== undefined) {
  const checked = validateProbabilityMap(labels, value.probabilities);
  if (!checked.ok) return;
  result.probabilities = checked.probabilities;
 }
 return result;
}
export async function assessAdequacy(input: unknown, facts: { status: string; counts: unknown; freshness: string; caseIds?: string[]; assertions?:{step:number;id:string;kind:'visible'|'text_exact'|'text_substring';status:string}[] }, deps: { fetch?: typeof fetch; env?: Record<string, string | undefined>; envFile?: string } = {}): Promise<AssessmentResult> {
 const observed = adequacyFacts(facts);
 if (!observed) return { status: "invalid_input", reason: "invalid_facts" };
 if (input !== undefined && !adequacyInput(input, facts.caseIds)) return { status: "invalid_input", reason: "invalid_context" };
 const evidenceIncomplete = observed.status !== 'passed' || observed.freshness !== 'fresh' || (observed.counts === null && !observed.assertions?.length) || (observed.counts !== null && (observed.counts.passed < 1 || observed.counts.failed > 0 || observed.counts.cancelled > 0)) || observed.assertions?.some(a => a.status !== 'passed');
 const environment = deps.env ?? process.env;
 // Explicit off needs neither file access nor credentials.
 if (environment.JEV_ADVISOR_PROVIDER?.trim().toLowerCase() === "off") return { status: "unavailable", reason: "off" };
 const file = adequacyEnv(deps.envFile ?? adequacyJoin(adequacyHomedir(), ".gjc", "agent", "jev-advisor", ".env"));
 const variable = (name: string) => environment[name] ?? file[name];
 if (variable("JEV_ADVISOR_PROVIDER")?.trim().toLowerCase() === "off") return { status: "unavailable", reason: "off" };
 const key = variable("JEV_ADVISOR_API_KEY")?.trim() || variable("OPENROUTER_API_KEY")?.trim();
 if (!key) return { status: "unavailable", reason: "missing_key" };
 // Deterministic ineligibility: with a key available, no call is made when the
 // evidence cannot support a decision or no caller context was supplied.
 if (evidenceIncomplete) return { status: "unknown", reason: "insufficient_evidence" };
 if (input === undefined) return { status: "unknown", reason: "missing_context" };
 const explicitContext = input === undefined ? { authorship: "not_supplied" } : { authorship: "caller_authored", ...(input as AssessmentInput) };
 const body = JSON.stringify({ model: "typesafe/jev-1.13", state: { explicitContext, observed }, questions: {
  coverage_alignment: { type: "choice", instructions: "Assess whether caller-authored expected behavior and case notes align with the change. Counts are execution evidence, not proof of quality. If context is not_supplied, choose unknown. Failed, absent or stale execution is never a current passing verification.", criteria: { aligned: "Evidence aligns with expected behavior.", gap: "A coverage gap is evident.", none: "No applicable coverage evidence.", unknown: "Insufficient information." } },
  boundary_evidence: { type: "choice", instructions: "Assess boundary and failure evidence only from supplied context; never infer it from counts. If context is not_supplied, choose unknown. Empty observations cannot establish boundary coverage.", criteria: { present: "Relevant boundary or failure evidence is supplied.", missing: "Relevant boundary evidence is missing.", none: "No applicable boundary behavior.", unknown: "Insufficient information." } }
 } });
 if (Buffer.byteLength(body) > 16 * 1024) return { status: "invalid_input", reason: "request_cap" };
 const controller = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined;
 const timeout = new Promise<AssessmentResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: "unavailable", reason: "timeout" }); }, 8000); });
 const request = async (): Promise<AssessmentResult> => {
  try {
   const endpoint = "https://openrouter.ai/api/alpha/decisions";
   if (!isAllowedDecisionEndpoint(endpoint)) return { status: "unavailable", reason: "transport" };
   const response = await (deps.fetch ?? fetch)(endpoint, { method: "POST", redirect: "manual", signal: controller.signal, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body });
   if (controller.signal.aborted) return { status: "unavailable", reason: "timeout" };
   if (response.status >= 300 && response.status < 400 || response.redirected) { await response.body?.cancel(); return { status: "unavailable", reason: "redirect" }; }
   if (!response.ok) { await response.body?.cancel(); return { status: "unavailable", reason: response.status === 401 ? "http_auth" : response.status === 402 ? "http_credit" : response.status === 429 ? "http_rate" : response.status >= 500 ? "http_server" : "http_error" }; }
   if (Number(response.headers.get("content-length")) > 65536) { await response.body?.cancel(); return { status: "invalid_response", reason: "response_cap" }; }
   if (!response.body) return { status: "invalid_response", reason: "invalid_answer" };
   const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
   try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) { await reader.cancel(); return { status: "invalid_response", reason: "response_cap" }; } chunks.push(part.value); } } finally { reader.releaseLock(); }
   let parsed: unknown;
   try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return { status: "invalid_response", reason: "invalid_answer" }; }
   if (!adequacyObject(parsed) || !adequacyObject(parsed.answers)) return { status: "invalid_response", reason: "invalid_answer" };
   const coverage = adequacyAnswer(parsed.answers.coverage_alignment, adequacyLabels.coverage_alignment);
   const boundary = adequacyAnswer(parsed.answers.boundary_evidence, adequacyLabels.boundary_evidence);
   if (!coverage || !boundary) return { status: "invalid_response", reason: "invalid_answer" };
   const answers = { coverage_alignment: coverage, boundary_evidence: boundary } as NonNullable<AssessmentResult["answers"]>;
   if ([coverage.choice, boundary.choice].some(choice => choice === "none" || choice === "unknown")) return { status: "unknown", reason: "unknown_choice", answers };
   const scored = [coverage, boundary].every(answer => answer.confidence !== undefined && answer.probabilities !== undefined && Object.keys(answer.probabilities).length === 4);
   return { status: scored ? "scored" : "unscored", reason: scored ? "scored" : "optional_scores_missing", answers };
  } catch { return { status: "unavailable", reason: controller.signal.aborted ? "timeout" : "transport" }; }
 };
 try { return await Promise.race([request(), timeout]); } finally { clearTimeout(timer); }
}


// Project only host-owned metadata; caller context and private input locators never enter the journal.
export async function finalizeVerificationOutcome(plugin: 'verification-receipts' | 'ui-regression', operation: 'run' | 'status', value: Record<string, any>) {
 const receipt = value.receipt;
 const execution = receipt?.execution ?? value.execution;
 const projected: Record<string, unknown> = {status: execution.status, reason: execution.reason};
 if ('counts' in execution) projected.counts = execution.counts;
 if ('assertions' in execution) projected.assertions = execution.assertions;
 if ('cleanup' in execution) projected.cleanup = execution.cleanup;
 const receiptStorage = value.receiptStorage ?? (typeof value.persisted === 'boolean' ? {
  persisted: value.persisted, reason: value.reason,
  ...(value.count !== undefined ? {count:value.count} : {}),
  ...(value.bytes !== undefined ? {bytes:value.bytes} : {}),
  ...(value.nearCapacity !== undefined ? {nearCapacity:value.nearCapacity} : {}),
 } : {persisted:false,reason:operation === 'status' && receipt ? 'not_requested' : 'no_receipt'});
 const outcome: PluginOutcome = {
  operation, repositoryDigest:receipt?.repositoryDigest ?? null, receiptId:receipt?.id ?? null,
  freshness:value.freshness ?? receipt?.freshness ?? 'unavailable',
  execution:projected as PluginOutcome['execution'], assessment:value.assessment, receiptStorage,
  ...(receipt ? {toolCallDigest:receipt.toolCallDigest,durationMs:receipt.durationMs} : {}),
 };
 let journalStorage;
 try { journalStorage = await appendPluginOutcome(plugin,outcome); }
 catch { journalStorage = {persisted:false,reason:'store_unavailable'}; }
 const warnings = [...(value.warnings ?? [])];
 if (receiptStorage.nearCapacity) warnings.push('receipt_store_near_capacity');
 if (receiptStorage.reason === 'store_full') warnings.push('receipt_store_full');
 if (!journalStorage.persisted) warnings.push('journal_not_persisted');
 return {...value,receiptStorage,journalStorage,receiptLoadable:Boolean(receipt && (operation === 'status' || receiptStorage.persisted)),warnings};
}


export default function verificationStatus(pi: {cwd:string;typebox:{Type:any}}) {
 const T=pi.typebox.Type;
 return {
  name:'verification_status',label:'Verification Status',
  description:'Read one immutable repository-scoped local verification receipt and recompute source freshness. Historical execution is never rerun. Automatically attempt Jev adequacy on every lookup, including stale or missing evidence, at https://openrouter.ai/api/alpha/decisions (typesafe/jev-1.13). Optional assessment supplies non-sensitive context, not an opt-in switch. Only selected summaries/notes and bounded status/counts/freshness leave; no logs, diffs, source, test names, paths, keys or accounts. Missing context, failures and stale evidence cannot establish sufficient current verification. Warning-only; no automatic repair or blocking.',
  parameters:T.Object({receiptId:T.String(),assessment:T.Optional(T.Object({changeSummary:T.String({maxLength:2000}),expectedBehavior:T.String({maxLength:2000}),caseNotes:T.Optional(T.Array(T.Object({id:T.String(),note:T.String({maxLength:300})}),{maxItems:8}))},{additionalProperties:false}))},{additionalProperties:false}),
  async execute(_toolCallId:string,params:{receiptId:string;assessment?:unknown}) {
   const text=async(v:Record<string,any>)=>({content:[{type:'text',text:JSON.stringify(await finalizeVerificationOutcome('verification-receipts','status',v))}]});
   try {
    if (!params || Object.keys(params).some(k=>!['receiptId','assessment'].includes(k))) throw new Error('invalid_input');
    const root=await actualRepository(pi.cwd); const receipt=await loadReceipt(root,params.receiptId);
    if (!receipt || receipt.plugin !== 'verification-receipts') throw new Error('receipt_unavailable');
    const freshness=await currentReceiptFreshness(root,receipt);
    const assessment=await assessAdequacy(params.assessment,{status:String(receipt.execution.status),counts:receipt.execution.counts,freshness,caseIds:['run']});
    return text({receipt,freshness,assessment,...staticReceiptGuidance(receipt.execution,freshness,assessment)});
   } catch {
    const execution={status:'unavailable',reason:'receipt_unavailable'};
    const assessment=await assessAdequacy(undefined,{status:execution.status,counts:null,freshness:'unavailable'});
    const guidance=staticReceiptGuidance(execution,'unavailable',assessment);
    return text({execution,freshness:'unavailable',assessment,...guidance,warnings:['receipt_unavailable',...guidance.warnings]});
   }
  }
 };
}
