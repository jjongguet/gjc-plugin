// GENERATED — edit lib/ and src/, then bun scripts/build.mjs. Keyless standalone hook.
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
		authEnv: ["OPENGATEWAY_API_KEY"],
		status: "candidate_unverified",
		contextTokens: 32768,
		note: "Catalog candidate (openai-compatible decisions endpoint, input text/image/audio/video). Envelope and confidence semantics are not yet verified; unusable until a consumer verifies them.",
	},
	{
		id: "opengateway/sionic-ai/decider-4b",
		provider: "opengateway",
		model: "sionic-ai/decider-4b",
		endpoint: "https://apis.opengateway.ai/v1/decisions",
		authEnv: ["OPENGATEWAY_API_KEY"],
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
	"invalid_case_id",
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
  operation: 'run' | 'status' | 'advise' | 'calibration' | 'check' | 'task_advice' | 'task_launch' | 'subagent_terminal' | 'wiki_query' | 'wiki_propose' | 'rea_readiness' | 'backplan_check' | 'gate_emitted' | 'loop_run' | 'capture' | 'import' | 'dream' | 'cohort';
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
export type RrsiAction = 'capture' | 'import' | 'dream' | 'status' | 'cohort';
export type LoopGapKind = 'no_receipt_after_gate' | 'receipt_not_passed' | 'receipt_no_tests' | 'receipt_incomplete' | 'receipt_stale' | 'receipt_changed_during_run' | 'receipt_freshness_unavailable' | 'changed_test_uncovered' | 'state_unavailable' | 'not_a_repository';
type ResultsPlugin = 'jev-advisor' | 'verification-receipts' | 'ui-regression' | 'wiki' | 'rea' | 'backplan' | 'rrsi';
type ResultsAppend = { persisted: boolean; reason: string; id?: string; rotated?: number; retainedSegments?: number };
type ResultsDependencies = { baseDir?: string; maxRecordBytes?: number; maxSegmentBytes?: number; maxSegments?: number; lockTimeoutMs?: number };
const resultsPlugins = ['jev-advisor', 'verification-receipts', 'ui-regression', 'wiki', 'rea', 'backplan', 'rrsi'];
const resultsOperations = ['run', 'status', 'advise', 'calibration', 'check', 'task_advice', 'task_launch', 'subagent_terminal', 'wiki_query', 'wiki_propose', 'rea_readiness', 'backplan_check', 'gate_emitted', 'loop_run', 'capture', 'import', 'dream', 'cohort'];
const resultsRrsiActions = ['capture', 'import', 'dream', 'status', 'cohort'];
const resultsGapKinds = ['no_receipt_after_gate', 'receipt_not_passed', 'receipt_no_tests', 'receipt_incomplete', 'receipt_stale', 'receipt_changed_during_run', 'receipt_freshness_unavailable', 'changed_test_uncovered', 'state_unavailable', 'not_a_repository'];
const resultsHex = /^[a-f0-9]{64}$/;
const resultsId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const resultsCountKeys = ['tests', 'suites', 'topLevel', 'passed', 'failed', 'skipped', 'todo', 'cancelled'];
export const RESULTS_UI_SCENARIO_REASONS = [
  'scenario_object', 'scenario_fields', 'scenario_id', 'scenario_expected_behavior', 'scenario_steps', 'scenario_step',
  'scenario_first_goto', 'scenario_origin', 'scenario_url', 'scenario_url_scheme', 'scenario_url_host',
  'scenario_url_unsafe', 'scenario_url_sensitive', 'scenario_selector', 'scenario_selector_unsafe',
  'scenario_value', 'scenario_assert_kind', 'scenario_match', 'scenario_expected', 'scenario_no_assertion',
  'scenario_action', 'scenario_sensitive',
] as const;
const resultsExecutionReasons = [
  'not_run', 'invalid_or_unavailable_input', 'receipt_unavailable', 'invalid_file_count', 'invalid_root', 'invalid_test_path',
  'path_escape', 'symlink_test_path', 'invalid_test_file', 'missing_test_file', 'duplicate_test_file', 'invalid_timeout',
  'cancelled', 'process_groups_unavailable', 'node_unavailable', 'invalid_node_version', 'unsupported_node_version',
  'cleanup_unresolved', 'cleanup_unconfirmed', 'timeout', 'output_limit', 'spawn_unavailable', 'missing_summary',
  'invalid_summary_frame', 'runner_crash', 'native_failure', 'no_actual_passes', 'native_success', 'runner_setup_failed',
  'complete', 'origin_drift', 'missing_target', 'ambiguous_target', 'hidden_target', 'assertion_failed', 'unsupported_control',
  'runtime_error', 'missing_observations', 'output_overflow', 'malformed_observations', 'runner_exit', 'partial_observations',
  'missing_account', 'unsafe_lock', 'busy', 'lock_unavailable', 'runner_signal', 'missing_cli', 'runner_unavailable',
  'missing_binary', 'not_a_repository', 'invalid_repository', 'repository_outside_session_cwd',
  ...RESULTS_UI_SCENARIO_REASONS,
];
const resultsAssessmentReasons = ['scored', 'optional_scores_missing', 'unknown_choice', 'missing_context', 'insufficient_evidence', 'invalid_context', 'invalid_case_id', 'invalid_facts', 'off', 'missing_key', 'request_cap', 'response_cap', 'invalid_answer', 'http_auth', 'http_credit', 'http_rate', 'http_server', 'http_error', 'redirect', 'timeout', 'transport'];
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
export const RECEIPT_REPOSITORY_REASONS = ['not_a_repository', 'invalid_repository', 'repository_outside_session_cwd'] as const;
function receiptWithin(parent: string, child: string): boolean {
 const rel = receiptPath.relative(parent, child);
 return rel === '' || (rel !== '..' && !rel.startsWith(`..${receiptPath.sep}`) && !receiptPath.isAbsolute(rel));
}
// Without `repository` the session directory must sit inside a Git work tree. An explicit
// `repository` (absolute or relative to the session directory) must be a work-tree root that is
// the session's own repository or lies inside the session directory; nothing outside it is reachable.
export async function resolveReceiptRepository(cwd: string, repository?: unknown): Promise<string> {
 const fail = (reason: (typeof RECEIPT_REPOSITORY_REASONS)[number]): never => { throw new Error(reason); };
 if (repository === undefined) {
  try { return await actualRepository(cwd); } catch { return fail('not_a_repository'); }
 }
 if (typeof repository !== 'string' || !repository || repository.length > 4096 || repository.includes('\0')) return fail('invalid_repository');
 let session = '', target = '';
 try {
  session = await receiptFs.realpath(cwd);
  target = await receiptFs.realpath(receiptPath.resolve(cwd, repository));
  if (!(await receiptFs.stat(target)).isDirectory()) throw new Error('not_directory');
 } catch { return fail('invalid_repository'); }
 let root = '';
 try { root = await actualRepository(target); } catch { return fail('not_a_repository'); }
 if (root !== target) return fail('invalid_repository');
 if (!receiptWithin(session, root) && !receiptWithin(root, session)) return fail('repository_outside_session_cwd');
 return root;
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
const RECEIPT_INPUT_ACTIONS: Record<string, string> = {
 not_a_repository: 'The directory is not inside a Git work tree; pass `repository` with the root of a repository inside the session directory.',
 invalid_repository: '`repository` must name an existing Git work-tree root, absolute or relative to the session directory.',
 repository_outside_session_cwd: '`repository` must be the session repository or a repository inside the session directory.',
};
// Rejections raised by validateTestFiles before any test runs.
export const RECEIPT_TEST_PATH_REASONS = ['invalid_file_count', 'invalid_root', 'invalid_test_path', 'path_escape', 'symlink_test_path', 'invalid_test_file', 'missing_test_file', 'duplicate_test_file'];
const RECEIPT_UI_INPUT_ACTIONS: Record<string, string> = {
 scenario_object: 'Provide a plain scenario object with id, expectedBehavior and steps.',
 scenario_fields: 'Use exactly the documented fields for each scenario step; imported results and extra fields are unsupported.',
 scenario_id: 'Use a non-sensitive scenario id of 1-64 letters, digits, underscores or hyphens, beginning with a letter or digit.',
 scenario_expected_behavior: 'Describe the non-sensitive expected behavior in 1-2000 characters.',
 scenario_steps: 'Provide 1-20 explicit supported steps.',
 scenario_step: 'Provide each step as a plain object with a supported action.',
 scenario_first_goto: 'Start the scenario with goto on an inspected, owned non-sensitive loopback fixture.',
 scenario_origin: 'Keep all navigation on the same inspected loopback origin.',
 scenario_url: 'Use a valid explicit HTTP or HTTPS loopback URL without sensitive content.',
 scenario_url_scheme: 'Use HTTP or HTTPS for an inspected loopback fixture, not another URL scheme.',
 scenario_url_host: 'This tool only supports explicit localhost, 127.0.0.1 or [::1]. Use the separately authorized browser workflow for real or deployed sites.',
 scenario_url_unsafe: 'Use an inspected loopback URL without credentials, query, fragment or backslashes; do not disguise sensitive destinations.',
 scenario_url_sensitive: 'Authentication, account, payment and other sensitive routes are unsupported. Use a separate authorized browser workflow for those paths; do not rename them to evade the guard.',
 scenario_selector: 'Use a current visible CSS selector of 1-256 characters for the owned fixture.',
 scenario_selector_unsafe: 'Use only non-sensitive supported visible controls and current CSS selectors. Authentication, uploads, payment, script expressions and snapshot references are unsupported.',
 scenario_value: 'Use only non-sensitive fixture text within the documented fill limit.',
 scenario_assert_kind: 'Use a visible or text DOM assertion; screenshots and arbitrary JavaScript are unsupported.',
 scenario_match: 'Choose exact or substring for a literal text assertion.',
 scenario_expected: 'Use bounded non-sensitive literal expected text; substring assertions must not be empty.',
 scenario_no_assertion: 'Include at least one visible or literal text assertion on the owned fixture.',
 scenario_action: 'Use only goto, click, fill or assert. Arbitrary JavaScript, screenshots and result imports are unsupported.',
 scenario_sensitive: 'Remove sensitive data from the fixture scenario. Real sensitive workflows require a separate authorized browser workflow; do not encode data to evade screening.',
};
export function staticReceiptGuidance(execution: Record<string, unknown>, freshness: ReceiptFreshness, assessment?: {status: string; reason?: string; answers?: Record<string, {choice:string;confidence?:number;probabilities?:Record<string,number|undefined>}>}, receiptWarnings: string[] = [], context: {tool?: 'verification' | 'ui'; allowedCaseIds?: string[]} = {}) {
 const warnings: string[] = [], recommendedNextActions: string[] = [];
 const missingBinaries = receiptWarnings.filter(w => w.startsWith('missing_binary:')).map(w => w.slice('missing_binary:'.length));
 const reason = String(execution.reason);
 if (assessment?.reason === 'invalid_case_id') {
  warnings.push('assessment_case_id_rejected');
  const allowed = [...new Set((context.allowedCaseIds ?? []).filter(id => /^(?:run|step-(?:0|[1-9]|1[0-9]))$/.test(id)))].slice(0,20);
  recommendedNextActions.push(allowed.length
   ? `Use unique assessment.caseNotes ids from this invocation: ${allowed.join(', ')}.${context.tool === 'ui' ? ' UI ids refer only to observed assertions, not planned coverage.' : ''}`
   : 'This invocation has no observed eligible case ids. Omit caseNotes; do not invent ids or infer coverage from planned assertions.');
 } else if (assessment?.reason === 'invalid_context') {
  warnings.push('assessment_context_rejected');
  recommendedNextActions.push('Provide only non-sensitive changeSummary and expectedBehavior (1-2000 characters), with at most 8 unique case notes of 1-300 characters and documented ids. Do not include URLs, paths, credentials or raw source.');
 }
 if (context.tool === 'ui' && execution.status === 'not_run') {
  warnings.push('execution_not_passed');
  if (Object.hasOwn(RECEIPT_UI_INPUT_ACTIONS, reason)) {
   warnings.push('scenario_rejected');
   recommendedNextActions.push(`${reason}: ${RECEIPT_UI_INPUT_ACTIONS[reason]}`);
  } else if (Object.hasOwn(RECEIPT_INPUT_ACTIONS, reason)) recommendedNextActions.push(RECEIPT_INPUT_ACTIONS[reason]);
  else if (!recommendedNextActions.length) recommendedNextActions.push('Correct the documented account routing, timeout and scenario input shape. Use an inspected owned non-sensitive loopback fixture; unsupported workflows need a separate authorized browser entry point.');
  return {warnings, recommendedNextActions:recommendedNextActions.slice(0,3), advisoryOnly:true};
 }
 if (execution.status !== 'passed') {
  warnings.push('execution_not_passed');
  if (missingBinaries.length) { warnings.push('missing_binary'); recommendedNextActions.push(`Tests could not start ${missingBinaries.join(', ')}: the runner passes the host PATH without HOME. Install it on PATH or select tests that do not spawn it.`); }
  else if (Object.hasOwn(RECEIPT_INPUT_ACTIONS, reason)) recommendedNextActions.push(RECEIPT_INPUT_ACTIONS[reason]);
  else if (RECEIPT_TEST_PATH_REASONS.includes(reason)) recommendedNextActions.push('Pass 1-32 existing repository-relative .js/.mjs/.cjs test files: no absolute paths, .., symlinks or duplicates.');
  else recommendedNextActions.push(context.tool === 'ui' ? 'Inspect the owned fixture and the failed or incomplete DOM assertion; use current visible selectors and literal expectations.' : 'Inspect the relevant failing or incomplete tests locally.');
 }
 if (freshness !== 'fresh') { warnings.push('source_not_fresh'); recommendedNextActions.push(context.tool === 'ui' ? 'Stored browser observations do not establish current UI state. Reobserve only an allowed, authorized non-sensitive loopback scenario.' : 'Run verification again against the current source.'); }
 if (assessment && (assessment.status !== 'scored' || Object.values(assessment.answers ?? {}).some(a => a.confidence === undefined || a.confidence < 0.8 || a.probabilities?.[a.choice] === undefined || Number(a.probabilities[a.choice]) < 0.8))) { warnings.push('adequacy_unknown'); recommendedNextActions.push('Inspect coverage and boundary evidence; no confident adequacy claim is available.'); }
 else if (assessment && Object.values(assessment.answers ?? {}).some(a => ['gap', 'missing'].includes(a.choice))) { warnings.push('adequacy_gap'); recommendedNextActions.push(context.tool === 'ui' ? 'Inspect changed behavior and add relevant allowed DOM boundary assertions.' : 'Inspect changed behavior and add relevant boundary tests.'); }
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

// Delegation verification loop core: private per-session state, bounded git
// facts, receipt-coverage evaluation and the deterministic gate text. Hook and
// tool surfaces consume these primitives; every path is fail-open for hooks and
// bounded for the tool. State files are writer-owned: this module only ever
// writes the current session's file and reads every other session file.
import * as loopFs from 'node:fs/promises';
import { constants as loopConstants } from 'node:fs';
import * as loopPath from 'node:path';
import { createHash as loopHash, randomUUID as loopUUID } from 'node:crypto';
import { execFile as loopExecFile } from 'node:child_process';
import { promisify as loopPromisify } from 'node:util';
import { performance as loopClock } from 'node:perf_hooks';

const loopExec = loopPromisify(loopExecFile);
const loopDigest = (data: string | Uint8Array) => loopHash('sha256').update(data).digest('hex');
const loopHex = /^[a-f0-9]{64}$/;
const loopGitSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const loopIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const loopChildEnv = () => ({ PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' });

export const LOOP_BUDGET_MS = 15000;
export const BEFORE_BUDGET_MS = 3000;
export const LOCK_WAIT_MS = 100;
export const GATE_TEXT_MAX = 1600;
export const MAX_BASELINES = 8;
export const MAX_PENDING = 8;
export const MAX_GATES = 32;
export const MAX_DIRTY_STORED = 32;
export const MAX_STATE_BYTES = 32 * 1024;
export const MAX_RECEIPT_CANDIDATES = 8;
export const MAX_SCAN_SESSION_FILES = 16;
const FACT_MARGIN_MS = 3000;
const RECEIPT_RECOMPUTE_MARGIN_MS = 6000;
const LOOP_GAP_KINDS = ['no_receipt_after_gate', 'receipt_not_passed', 'receipt_no_tests', 'receipt_incomplete', 'receipt_stale', 'receipt_changed_during_run', 'receipt_freshness_unavailable', 'changed_test_uncovered', 'state_unavailable', 'not_a_repository'] as const;
export type LoopGapKindName = (typeof LOOP_GAP_KINDS)[number];
export type LoopGateTrigger = 'task' | 'task_async' | 'subagent_terminal' | 'job_terminal';
export type LoopBindingEvidence = 'present' | 'absent' | 'unknown';
export type LoopGateFactState = 'available' | 'partial' | 'unavailable';
export type LoopReceiptState = 'none' | 'present' | 'fresh_passed' | 'unavailable';

export type LoopBaseline = { toolCallId: string; head: string; porcelainDigest: string; dirtyFiles: string[]; capturedAt: string };
export type LoopPendingAsync = { jobId: string; baselineToolCallId: string | null; recordedAt: string; consumedAtGateId: string | null; consumedAt: string | null };
export type LoopGate = {
 toolCallId?: string; jobId?: string;
 id: string; trigger: LoopGateTrigger; dedupKey: string; dedupKeyDigest: string;
 baselineToolCallId: string | null; emittedAt: string;
 facts: LoopGateFactState; bindingEvidence: LoopBindingEvidence; persistence?: 'applied' | 'no_changes' | 'recovery_available';
 boundRoot?: string; boundBaseline?: string;
 changedFiles: number; commits: number | null; receiptState: LoopReceiptState; stateWrite: 'ok' | 'drop';
 resolvedAt: string | null; resolution: 'no_change' | 'receipt' | null; resolvedReceiptId: string | null; loopRuns: number;
};
export type LoopState = {
 schemaVersion: 1; sessionDigest: string; repoDigest: string; repoRoot: string; updatedAt: string;
 baselines: LoopBaseline[]; pendingAsync: LoopPendingAsync[]; gates: LoopGate[];
};
export type LoopGitFacts = { available: boolean; head: string | null; treeClean: boolean; dirtyFiles: string[]; changedFiles: number; changedTestFiles: string[]; commits: number | null; changedNames: string[]; namesOverflow: boolean };
export type LoopReceiptSummary = { state: LoopReceiptState; id: string | null; observedAt: string | null; status: string | null; freshness: string | null };
export type LoopCandidate = { id: string; observedAt: string; status: string; files: string[]; freshness: string; root: string };
export type LoopGap = { gateId: string; trigger: LoopGateTrigger; kind: LoopGapKindName; detail: string };
export type LoopEvaluation = {
 status: 'clean' | 'gaps' | 'blocked'; repositoryDigest: string | null; gaps: LoopGap[];
 openGates: number; resolvedGates: number; scannedSessionFiles: number; scanTruncated: boolean; silentPending: number; gapKinds: LoopGapKindName[]; stateWritten: boolean; stateWriteAttempted: boolean; budgetExceeded: boolean;
};

export function sessionDigestOf(sessionId: string): string { return loopDigest(String(sessionId)); }
export function loopStateRoot(): string { return loopPath.join(pluginResultsRoot(), 'verification-receipts', 'loop', 'v1'); }
export function loopRepoDir(repoDigest: string): string { return loopPath.join(loopStateRoot(), repoDigest); }
export function loopStateFile(repoDigest: string, sessionDigest: string): string { return loopPath.join(loopRepoDir(repoDigest), sessionDigest + '.json'); }
function loopLockPath(repoDigest: string): string { return loopPath.join(loopRepoDir(repoDigest), '.loop.lock'); }

export function emptyLoopState(sessionDigest: string, repoDigest: string, repoRoot: string): LoopState {
 return { schemaVersion: 1, sessionDigest, repoDigest, repoRoot, updatedAt: new Date().toISOString(), baselines: [], pendingAsync: [], gates: [] };
}

function loopPlain(value: unknown, depth = 0): boolean {
 if (depth > 6) return false;
 if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
 if (typeof value === 'number') return Number.isFinite(value);
 if (!value || typeof value !== 'object') return false;
 if (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
 return true;
}
export function validLoopState(value: unknown, repoDigest: string, sessionDigest: string): value is LoopState {
 if (!loopPlain(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
 const state = value as LoopState;
 if (Object.keys(state).length !== 8 || Object.keys(state).some(k => !['schemaVersion', 'sessionDigest', 'repoDigest', 'repoRoot', 'updatedAt', 'baselines', 'pendingAsync', 'gates'].includes(k))) return false;
 if (state.schemaVersion !== 1 || state.sessionDigest !== sessionDigest || state.repoDigest !== repoDigest) return false;
 if (typeof state.repoRoot !== 'string' || !state.repoRoot || state.repoRoot.length > 4096 || typeof state.updatedAt !== 'string') return false;
 if (!Array.isArray(state.baselines) || state.baselines.length > MAX_BASELINES || !Array.isArray(state.pendingAsync) || state.pendingAsync.length > MAX_PENDING || !Array.isArray(state.gates) || state.gates.length > MAX_GATES) return false;
 for (const b of state.baselines) {
  if (!loopPlain(b) || !b || Object.keys(b).length !== 5 || Object.keys(b).some(k => !['toolCallId', 'head', 'porcelainDigest', 'dirtyFiles', 'capturedAt'].includes(k))) return false;
  if (typeof b.toolCallId !== 'string' || b.toolCallId.length > 512 || !loopGitSha.test(b.head) || !loopHex.test(b.porcelainDigest)) return false;
  if (!Array.isArray(b.dirtyFiles) || b.dirtyFiles.length > MAX_DIRTY_STORED || b.dirtyFiles.some(n => typeof n !== 'string' || n.length > 1024)) return false;
  if (typeof b.capturedAt !== 'string') return false;
 }
 for (const p of state.pendingAsync) {
  if (!loopPlain(p) || !p || Object.keys(p).length !== 5 || Object.keys(p).some(k => !['jobId', 'baselineToolCallId', 'recordedAt', 'consumedAtGateId', 'consumedAt'].includes(k))) return false;
  if (typeof p.jobId !== 'string' || !p.jobId || p.jobId.length > 512) return false;
  if (!(p.baselineToolCallId === null || (typeof p.baselineToolCallId === 'string' && p.baselineToolCallId.length <= 512))) return false;
  if (!(p.consumedAtGateId === null || (typeof p.consumedAtGateId === 'string' && p.consumedAtGateId.length <= 64))) return false;
  if (!(p.consumedAt === null || typeof p.consumedAt === 'string')) return false;
  if (typeof p.recordedAt !== 'string') return false;
 }
 for (const g of state.gates) {
  if (!loopPlain(g) || !g || Object.keys(g).some(k => !['id', 'trigger', 'dedupKey', 'dedupKeyDigest', 'toolCallId', 'jobId', 'baselineToolCallId', 'emittedAt', 'facts', 'bindingEvidence', 'persistence', 'boundRoot', 'boundBaseline', 'changedFiles', 'commits', 'receiptState', 'stateWrite', 'resolvedAt', 'resolution', 'resolvedReceiptId', 'loopRuns'].includes(k))) return false;
  if (!loopIdPattern.test(g.id) || !['task', 'task_async', 'subagent_terminal', 'job_terminal'].includes(g.trigger)) return false;
  if (typeof g.dedupKey !== 'string' || !g.dedupKey || g.dedupKey.length > 600 || !loopHex.test(g.dedupKeyDigest)) return false;
  if (!(g.toolCallId === undefined || (typeof g.toolCallId === 'string' && g.toolCallId.length <= 512))) return false;
  if (!(g.jobId === undefined || (typeof g.jobId === 'string' && g.jobId.length <= 512))) return false;
  if (!(g.baselineToolCallId === null || (typeof g.baselineToolCallId === 'string' && g.baselineToolCallId.length <= 512))) return false;
  if (typeof g.emittedAt !== 'string') return false;
  if (!['available', 'partial', 'unavailable'].includes(g.facts) || !['present', 'absent', 'unknown'].includes(g.bindingEvidence)) return false;
  if (!(g.persistence === undefined || ['applied', 'no_changes', 'recovery_available'].includes(g.persistence))) return false;
  if (!(g.boundRoot === undefined || (typeof g.boundRoot === 'string' && g.boundRoot.length <= 4096))) return false;
  if (!(g.boundBaseline === undefined || (typeof g.boundBaseline === 'string' && g.boundBaseline.length <= 4096))) return false;
  if (!Number.isSafeInteger(g.changedFiles) || g.changedFiles < 0 || !(g.commits === null || (Number.isSafeInteger(g.commits) && g.commits >= 0))) return false;
  if (!['none', 'present', 'fresh_passed', 'unavailable'].includes(g.receiptState) || !['ok', 'drop'].includes(g.stateWrite)) return false;
  if (!(g.resolvedAt === null || typeof g.resolvedAt === 'string')) return false;
  if (!(g.resolution === null || g.resolution === 'no_change' || g.resolution === 'receipt')) return false;
  if (!(g.resolvedReceiptId === null || (typeof g.resolvedReceiptId === 'string' && loopIdPattern.test(g.resolvedReceiptId)))) return false;
  if (!Number.isSafeInteger(g.loopRuns) || g.loopRuns < 0) return false;
 }
 return true;
}

export function pruneLoopState(state: LoopState): void {
 while (state.baselines.length > MAX_BASELINES) state.baselines.shift();
 while (state.pendingAsync.length > MAX_PENDING) state.pendingAsync.shift();
 for (const b of state.baselines) if (b.dirtyFiles.length > MAX_DIRTY_STORED) b.dirtyFiles = b.dirtyFiles.slice(0, MAX_DIRTY_STORED);
 while (state.gates.length > MAX_GATES) {
  const index = state.gates.findIndex(g => g.resolvedAt !== null);
  if (index < 0) break;
  state.gates.splice(index, 1);
 }
 for (const g of state.gates) if (g.loopRuns > 1000000) g.loopRuns = 1000000;
}

export function serializeLoopState(state: LoopState): string | null {
 pruneLoopState(state);
 if (state.gates.length > MAX_GATES || state.baselines.length > MAX_BASELINES || state.pendingAsync.length > MAX_PENDING) return null;
 const body = JSON.stringify(state);
 return Buffer.byteLength(body) <= MAX_STATE_BYTES ? body : null;
}

export async function readLoopState(repoDigest: string, sessionDigest: string): Promise<{ status: 'ok' | 'missing' | 'unavailable'; state: LoopState | null }> {
 const file = loopStateFile(repoDigest, sessionDigest);
 let body: Buffer;
 try { body = await readPrivateResultFile(file, MAX_STATE_BYTES); }
 catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', state: null };
  return { status: 'unavailable', state: null };
 }
 try {
  const parsed = JSON.parse(body.toString('utf8'));
  if (!validLoopState(parsed, repoDigest, sessionDigest)) return { status: 'unavailable', state: null };
  return { status: 'ok', state: parsed };
 } catch { return { status: 'unavailable', state: null }; }
}

/** Locked read-modify-write for the current session's own file. Never touches other sessions. */
export async function withLoopStateWrite(repoDigest: string, sessionDigest: string, repoRoot: string, mutate: (state: LoopState) => void): Promise<'ok' | 'drop'> {
 const dir = loopRepoDir(repoDigest);
 try { await ensurePrivateResultDirectory(dir, true); } catch { return 'drop'; }
 const lockFile = loopLockPath(repoDigest);
 let lock: loopFs.FileHandle | undefined;
 const deadline = loopClock.now() + LOCK_WAIT_MS;
 try {
  while (!lock) {
   try { lock = await loopFs.open(lockFile, loopConstants.O_WRONLY | loopConstants.O_CREAT | loopConstants.O_EXCL | loopConstants.O_NOFOLLOW, 0o600); }
   catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'drop';
    if (loopClock.now() >= deadline) return 'drop';
    await new Promise(resolve => setTimeout(resolve, 5));
   }
  }
  const lockStat = await lock.stat();
  if (!lockStat.isFile() || lockStat.nlink !== 1 || (lockStat.mode & 0o7777) !== 0o600 || lockStat.uid !== process.getuid?.()) return 'drop';
  const file = loopStateFile(repoDigest, sessionDigest);
  const existing = await readLoopState(repoDigest, sessionDigest);
  if (existing.status === 'unavailable') {
   // A corrupt own file is never repaired in place: fall back to a fresh file only when the
   // corrupt bytes cannot be trusted; the caller journals the drop instead of overwriting.
   return 'drop';
  }
  const state = existing.state ?? emptyLoopState(sessionDigest, repoDigest, repoRoot);
  state.repoRoot = repoRoot;
  mutate(state);
  state.updatedAt = new Date().toISOString();
  const body = serializeLoopState(state);
  if (body === null) return 'drop';
  const temp = loopPath.join(dir, '.' + loopUUID() + '.tmp');
  const handle = await loopFs.open(temp, loopConstants.O_WRONLY | loopConstants.O_CREAT | loopConstants.O_EXCL | loopConstants.O_NOFOLLOW, 0o600);
  try {
   const stat = await handle.stat();
   if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.()) return 'drop';
   await handle.writeFile(body);
   await handle.sync();
  } finally { await handle.close(); }
  const staged = await readPrivateResultFile(temp, MAX_STATE_BYTES);
  if (staged.toString('utf8') !== body) { await loopFs.unlink(temp).catch(() => {}); return 'drop'; }
  await loopFs.rename(temp, file);
  return 'ok';
 } catch { return 'drop'; }
 finally {
  if (lock) {
   try { await lock.close(); } catch {}
   try { const stat = await loopFs.lstat(lockFile); if (stat.isFile() && stat.uid === process.getuid?.()) await loopFs.unlink(lockFile); } catch {}
  }
 }
}

async function loopRunGit(root: string, args: string[], deadlineMs: number): Promise<{ bytes: Buffer } | null> {
 const remaining = deadlineMs - loopClock.now();
 if (remaining <= 0) return null;
 try {
  const { stdout } = await loopExec('git', args, { cwd: root, env: loopChildEnv(), timeout: Math.max(1, Math.min(BEFORE_BUDGET_MS, Math.ceil(remaining))), maxBuffer: 1024 * 1024, encoding: 'buffer' });
  return { bytes: stdout };
 } catch { return null; }
}

export async function resolveRepoRoot(cwd: string, budgetMs = BEFORE_BUDGET_MS): Promise<string | null> {
 const deadline = loopClock.now() + budgetMs;
 const head = await loopRunGit(cwd, ['rev-parse', '--show-toplevel'], deadline);
 if (!head) return null;
 const top = head.bytes.toString('utf8').trim();
 if (!top || top.includes('\0')) return null;
 try { return await loopFs.realpath(top); } catch { return null; }
}

function loopNoisePath(name: string): boolean {
 return name.split('/').some(part => part === '.git' || part === '.gjc' || part === '.gjc-plugin');
}
function splitPorcelain(bytes: Buffer): { entries: string[]; deleted: string[]; digest: string } {
 const text = bytes.toString('utf8');
 const parts = text.split('\0').filter(Boolean);
 const entries: string[] = [];
 const deleted: string[] = [];
 for (const part of parts) {
  const status = part.slice(0, 2);
  const name = part.length > 3 ? part.slice(3) : part;
  if (!name || name.includes('\u0000') || loopNoisePath(name)) continue;
  if (status.includes('D')) deleted.push(name); else entries.push(name);
 }
 return { entries, deleted, digest: loopDigest(bytes) };
}

export async function captureBaseline(root: string, budgetMs = BEFORE_BUDGET_MS): Promise<LoopBaseline | null> {
 const deadline = loopClock.now() + budgetMs;
 const head = await loopRunGit(root, ['rev-parse', 'HEAD'], deadline);
 const status = await loopRunGit(root, ['status', '--porcelain=v1', '-z'], deadline);
 if (!head || !status) return null;
 const headText = head.bytes.toString('utf8').trim();
 if (!loopGitSha.test(headText)) return null;
 const porcelain = splitPorcelain(status.bytes);
 return { toolCallId: '', head: headText, porcelainDigest: porcelain.digest, dirtyFiles: porcelain.entries.slice(0, MAX_DIRTY_STORED), capturedAt: new Date().toISOString() };
}

export async function gitDeltaFacts(root: string, baselineHead: string | null, budgetMs = BEFORE_BUDGET_MS): Promise<LoopGitFacts> {
 const deadline = loopClock.now() + budgetMs;
 const head = await loopRunGit(root, ['rev-parse', 'HEAD'], deadline);
 const status = await loopRunGit(root, ['status', '--porcelain=v1', '-z'], deadline);
 if (!head || !status) return { available: false, head: null, treeClean: false, dirtyFiles: [], changedFiles: 0, changedTestFiles: [], commits: null, changedNames: [], namesOverflow: false };
 const headText = head.bytes.toString('utf8').trim();
 const porcelain = splitPorcelain(status.bytes);
 const names = new Set<string>([...porcelain.entries, ...porcelain.deleted]);
 const deletedNames = new Set<string>(porcelain.deleted);
 let namesOverflow = false;
 let commits: number | null = null;
 if (baselineHead && loopGitSha.test(baselineHead)) {
  if (baselineHead === headText) commits = 0;
  else {
   const rev = await loopRunGit(root, ['rev-list', '--count', baselineHead + '..HEAD'], deadline);
   if (rev) { const parsed = Number.parseInt(rev.bytes.toString('utf8').trim(), 10); if (Number.isSafeInteger(parsed) && parsed >= 0) commits = parsed; }
   const diff = await loopRunGit(root, ['diff', '--name-only', '-z', baselineHead, 'HEAD'], deadline);
   if (diff) for (const name of diff.bytes.toString('utf8').split('\0')) if (name && !loopNoisePath(name)) names.add(name);
   const deletedDiff = await loopRunGit(root, ['diff', '--diff-filter=D', '--name-only', '-z', baselineHead, 'HEAD'], deadline);
   if (deletedDiff) for (const name of deletedDiff.bytes.toString('utf8').split('\0')) if (name && !loopNoisePath(name)) deletedNames.add(name);
  }
 }
 const changedNames: string[] = [];
 for (const name of [...names].sort()) {
  if (changedNames.length >= 50) { namesOverflow = true; break; }
  changedNames.push(name);
 }
 // Deleted files are changes but can never be covered by a receipt run; they are excluded from the coverage demand.
 const changedTestFiles = changedNames.filter(name => /\.(?:js|mjs|cjs)$/.test(name) && !deletedNames.has(name));
 return { available: true, head: headText, treeClean: porcelain.entries.length === 0 && porcelain.deleted.length === 0, dirtyFiles: porcelain.entries.slice(0, MAX_DIRTY_STORED), changedFiles: namesOverflow ? 50 : names.size, changedTestFiles, commits, changedNames, namesOverflow };
}

export function taskDedupKey(toolCallId: string): string { return 'task:' + toolCallId; }
export function jobDedupKey(jobId: string): string { return 'job:' + jobId; }
export function dedupDigest(dedupKey: string): string { return loopDigest(dedupKey); }
export function toolCallDigestFor(trigger: string, dedupKey: string): string { return loopDigest(trigger + '|' + dedupKey); }

export type LoopGateEmission = {
 trigger: LoopGateTrigger; dedupKey: string; toolCallId?: string; jobId?: string;
 baselineToolCallId: string | null; facts: LoopGateFactState; bindingEvidence: LoopBindingEvidence;
 boundRoot?: string; boundBaseline?: string; changedFiles: number; commits: number | null; receiptState: LoopReceiptState;
 noChange: boolean;
};
/** Record one gate with dedup. Returns the canonical gate id (existing on dedup) or null on state drop. */
export async function recordGate(repoDigest: string, sessionDigest: string, repoRoot: string, emission: LoopGateEmission): Promise<{ gateId: string | null; duplicate: boolean; stateWrite: 'ok' | 'drop' }> {
 let result: { gateId: string | null; duplicate: boolean; stateWrite: 'ok' | 'drop' } = { gateId: null, duplicate: false, stateWrite: 'drop' };
 const status = await withLoopStateWrite(repoDigest, sessionDigest, repoRoot, state => {
  const existing = state.gates.find(g => g.dedupKey === emission.dedupKey);
  if (existing) {
   if (emission.jobId !== undefined) consumePending(state, emission.jobId, existing.id);
   result = { gateId: existing.id, duplicate: true, stateWrite: 'ok' };
   return;
  }
  const gate: LoopGate = {
   id: loopUUID(), trigger: emission.trigger, dedupKey: emission.dedupKey, dedupKeyDigest: dedupDigest(emission.dedupKey),
   ...(emission.toolCallId !== undefined ? { toolCallId: emission.toolCallId } : {}),
   ...(emission.jobId !== undefined ? { jobId: emission.jobId } : {}),
   baselineToolCallId: emission.baselineToolCallId, emittedAt: new Date().toISOString(),
   facts: emission.facts, bindingEvidence: emission.bindingEvidence,
   ...(emission.bindingEvidence !== 'absent' ? { persistence: 'recovery_available' as const } : emission.noChange ? { persistence: 'no_changes' as const } : { persistence: 'applied' as const }),
   ...(emission.boundRoot !== undefined ? { boundRoot: emission.boundRoot } : {}),
   ...(emission.boundBaseline !== undefined ? { boundBaseline: emission.boundBaseline } : {}),
   changedFiles: emission.changedFiles, commits: emission.commits, receiptState: emission.receiptState, stateWrite: 'ok',
   resolvedAt: null, resolution: null, resolvedReceiptId: null, loopRuns: 0,
  };
  if (emission.noChange) { gate.resolvedAt = gate.emittedAt; gate.resolution = 'no_change'; }
  state.gates.push(gate);
  if (emission.jobId !== undefined) consumePending(state, emission.jobId, gate.id);
  result = { gateId: gate.id, duplicate: false, stateWrite: 'ok' };
 });
 if (status === 'drop') result = { gateId: null, duplicate: false, stateWrite: 'drop' };
 return result;
}

function consumePending(state: LoopState, jobId: string, gateId: string): void {
 const pending = state.pendingAsync.find(p => p.jobId === jobId);
 if (pending && pending.consumedAtGateId === null) { pending.consumedAtGateId = gateId; pending.consumedAt = new Date().toISOString(); }
}

export async function recordTaskBaseline(repoDigest: string, sessionDigest: string, repoRoot: string, toolCallId: string, baseline: LoopBaseline): Promise<'ok' | 'drop'> {
 return await withLoopStateWrite(repoDigest, sessionDigest, repoRoot, state => {
  const existing = state.baselines.find(b => b.toolCallId === toolCallId);
  if (existing) return;
  state.baselines.push({ ...baseline, toolCallId });
 });
}

export async function recordPendingAsync(repoDigest: string, sessionDigest: string, repoRoot: string, jobId: string, baselineToolCallId: string | null): Promise<'ok' | 'drop'> {
 return await withLoopStateWrite(repoDigest, sessionDigest, repoRoot, state => {
  if (state.pendingAsync.some(p => p.jobId === jobId)) return;
  state.pendingAsync.push({ jobId, baselineToolCallId, recordedAt: new Date().toISOString(), consumedAtGateId: null, consumedAt: null });
 });
}

async function listReceiptEntries(root: string, base: string): Promise<{ ids: { id: string; mtimeMs: number }[]; error: boolean }> {
 let repoDigest: string;
 try { repoDigest = await repositoryDigestOf(root); } catch { return { ids: [], error: false }; }
 const dir = loopPath.join(base, repoDigest);
 let names: string[];
 try { names = await loopFs.readdir(dir); }
 catch (error) { return { ids: [], error: (error as NodeJS.ErrnoException).code !== 'ENOENT' }; }
 const entries: { id: string; mtimeMs: number }[] = [];
 for (const name of names) {
  if (name === '.admission.lock' || !name.endsWith('.json')) continue;
  const id = name.slice(0, -5);
  if (!loopIdPattern.test(id)) continue;
  try { const stat = await loopFs.lstat(loopPath.join(dir, name)); if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ id, mtimeMs: stat.mtimeMs }); }
  catch { /* skip unreadable candidates; bounded scan */ }
 }
 entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
 return { ids: entries, error: false };
}

export async function repositoryDigestOf(root: string): Promise<string> { return loopDigest(await loopFs.realpath(root)); }

/** Cheap gate-time summary: newest stored verification receipt only; stored freshness, never a recompute. */
export async function latestReceiptSummary(root: string, base = receiptStoreBase()): Promise<LoopReceiptSummary> {
 const listed = await listReceiptEntries(root, base);
 if (listed.error) return { state: 'unavailable', id: null, observedAt: null, status: null, freshness: null };
 if (!listed.ids.length) return { state: 'none', id: null, observedAt: null, status: null, freshness: null };
 let sawInvalid = false;
 let firstCandidate = true;
 for (const entry of listed.ids.slice(0, MAX_RECEIPT_CANDIDATES)) {
  const receipt = await loadReceipt(root, entry.id, base);
  if (!receipt) {
   if (firstCandidate) return { state: 'unavailable', id: null, observedAt: null, status: null, freshness: null };
   sawInvalid = true;
   continue;
  }
  if (receipt.plugin !== 'verification-receipts') { firstCandidate = false; continue; }
  const status = typeof receipt.execution.status === 'string' ? receipt.execution.status : 'unavailable';
  const freshPassed = status === 'passed' && receipt.freshness === 'fresh';
  return { state: freshPassed ? 'fresh_passed' : 'present', id: receipt.id, observedAt: receipt.observedAt, status, freshness: receipt.freshness };
 }
 return sawInvalid ? { state: 'unavailable', id: null, observedAt: null, status: null, freshness: null } : { state: 'none', id: null, observedAt: null, status: null, freshness: null };
}

/** R1 candidate collection: newest receipts for the roots, freshness recomputed only for the bounded set. */
export async function collectReceiptCandidates(roots: string[], gateEmittedAtMs: number, base = receiptStoreBase(), cache?: { freshness: Map<string, string> }, deadlineMs?: number, stop?: { truncated: boolean }): Promise<LoopCandidate[]> {
 const candidates: LoopCandidate[] = [];
 const seen = new Set<string>();
 for (const root of roots) {
  const listed = await listReceiptEntries(root, base);
  if (listed.error) throw new Error('store_unavailable');
  for (const entry of listed.ids) {
   if (deadlineMs !== undefined && loopClock.now() >= deadlineMs) { if (stop) stop.truncated = true; return candidates; }
   const key = root + '\n' + entry.id;
   if (seen.has(key)) continue;
   seen.add(key);
   if (candidates.length >= MAX_RECEIPT_CANDIDATES) break;
   const receipt = await loadReceipt(root, entry.id, base);
   if (!receipt || receipt.plugin !== 'verification-receipts') continue;
   const observedAtMs = Date.parse(receipt.observedAt);
   if (!Number.isFinite(observedAtMs) || observedAtMs < gateEmittedAtMs) continue;
   if (deadlineMs !== undefined && deadlineMs - loopClock.now() < RECEIPT_RECOMPUTE_MARGIN_MS) { if (stop) stop.truncated = true; return candidates; }
   let freshness: string;
   if (cache?.freshness.has(key)) freshness = cache.freshness.get(key)!;
   else { freshness = await currentReceiptFreshness(root, receipt, base); cache?.freshness.set(key, freshness); }
   const files = (await loadReceiptInputs(root, entry.id, base)) ?? [];
   const status = typeof receipt.execution.status === 'string' ? receipt.execution.status : 'unavailable';
   candidates.push({ id: receipt.id, observedAt: receipt.observedAt, status, files, freshness, root });
   if (candidates.length >= MAX_RECEIPT_CANDIDATES) break;
  }
 }
 return candidates;
}

export function gapKindForCandidate(candidate: LoopCandidate | undefined, changedTestFiles: string[]): LoopGapKindName {
 if (!candidate) return 'no_receipt_after_gate';
 if (candidate.status === 'failed') return 'receipt_not_passed';
 if (candidate.status === 'no_tests') return 'receipt_no_tests';
 if (candidate.status === 'incomplete' || candidate.status === 'not_run') return 'receipt_incomplete';
 if (candidate.status === 'unavailable') return 'receipt_freshness_unavailable';
 if (candidate.status !== 'passed') return 'receipt_not_passed';
 if (candidate.freshness === 'stale') return 'receipt_stale';
 if (candidate.freshness === 'changed_during_run') return 'receipt_changed_during_run';
 if (candidate.freshness !== 'fresh') return 'receipt_freshness_unavailable';
 const covered = changedTestFiles.every(file => candidate.files.includes(file));
 return covered ? 'no_receipt_after_gate' : 'changed_test_uncovered';
}

export function isCoveringCandidate(candidate: LoopCandidate, changedTestFiles: string[]): boolean {
 return candidate.status === 'passed' && candidate.freshness === 'fresh' && changedTestFiles.every(file => candidate.files.includes(file));
}

type ScannedSession = { sessionDigest: string; state: LoopState; own: boolean };

async function scanSessionFiles(repoDigest: string, sessionDigest: string): Promise<{ sessions: ScannedSession[]; scanned: number; truncated: boolean; ownCorrupt: boolean }> {
 const dir = loopRepoDir(repoDigest);
 let names: string[];
 try { names = await loopFs.readdir(dir); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [], scanned: 0, truncated: false, ownCorrupt: false }; throw error; }
 const files = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
 const truncated = files.length > MAX_SCAN_SESSION_FILES;
 const ownName = sessionDigest + '.json';
 const others: { name: string; mtimeMs: number }[] = [];
 for (const name of files) {
  if (name === ownName) continue;
  try { const stat = await loopFs.lstat(loopPath.join(dir, name)); if (stat.isFile() && !stat.isSymbolicLink()) others.push({ name, mtimeMs: stat.mtimeMs }); }
  catch { /* skip unreadable candidates; bounded scan */ }
 }
 others.sort((a, b) => b.mtimeMs - a.mtimeMs);
 const ownIncluded = files.includes(ownName);
 const limit = MAX_SCAN_SESSION_FILES - (ownIncluded ? 1 : 0);
 const ordered = [...(ownIncluded ? [ownName] : []), ...others.slice(0, Math.max(0, limit)).map(entry => entry.name)];
 const sessions: ScannedSession[] = [];
 let ownCorrupt = false;
 for (const name of ordered) {
  const digest = name.slice(0, -5);
  const read = await readLoopState(repoDigest, digest);
  if (read.status === 'ok' && read.state) { sessions.push({ sessionDigest: digest, state: read.state, own: digest === sessionDigest }); continue; }
  if (read.status === 'unavailable' && digest === sessionDigest) ownCorrupt = true;
 }
 return { sessions, scanned: ordered.length, truncated, ownCorrupt };
}

export type LoopEvaluationDeps = { base?: string; now?: number; budgetMs?: number };

export async function evaluateRepoGates(root: string, repoDigest: string, sessionDigest: string, deps: LoopEvaluationDeps = {}): Promise<LoopEvaluation> {
 const now = deps.now ?? Date.now();
 const deadlineMs = loopClock.now() + Math.max(1, deps.budgetMs ?? LOOP_BUDGET_MS);
 let sessions: ScannedSession[];
 let scanned = 0;
 let truncated = false;
 try {
  const scan = await scanSessionFiles(repoDigest, sessionDigest);
  if (scan.ownCorrupt) return { status: 'blocked', repositoryDigest: repoDigest, gaps: [{ gateId: '', trigger: 'task', kind: 'state_unavailable', detail: 'own session state is unreadable' }], openGates: 0, resolvedGates: 0, scannedSessionFiles: scan.scanned, scanTruncated: scan.truncated, silentPending: 0, gapKinds: ['state_unavailable'], stateWritten: false, stateWriteAttempted: false, budgetExceeded: false };
  sessions = scan.sessions; scanned = scan.scanned; truncated = scan.truncated;
 } catch {
  return { status: 'blocked', repositoryDigest: repoDigest, gaps: [{ gateId: '', trigger: 'task', kind: 'state_unavailable', detail: 'loop state directory is unreadable' }], openGates: 0, resolvedGates: 0, scannedSessionFiles: 0, scanTruncated: false, silentPending: 0, gapKinds: ['state_unavailable'], stateWritten: false, stateWriteAttempted: false, budgetExceeded: false };
 }
 const factsCache = new Map<string, LoopGitFacts>();
 const gateFacts = async (baselineHead: string | null): Promise<LoopGitFacts> => {
  const key = baselineHead ?? 'none';
  if (!factsCache.has(key)) factsCache.set(key, await gitDeltaFacts(root, baselineHead, Math.min(BEFORE_BUDGET_MS, Math.max(1, deadlineMs - loopClock.now()))));
  return factsCache.get(key)!;
 };
 const freshnessCache = { freshness: new Map<string, string>() };
 const gaps: LoopGap[] = [];
 const resolutionsToStamp: { gateId: string; resolution: 'no_change' | 'receipt'; resolvedReceiptId: string | null; at: string }[] = [];
 let openGates = 0;
 let resolvedGates = 0;
 let silentPending = 0;
 let budgetExceeded = false;
 let skippedGates = 0;
 const gapKinds: LoopGapKindName[] = [];
 for (const session of sessions) {
  for (const pending of session.state.pendingAsync) if (pending.consumedAtGateId === null) silentPending++;
  for (const gate of session.state.gates) {
   if (gate.resolvedAt !== null) { resolvedGates++; continue; }
   if (budgetExceeded || deadlineMs - loopClock.now() < FACT_MARGIN_MS) {
    budgetExceeded = true;
    skippedGates++;
    openGates++;
    gaps.push({ gateId: gate.id, trigger: gate.trigger, kind: 'state_unavailable', detail: 'evaluation budget reached before this gate could be evaluated' });
    if (!gapKinds.includes('state_unavailable')) gapKinds.push('state_unavailable');
    continue;
   }
   const baseline = session.state.baselines.find(b => b.toolCallId === gate.baselineToolCallId) ?? null;
   const roots = [root];
   if (gate.boundRoot && gate.boundRoot !== root) roots.push(gate.boundRoot);
   const gateDeadline = Math.max(1, deadlineMs - loopClock.now());
   let candidates: LoopCandidate[];
   const scanStop = { truncated: false };
   try { candidates = await collectReceiptCandidates(roots, Date.parse(gate.emittedAt) || 0, deps.base, freshnessCache, loopClock.now() + gateDeadline, scanStop); }
   catch {
    openGates++; gaps.push({ gateId: gate.id, trigger: gate.trigger, kind: 'state_unavailable', detail: 'receipt store is unreadable' });
    if (!gapKinds.includes('state_unavailable')) gapKinds.push('state_unavailable');
    continue;
   }
   const sameRoot = gate.boundRoot === undefined || gate.boundRoot === root;
   const current = await gateFacts(baseline?.head ?? null);
   const noChange = gate.changedFiles === 0 && (gate.commits === 0 || gate.commits === null) && gate.bindingEvidence === 'absent' && sameRoot && baseline !== null && current.available && current.treeClean && current.changedFiles === 0 && current.commits === 0;
   if (noChange) {
    resolvedGates++;
    if (session.own) resolutionsToStamp.push({ gateId: gate.id, resolution: 'no_change', resolvedReceiptId: null, at: new Date(now).toISOString() });
    continue;
   }
   const changedTests = current.available ? current.changedTestFiles : [];
   const covering = current.available ? candidates.find(candidate => isCoveringCandidate(candidate, changedTests)) : undefined;
   if (covering) {
    resolvedGates++;
    if (session.own) resolutionsToStamp.push({ gateId: gate.id, resolution: 'receipt', resolvedReceiptId: covering.id, at: new Date(now).toISOString() });
    continue;
   }
   // Coverage can only be judged from available repository facts: a receipt is never treated as covering
   // (and a gap is never classified as receipt-side) while the git delta itself is unreadable.
   // A scan stopped by the budget envelope can no longer prove absence of a covering receipt:
   // receipts evaluated before the stop stay valid, but the remainder is unknown, so the gap is
   // reported as a bounded-evaluation state, never as a receipt-side demand.
   const kind = !current.available || scanStop.truncated ? 'state_unavailable' : gapKindForCandidate(candidates[0], changedTests);
   openGates++;
   if (scanStop.truncated) budgetExceeded = true;
   gaps.push({ gateId: gate.id, trigger: gate.trigger, kind, detail: !current.available ? 'repository facts unavailable; coverage cannot be verified' : scanStop.truncated ? 'receipt scan stopped at the evaluation budget; coverage could not be fully checked' : kind === 'changed_test_uncovered' ? `qualifying receipt does not cover changed test files (${changedTests.slice(0, 8).join(', ')})` : 'no covering fresh passed receipt after gate' });
   if (!gapKinds.includes(kind)) gapKinds.push(kind);
  }
 }
 const ownSession = sessions.find(session => session.own);
 let stateWritten = false;
 let stateWriteAttempted = false;
 if (ownSession && resolutionsToStamp.length) {
  stateWriteAttempted = true;
  const status = await withLoopStateWrite(repoDigest, sessionDigest, ownSession.state.repoRoot ?? root, state => {
   for (const stamp of resolutionsToStamp) {
    const gate = state.gates.find(g => g.id === stamp.gateId);
    if (gate && gate.resolvedAt === null) { gate.resolvedAt = stamp.at; gate.resolution = stamp.resolution; gate.resolvedReceiptId = stamp.resolvedReceiptId; }
   }
   for (const gate of state.gates) gate.loopRuns++;
  });
  stateWritten = status === 'ok';
 }
 const boundedGaps = gaps.slice(0, 16);
 // A single bounded operation may still finish slightly past the deadline; the overrun is reported honestly.
 if (!budgetExceeded && loopClock.now() > deadlineMs) budgetExceeded = true;
 if (budgetExceeded) {
  if (!gapKinds.includes('state_unavailable')) gapKinds.push('state_unavailable');
  boundedGaps.push({ gateId: '', trigger: 'task', kind: 'state_unavailable', detail: `evaluation budget reached; ${skippedGates} gate(s) unevaluated` });
 }
 return { status: openGates > 0 || budgetExceeded ? 'gaps' : 'clean', repositoryDigest: repoDigest, gaps: boundedGaps.slice(0, 16), openGates, resolvedGates, scannedSessionFiles: scanned, scanTruncated: truncated, silentPending, gapKinds: gapKinds.slice(0, 10), stateWritten, stateWriteAttempted, budgetExceeded };
}

export type GateTextView = {
 tool: string; idShort: string; facts: LoopGateFactState; root: string | null; baselinePresent: boolean; baselineAt: string | null;
 treeClean: boolean; effectsClean: boolean; changedFiles: number; changedNames: string[]; namesOverflow: boolean; commits: number | null;
 binding: LoopBindingEvidence; receipt: LoopReceiptSummary; partial: { completed: number; total: number } | null; noChange: boolean;
};
export function buildGateText(view: GateTextView): string {
 if (view.noChange) {
  const label = view.root ? loopPath.basename(view.root) : 'unknown-root';
  const line = `[delegation-verification-gate] ${view.tool} ${view.idShort} completed; machine-checked no repo change at ${label} since baseline ${view.baselineAt ?? 'unknown'} (no binding evidence). Run verification_loop to confirm (expected: clean/no_change).`;
  return line.slice(0, GATE_TEXT_MAX);
 }
 const lines: string[] = [];
 lines.push(`[delegation-verification-gate] ${view.tool} ${view.idShort} completed.`);
 const facts: string[] = [];
 if (view.facts === 'unavailable') facts.push('repo facts unavailable');
 else {
  const names = view.changedNames.slice(0, 8).join(', ');
  const more = view.changedFiles > view.changedNames.slice(0, 8).length || view.namesOverflow;
  facts.push(`changed files: ${view.changedFiles === 0 ? 'none observed' : names + (more ? ', +more' : '')}`);
  if (view.commits !== null) facts.push(`commits since baseline: ${view.commits}`);
  facts.push(`tree ${view.treeClean ? 'clean' : 'dirty'}`);
 }
 facts.push(`binding: ${view.binding}`);
 if (view.receipt.state === 'none') facts.push('receipt: none');
 else if (view.receipt.state === 'unavailable') facts.push('receipt: store unavailable');
 else facts.push(`receipt ${view.receipt.id?.slice(0, 8) ?? 'unknown'} (${view.receipt.status ?? 'unknown'}, freshness ${view.receipt.freshness ?? 'unknown'})`);
 if (view.partial) facts.push(`partial batch: ${view.partial.completed}/${view.partial.total} completed`);
 lines.push('Machine facts: ' + facts.join('; ') + '.');
 lines.push('REQUIRED: call verification_loop now; resolve every reported gap (verification_run for tests; fix the underlying work); re-run verification_loop; do not claim completion until status is "clean" or you report an explicit blocker with remaining gaps.');
 lines.push('Sweep (judgment, not machine-checked): sibling tests? docs/README/examples? callers/consumers? deleted-file references? commit/branch state?');
 lines.push('If verification_loop is unavailable in this context, do these checks and report them in your final message.');
 return lines.join('\n').slice(0, GATE_TEXT_MAX);
}

export function gateOutcomePayload(input: { repositoryDigest: string | null; trigger: LoopGateTrigger; dedupKey: string; facts: LoopGateFactState; baselinePresent: boolean; binding: 'none' | 'bound' | 'unknown'; stateWrite: 'ok' | 'drop'; persistence?: 'applied' | 'no_changes' | 'recovery_available'; changedFiles: number; commits?: number; receiptState: LoopReceiptState }) {
 return {
  operation: 'gate_emitted' as const,
  repositoryDigest: input.repositoryDigest,
  toolCallDigest: toolCallDigestFor(input.trigger, input.dedupKey),
  gate: {
   trigger: input.trigger, facts: input.facts, baselinePresent: input.baselinePresent, binding: input.binding, stateWrite: input.stateWrite,
   ...(input.persistence !== undefined ? { persistence: input.persistence } : {}),
   changedFiles: input.changedFiles, ...(input.commits !== undefined && input.commits !== null ? { commits: input.commits } : {}), receiptState: input.receiptState,
  },
 };
}

export function loopOutcomePayload(evaluation: LoopEvaluation, repositoryDigest: string | null) {
 return {
  operation: 'loop_run' as const,
  repositoryDigest: repositoryDigest ?? evaluation.repositoryDigest,
  loop: {
   status: evaluation.status, openGates: evaluation.openGates, resolvedGates: evaluation.resolvedGates,
   scannedSessionFiles: evaluation.scannedSessionFiles, scanTruncated: evaluation.scanTruncated, silentPending: evaluation.silentPending,
   gapKinds: evaluation.gapKinds,
  },
 };
}

export function requiredActionsFor(kinds: LoopGapKindName[]): string[] {
 const actions: string[] = [];
 for (const kind of kinds) {
  if (kind === 'no_receipt_after_gate' || kind === 'changed_test_uncovered') actions.push('Run verification_run over the changed test files (or explain in the final report why verification does not apply).');
  else if (kind === 'receipt_not_passed' || kind === 'receipt_no_tests' || kind === 'receipt_incomplete') actions.push('Fix the failing or incomplete verification and rerun verification_run, then re-run verification_loop.');
  else if (kind === 'receipt_stale' || kind === 'receipt_changed_during_run' || kind === 'receipt_freshness_unavailable') actions.push('Re-run verification_run against the current source, then re-run verification_loop.');
  else if (kind === 'not_a_repository') actions.push('Run verification_loop from inside the repository that received the delegated work, or pass `repository` when the session directory is not a Git work tree.');
  else if (kind === 'state_unavailable') actions.push('Loop state or repository facts are unreadable; inspect the verification-receipts store and re-run verification_loop once facts are available.');
 }
 return [...new Set(actions)].slice(0, 4);
}

// Before-task baseline hook: records one bounded repository baseline per task
// call. It never blocks or rewrites anything; any failure simply leaves the
// delegation ungated-factually (partial facts at gate time).

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function boundedId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= 512 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}
function readSessionId(ctx: unknown): string | null {
	if (!isRecord(ctx) || !isRecord(ctx.sessionManager) || typeof ctx.sessionManager.getSessionId !== 'function') return null;
	try { return boundedId(ctx.sessionManager.getSessionId.call(ctx.sessionManager)); } catch { return null; }
}

export default function register(api: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) {
	api.on('tool_call', async (event, ctx) => {
		try {
			const call = isRecord(event) ? event : null;
			if (!call || call.type !== 'tool_call' || call.toolName !== 'task') return undefined;
			const sessionId = readSessionId(ctx);
			const toolCallId = boundedId(call.toolCallId);
			const cwd = isRecord(ctx) && typeof ctx.cwd === 'string' ? ctx.cwd : null;
			if (!sessionId || !toolCallId || !cwd) return undefined;
			const deadline = performance.now() + BEFORE_BUDGET_MS;
			const root = await resolveRepoRoot(cwd, Math.max(1, deadline - performance.now()));
			if (!root) return undefined;
			const baseline = await captureBaseline(root, Math.max(1, deadline - performance.now()));
			if (!baseline) return undefined;
			const repoDigest = await repositoryDigestOf(root);
			await recordTaskBaseline(repoDigest, sessionDigestOf(sessionId), root, toolCallId, baseline);
			return undefined;
		} catch {
			return undefined;
		}
	});
}
