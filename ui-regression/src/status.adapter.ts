import { resolveReceiptRepository, RECEIPT_REPOSITORY_REASONS, loadReceipt, currentReceiptFreshness, staticReceiptGuidance } from '../../verification-receipts/lib/receipts';
import { assessAdequacy } from '../../verification-receipts/lib/decision';
import { finalizeVerificationOutcome } from '../../verification-receipts/lib/outcomes';

export default function uiRegressionStatus(pi:{cwd:string;typebox:{Type:any}}) {
 const T=pi.typebox.Type;
 return {
  name:'ui_regression_status',label:'UI Regression Status',
  description:'Read one repository-scoped UI metadata receipt and recompute source freshness. Browser state is NOT reobserved and build binding remains unverified. Automatically attempt Jev adequacy every lookup at https://openrouter.ai/api/alpha/decisions (typesafe/jev-1.14), including stale or missing evidence. Optional assessment supplies non-sensitive context, not an opt-in switch. Only selected summaries/notes and bounded host facts leave; no account, fill values, source, snapshots, paths or logs. Missing context, failures and stale evidence cannot establish sufficient current verification. Warning-only.',
  parameters:T.Object({receiptId:T.String(),repository:T.Optional(T.String({minLength:1,maxLength:4096,description:'The repository the receipt was recorded for, as passed to ui_regression_run; defaults to the repository containing the session directory.'})),assessment:T.Optional(T.Object({changeSummary:T.String({description:'Non-sensitive summary of the change, 1-2000 characters; no secrets, URLs, paths, logs or source.'}),expectedBehavior:T.String({description:'Non-sensitive expected behavior, 1-2000 characters; same restrictions as changeSummary.'}),caseNotes:T.Optional(T.Array(T.Object({id:T.String({description:'Case note id step-N, the zero-based scenario step index (step-0 to step-19). Only observed assertions in the receipt are eligible; planned or unreached steps are not. Ids must be unique. Any other id is rejected in-plugin as invalid_case_id and the result lists the allowed ids.'}),note:T.String({description:'Non-sensitive case note, 1-300 characters.'})}),{description:'At most 8 case notes with unique ids.'}))},{description:'Optional non-sensitive context. Malformed or sensitive context is rejected in-plugin as invalid_context without echoing it.'}))},{additionalProperties:false}),
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
