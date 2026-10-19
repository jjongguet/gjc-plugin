// backplan plugin core — deterministic contract validation and Linear-payload
// rendering for backward-derived work plans. Pure and hermetic: no network, no
// filesystem access, no credentials. Linear registration itself stays with the
// agent's Linear MCP tooling; this module only grades the draft and renders the
// exact project/issue text plus a stable content digest.
import { createHash as backplanHash } from "node:crypto";

export const BACKPLAN_PLAN_BYTES = 262144;
export const BACKPLAN_OUTPUT_LIMIT = 131072;
export const BACKPLAN_ISSUE_LIMIT = 24;
export const BACKPLAN_CRITERIA_LIMIT = 12;
export const BACKPLAN_ARRAY_LIMIT = 48;
export const BACKPLAN_STRING_LIMIT = 2000;
export const BACKPLAN_TITLE_LIMIT = 160;
export const BACKPLAN_ERROR_LIMIT = 64;

export type BackplanRenderContext = { session?: string; worktree?: string; branch?: string };

export type BackplanIssue = {
	title: string;
	objective: string;
	context: string;
	scopeIn: string[];
	scopeOut: string[];
	completionCriteria: string[];
	delivery: string;
	dependencies: string[];
	labels: string[] | null;
};

export type BackplanPolicyDecision = {
	topic: string;
	needsUserDecision: boolean;
	options: string[];
	recordLocation: string;
};

export type BackplanAutomationCandidate = {
	candidate: string;
	disposition: "backlog" | "out_of_scope";
};

export type BackplanPlan = {
	request: string | null;
	goal: string;
	endState: string;
	successCriteria: string[];
	project: { name: string; mode: "reuse" | "create"; reason: string; boundaries: string[] | null };
	issues: BackplanIssue[];
	policyDecisions: BackplanPolicyDecision[];
	automationCandidates: BackplanAutomationCandidate[];
};

export type BackplanReport = {
	status: "ok" | "invalid";
	errors: string[];
	warnings: string[];
	digest: string | null;
	linear: null | {
		project: { mode: "reuse" | "create"; name: string; reason: string; description: string | null };
		issues: { title: string; description: string; labels: string[] | null }[];
		notes: string | null;
	};
};

const rootKeys = ["request", "goal", "end_state", "success_criteria", "project", "issues", "policy_decisions", "automation_candidates"];
const issueKeys = ["title", "objective", "context", "scope_in", "scope_out", "completion_criteria", "delivery", "dependencies", "labels"];
const projectKeys = ["name", "mode", "reason", "boundaries"];
const decisionKeys = ["topic", "needs_user_decision", "options", "record_location"];
const candidateKeys = ["candidate", "disposition"];
const genericCriterion = /^(완료|완성|됨|정상|동작|동작함|잘\s*됨|잘됨|끝|done|complete|completed|works|working|ok|n\/a|없음)\.?$/i;
const labelPattern = /^[a-z0-9][a-z0-9:._-]*$/i;

function plainObject(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
	return value as Record<string, unknown>;
}

function collectObject(value: unknown, path: string, keys: string[], required: string[], errors: string[]): Record<string, unknown> {
	const record = plainObject(value);
	if (!record) {
		errors.push(`${path}: expected an object`);
		return {};
	}
	for (const key of Object.keys(record)) if (!keys.includes(key)) errors.push(`${path}.${key}: unknown key`);
	for (const key of required) if (!Object.hasOwn(record, key)) errors.push(`${path}.${key}: required`);
	return record;
}

function collectString(value: unknown, path: string, errors: string[], limit: number, required = true): string {
	if (value === undefined) {
		if (required) errors.push(`${path}: required string missing`);
		return "";
	}
	if (typeof value !== "string") {
		errors.push(`${path}: expected a string`);
		return "";
	}
	const text = value.trim();
	if (!text) {
		errors.push(`${path}: must not be empty`);
		return "";
	}
	if (text.length > limit) {
		errors.push(`${path}: exceeds the ${limit}-character limit`);
		return text.slice(0, limit);
	}
	return text;
}

function collectBoolean(value: unknown, path: string, errors: string[]): boolean {
	if (typeof value !== "boolean") {
		errors.push(`${path}: expected true or false`);
		return false;
	}
	return value;
}

