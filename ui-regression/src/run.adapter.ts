import { actualRepository, repositoryDigest, specFingerprint, fingerprintSource, freshnessFor, createReceipt, persistReceipt, staticReceiptGuidance } from '../../verification-receipts/lib/receipts';
import { assessAdequacy } from '../../verification-receipts/lib/decision';
import { validateScenario } from '../lib/scenario';
import { runAsideScenario } from '../lib/aside';
import { finalizeVerificationOutcome } from '../../verification-receipts/lib/outcomes';

export default function uiRegressionRun(pi:{cwd:string;typebox:{Type:any}}) {
 const T=pi.typebox.Type;
 return {
  name:'ui_regression_run',label:'UI Regression Run',
  description:'Execute one explicitly authorized non-sensitive loopback scenario through ONE Aside REPL invocation. Inspect handlers first: loopback is not a sandbox. Open/close only the owned new tab, fresh snapshots and unique visible current CSS locators, literal exact/substring assertions; no screenshots, user tabs, result imports or arbitrary JS. Account is explicit ephemeral routing, never in receipts. Automatically attempt Jev adequacy every invocation at https://openrouter.ai/api/alpha/decisions (typesafe/jev-1.13). Supply assessment context when known; omission does not disable the call. Only validated selected summaries/notes and bounded host facts leave, not scenario text, account, inputs, selectors or snapshots. Warning-only; no repair loops or blocking. Missing context is not adequate verification. Historical browser evidence is not current/deployed UI evidence.',
  parameters:T.Object({
   account:T.String({minLength:1,maxLength:64,description:'Explicit Aside account routing only; not persisted or included in evidence.'}),
   scenario:T.Object({id:T.String({maxLength:64}),expectedBehavior:T.String({maxLength:2000}),steps:T.Array(T.Union([
    T.Object({action:T.Literal('goto'),url:T.String()},{additionalProperties:false}),
    T.Object({action:T.Literal('click'),selector:T.String({maxLength:256})},{additionalProperties:false}),
    T.Object({action:T.Literal('fill'),selector:T.String({maxLength:256}),value:T.String({maxLength:1000})},{additionalProperties:false}),
    T.Object({action:T.Literal('assert'),selector:T.String({maxLength:256}),kind:T.Literal('visible')},{additionalProperties:false}),
    T.Object({action:T.Literal('assert'),selector:T.String({maxLength:256}),kind:T.Literal('text'),match:T.Union([T.Literal('exact'),T.Literal('substring')]),expected:T.String({maxLength:2000})},{additionalProperties:false})
   ]),{minItems:1,maxItems:20})},{additionalProperties:false}),
   timeoutMs:T.Optional(T.Number({minimum:1,maximum:90000,description:'Total timeout default 60,000 ms, maximum 90,000 ms, below Aside 120 seconds.'})),
   assessment:T.Optional(T.Object({changeSummary:T.String({maxLength:2000}),expectedBehavior:T.String({maxLength:2000}),caseNotes:T.Optional(T.Array(T.Object({id:T.String(),note:T.String({maxLength:300})}),{maxItems:8}))},{additionalProperties:false}))
  },{additionalProperties:false}),
  async execute(toolCallId:string,params:{account:string;scenario:unknown;timeoutMs?:number;assessment?:unknown},_update?:unknown,_ctx?:unknown,signal?:AbortSignal) {
   const started=performance.now();
   let execution: Record<string, any> = {status:'not_run',reason:'invalid_or_unavailable_input'};
   const text=async(value:Record<string,any>)=>({content:[{type:'text',text:JSON.stringify(await finalizeVerificationOutcome('ui-regression','run',value))}]});
   try {
    if(!params||Object.keys(params).some(k=>!['account','scenario','timeoutMs','assessment'].includes(k))||typeof params.account!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(params.account)||(params.timeoutMs!==undefined&&(!Number.isSafeInteger(params.timeoutMs)||params.timeoutMs<1||params.timeoutMs>90000))) throw Error('invalid_input');
    const scenario=validateScenario(params.scenario);const root=await actualRepository(pi.cwd);
    const specDigest=specFingerprint({scenario,timeoutMs:params.timeoutMs??60000});const before=await fingerprintSource(root,specDigest);
    execution=await runAsideScenario(scenario,params.account,params.timeoutMs??60000,signal);
    const after=await fingerprintSource(root,specDigest),freshness=freshnessFor(before,after);
    const receipt=createReceipt({plugin:'ui-regression',toolCallId,repositoryDigest:await repositoryDigest(root),durationMs:Math.round(performance.now()-started),specDigest,before,after,freshness,execution,warnings:[],limitations:['Historical browser observations are not current UI observations.','Browser build/source binding is unverified; loopback is not a sandbox.','Snapshots, inputs and account routing are discarded; excluded source paths are not covered.']});
    const storage=await persistReceipt(receipt);
    const assessment=await assessAdequacy(params.assessment,{status:execution.status,counts:null,freshness,caseIds:execution.assertions.map(a=>a.id),assertions:execution.assertions});
    return text({receipt,...storage,assessment,...staticReceiptGuidance(execution,freshness,assessment)});
   }catch{
    const assessment=await assessAdequacy(undefined,{status:execution.status,counts:null,freshness:'unavailable',...(execution.assertions ? {assertions:execution.assertions} : {})});
    return text({execution,assessment,...staticReceiptGuidance(execution,'unavailable',assessment)});
   }
  }
 };
}
