import { resolveReceiptRepository, RECEIPT_REPOSITORY_REASONS, repositoryDigest, specFingerprint, fingerprintSource, freshnessFor, createReceipt, persistReceipt, staticReceiptGuidance } from '../../verification-receipts/lib/receipts';
import { assessAdequacy, assessmentShapeRejection } from '../../verification-receipts/lib/decision';
import { validateScenario, uiScenarioReason } from '../lib/scenario';
import { runAsideScenario } from '../lib/aside';
import { finalizeVerificationOutcome } from '../../verification-receipts/lib/outcomes';

// Caller scenario and assessment text carry no host-checkable bounds or literal unions:
// validateScenario and the adequacy shape check decide them in-plugin (UI_SCENARIO_* /
// invalid_context / invalid_case_id) so a host schema rejection cannot echo the input.
// The parameters literal must stay statically readable by the GJC installer.
export default function uiRegressionRun(pi:{cwd:string;typebox:{Type:any}}) {
 const T=pi.typebox.Type;
 return {
  name:'ui_regression_run',label:'UI Regression Run',
  description:'Execute one explicitly authorized non-sensitive loopback scenario through ONE Aside REPL invocation pinned to the local session host (--host local): the scenario origin is strictly loopback, so the browser must run on this machine and a cloud session host can never reach the fixture. Inspect handlers first: loopback is not a sandbox. Open/close only the owned new tab in the local Aside Browser and never attach to existing tabs; fresh snapshots and unique visible current CSS locators, literal exact/substring assertions; no screenshots, user tabs, result imports or arbitrary JS. Account is explicit ephemeral routing, never in receipts. Automatically attempt Jev adequacy every invocation at https://openrouter.ai/api/alpha/decisions (typesafe/jev-1.14). Supply assessment context when known; omission does not disable the call. Only validated selected summaries/notes and bounded host facts leave, not scenario text, account, inputs, selectors or snapshots. Warning-only; no repair loops or blocking. Missing context is not adequate verification. Historical browser evidence is not current/deployed UI evidence.',
  parameters:T.Object({
   account:T.String({minLength:1,maxLength:64,description:'Explicit Aside account routing only; not persisted or included in evidence.'}),
   scenario:T.Object({
    id:T.String({description:'Scenario id: letters, digits, _ or -, at most 64 characters.'}),
    expectedBehavior:T.String({description:'Non-sensitive expected behavior, 1-2000 characters.'}),
    steps:T.Array(T.Object({
     action:T.String({description:'One of goto, click, fill, assert. The first step must be goto.'}),
     url:T.Optional(T.String({description:'goto only: explicit loopback URL (localhost, 127.0.0.1 or [::1]) without credentials, query, fragment or sensitive paths.'})),
     selector:T.Optional(T.String({description:'click, fill and assert: unique visible CSS selector, at most 256 characters.'})),
     value:T.Optional(T.String({description:'fill only: non-sensitive value, at most 1000 characters.'})),
     kind:T.Optional(T.String({description:'assert only: visible or text.'})),
     match:T.Optional(T.String({description:'assert kind text only: exact or substring.'})),
     expected:T.Optional(T.String({description:'assert kind text only: literal expected text, at most 2000 characters.'}))
    }),{description:'1-20 steps with at least one assert. Fields not used by the step action must be omitted.'})
   },{description:'Rejected in-plugin with a specific scenario_* reason, before any browser launch, when malformed, sensitive or not loopback.'}),
   timeoutMs:T.Optional(T.Number({minimum:1,maximum:90000,description:'Total timeout default 60,000 ms, maximum 90,000 ms, below Aside 120 seconds.'})),
   repository:T.Optional(T.String({minLength:1,maxLength:4096,description:'Root of the Git work tree to record against, absolute or relative to the session directory. Needed when the session directory is not inside a repository; it must be the session repository or lie inside the session directory. Defaults to the repository containing the session directory.'})),
   assessment:T.Optional(T.Object({changeSummary:T.String({description:'Non-sensitive summary of the change, 1-2000 characters; no secrets, URLs, paths, logs or source.'}),expectedBehavior:T.String({description:'Non-sensitive expected behavior, 1-2000 characters; same restrictions as changeSummary.'}),caseNotes:T.Optional(T.Array(T.Object({id:T.String({description:'Case note id step-N, the zero-based scenario step index (step-0 to step-19). Only observed assertions of this run are eligible; planned or unreached steps are not. Ids must be unique. Any other id is rejected in-plugin as invalid_case_id and the result lists the allowed ids.'}),note:T.String({description:'Non-sensitive case note, 1-300 characters.'})}),{description:'At most 8 case notes with unique ids.'}))},{description:'Optional non-sensitive context. Malformed or sensitive context is rejected in-plugin as invalid_context without echoing it.'}))
  },{additionalProperties:false}),
  async execute(toolCallId:string,params:{account:string;scenario:unknown;timeoutMs?:number;repository?:string;assessment?:unknown},_update?:unknown,_ctx?:unknown,signal?:AbortSignal) {
   const started=performance.now();
   let execution: Record<string, any> = {status:'not_run',reason:'invalid_or_unavailable_input'};
   const text=async(value:Record<string,any>)=>({content:[{type:'text',text:JSON.stringify(await finalizeVerificationOutcome('ui-regression','run',value))}]});
   try {
    if(!params||Object.keys(params).some(k=>!['account','scenario','timeoutMs','repository','assessment'].includes(k))||typeof params.account!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(params.account)||(params.timeoutMs!==undefined&&(!Number.isSafeInteger(params.timeoutMs)||params.timeoutMs<1||params.timeoutMs>90000))) throw Error('invalid_input');
    const scenario=validateScenario(params.scenario);
    const rejected=assessmentShapeRejection(params.assessment);
    if(rejected) return text({execution,assessment:rejected,...staticReceiptGuidance(execution,'unavailable',rejected,[],{tool:'ui'})});
    const root=await resolveReceiptRepository(pi.cwd,params.repository);
    const specDigest=specFingerprint({scenario,timeoutMs:params.timeoutMs??60000});const before=await fingerprintSource(root,specDigest);
    execution=await runAsideScenario(scenario,params.account,params.timeoutMs??60000,signal);
    const after=await fingerprintSource(root,specDigest),freshness=freshnessFor(before,after);
    const receipt=createReceipt({plugin:'ui-regression',toolCallId,repositoryDigest:await repositoryDigest(root),durationMs:Math.round(performance.now()-started),specDigest,before,after,freshness,execution,warnings:[],limitations:['Historical browser observations are not current UI observations.','Browser build/source binding is unverified; loopback is not a sandbox.','Snapshots, inputs and account routing are discarded; excluded source paths are not covered.']});
    const storage=await persistReceipt(receipt);
    const assessment=await assessAdequacy(params.assessment,{status:execution.status,counts:null,freshness,caseIds:execution.assertions.map(a=>a.id),assertions:execution.assertions});
    return text({receipt,...storage,assessment,...staticReceiptGuidance(execution,freshness,assessment,[],{tool:'ui',allowedCaseIds:execution.assertions.map(a=>a.id)})});
   }catch(error){
    const cause=error instanceof Error ? error.message : '';
    const scenarioReason=uiScenarioReason(cause);
    if (execution.status==='not_run' && scenarioReason) execution={status:'not_run',reason:scenarioReason};
    if (execution.status==='not_run' && (RECEIPT_REPOSITORY_REASONS as readonly string[]).includes(cause)) execution={status:'not_run',reason:cause};
    const assessment=await assessAdequacy(undefined,{status:execution.status,counts:null,freshness:'unavailable',...(execution.assertions ? {assertions:execution.assertions} : {})});
    return text({execution,assessment,...staticReceiptGuidance(execution,'unavailable',assessment,[],{tool:'ui'})});
   }
  }
 };
}