function asArray(value: unknown, path: string, errors: string[]): unknown[] {
	if (!Array.isArray(value)) {
		errors.push(`${path}: expected an array`);
		return [];
	}
	if (value.length > BACKPLAN_ARRAY_LIMIT) errors.push(`${path}: exceeds the ${BACKPLAN_ARRAY_LIMIT}-item limit`);
	return value;
}

function collectStringArray(value: unknown, path: string, errors: string[], itemLimit: number, minimum: number): string[] {
	const list = asArray(value, path, errors);
	if (list.length < minimum) errors.push(`${path}: needs at least ${minimum} item(s)`);
	const out: string[] = [];
	list.slice(0, BACKPLAN_ARRAY_LIMIT).forEach((entry, index) => {
		const text = collectString(entry, `${path}[${index}]`, errors, itemLimit);
		if (text) out.push(text);
	});
	return out;
}

function collectCriteria(value: unknown, path: string, errors: string[], warnings: string[]): string[] {
	const list = asArray(value, path, errors);
	if (list.length < 1) errors.push(`${path}: needs at least one criterion`);
	if (list.length > BACKPLAN_CRITERIA_LIMIT) errors.push(`${path}: exceeds the ${BACKPLAN_CRITERIA_LIMIT}-criterion limit`);
	const out: string[] = [];
	const seen = new Map<string, number>();
	list.slice(0, BACKPLAN_CRITERIA_LIMIT).forEach((entry, index) => {
		const itemPath = `${path}[${index}]`;
		const text = collectString(entry, itemPath, errors, BACKPLAN_STRING_LIMIT);
		if (!text) return;
		if (text.length < 8) errors.push(`${itemPath}: too short to be observable (${text.length} characters)`);
		if (genericCriterion.test(text)) errors.push(`${itemPath}: generic phrase; state the observable check (command, artifact or observed result)`);
		const key = text.toLowerCase().replace(/\s+/g, " ");
		const first = seen.get(key);
		if (first !== undefined) warnings.push(`${itemPath}: duplicates ${path}[${first}]`);
		else seen.set(key, index);
		out.push(text);
	});
	return out;
}

