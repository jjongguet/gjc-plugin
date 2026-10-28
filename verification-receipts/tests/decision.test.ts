import { describe, test, expect, jest } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessAdequacy, assessmentShapeRejection } from "../lib/decision";

const context = { changeSummary: "Reject empty requests", expectedBehavior: "Empty requests fail safely", caseNotes: [{ id: "empty", note: "An empty request exercises the failure boundary" }] };
const facts = { status: "passed", freshness: "fresh", counts: { tests: 2, suites: 0, topLevel: 2, passed: 2, failed: 0, skipped: 0, todo: 0, cancelled: 0 }, caseIds: ["empty"] };
const environment = { JEV_ADVISOR_API_KEY: "synthetic-key", OPENROUTER_API_KEY: "other-key" };
const choices = () => ({ coverage_alignment: { type: "choice", choice: "aligned" }, boundary_evidence: { type: "choice", choice: "present" } });
function harness(payload: unknown = { answers: choices() }, status = 200) {
 const calls: { url: string; options: RequestInit }[] = [];
 const transport = (async (url: string | URL | Request, options?: RequestInit) => { calls.push({ url: String(url), options: options! }); return new Response(JSON.stringify(payload), { status }); }) as typeof fetch;
 return { calls, deps: { fetch: transport, env: environment, envFile: "/nonexistent/synthetic-env" } };
}
describe("adequacy Decisions contract", () => {
 test('unknown case ids are distinct from unsafe or duplicate context without transport or input echoes',async()=>{
  for(const id of ['policy','machinery','native-read','C1','C2','step-20','step-x']){
   const input={...context,caseNotes:[{id,note:'Boundary behavior observed'}]};
   const h=harness();
   expect(assessmentShapeRejection(input)).toBeUndefined();
   expect(await assessAdequacy(input,{...facts,caseIds:['run']},h.deps)).toEqual({status:'invalid_input',reason:'invalid_case_id'});
   expect(h.calls).toHaveLength(0);
  }
  for(const input of [
   {...context,caseNotes:[{id:'policy',note:'password=PRIVATE_CANARY'}]},
   {...context,caseNotes:[context.caseNotes[0],context.caseNotes[0]]},
   {...context,caseNotes:Array.from({length:9},(_,i)=>({id:`case-${i}`,note:'Boundary observed'}))},
  ]){
   const h=harness(),preflight=assessmentShapeRejection(input);
   expect(preflight).toEqual({status:'invalid_input',reason:'invalid_context'});
   expect(await assessAdequacy(input,facts,h.deps)).toEqual(preflight);
   expect(h.calls).toHaveLength(0);expect(JSON.stringify(preflight)).not.toContain('PRIVATE_CANARY');
  }
  const h=harness();
  expect((await assessAdequacy({...context,caseNotes:[{id:'run',note:'Normal and failure paths observed'}]},{...facts,caseIds:['run']},h.deps)).status).toBe('unscored');
  expect(h.calls).toHaveLength(1);
 });
 test('nonpassing stale and unavailable evidence is decided before any call',async()=>{
  for(const status of ['failed','no_tests','incomplete','not_run','unavailable']){const h=harness();const result=await assessAdequacy(context,{...facts,status},h.deps);expect(result.reason).toBe('insufficient_evidence');expect(result.status).toBe('unknown');expect(h.calls.length).toBe(0);}
  for(const freshness of ['stale','changed_during_run','unavailable']){const h=harness();const result=await assessAdequacy(context,{...facts,freshness},h.deps);expect(result.reason).toBe('insufficient_evidence');expect(h.calls.length).toBe(0);}
 });
 test('omitted context is decided before any call',async()=>{
  const h=harness();const result=await assessAdequacy(undefined,facts,h.deps);
  expect(h.calls.length).toBe(0);expect(result.status).toBe('unknown');expect(result.reason).toBe('missing_context');
  for(const observed of [{status:'incomplete',counts:null,freshness:'unavailable',assertions:[]},{status:'not_run',counts:null,freshness:'unavailable'},{...facts,counts:{...facts.counts,passed:0}}]){
   const other=harness();expect((await assessAdequacy(undefined,observed,other.deps)).reason).toBe('insufficient_evidence');expect(other.calls.length).toBe(0);
  }
 });
 test('UI assertion IDs kinds and outcomes are host facts while semantic notes remain caller authored',async()=>{
  const assertions=[{step:1,id:'step-1',kind:'text_exact' as const,status:'passed'}];
  const input={changeSummary:'Display a local result',expectedBehavior:'The result label matches the expected state',caseNotes:[{id:'step-1',note:'The label is the selected behavior observation'}]};
  const h=harness();const result=await assessAdequacy(input,{status:'passed',counts:null,freshness:'fresh',caseIds:['step-1'],assertions:assertions.map(a=>({...a,rawText:'PRIVATE_CANARY'}))},h.deps);
  expect(result.status).toBe('unscored');expect(h.calls.length).toBe(1);const body=JSON.parse(String(h.calls[0].options.body));expect(body.state.observed.assertions).toEqual(assertions);expect(body.state.explicitContext.authorship).toBe('caller_authored');expect(String(h.calls[0].options.body)).not.toContain('PRIVATE_CANARY');
  for(const invalid of [[{...assertions[0],id:'unknown'}],[{...assertions[0],kind:'source_canary'}],[...assertions,...assertions]]){const other=harness();expect((await assessAdequacy(input,{status:'passed',counts:null,freshness:'fresh',caseIds:['step-1'],assertions:invalid as any},other.deps)).status).toBe('invalid_input');expect(other.calls.length).toBe(0);}
  const other=harness();expect((await assessAdequacy(input,{status:'passed',counts:null,freshness:'fresh',caseIds:['step-1'],assertions:[{...assertions[0],status:'failed'}]},other.deps)).reason).toBe('insufficient_evidence');expect(other.calls.length).toBe(0);
 });
 test("official choice shape, fixed endpoint, and allowlisted caller context", async () => {
  const h = harness();
  const result = await assessAdequacy(context, { ...facts, path: "private-canary", hash: "hash-canary", logs: "log-canary" } as typeof facts, h.deps);
  expect(result.status).toBe("unscored"); expect(h.calls.length).toBe(1);
  const call = h.calls[0]; expect(call.url).toBe("https://openrouter.ai/api/alpha/decisions"); expect(call.options.method).toBe("POST"); expect(call.options.redirect).toBe("manual");
  const wire = JSON.parse(String(call.options.body));
  expect(wire.model).toBe("typesafe/jev-1.13"); expect(Object.keys(wire.questions)).toEqual(["coverage_alignment", "boundary_evidence"]);
  expect(wire.state).toEqual({ explicitContext: { authorship: "caller_authored", ...context }, observed: { status: facts.status, counts: facts.counts, freshness: facts.freshness } });
  expect(JSON.stringify(result)).not.toContain("synthetic-key"); expect(String(call.options.body)).not.toContain("canary");
 });
 test("independent low confidence and selected probabilities are preserved", async () => {
  const answers = { coverage_alignment: { type: "choice", choice: "aligned", confidence: 0.2, probabilities: { aligned: 0.84, gap: 0.16, none: 0, unknown: 0 }, rationale: "private-canary" }, boundary_evidence: { type: "choice", choice: "present", confidence: 0.75, probabilities: { present: 0.1, missing: 0.9, none: 0, unknown: 0 } } };
  const result = await assessAdequacy(context, facts, harness({ answers, provider: "private-canary" }).deps);
  expect(result.status).toBe("scored"); expect(result.answers?.coverage_alignment.confidence).toBe(0.2); expect(result.answers?.coverage_alignment.probabilities?.aligned).toBe(0.84); expect(JSON.stringify(result)).not.toContain("private-canary");
 });
 test("absent and partial scores remain valid unscored choices", async () => {
  for (const extra of [{ confidence: 0.5 }, { probabilities: { aligned: 0.5 } }, { confidence: 0.5, probabilities: { aligned: 0.5 } }, {}]) {
   const answers = choices(); Object.assign(answers.coverage_alignment, extra);
   expect((await assessAdequacy(context, facts, harness({ answers }).deps)).status).toBe("unscored");
  }
 });
 test("none and unknown remain uncertain", async () => {
  for (const choice of ["none", "unknown"]) { const answers = choices(); answers.coverage_alignment.choice = choice; expect((await assessAdequacy(context, facts, harness({ answers }).deps)).status).toBe("unknown"); }
 });
 test("malformed IDs, type, label, scores, and JSON never return provider data", async () => {
  for (const answer of [{ type: "score", choice: "aligned" }, { type: "choice", choice: "private-canary" }, { type: "choice", choice: "aligned", confidence: -1 }, { type: "choice", choice: "aligned", confidence: 2 }, { type: "choice", choice: "aligned", confidence: null }, { type: "choice", choice: "aligned", probabilities: { private: 0.5 } }, { type: "choice", choice: "aligned", probabilities: { aligned: "secret" } }]) {
   const result = await assessAdequacy(context, facts, harness({ answers: { ...choices(), coverage_alignment: answer } }).deps); expect(result.status).toBe("invalid_response"); expect(JSON.stringify(result)).not.toContain("canary");
  }
  expect((await assessAdequacy(context, facts, harness({ answers: { wrong_id: choices().coverage_alignment } }).deps)).status).toBe("invalid_response");
  const h = harness(); h.deps.fetch = (async () => new Response("not json private-canary")) as typeof fetch;
  expect((await assessAdequacy(context, facts, h.deps)).status).toBe("invalid_response");
 });
 test("HTTP failures and redirects have bounded receipts and no retries", async () => {
  for (const [status, reason] of [[401, "http_auth"], [402, "http_credit"], [429, "http_rate"], [500, "http_server"], [503, "http_server"], [302, "redirect"]] as const) {
   const h = harness({ error: "private-canary" }, status); expect(await assessAdequacy(context, facts, h.deps)).toEqual({ status: "unavailable", reason }); expect(h.calls.length).toBe(1);
  }
 });
 test("streaming and declared response caps", async () => {
  for (const declared of [false, true]) {
   const h = harness(); h.deps.fetch = (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); controller.close(); } }), { headers: declared ? { "content-length": "65537" } : {} })) as typeof fetch;
   expect(await assessAdequacy(context, facts, h.deps)).toEqual({ status: "invalid_response", reason: "response_cap" });
  }
 });
 test("timeout bounds even an injected fetch that ignores abort", async () => {
  jest.useFakeTimers();
  try { const h = harness(); let signal: AbortSignal | null | undefined; h.deps.fetch = ((_url, options) => { signal = options?.signal; return new Promise(() => {}); }) as typeof fetch;
   const pending = assessAdequacy(context, facts, h.deps); jest.advanceTimersByTime(8000); expect(await pending).toEqual({ status: "unavailable", reason: "timeout" }); expect(signal?.aborted).toBe(true);
  } finally { jest.useRealTimers(); }
 });
 test("encoded request cap rejects without transport", async () => {
  const h = harness();
  const input = { changeSummary: "界".repeat(2000), expectedBehavior: "界".repeat(2000), caseNotes: Array.from({ length: 8 }, (_, index) => ({ id: `case_${index}`, note: "界".repeat(300) })) };
  const result = await assessAdequacy(input, { ...facts, caseIds: input.caseNotes.map(note => note.id) }, h.deps);
  expect(result.reason).toBe("request_cap"); expect(h.calls.length).toBe(0);
 });
 test("off, missing key, invalid facts and rejected context make zero calls", async () => {
  const inputs: unknown[] = [null, { ...context, unexpected: "canary" }, { ...context, changeSummary: "x".repeat(2001) }, { ...context, caseNotes: [{ id: "unknown", note: "boundary" }] }, { ...context, caseNotes: Array.from({ length: 9 }, () => ({ id: "empty", note: "boundary" })) }, { ...context, caseNotes: [{ id: "empty", note: "x".repeat(301) }] }];
  for (const input of inputs) { const h = harness(); await assessAdequacy(input, facts, h.deps); expect(h.calls.length).toBe(0); }
  for (const env of [{ JEV_ADVISOR_PROVIDER: "off", JEV_ADVISOR_API_KEY: "synthetic-key" }, {}]) { const h = harness(); await assessAdequacy(context, facts, { ...h.deps, env }); expect(h.calls.length).toBe(0); }
  for (const [env,reason] of [[{JEV_ADVISOR_PROVIDER:'off'},'off'],[{},'missing_key']] as const) {const h=harness();expect((await assessAdequacy(undefined,facts,{...h.deps,env})).reason).toBe(reason);expect(h.calls.length).toBe(0);}
  for (const invalid of [{ ...facts, status: "canary" }, { ...facts, freshness: "canary" }, { ...facts, counts: { tests: -1 } }, { ...facts, counts: undefined }]) { const h = harness(); expect((await assessAdequacy(context, invalid, h.deps)).reason).toBe("invalid_facts"); expect(h.calls.length).toBe(0); }
 });
 test("secret, raw source, path, log and diff canaries are rejected rather than truncated", async () => {
  for (const text of ["api_key=private-canary", "Cookie: private-canary", "account_id=private-canary", "Bearer private-canary", "sk-private-canary", "https://private.invalid", "/Users/" + "private-canary/file", "```source canary```", "diff --git private-canary", "at private-canary:20", "a".repeat(64)]) {
   for (const field of ["changeSummary", "expectedBehavior", "note"]) {
    const input = field === "note" ? { ...context, caseNotes: [{ id: "empty", note: text }] } : { ...context, [field]: text };
    const h = harness(); expect(await assessAdequacy(input, facts, h.deps)).toEqual({ status: "invalid_input", reason: "invalid_context" }); expect(h.calls.length).toBe(0);
   }
  }
 });
 test("per-variable environment precedence and Jev key priority without configuration changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "adequacy-env-")); const file = join(directory, ".env"); const content = "JEV_ADVISOR_API_KEY=file-jev\nOPENROUTER_API_KEY=file-router\n";
  writeFileSync(file, content);
  try {
   const h = harness(); await assessAdequacy(context, facts, { ...h.deps, env: { OPENROUTER_API_KEY: "env-router" }, envFile: file }); expect((h.calls[0].options.headers as Record<string, string>).authorization).toBe("Bearer file-jev");
   const other = harness(); await assessAdequacy(context, facts, { ...other.deps, env: { JEV_ADVISOR_API_KEY: "env-jev" }, envFile: file }); expect((other.calls[0].options.headers as Record<string, string>).authorization).toBe("Bearer env-jev");
  } finally { rmSync(directory, { recursive: true }); }
 });
});
