// GENERATED FILE — do not edit by hand.
// Core: lib/alignment.ts + lib/alignment-journal.ts + adapter: src/alignment.adapter.ts
// Rebuild with: bun scripts/build.mjs

/**
 * Goal alignment core: deterministic authority collection, ordered action
 * rules, and the correction → admission → observation → completion chain.
 *
 * Pure by construction. This module reads no filesystem, network, environment
 * or process state: the caller supplies the branch entries, the baseline
 * observation and the journal load/save adapter. Records carry digests, ids and
 * typed statuses only — never raw user text.
 *
 * Authority comes exclusively from host session *user* entries. Agent prose,
 * todo lists and subagent output are data, never authority.
 */
import { createHash } from "node:crypto";

export type ChangeSemantics = "supersede" | "cancel" | "narrow" | "add" | "unknown";
export type ConstraintKind = "read_only" | "stop" | "forbidden_target";
export type ActionClass = "read" | "bash" | "write";
export type Coverage = "evaluated" | "coverage_gap";
export type Verdict = "aligned" | "drift" | "uncertain" | "allow";
export type Observation = "true" | "false" | "unknown";
export type CriterionKind = "exit_zero" | "artifact_exists" | "criterion_file";
export type ReleaseMode = "none" | "explicit" | "release_ambiguous";

/** Ordered rule ids. `evaluateAction` returns exactly one of these. */
export type RuleId =
	| "drift_write_vs_readonly"
	| "drift_write_forbidden_target"
	| "drift_write_after_stop"
	| "aligned_write_within_requested_scope"
	| "uncertain_authority_ambiguous"
	| "read_allow"
	| "bash_observe"
	| "unknown_authority";

/** Default bounded scan: the last 12 user entries of the session branch. */
export const WINDOW_SIZE = 12;
const MAX_SCAN_ENTRIES = 200;
const MAX_ENTRY_TEXT = 8192;
const MAX_TARGETS = 16;
const MAX_TARGET_LENGTH = 200;
const MAX_ID_LENGTH = 512;
const FUTURE_SKEW_MS = 60_000;

/* ------------------------------------------------------------------------- */
/* Digests and targets                                                        */
/* ------------------------------------------------------------------------- */

/** Stable 32-hex identity for any value this core retains in a record. */
export function digestText(value: string): string {
	return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 32);
}

/**
 * Normalise one path-like target. Quoted or backticked spans, `./` prefixes,
 * doubled separators and trailing punctuation are removed; URLs, whitespace and
 * over-long values are rejected instead of guessed at.
 */