function normalizePlan(raw: unknown, errors: string[], warnings: string[]): BackplanPlan {
	const root = collectObject(raw, "plan", rootKeys, ["goal", "end_state", "success_criteria", "project", "issues", "policy_decisions", "automation_candidates"], errors);

	let request: string | null = null;
	if (root.request !== undefined) request = collectString(root.request, "request", errors, BACKPLAN_STRING_LIMIT) || null;

	const goal = collectString(root.goal, "goal", errors, BACKPLAN_STRING_LIMIT);
	const endState = collectString(root.end_state, "end_state", errors, BACKPLAN_STRING_LIMIT);
	const successCriteria = collectCriteria(root.success_criteria, "success_criteria", errors, warnings);

	const projectRecord = collectObject(root.project, "project", projectKeys, ["name", "mode", "reason"], errors);
	let projectMode: "reuse" | "create" = "reuse";
	if (projectRecord.mode === undefined) errors.push("project.mode: required");
	else if (projectRecord.mode !== "reuse" && projectRecord.mode !== "create") errors.push("project.mode: expected reuse or create");
	else projectMode = projectRecord.mode;
	const project = {
		name: collectString(projectRecord.name, "project.name", errors, BACKPLAN_TITLE_LIMIT),
		mode: projectMode,
		reason: collectString(projectRecord.reason, "project.reason", errors, BACKPLAN_STRING_LIMIT),
		boundaries: projectRecord.boundaries === undefined ? null : collectStringArray(projectRecord.boundaries, "project.boundaries", errors, BACKPLAN_STRING_LIMIT, 0),
	};

	const issuesRaw = asArray(root.issues, "issues", errors);
	if (issuesRaw.length < 1) errors.push("issues: needs at least one issue");
	if (issuesRaw.length > BACKPLAN_ISSUE_LIMIT) errors.push(`issues: exceeds the ${BACKPLAN_ISSUE_LIMIT}-issue limit`);
	const issues = issuesRaw.slice(0, BACKPLAN_ISSUE_LIMIT).map((entry, index) => {
		const path = `issues[${index}]`;
		const record = collectObject(entry, path, issueKeys, ["title", "objective", "context", "scope_in", "scope_out", "completion_criteria", "delivery"], errors);
		return {
			title: collectString(record.title, `${path}.title`, errors, BACKPLAN_TITLE_LIMIT),
			objective: collectString(record.objective, `${path}.objective`, errors, BACKPLAN_STRING_LIMIT),
			context: collectString(record.context, `${path}.context`, errors, BACKPLAN_STRING_LIMIT),
			scopeIn: collectStringArray(record.scope_in, `${path}.scope_in`, errors, BACKPLAN_STRING_LIMIT, 1),
			scopeOut: collectStringArray(record.scope_out, `${path}.scope_out`, errors, BACKPLAN_STRING_LIMIT, 1),
			completionCriteria: collectCriteria(record.completion_criteria, `${path}.completion_criteria`, errors, warnings),
			delivery: collectString(record.delivery, `${path}.delivery`, errors, BACKPLAN_STRING_LIMIT),
			dependencies: record.dependencies === undefined ? [] : collectStringArray(record.dependencies, `${path}.dependencies`, errors, BACKPLAN_STRING_LIMIT, 0),
			labels: record.labels === undefined ? null : collectStringArray(record.labels, `${path}.labels`, errors, 64, 0),
		} satisfies BackplanIssue;
	});
	const titleSeen = new Map<string, number>();
	issues.forEach((issue, index) => {
		if (!issue.title) return;
		const key = issue.title.toLowerCase().replace(/\s+/g, " ");
		const first = titleSeen.get(key);
		if (first !== undefined) errors.push(`issues[${index}].title: duplicates issues[${first}].title`);
		else titleSeen.set(key, index);
		if (issue.labels) issue.labels.forEach((label, labelIndex) => {
			if (!labelPattern.test(label)) errors.push(`issues[${index}].labels[${labelIndex}]: expected a label like repo:gjc-plugin`);
		});
	});

	const decisionsRaw = asArray(root.policy_decisions, "policy_decisions", errors);
	const policyDecisions = decisionsRaw.slice(0, BACKPLAN_ARRAY_LIMIT).map((entry, index) => {
		const path = `policy_decisions[${index}]`;
		const record = collectObject(entry, path, decisionKeys, decisionKeys, errors);
		const needsUserDecision = collectBoolean(record.needs_user_decision, `${path}.needs_user_decision`, errors);
		const options = record.options === undefined ? [] : collectStringArray(record.options, `${path}.options`, errors, 500, 0);
		if (needsUserDecision && options.length === 0) errors.push(`${path}.options: a user-decision entry needs at least one option`);
		return {
			topic: collectString(record.topic, `${path}.topic`, errors, 200),
			needsUserDecision,
			options,
			recordLocation: collectString(record.record_location, `${path}.record_location`, errors, 500),
		} satisfies BackplanPolicyDecision;
	});

	const candidatesRaw = asArray(root.automation_candidates, "automation_candidates", errors);
	const automationCandidates = candidatesRaw.slice(0, BACKPLAN_ARRAY_LIMIT).map((entry, index) => {
		const path = `automation_candidates[${index}]`;
		const record = collectObject(entry, path, candidateKeys, candidateKeys, errors);
		let disposition: "backlog" | "out_of_scope" = "backlog";
		if (record.disposition === undefined) errors.push(`${path}.disposition: required`);
		else if (record.disposition !== "backlog" && record.disposition !== "out_of_scope") errors.push(`${path}.disposition: must be backlog or out_of_scope — promote in-scope automation to an issue instead`);
		else disposition = record.disposition;
		return {
			candidate: collectString(record.candidate, `${path}.candidate`, errors, BACKPLAN_STRING_LIMIT),
			disposition,
		} satisfies BackplanAutomationCandidate;
	});

	return { request, goal, endState, successCriteria, project, issues, policyDecisions, automationCandidates };
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = sortValue((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function renderProjectDescription(plan: BackplanPlan, digest: string): string {
	const lines = ["## 목표", "", plan.goal, "", "## 성공 기준", ""];
	for (const item of plan.successCriteria) lines.push(`* ${item}`);
	if (plan.project.boundaries && plan.project.boundaries.length > 0) {
		lines.push("", "## 비범위", "");
		for (const item of plan.project.boundaries) lines.push(`* ${item}`);
	}
	lines.push("", "## 참조", "", `* backplan digest: sha256:${digest}`);
	return lines.join("\n");
}

function renderIssueDescription(issue: BackplanIssue, project: BackplanPlan["project"], context: BackplanRenderContext): string {
	const lines = [
		"목적·상위 목표",
		"",
		`- 해결할 문제와 기대 결과: ${issue.objective}`,
		`- 연결 프로젝트: ${project.name} (${project.mode === "reuse" ? "기존 재사용" : "신규"})`,
		"",
		"대상·근거",
		"",
		`- ${issue.context}`,
		"",
		"범위",
		"",
		"- 이번에 할 것:",
	];
	for (const item of issue.scopeIn) lines.push(`  - ${item}`);
	lines.push("- 하지 않을 것:");
	for (const item of issue.scopeOut) lines.push(`  - ${item}`);
	lines.push("", "완료 조건", "");
	for (const item of issue.completionCriteria) lines.push(`- [ ] ${item}`);
	lines.push(
		"",
		"의존성·실행 경계",
		"",
		`- 선행 티켓 / 미결정 사항 / 재개 조건: ${issue.dependencies.length > 0 ? issue.dependencies.join(" / ") : "해당 없음"}`,
		"",
		"실행·Git 연결 — 주요 전환점마다 댓글로 기록",
		"",
		`- 착수: 세션 ${context.session ?? "<세션 ID>"} / 워크트리 ${context.worktree ?? "<작업 경로>"} / 브랜치 ${context.branch ?? "<브랜치>"}`,
	);
	return lines.join("\n");
}

function renderNotes(plan: BackplanPlan): string | null {
	const lines: string[] = [];
	if (plan.policyDecisions.length > 0) {
		lines.push("### 정책·결정", "");
		for (const decision of plan.policyDecisions) {
			const options = decision.options.length > 0 ? ` (옵션: ${decision.options.join(" / ")})` : "";
			const owner = decision.needsUserDecision ? "사용자 결정 필요" : "에이전트 결정 가능";
			lines.push(`* ${decision.topic} — ${owner}${options} — 기록 위치: ${decision.recordLocation}`);
		}
	}
	if (plan.automationCandidates.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("### 자동화 후보 (비범위)", "");
		for (const candidate of plan.automationCandidates) lines.push(`* ${candidate.candidate} — ${candidate.disposition}`);
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

// A missing required key is reported once by collectObject; the per-field
// collectors would otherwise repeat it ("required string missing", "expected an
// array", nested "required") and crowd real errors out of the bounded list.
function dropMissingKeyEchoes(errors: string[]): string[] {
	const pathOf = (error: string) => error.slice(0, error.indexOf(": ")).replace(/^plan\./, "");
	const missing = new Set(errors.filter(error => error.endsWith(": required")).map(pathOf));
	const under = (path: string, parent: string) => path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`);
	return errors.filter(error => {
		const path = pathOf(error);
		for (const parent of missing) {
			if (under(path, parent)) return false;
			if (path === parent && !error.endsWith(": required")) return false;
		}
		return true;
	});
}

export function checkBackplanPlan(raw: unknown, context: BackplanRenderContext = {}): BackplanReport {
	const collected: string[] = [];
	const warnings: string[] = [];
	const plan = normalizePlan(raw, collected, warnings);
	const errors = dropMissingKeyEchoes(collected);
	if (errors.length > 0) {
		const shown = errors.slice(0, BACKPLAN_ERROR_LIMIT);
		if (errors.length > BACKPLAN_ERROR_LIMIT) shown.push(`... ${errors.length - BACKPLAN_ERROR_LIMIT} more error(s) omitted`);
		return { status: "invalid", errors: shown, warnings: warnings.slice(0, BACKPLAN_ERROR_LIMIT), digest: null, linear: null };
	}
	const digest = backplanHash("sha256").update(stableJson(plan)).digest("hex");
	const report: BackplanReport = {
		status: "ok",
		errors: [],
		warnings: warnings.slice(0, BACKPLAN_ERROR_LIMIT),
		digest,
		linear: {
			project: {
				mode: plan.project.mode,
				name: plan.project.name,
				reason: plan.project.reason,
				description: plan.project.mode === "create" ? renderProjectDescription(plan, digest) : null,
			},
			issues: plan.issues.map(issue => ({
				title: issue.title,
				description: renderIssueDescription(issue, plan.project, context),
				labels: issue.labels,
			})),
			notes: renderNotes(plan),
		},
	};
	if (JSON.stringify(report).length > BACKPLAN_OUTPUT_LIMIT) {
		return { status: "invalid", errors: ["rendered output exceeds the bounded limit; split the plan into smaller issues"], warnings: [], digest: null, linear: null };
	}
	return report;
}
