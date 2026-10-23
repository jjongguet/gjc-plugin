import { isAllowedDecisionEndpoint, validateProbabilityMap } from "../../shared/lib/decision-contract";
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
