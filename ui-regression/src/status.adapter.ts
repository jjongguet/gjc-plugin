import { resolveReceiptRepository, RECEIPT_REPOSITORY_REASONS, loadReceipt, currentReceiptFreshness, staticReceiptGuidance } from '../../verification-receipts/lib/receipts';
import { assessAdequacy } from '../../verification-receipts/lib/decision';
import { finalizeVerificationOutcome } from '../../verification-receipts/lib/outcomes';
import { ASSESSMENT_CASE_IDS } from '../../shared/lib/decision-contract';

export default function uiRegressionStatus(pi:{cwd:string;typebox:{Type:any}}) {
 const T=pi.typebox.Type;
 return {
  name:'ui_regression_status',label:'UI Regression Status',
  description:'Read one repository-scoped UI metadata receipt and recompute source freshness. Browser state is NOT reobserved and build binding remains unverified. Automatically attempt Jev adequacy every lookup at https://openrouter.ai/api/alpha/decisions (typesafe/jev-1.13), including stale or missing evidence. Optional assessment supplies non-sensitive context, not an opt-in switch. Only selected summaries/notes and bounded host facts leave; no account, fill values, source, snapshots, paths or logs. Missing context, failures and stale evidence cannot establish sufficient current verification. Warning-only.',
  parameters:T.Object({receiptId:T.String(),repository:T.Optional(T.String({minLength:1,maxLength:4096,description:'The repository the receipt was recorded for, as passed to ui_regression_run; defaults to the repository containing the session directory.'})),assessment:T.Optional(T.Object({changeSummary:T.String({maxLength:2000}),expectedBehavior:T.String({maxLength:2000}),caseNotes:T.Optional(T.Array(T.Object({id:T.Union(ASSESSMENT_CASE_IDS.ui.map(id=>T.Literal(id)),{description:'Use step-N with the zero-based scenario step index (0-19). Only observed assertions in the receipt are eligible; planned or unreached steps are not. Ids must be unique.'}),note:T.String({maxLength:300})},{additionalProperties:false}),{maxItems:8}))},{additionalProperties:false}))},{additionalProperties:false}),
  async execute(_toolCallId:string,params:{receiptId:string;repository?:string;assessment?:unknown}) {
   const text=async(value:Record<string,any>)=>({content:[{type:'text',text:JSON.stringify(await finalizeVerificationOutcome('ui-regression','status',value))}]});
   try {
    if(!params||Object.keys(params).some(k=>!['receiptId','repository','assessment'].includes(k)))throw Error('invalid_input');
    const root=await resolveReceiptRepository(pi.cwd,params.repository),receipt=await loadReceipt(root,params.receiptId);
    if(!receipt||receipt.plugin!=='ui-regression')throw Error('unavailable');
    const freshness=await currentReceiptFreshness(root,receipt);
    const assertions=receipt.execution.assertions as {step:number;id:string;kind:'visible'|'text_exact'|'text_substring';status:string}[];
    const caseIds=assertions.map(a=>a.id);
    const assessment=await assessAdequacy(params.assessment,{status:String(receipt.execution.status),counts:null,freshness,caseIds,assertions});
    return text({receipt,freshness,currentUiState:'not_reobserved',browserBuildBinding:'unverified',assessment,...staticReceiptGuidance(receipt.execution,freshness,assessment,[],{tool:'ui',allowedCaseIds:caseIds})});
   }catch(error){
    const cause=error instanceof Error ? error.message : '';
    const reason=(RECEIPT_REPOSITORY_REASONS as readonly string[]).includes(cause) ? cause : 'receipt_unavailable';
    const execution={status:'unavailable',reason};
    const assessment=await assessAdequacy(undefined,{status:execution.status,counts:null,freshness:'unavailable'});
    const guidance=staticReceiptGuidance(execution,'unavailable',assessment,[],{tool:'ui'});
    return text({execution,freshness:'unavailable',currentUiState:'not_reobserved',browserBuildBinding:'unverified',assessment,...guidance,warnings:[reason,...guidance.warnings]});
   }
  }
 };
}