export function normalizeTarget(value: string): string {
	let token = String(value ?? "").trim();
	token = token.replace(/^[`'"(<[]+/, "").replace(/[`'")>\],.:;!?]+$/, "");
	token = token.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	while (token.startsWith("./")) token = token.slice(2);
	if (!token || token.length > MAX_TARGET_LENGTH) return "";
	if (token.includes("://") || /\s/.test(token)) return "";
	return token;
}

/** Digest of a normalised target; the empty target is never a valid digest. */
export function digestTarget(value: string): string {
	const token = normalizeTarget(value);
	return token ? digestText(token) : "";
}

export type AuthorityTarget = { path: string; digest: string };

const FILE_EXTENSION = /\.(?:[cm]?[jt]sx?|json|jsonc|md|mdx|txt|py|rs|go|rb|java|kt|swift|css|scss|html|yml|yaml|toml|ini|sh|bash|zsh|sql|db|sqlite|lock|env|cfg|conf)$/i;
const CRITERION_MARKER = /\bcriterion=(exit_zero|artifact_exists|criterion_file)(?::([^\s`'"]{1,200}))?/i;

/**
 * Extract normalised path-like targets from one user entry. Only explicit,
 * machine-shaped tokens qualify (backticked spans, slash paths, filenames with
 * an extension); free prose never becomes a target.
 */
export function targetsInText(text: string): string[] {
	const found = new Set<string>();
	let source: string;
	try { source = String(text ?? ""); } catch { return []; }
	const add = (raw: string) => {
		const token = normalizeTarget(raw);
		if (!token) return;
		if (!token.includes("/") && !FILE_EXTENSION.test(token)) return;
		found.add(token);
	};
	for (const match of source.matchAll(/`([^`\n]{1,200})`/g)) add(match[1]);
	for (const match of source.matchAll(/(?:^|[\s("'[=])((?:\.{1,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)+(?:\.[\w-]+)?)/g)) add(match[1]);
	for (const match of source.matchAll(/(?:^|[\s("'[=])([\w@.+-]+\.[A-Za-z]{1,8})(?=$|[\s`'"),.;:!?])/g)) add(match[1]);
	for (const match of source.matchAll(new RegExp(CRITERION_MARKER.source, "gi"))) add(match[2] ?? "");
	return [...found].slice(0, MAX_TARGETS);
}

/* ------------------------------------------------------------------------- */
/* Lexicon (deterministic, documented, never a model call)                    */
/* ------------------------------------------------------------------------- */

/* A bare `stop`/`pause`/`중지` is a noun at least as often as it is a directive:
 * "stop 이벤트를 로깅해줘", "배포 중지 기능". Only a standalone directive or a
 * phrase that names the work being stopped is a cancel (JJO-1161 P1). Every
 * pattern here is deliberately explicit; ambiguous single words are not signals. */
const STOP = /^\s*(?:please\s+)?(?:stop|halt|pause|중지|멈춰|그만|그만해|작업\s*취소)\s*[.!?。]*\s*$|\bdo\s+not\s+continue\b|\bcancel\s+(?:the\s+)?(?:work|task|request|job)\b|\b(?:stop|halt|pause)\s+now\b|\b(?:stop|halt|pause)\s+(?:the\s+)?(?:current\s+)?(?:work|task|job|build|run|request|session|everything|all)\b|작업\s*(?:을|를)?\s*(?:중지|멈춰|그만)|작업\s*(?:을|를)?\s*취소\s*(?:해|해줘|해라|하세요|합니다|할게)|(?:중지|멈춰|그만해)\s*(?:해|해줘|해라|하세요|합니다|할게)/i;
/* `read-only` as a feature name ("읽기 전용 모드로 열어줘", "read-only mode") is
 * not an instruction to stop writing. The directive forms below are. */
const READ_ONLY = /\b(?:make|keep|treat)\s+(?:it|this|that|the\s+\S+)\s+read[- ]?only\b|\bread[- ]?only\s+(?:mode\s+)?(?:please|for\s+(?:now|this))\b|\b(?:do\s+not|don'?t)\s+(?:modify|change|edit|write|touch)\s+(?:anything|any\s+files?|any\s+code|the\s+(?:code|source|repo|repository|files|tree|codebase)|files|code)\b|^\s*(?:please\s+)?(?:do\s+not|don'?t)\s+(?:modify|change|edit|write|touch)\s*[.!]*\s*$|\bno\s+(?:edits?|changes?|writes?)\b|\bwithout\s+(?:editing|modifying|changing)\s+(?:anything|any\s+files?|the\s+(?:code|repo|files))\b|읽기\s*전용(?:으로|으로만)?\s*(?:해|해줘|해라|유지|보|봐|설정|진행|처리)|(?:코드|소스|파일|저장소|전체)\s*(?:는|은|을|를)?\s*(?:수정|변경|작성)\s*하지\s*마|^\s*(?:수정|변경|작성)\s*하지\s*마\s*[.!]*\s*$|\b쓰기\s*금지|코드\s*수정\s*금지/i;
/* `instead` alone is a style instruction ("use map instead of for loop"). Only
 * goal-level replacement wording supersedes the current request. Ambiguous phrases stay out: "다른 작업은
 * 하지 마" narrows the scope of the current request instead of replacing it, so the Korean branch needs a
 * switching verb ("다른 작업을 하자") and never fires on the bare noun. */
const SUPERSEDE = /\binstead\s+of\s+(?:the\s+)?(?:goal|request|task|plan|approach|work)\b|\binstead\s*[,:]\s*(?:do|use|work\s+on|implement|build)\b|\bsupersede\b|\breplace\s+the\s+(?:goal|request|task)\b|\bnew\s+(?:goal|request|target)\b|새\s*(?:목표|작업)|목표\s*변경|다른\s*작업(?:을|으로)?\s*(?:하자|하세|하겠|진행|시작|바꾸|해보자)|이건\s*(?:하지\s*마|그만)/i;
const NARROW = /\bnarrow\b|\bonly\b|\bjust\b|\bscope\s*down\b|오직|범위\s*축소/i;
const ADD = /\balso\b|\badditionally\b|\bplus\b|추가로|그리고\s*또/i;
const FORBIDDEN = /\bdo\s+not\s+(?:touch|modify|edit|change|write)\b|\bdon'?t\s+(?:touch|modify|edit|change|write)\b|\bnever\s+(?:touch|modify|edit|change)\b|\bforbidden\b|건드리지\s*마|수정\s*금지|변경\s*금지|작성\s*금지/i;
const RELEASE = /\brelease(?:d|s)?\s+(?:the\s+)?(?:read[- ]?only|restriction|lock|constraint)\b|\bread[- ]?only\s+(?:is\s+)?(?:released|lifted|off)\b|\b(?:writes?|edits?)\s+(?:are|is)\s+(?:now\s+)?(?:allowed|permitted|enabled)\b|\byou\s+may\s+(?:now\s+)?(?:write|edit|modify|change)\b|\bfeel\s+free\s+to\s+(?:write|edit|modify|change)\b|\bcan\s+(?:now\s+)?(?:write|edit|modify|change)\b|읽기\s*전용\s*(?:해제|풀|끝)|(?:수정|쓰기|편집)\s*(?:해도|가능|허용)|이제\s*(?:수정|작성|편집)/i;
const RELEASE_HEDGE = /\bif\b|\bmaybe\b|\bperhaps\b|\bunless\b|\bnot\s+sure\b|\?|혹시|가능하면|아마|조건/i;

/** Change semantics of one entry; first match wins. */
export function classifyChange(text: string): ChangeSemantics {
	let source: string;
	try { source = String(text ?? ""); } catch { return "unknown"; }
	if (STOP.test(source)) return "cancel";
	if (SUPERSEDE.test(source)) return "supersede";
	if (NARROW.test(source)) return "narrow";
	if (ADD.test(source)) return "add";
	return "unknown";
}

/** `continue` is not a release; hedged release wording is explicitly ambiguous. */
export function classifyRelease(text: string): ReleaseMode {
	let source: string;
	try { source = String(text ?? ""); } catch { return "none"; }
	if (!RELEASE.test(source)) return "none";
	return RELEASE_HEDGE.test(source) ? "release_ambiguous" : "explicit";
}

/* ------------------------------------------------------------------------- */
/* Authority                                                                  */
/* ------------------------------------------------------------------------- */

export type AuthorityConstraint =
	| { kind: "read_only"; sinceEntryId: string }
	| { kind: "stop"; sinceEntryId: string }
	| { kind: "forbidden_target"; sinceEntryId: string; targetDigest: string };

/** Journalable criterion: kind plus target digest only. */
export type CriterionState = { kind: CriterionKind; targetDigest: string };

export type Authority = {
	/** Number of user entries scanned (bounded by the window). */
	userEntries: number;
	windowSize: number;
	/** Latest host user entry id; the retry identity, never the branch head. */
	latestUserEntryId: string;
	changeSemantics: ChangeSemantics;
	constraints: readonly AuthorityConstraint[];
	/** Normalised request targets (paths are adapter-local, digests are recorded). */
	targets: readonly AuthorityTarget[];
	scopeDigests: readonly string[];
	release: ReleaseMode;
	criterion: CriterionState | null;
	/** True when older branch entries were not scanned, so constraints may be unseen. */
	authorityTruncated: boolean;
};

function asRecord(value: unknown): Record<string, any> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function boundedId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

function isUserEntry(entry: Record<string, any>): boolean {
	if (entry.type === "assistant" || entry.role === "assistant") return false;
	// Host session entries wrap the message: { type: "message", message: { role, content } }.
	const message = asRecord(entry.message);
	if (message?.role === "assistant") return false;
	if (entry.type === "user" || entry.role === "user") return true;
	if (message?.role === "user") return true;
	const info = asRecord(entry.info);
	return info?.role === "user";
}

/** Bounded text of one host user entry, or null when it carries no authority. */
function entryText(entry: Record<string, any>): string | null {
	if (!isUserEntry(entry)) return null;
	const chunks: string[] = [];
	const push = (value: unknown) => {
		if (typeof value === "string" && value.trim()) chunks.push(value);
	};
	push(entry.text);
	if (Array.isArray(entry.parts)) {
		for (const part of entry.parts) {
			const record = asRecord(part);
			if (!record) continue;
			if (record.type === "text" || record.type === "input_text" || record.type === undefined) push(record.text);
		}
	}
	if (typeof entry.content === "string") push(entry.content);
	else if (Array.isArray(entry.content)) {
		for (const part of entry.content) {
			const record = asRecord(part);
			if (record && (record.type === "text" || record.type === "input_text")) push(record.text);
		}
	}
	const message = asRecord(entry.message);
	if (message) {
		if (typeof message.content === "string") push(message.content);
		else if (Array.isArray(message.content)) {
			for (const part of message.content) {
				const record = asRecord(part);
				if (record && (record.type === "text" || record.type === "input_text")) push(record.text);
			}
		}
	}
	const joined = chunks.join("\n").trim();
	return joined ? joined.slice(0, MAX_ENTRY_TEXT) : null;
}

function entryIdentity(entry: Record<string, any>, text: string, ordinal: number): string {
	return boundedId(entry.id) ?? `anon-${ordinal}-${digestText(text).slice(0, 12)}`;
}

/**
 * Collect the current authority from host branch entries.
 *
 * Returns null when the branch holds no user entry: missing authority is never
 * a block and never an invented request. Only the newest `windowSize` user
 * entries are scanned; assistant/tool entries are ignored entirely.
 *
 * Constraints are sticky in a deliberate, documented way:
 *  - `read_only` clears only on an explicit release (a later "continue" never
 *    clears it, and hedged release wording stays active as release_ambiguous);
 *  - `stop` clears on an explicit release or on a later add/narrow/supersede
 *    request (a new request re-opens work, a bare "continue" does not);
 *  - a forbidden target clears only on an explicit release.
 */
export function collectAuthority(branchEntries: unknown, options: { windowSize?: number } = {}): Authority | null {
	const list = Array.isArray(branchEntries) ? branchEntries : [];
	const windowSize = Math.min(64, Math.max(1, Math.trunc(Number(options.windowSize) || WINDOW_SIZE)));
	const entries: { id: string; text: string }[] = [];
	let scanned = 0;
	let cursor = list.length - 1;
	for (; cursor >= 0 && scanned < MAX_SCAN_ENTRIES && entries.length < windowSize; cursor--) {
		scanned++;
		const entry = asRecord(list[cursor]);
		if (!entry) continue;
		const text = entryText(entry);
		if (text === null) continue;
		entries.push({ id: entryIdentity(entry, text, cursor), text });
	}
	// Unscanned entries remain when the window or the scan cap stopped us early:
	// the authority view is incomplete and must not be read as "no constraint".
	const authorityTruncated = cursor >= 0;
	if (entries.length === 0) return null;
	entries.reverse();

	let latestUserEntryId = entries[entries.length - 1].id;
	let changeSemantics: ChangeSemantics = "unknown";
	let release: ReleaseMode = "none";
	let readOnly: AuthorityConstraint | null = null;
	let stop: AuthorityConstraint | null = null;
	const forbidden = new Map<string, AuthorityConstraint>();
	let targets: AuthorityTarget[] = [];
	let criterion: CriterionState | null = null;

	for (const entry of entries) {
		const semantics = classifyChange(entry.text);
		const entryTargets = targetsInText(entry.text);
		if (READ_ONLY.test(entry.text)) readOnly = { kind: "read_only", sinceEntryId: entry.id };
		if (STOP.test(entry.text)) stop = { kind: "stop", sinceEntryId: entry.id };
		if (entryTargets.length > 0) {
			targets = entryTargets.map(path => ({ path, digest: digestTarget(path) })).filter(target => target.digest !== "");
			// Only targets named at or after the do-not-touch phrase are forbidden:
			// "implement `a.ts` and do not touch `b.ts`" forbids b.ts, never a.ts.
			// A prohibition names its object in the same sentence ("implement `a.ts` and do not touch `b.ts`
			// forbids b.ts"). Scanning to the end of the entry instead collected later prose and later
			// paths, so an assignment that says "add a test; do not delete the existing test" forbade the
			// very file it asked for and blocked the write.
			const forbiddenAt = FORBIDDEN.exec(entry.text)?.index;
			if (forbiddenAt !== undefined) {
				const prohibition = entry.text.slice(forbiddenAt).split(/[.\n。!?](?=\s|$)/)[0];
				for (const path of targetsInText(prohibition)) {
					const digest = digestTarget(path);
					if (digest) forbidden.set(digest, { kind: "forbidden_target", sinceEntryId: entry.id, targetDigest: digest });
				}
			}
		} else if (semantics === "cancel" || semantics === "supersede") {
			// A withdrawn or replaced request no longer authorises its old targets.
			targets = [];
		}
		const marker = CRITERION_MARKER.exec(entry.text);
		if (marker) {
			const kind = marker[1].toLowerCase() as CriterionKind;
			const explicit = marker[2] ? normalizeTarget(marker[2]) : "";
			const chosen = explicit || targets[0]?.path || "";
			const digest = chosen ? digestTarget(chosen) : "";
			if (digest) {
				criterion = { kind, targetDigest: digest };
				if (!targets.some(target => target.digest === digest)) targets = [{ path: chosen, digest }, ...targets].slice(0, MAX_TARGETS);
			}
		}
		const releaseMode = classifyRelease(entry.text);
		if (releaseMode === "explicit") {
			release = "explicit";
			readOnly = null;
			stop = null;
			forbidden.clear();
		} else if (releaseMode === "release_ambiguous") {
			// Recorded, never applied: an unclear release keeps the constraint.
			release = "release_ambiguous";
		}
		if (semantics === "add" || semantics === "narrow" || semantics === "supersede") stop = null;
		changeSemantics = semantics;
		latestUserEntryId = entry.id;
	}

	const constraints: AuthorityConstraint[] = [];
	if (readOnly) constraints.push(readOnly);
	if (stop) constraints.push(stop);
	constraints.push(...forbidden.values());

	return {
		userEntries: entries.length,
		windowSize,
		latestUserEntryId,
		changeSemantics,
		constraints,
		targets,
		scopeDigests: targets.map(target => target.digest),
		release,
		criterion,
		authorityTruncated,
	};
}

/* ------------------------------------------------------------------------- */
/* Ordered action rules                                                       */
/* ------------------------------------------------------------------------- */

export type ActionEvaluation = {
	actionClass: ActionClass;
	ruleId: RuleId;
	verdict: Verdict;
	coverage: Coverage;
	/** Only an evaluated, aligned write may enter the recovery chain. */
	stage2Admissible: boolean;
	block: boolean;
	targetDigest: string | null;
	/** (latestUserEntryId, changeSemantics, actionClass, targetDigest). */
	retryKey: string;
	entryIdPrefix: string | null;
};

function retryIdentity(authority: Authority | null, actionClass: ActionClass, targetDigest: string | null): string {
	return digestText(
		JSON.stringify([
			authority?.latestUserEntryId ?? "",
			authority?.changeSemantics ?? "unknown",
			actionClass,
			targetDigest ?? null,
		]),
	);
}

/**
 * Ordered rules; the first match wins. Only a write-class action against an
 * explicit drift rule blocks. Reads always allow, bash always allows with a
 * coverage gap, and missing authority never blocks.
 */
export function evaluateAction(input: {
	actionClass: ActionClass;
	targetDigest: string | null;
	authority: Authority | null;
}): ActionEvaluation {
	const { actionClass, targetDigest, authority } = input;
	const base = {
		actionClass,
		targetDigest: targetDigest ?? null,
		retryKey: retryIdentity(authority, actionClass, targetDigest ?? null),
		entryIdPrefix: authority ? authority.latestUserEntryId.slice(0, 8) : null,
	};
	if (actionClass === "read") {
		return { ...base, ruleId: "read_allow", verdict: "allow", coverage: "evaluated", stage2Admissible: false, block: false };
	}
	if (actionClass === "bash") {
		return { ...base, ruleId: "bash_observe", verdict: "allow", coverage: "coverage_gap", stage2Admissible: false, block: false };
	}
	const drift = (ruleId: RuleId): ActionEvaluation => ({
		...base,
		ruleId,
		verdict: "drift",
		coverage: "evaluated",
		stage2Admissible: false,
		block: true,
	});
	if (!authority) {
		return { ...base, ruleId: "unknown_authority", verdict: "uncertain", coverage: "coverage_gap", stage2Admissible: false, block: false };
	}
	if (authority.constraints.some(constraint => constraint.kind === "read_only")) return drift("drift_write_vs_readonly");
	if (targetDigest && authority.constraints.some(constraint => constraint.kind === "forbidden_target" && constraint.targetDigest === targetDigest)) {
		return drift("drift_write_forbidden_target");
	}
	if (authority.constraints.some(constraint => constraint.kind === "stop")) return drift("drift_write_after_stop");
	if (targetDigest && authority.scopeDigests.includes(targetDigest) && authority.authorityTruncated) {
		// Older entries were not scanned, so an unseen constraint may exist:
		// never claim alignment, never block, and report the gap rather than
		// labelling a partially read authority as evaluated.
		return { ...base, ruleId: "uncertain_authority_ambiguous", verdict: "uncertain", coverage: "coverage_gap", stage2Admissible: false, block: false };
	}
	if (targetDigest && authority.scopeDigests.includes(targetDigest) && !authority.authorityTruncated) {
		return {
			...base,
			ruleId: "aligned_write_within_requested_scope",
			verdict: "aligned",
			coverage: "evaluated",
			stage2Admissible: true,
			block: false,
		};
	}
	return { ...base, ruleId: "uncertain_authority_ambiguous", verdict: "uncertain", coverage: "coverage_gap", stage2Admissible: false, block: false };
}

export const RECOVERY_GUIDANCE = {
	readOnly: "Ask the user for an explicit release before writing; a plain \"continue\" does not release read-only.",
	forbidden: "The target is on the user's do-not-touch list; request an explicit release for that path or pick another target.",
	stop: "The user stopped this work; wait for a new explicit request before writing.",
	retry: "Report the blocker and the attempted fix instead of retrying the same write.",
} as const;

/** Deterministic block reason: rule id, entry-id prefix, recovery guidance. */
export function alignmentReason(evaluation: ActionEvaluation, retryCount = 1): string {
	const entry = evaluation.entryIdPrefix ?? "unknown";
	const stop = retryCount >= 2 ? ` stop_recommended: two repeated blocks for this request. ${RECOVERY_GUIDANCE.retry}` : "";
	switch (evaluation.ruleId) {
		case "drift_write_vs_readonly":
			return `jev-goal-alignment: drift_write_vs_readonly (entry ${entry}). ${RECOVERY_GUIDANCE.readOnly}${stop}`;
		case "drift_write_forbidden_target":
			return `jev-goal-alignment: drift_write_forbidden_target (entry ${entry}). ${RECOVERY_GUIDANCE.forbidden}${stop}`;
		case "drift_write_after_stop":
			return `jev-goal-alignment: drift_write_after_stop (entry ${entry}). ${RECOVERY_GUIDANCE.stop}${stop}`;
		default:
			return `jev-goal-alignment: ${evaluation.ruleId} (entry ${entry}).${stop}`;
	}
}

/* ------------------------------------------------------------------------- */
/* Recovery transitions                                                       */
/* ------------------------------------------------------------------------- */

export type RecoveryStatus =
	| "correction_recorded"
	| "aligned_admitted"
	| "result_observed"
	| "recovered"
	| "recovery_unverified";

export type TransitionReason =
	| "no_authority"
	| "same_authority"
	| "not_correction_stage"
	| "not_admitted_stage"
	| "not_observed_stage"
	| "already_terminal"
	| "not_stage2_admissible"
	| "target_mismatch"
	| "missing_tool_call"
	| "tool_call_mismatch"
	| "no_declared_criterion"
	| "baseline_true"
	| "criterion_not_true";

export type AlignmentState = {
	v: 1;
	recoveryId: string;
	latestUserEntryId: string;
	changeSemantics: ChangeSemantics;
	step: 1 | 2 | 3 | 4;
	status: RecoveryStatus;
	ruleId: RuleId | null;
	actionClass: ActionClass | null;
	/** Digests of the request targets captured at correction time. */
	approvedTargets: readonly string[];
	targetDigest: string | null;
	toolCallIdDigest: string | null;
	criterion: CriterionState | null;
	criterionBaseline: Observation | null;
	observation: Observation | null;
	reason: TransitionReason | null;
	updatedAt: number;
};

export type AlignmentEventKind = "correction" | "admit" | "observe" | "complete" | "unverified" | "block" | "shutdown" | "hook_error" | "latency_exceeded";

export type AlignmentCounts = {
	corrections: number;
	blocks: number;
	recovered: number;
	unverified: number;
	unresolved: number;
};

export type AlignmentEvent = {
	v: 1;
	kind: AlignmentEventKind;
	at: number;
	recoveryId: string | null;
	/** Full post-transition state for recovery events; null for block/shutdown. */
	state: AlignmentState | null;
	retryKey?: string;
	ruleId?: RuleId;
	retryCount?: number;
	stopRecommended?: boolean;
	counts?: AlignmentCounts;
};

export type Transition = {
	applied: boolean;
	state: AlignmentState | null;
	status: RecoveryStatus | null;
	reason: TransitionReason | null;
	event: AlignmentEvent | null;
};

function rejected(state: AlignmentState | null, reason: TransitionReason): Transition {
	return { applied: false, state, status: state?.status ?? null, reason, event: null };
}

function applied(state: AlignmentState, kind: AlignmentEventKind, now: number): Transition {
	return {
		applied: true,
		state,
		status: state.status,
		reason: state.reason,
		event: { v: 1, kind, at: now, recoveryId: state.recoveryId, state },
	};
}

function recoveryIdentity(authority: Authority): string {
	const constraints = authority.constraints
		.map(constraint => [constraint.kind, constraint.kind === "forbidden_target" ? constraint.targetDigest : ""])
		.sort((left, right) => left.join(":").localeCompare(right.join(":")));
	return digestText(
		JSON.stringify([
			"goal-alignment-v1",
			authority.latestUserEntryId,
			authority.changeSemantics,
			authority.scopeDigests,
			authority.criterion?.kind ?? null,
			authority.criterion?.targetDigest ?? null,
			constraints,
		]),
	);
}

/** Step 1 — record one correction: authority identity, scope and criterion baseline. */
export function recordCorrection(input: {
	authority: Authority | null;
	baseline: Observation | null;
	now: number;
	previous?: AlignmentState | null;
}): Transition {
	const { authority, now } = input;
	if (!authority) return rejected(input.previous ?? null, "no_authority");
	if (input.previous && input.previous.latestUserEntryId === authority.latestUserEntryId) {
		return rejected(input.previous, "same_authority");
	}
	const state: AlignmentState = {
		v: 1,
		recoveryId: recoveryIdentity(authority),
		latestUserEntryId: authority.latestUserEntryId,
		changeSemantics: authority.changeSemantics,
		step: 1,
		status: "correction_recorded",
		ruleId: null,
		actionClass: null,
		approvedTargets: authority.scopeDigests.slice(0, MAX_TARGETS),
		targetDigest: null,
		toolCallIdDigest: null,
		criterion: authority.criterion,
		criterionBaseline: authority.criterion ? (input.baseline ?? "unknown") : null,
		observation: null,
		reason: null,
		updatedAt: now,
	};
	return applied(state, "correction", now);
}

/** Step 2 — admit an evaluated, aligned write whose target was in the correction scope. */
export function admitAlignedAction(input: {
	state: AlignmentState | null;
	evaluation: ActionEvaluation;
	targetDigest: string | null;
	toolCallIdDigest: string | null;
	now: number;
}): Transition {
	const { state, evaluation } = input;
	if (!state || state.step !== 1) return rejected(state, state && state.step === 4 ? "already_terminal" : "not_correction_stage");
	if (evaluation.coverage !== "evaluated" || evaluation.verdict !== "aligned" || !evaluation.stage2Admissible || !evaluation.ruleId) {
		return rejected(state, "not_stage2_admissible");
	}
	if (!input.targetDigest || !state.approvedTargets.includes(input.targetDigest)) {
		return rejected(state, "target_mismatch");
	}
	if (!input.toolCallIdDigest) return rejected(state, "missing_tool_call");
	const next: AlignmentState = {
		...state,
		step: 2,
		status: "aligned_admitted",
		ruleId: evaluation.ruleId,
		actionClass: evaluation.actionClass,
		targetDigest: input.targetDigest,
		toolCallIdDigest: input.toolCallIdDigest,
		reason: null,
		updatedAt: input.now,
	};
	return applied(next, "admit", input.now);
}

/** Step 3 — observe the admitted call's result; the id must match exactly. */
export function observeResult(input: {
	state: AlignmentState | null;
	toolCallIdDigest: string | null;
	observation: Observation;
	now: number;
}): Transition {
	const { state, now } = input;
	if (!state) return rejected(null, "not_admitted_stage");
	if (state.step === 4) return rejected(state, "already_terminal");
	if (state.step !== 2) return rejected(state, "not_admitted_stage");
	if (!state.toolCallIdDigest || !input.toolCallIdDigest || input.toolCallIdDigest !== state.toolCallIdDigest) {
		const unverified: AlignmentState = {
			...state,
			step: 4,
			status: "recovery_unverified",
			reason: "tool_call_mismatch",
			observation: input.observation ?? "unknown",
			updatedAt: now,
		};
		return applied(unverified, "unverified", now);
	}
	const next: AlignmentState = {
		...state,
		step: 3,
		status: "result_observed",
		observation: input.observation,
		reason: null,
		updatedAt: now,
	};
	return applied(next, "observe", now);
}

/**
 * Step 4 — completion is only the declared criterion's false|unknown → true
 * transition. A baseline that was already true, or no declared criterion at all,
 * is recovery_unverified rather than a recovered claim.
 */
export function evaluateCompletion(input: { state: AlignmentState | null; now: number }): Transition {
	const { state, now } = input;
	if (!state) return rejected(null, "not_observed_stage");
	if (state.step === 4) return rejected(state, "already_terminal");
	if (state.step !== 3) return rejected(state, "not_observed_stage");
	if (!state.criterion) {
		const unverified: AlignmentState = { ...state, step: 4, status: "recovery_unverified", reason: "no_declared_criterion", updatedAt: now };
		return applied(unverified, "unverified", now);
	}
	if (state.criterionBaseline === "true") {
		const unverified: AlignmentState = { ...state, step: 4, status: "recovery_unverified", reason: "baseline_true", updatedAt: now };
		return applied(unverified, "unverified", now);
	}
	if (state.observation !== "true") return rejected(state, "criterion_not_true");
	const recovered: AlignmentState = { ...state, step: 4, status: "recovered", reason: null, updatedAt: now };
	return applied(recovered, "complete", now);
}

/** One block record. The block itself is decided by `evaluateAction`. */
export function recordBlock(input: { evaluation: ActionEvaluation; retryCount: number; now: number }): AlignmentEvent {
	const retryCount = Math.max(1, Math.trunc(input.retryCount));
	return {
		v: 1,
		kind: "block",
		at: input.now,
		recoveryId: null,
		state: null,
		retryKey: input.evaluation.retryKey,
		ruleId: input.evaluation.ruleId,
		retryCount,
		stopRecommended: retryCount >= 2,
	};
}

/** Idempotent session-close record for one unresolved recovery. */
export function recordShutdown(input: { state: AlignmentState; counts: AlignmentCounts; now: number }): AlignmentEvent {
	return { v: 1, kind: "shutdown", at: input.now, recoveryId: input.state.recoveryId, state: null, counts: input.counts };
}

/* ------------------------------------------------------------------------- */
/* Journal: bounded, transition-only, digest-first                            */
/* ------------------------------------------------------------------------- */

export const ALIGNMENT_LIMITS = {
	maxRecords: 200,
	maxRecordBytes: 2048,
	maxTotalBytes: 256 * 1024,
	maxSegments: 2,
	retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

const EVENT_KINDS = new Set<string>(["correction", "admit", "observe", "complete", "unverified", "block", "shutdown", "hook_error", "latency_exceeded"]);
const RECOVERY_STATUSES = new Set<string>(["correction_recorded", "aligned_admitted", "result_observed", "recovered", "recovery_unverified"]);

function fresh(at: number, now: number): boolean {
	return Number.isFinite(at) && at >= now - ALIGNMENT_LIMITS.retentionMs && at <= now + FUTURE_SKEW_MS;
}

function isState(value: unknown): value is AlignmentState {
	const record = asRecord(value);
	if (!record) return false;
	return (
		record.v === 1 &&
		typeof record.recoveryId === "string" &&
		typeof record.latestUserEntryId === "string" &&
		(record.step === 1 || record.step === 2 || record.step === 3 || record.step === 4) &&
		typeof record.status === "string" &&
		RECOVERY_STATUSES.has(record.status) &&
		Array.isArray(record.approvedTargets) &&
		Number.isFinite(record.updatedAt)
	);
}

function isEvent(value: unknown): value is AlignmentEvent {
	const record = asRecord(value);
	if (!record) return false;
	if (record.v !== 1 || typeof record.kind !== "string" || !EVENT_KINDS.has(record.kind)) return false;
	if (typeof record.at !== "number" || !Number.isFinite(record.at)) return false;
	if (record.state !== null && record.state !== undefined && !isState(record.state)) return false;
	return true;
}

/** Serialize one record; over-cap records are dropped instead of truncated. */
export function serializeEvent(event: AlignmentEvent): string | null {
	let text: string;
	try { text = JSON.stringify(event); } catch { return null; }
	return Buffer.byteLength(text, "utf8") <= ALIGNMENT_LIMITS.maxRecordBytes ? text : null;
}

function parseJournalLines(text: string, now: number): { events: AlignmentEvent[]; dropped: number } {
	const events: AlignmentEvent[] = [];
	let dropped = 0;
	for (const line of String(text ?? "").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (Buffer.byteLength(trimmed, "utf8") > ALIGNMENT_LIMITS.maxRecordBytes) { dropped++; continue; }
		let parsed: unknown;
		try { parsed = JSON.parse(trimmed); } catch { dropped++; continue; }
		if (!isEvent(parsed) || !fresh(parsed.at, now)) { dropped++; continue; }
		events.push(parsed);
	}
	return { events, dropped };
}

function capEvents(events: readonly AlignmentEvent[]): AlignmentEvent[] {
	const kept: AlignmentEvent[] = [];
	let bytes = 0;
	for (let index = events.length - 1; index >= 0 && kept.length < ALIGNMENT_LIMITS.maxRecords; index--) {
		const size = Buffer.byteLength(JSON.stringify(events[index]), "utf8") + 1;
		if (bytes + size > ALIGNMENT_LIMITS.maxTotalBytes) break;
		kept.push(events[index]);
		bytes += size;
	}
	return kept.reverse();
}

export type JournalSnapshot = {
	events: readonly AlignmentEvent[];
	latest: AlignmentState | null;
	retryCounts: Readonly<Record<string, number>>;
	shutdownFor: Readonly<Record<string, true>>;
	counts: AlignmentCounts;
	dropped: number;
};

/** Rebuild the current recovery view and retry counters from retained records. */
export function reduceJournal(events: readonly AlignmentEvent[]): {
	latest: AlignmentState | null;
	retryCounts: Record<string, number>;
	shutdownFor: Record<string, true>;
	counts: AlignmentCounts;
} {
	const retryCounts: Record<string, number> = {};
	const shutdownFor: Record<string, true> = {};
	const counts: AlignmentCounts = { corrections: 0, blocks: 0, recovered: 0, unverified: 0, unresolved: 0 };
	let latest: AlignmentState | null = null;
	for (const event of events) {
		if (event.kind === "block") {
			counts.blocks++;
			if (typeof event.retryKey === "string") {
				const previous = retryCounts[event.retryKey] ?? 0;
				const observed = typeof event.retryCount === "number" ? event.retryCount : previous + 1;
				retryCounts[event.retryKey] = Math.max(previous, observed);
			}
		}
		if (event.kind === "shutdown" && typeof event.recoveryId === "string") shutdownFor[event.recoveryId] = true;
		if (event.kind === "correction") counts.corrections++;
		if (!event.state) continue;
		latest = event.state;
	}
	if (latest) {
		if (latest.status === "recovered") counts.recovered++;
		if (latest.status === "recovery_unverified") counts.unverified++;
		if (latest.step < 4) counts.unresolved = 1;
	}
	return { latest, retryCounts, shutdownFor, counts };
}

/**
 * Parse the retained segments (oldest first) into one bounded snapshot.
 * Records older than the retention window, oversized lines and future-dated
 * lines are dropped; the newest records win when the caps are reached.
 */
export function readJournalTexts(texts: readonly (string | null)[], now: number): JournalSnapshot {
	const events: AlignmentEvent[] = [];
	let dropped = 0;
	for (const text of texts) {
		const parsed = parseJournalLines(text ?? "", now);
		events.push(...parsed.events);
		dropped += parsed.dropped;
	}
	const retained = capEvents(events);
	const reduced = reduceJournal(retained);
	return { events: retained, dropped, ...reduced };
}

/** Newest retained records only, used when the active segment rotates. */
export function compactJournalText(text: string, now: number): string {
	const parsed = parseJournalLines(text, now);
	return capEvents(parsed.events).map(event => `${JSON.stringify(event)}\n`).join("");
}

export type JournalAppendPlan = { text: string; rotate: boolean; appended: number; skipped: number };

/**
 * Decide one bounded append to the active segment. Rotation keeps two segments:
 * the active tail and one retained predecessor, both under the record/byte caps.
 */
export function planJournalAppend(existingText: string | null, events: readonly AlignmentEvent[], now: number): JournalAppendPlan {
	const lines: string[] = [];
	let skipped = 0;
	for (const event of events) {
		const line = serializeEvent(event);
		if (line === null) skipped++;
		else lines.push(line);
	}
	if (lines.length === 0) return { text: "", rotate: false, appended: 0, skipped };
	const body = `${lines.join("\n")}\n`;
	const existing = String(existingText ?? "");
	let records = 0;
	let bytes = 0;
	for (const line of existing.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (Buffer.byteLength(trimmed, "utf8") > ALIGNMENT_LIMITS.maxRecordBytes) continue;
		let parsed: unknown;
		try { parsed = JSON.parse(trimmed); } catch { continue; }
		if (!isEvent(parsed) || !fresh(parsed.at, now)) continue;
		records++;
		bytes += Buffer.byteLength(trimmed, "utf8") + 1;
	}
	const rotate = records + lines.length > ALIGNMENT_LIMITS.maxRecords || bytes + Buffer.byteLength(body, "utf8") > ALIGNMENT_LIMITS.maxTotalBytes;
	return { text: body, rotate, appended: lines.length, skipped };
}

/** A fail-open handler failure: recorded so a silent throw is auditable. */
export function recordHookError(input: { errorClass: string; now: number }): AlignmentEvent {
	return { v: 1, kind: "hook_error", at: input.now, errorClass: input.errorClass.slice(0, 64) } as AlignmentEvent;
}

/** Resolve with `fallback` when `work` has not settled within `ms`. */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
	const budget = Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<T>(resolve => {
				timer = setTimeout(() => resolve(fallback), budget);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Deterministic evaluation exceeded its latency budget: allow and record it. */
export function recordLatencyExceeded(input: { elapsedMs: number; budgetMs: number; now: number }): AlignmentEvent {
	return { v: 1, kind: "latency_exceeded", at: input.now, elapsedMs: Math.max(0, Math.trunc(input.elapsedMs)), budgetMs: Math.max(0, Math.trunc(input.budgetMs)) } as AlignmentEvent;
}

/** Semantic advisory contract (AC-A3). Advisory only: it can never block. */
export type SemanticEnvelopeStatus = "ok" | "precision_anomaly" | "invalid_response" | "outbound_suppressed";

export type SemanticEnvelope = {
	status: SemanticEnvelopeStatus;
	/** Provider-returned score, preserved verbatim; never redefined as a margin. */
	confidence: number | null;
	/** Raw probabilities, preserved verbatim (no clamping or normalisation). */
	probabilities: Record<string, number> | null;
	/** True only when the caller opted in AND the envelope validated. */
	outbound: boolean;
	/** Sum of the probabilities, reported so a 1.0001 payload stays visible. */
	probabilitySum: number | null;
};

/**
 * Validate one provider envelope for the advisory path.
 *
 * `sendAuthorityText` is the outbound opt-in: without it nothing leaves the
 * process, so the status is `outbound_suppressed` and no request may be made.
 * A probability sum outside 1e-6 is reported as `precision_anomaly` instead of
 * being clamped, and the provider confidence is returned untouched so callers
 * cannot mistake a derived margin for calibration.
 */
export function validateSemanticEnvelope(input: {
	sendAuthorityText: boolean;
	confidence?: unknown;
	probabilities?: unknown;
	labels: readonly string[];
	tolerance?: number;
}): SemanticEnvelope {
	if (input.sendAuthorityText !== true)
		return { status: "outbound_suppressed", confidence: null, probabilities: null, outbound: false, probabilitySum: null };
	const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence) ? input.confidence : null;
	const raw = asRecord(input.probabilities);
	if (!raw) return { status: "invalid_response", confidence, probabilities: null, outbound: true, probabilitySum: null };
	const probabilities: Record<string, number> = {};
	for (const [label, value] of Object.entries(raw)) {
		if (!input.labels.includes(label)) return { status: "invalid_response", confidence, probabilities: null, outbound: true, probabilitySum: null };
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
			return { status: "invalid_response", confidence, probabilities: null, outbound: true, probabilitySum: null };
		probabilities[label] = value;
	}
	if (input.labels.some(label => probabilities[label] === undefined))
		return { status: "invalid_response", confidence, probabilities: null, outbound: true, probabilitySum: null };
	const probabilitySum = Object.values(probabilities).reduce((total, value) => total + value, 0);
	const tolerance = typeof input.tolerance === "number" && input.tolerance > 0 ? input.tolerance : 1e-6;
	if (Math.abs(probabilitySum - 1) > tolerance)
		return { status: "precision_anomaly", confidence, probabilities, outbound: true, probabilitySum };
	return { status: "ok", confidence, probabilities, outbound: true, probabilitySum };
}
/**
 * Goal-alignment journal store: the one read/append path shared by the
 * before-tool, observe and shutdown surfaces.
 *
 * The verdict never comes from here, and storage never delays a tool call:
 * every read and append is bounded by one budget
 * (`JEV_ALIGNMENT_STORE_TIMEOUT_MS`, default 100 ms). A bounded-out read
 * reports the empty, unavailable snapshot the adapters already treat as
 * degraded storage, and a bounded-out append reports "not stored" — never
 * "did not happen" and never a block.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_STORE_TIMEOUT_MS = 100;

/**
 * The store's whole filesystem surface. Production passes `JOURNAL_STORE_IO`;
 * a test passes its own so a hung or failing store is induced, not simulated
 * with a global builtin patch (builtin ESM bindings are snapshots in Bun).
 */
export type JournalStoreIo = {
	readFile: (file: string, encoding: "utf8") => Promise<string>;
	appendFile: (file: string, data: string, options: { mode: number }) => Promise<unknown>;
	writeFile: (file: string, data: string, options: { mode: number }) => Promise<unknown>;
	mkdir: (directory: string, options: { recursive: true; mode: number }) => Promise<unknown>;
};

export const JOURNAL_STORE_IO: JournalStoreIo = { readFile, appendFile, writeFile, mkdir };

/** One bounded budget for every journal read and append. */
export function journalStoreBudgetMs(env: Record<string, string | undefined> = process.env): number {
	const raw = Number(env.JEV_ALIGNMENT_STORE_TIMEOUT_MS ?? DEFAULT_STORE_TIMEOUT_MS);
	return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : DEFAULT_STORE_TIMEOUT_MS;
}

export type JournalLoad = { snapshot: JournalSnapshot; available: boolean };

function journalRecord(value: unknown): Record<string, any> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/** Bounded session segment key, or the shared segment when unreadable. */
export function journalSessionKey(ctx: unknown): string {
	const record = journalRecord(ctx);
	const manager = record ? journalRecord(record.sessionManager) : null;
	if (manager && typeof manager.getSessionId === "function") {
		try {
			const value = manager.getSessionId.call(manager);
			if (typeof value === "string" && value.trim() && value.length <= 512) return digestText(value.trim()).slice(0, 16);
		} catch {
			// An unreadable session id falls back to the shared segment.
		}
	}
	return "default";
}

export function journalFiles(ctx: unknown): { directory: string; current: string; rotated: string } {
	// Bun can cache os.homedir across HOME changes; honor the process-owned home.
	// One bounded segment pair per session keeps concurrent sessions apart.
	const directory = path.join(process.env.HOME || homedir(), ".gjc-plugin", "jev-advisor", "alignment", "v1", journalSessionKey(ctx));
	return { directory, current: path.join(directory, "events.jsonl"), rotated: path.join(directory, "events.1.jsonl") };
}

export async function journalReadText(file: string, io: JournalStoreIo = JOURNAL_STORE_IO): Promise<{ text: string | null; available: boolean }> {
	try {
		const text = await io.readFile(file, "utf8");
		return { text, available: Buffer.byteLength(text, "utf8") <= ALIGNMENT_LIMITS.maxTotalBytes };
	} catch (error) {
		return { text: null, available: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" };
	}
}

/** Unbounded store read; every caller goes through `loadJournalStore`. */
async function journalLoadUnbounded(ctx: unknown, now: number, io: JournalStoreIo): Promise<JournalLoad> {
	const files = journalFiles(ctx);
	const rotated = await journalReadText(files.rotated, io);
	const current = await journalReadText(files.current, io);
	return { snapshot: readJournalTexts([rotated.text, current.text], now), available: rotated.available && current.available };
}

/** Read the retained journal inside the store budget; a timeout is degraded storage. */
export async function loadJournalStore(
	ctx: unknown,
	now: number,
	budgetMs: number,
	io: JournalStoreIo = JOURNAL_STORE_IO,
): Promise<JournalLoad> {
	return withDeadline(journalLoadUnbounded(ctx, now, io), budgetMs, { snapshot: readJournalTexts([null, null], now), available: false });
}

/** Unbounded store append; every caller goes through `appendJournalStore`. */
async function journalAppendUnbounded(ctx: unknown, events: readonly AlignmentEvent[], now: number, io: JournalStoreIo): Promise<boolean> {
	if (events.length === 0) return true;
	const files = journalFiles(ctx);
	try {
		await io.mkdir(files.directory, { recursive: true, mode: 0o700 });
		const existing = await journalReadText(files.current, io);
		const plan = planJournalAppend(existing.text ?? "", events, now);
		if (!plan.text) return plan.skipped === 0;
		if (plan.rotate) {
			await io.writeFile(files.rotated, compactJournalText(existing.text ?? "", now), { mode: 0o600 });
			await io.writeFile(files.current, plan.text, { mode: 0o600 });
		} else {
			await io.appendFile(files.current, plan.text, { mode: 0o600 });
		}
		return true;
	} catch {
		return false;
	}
}

/** Append inside the store budget; `false` means "not stored", never "not attempted". */
export async function appendJournalStore(
	ctx: unknown,
	events: readonly AlignmentEvent[],
	now: number,
	budgetMs: number,
	io: JournalStoreIo = JOURNAL_STORE_IO,
): Promise<boolean> {
	return withDeadline(journalAppendUnbounded(ctx, events, now, io), budgetMs, false);
}
// Goal-alignment before-tool surface. Deterministic only: no provider call, no
// credential or config read. Only write-class calls are evaluated because reads
// and bash must never be blocked; the journal is best effort, so a storage
// failure degrades to in-process counters and can never cause or suppress a block.
import { existsSync } from "node:fs";

const ALIGNMENT_WRITE_TOOLS = new Set([
	"write",
	"write_file",
	"edit",
	"edit_file",
	"patch",
	"apply_patch",
	"multiedit",
	"multi_edit",
	"multi_edit_file",
	"str_replace",
	"str_replace_editor",
	"notebookedit",
	"notebook_edit",
]);
const ALIGNMENT_READ_TOOLS = new Set(["read", "read_file", "grep", "glob", "list", "ls", "view", "webfetch", "web_fetch", "websearch", "web_search"]);
const ALIGNMENT_BASH_TOOLS = new Set(["bash", "shell", "sh", "exec", "execute", "run", "terminal"]);
const ALIGNMENT_DEGRADED_COUNTERS_MAX = 64;

/**
 * Runtime mode for deterministic blocking, resolved per call:
 * `off` (kill switch), `shadow` (evaluate + journal, never block), or
 * `deterministic` (may block). Everything else, including unset, is `shadow`;
 * `JEV_ADVISOR_MODE` belongs to the tier advisor and is never read here.
 */
type AlignmentMode = "off" | "shadow" | "deterministic";

function alignmentMode(): AlignmentMode {
	try {
		const raw = process.env.JEV_ALIGNMENT_MODE;
		const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
		if (value === "off") return "off";
		if (value === "deterministic") return "deterministic";
		return "shadow";
	} catch {
		return "shadow";
	}
}

/** In-process retry counters used only while the journal store is unavailable. */
const alignmentDegradedRetries = new Map<string, number>();

export default function register(api: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	api.on("tool_call", async (event, ctx) => {
		const mode = alignmentMode();
		// off is a true kill switch: no evaluation, no journal, no block.
		if (mode === "off") return undefined;
		let blockReason: string | null = null;
		// One store budget for this call's read and appends: a hung store degrades
		// to "unavailable"/"not stored" instead of delaying the verdict.
		const storeBudgetMs = journalStoreBudgetMs();
		try {
			const call = alignmentAsRecord(event);
			if (!call || call.type !== "tool_call") return undefined;
			const actionClass = alignmentClassifyAction(call.toolName);
			// read_allow / bash_observe: never blocked, never journaled.
			if (actionClass !== "write") return undefined;
			const startedAt = Date.now();
			const now = startedAt;
			const authority = alignmentReadAuthority(ctx);
			const paths = alignmentWritePaths(call.input);
			const targetDigest = paths.length === 1 ? digestTarget(paths[0]) : paths.length > 1 ? digestText(paths.join("\n")) : null;
			// A multi-target write is evaluated per path so one forbidden target
			// still blocks; only single-target writes can be stage-2 admitted.
			const evaluations =
				paths.length > 1
					? paths.map(value => evaluateAction({ actionClass: "write", targetDigest: digestTarget(value), authority }))
					: [evaluateAction({ actionClass: "write", targetDigest, authority })];
			const evaluation = evaluations.find(candidate => candidate.block) ?? evaluations[0];
			const toolCallIdDigest = alignmentToolCallDigest(call.toolCallId);
			const loaded = await loadJournalStore(ctx, now, storeBudgetMs);
			const events: AlignmentEvent[] = [];
			let state = loaded.snapshot.latest;
			if (authority && state?.latestUserEntryId !== authority.latestUserEntryId) {
				const correction = recordCorrection({ authority, baseline: alignmentBaseline(authority), now, previous: state });
				if (correction.applied && correction.event && correction.state) {
					state = correction.state;
					events.push(correction.event);
				}
			}
			let blockRetryCount = 0;
			if (evaluation.block) {
				blockRetryCount = Math.max(loaded.snapshot.retryCounts[evaluation.retryKey] ?? 0, alignmentDegradedRetries.get(evaluation.retryKey) ?? 0) + 1;
				events.push(recordBlock({ evaluation, retryCount: blockRetryCount, now }));
				blockReason = alignmentReason(evaluation, blockRetryCount);
			} else if (evaluation.stage2Admissible && state) {
				const admission = admitAlignedAction({ state, evaluation, targetDigest, toolCallIdDigest, now });
				if (admission.applied && admission.event) events.push(admission.event);
			}
			// A deterministic evaluation that overruns its budget must never block:
			// record the overrun, then fall through to the default allow.
			const budgetMs = Number(process.env.JEV_ALIGNMENT_LATENCY_BUDGET_MS ?? 250);
			const elapsedMs = Date.now() - startedAt;
			if (blockReason && Number.isFinite(budgetMs) && elapsedMs > budgetMs) {
				blockReason = null;
				events.push(recordLatencyExceeded({ elapsedMs, budgetMs, now }));
			}
			// A hung store must not hold the tool call: the verdict is already
			// decided, so a slow append degrades to "not stored" instead of delay.
			const stored = await appendJournalStore(ctx, events, now, storeBudgetMs);
			// Degraded storage keeps the retry chain in process memory so a repeated
			// violation still reaches stop_recommended; it never changes the verdict.
			if (evaluation.block && (!loaded.available || !stored)) {
				alignmentRememberDegradedRetry(evaluation.retryKey, blockRetryCount);
				// The verdict is unchanged, but the reason carries the observable
				// storage_degraded code so the degradation is not silent.
				if (blockReason) blockReason = `${blockReason} [storage_degraded]`;
			}
		} catch (error) {
			// hook_error: a thrown handler is fail-open and can never block a tool.
			// Record the failure class so a silent throw stays auditable.
			try {
				await appendJournalStore(ctx, [recordHookError({ errorClass: error instanceof Error ? error.name || "error" : "non_error", now: Date.now() })], Date.now(), storeBudgetMs);
			} catch {
				// The recorder itself must never change the verdict.
			}
			return undefined;
		}
		// shadow journals the same block record but never enforces it.
		return mode === "deterministic" && blockReason ? { block: true, reason: blockReason } : undefined;
	});
}

function alignmentRememberDegradedRetry(key: string, count: number): void {
	if (alignmentDegradedRetries.size >= ALIGNMENT_DEGRADED_COUNTERS_MAX) alignmentDegradedRetries.clear();
	alignmentDegradedRetries.set(key, Math.max(alignmentDegradedRetries.get(key) ?? 0, count));
}

function alignmentAsRecord(value: unknown): Record<string, any> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function alignmentClassifyAction(toolName: unknown): ActionClass | null {
	const name = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
	if (!name) return null;
	if (ALIGNMENT_WRITE_TOOLS.has(name)) return "write";
	if (ALIGNMENT_READ_TOOLS.has(name)) return "read";
	if (ALIGNMENT_BASH_TOOLS.has(name)) return "bash";
	return null;
}

/** Bounded, normalised write targets of one tool input. */
function alignmentWritePaths(input: unknown): string[] {
	const record = alignmentAsRecord(input);
	if (!record) return [];
	const found = new Set<string>();
	const add = (value: unknown) => {
		if (typeof value !== "string") return;
		const token = normalizeTarget(value);
		if (token) found.add(token);
	};
	for (const key of ["filePath", "file_path", "path", "notebook_path", "notebookPath", "target"]) add(record[key]);
	if (Array.isArray(record.files)) for (const value of record.files) add(value);
	const patch = typeof record.patch === "string" ? record.patch : typeof record.diff === "string" ? record.diff : "";
	if (patch) {
		for (const line of patch.split("\n").slice(0, 400)) {
			const trimmed = line.trim();
			const update = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(trimmed);
			if (update) add(update[1]);
			const git = /^diff --git a\/(\S+) b\/(\S+)/.exec(trimmed);
			if (git) add(git[2]);
		}
	}
	return [...found].slice(0, 16);
}

function alignmentToolCallDigest(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= 512 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? digestText(trimmed) : null;
}

/** Host user entries are the only authority; a missing facade yields none. */
function alignmentReadAuthority(ctx: unknown): Authority | null {
	const record = alignmentAsRecord(ctx);
	const manager = record ? alignmentAsRecord(record.sessionManager) : null;
	if (!manager || typeof manager.getBranch !== "function") return null;
	try {
		const branch = manager.getBranch.call(manager);
		const entries = Array.isArray(branch) ? branch : alignmentAsRecord(branch)?.entries;
		return collectAuthority(entries, { windowSize: 12 });
	} catch {
		return null;
	}
}

/** Baseline of the declared criterion, observed before the action runs. */
function alignmentBaseline(authority: Authority | null): Observation | null {
	const criterion = authority?.criterion;
	if (!criterion) return null;
	if (criterion.kind === "exit_zero") return "unknown";
	const target = authority?.targets.find(item => item.digest === criterion.targetDigest);
	if (!target) return "unknown";
	try {
		return existsSync(target.path) ? "true" : "false";
	} catch {
		return "unknown";
	}
}
