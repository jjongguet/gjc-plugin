import { actualRepository, loadReceipt, currentReceiptFreshness, staticReceiptGuidance } from '../../verification-receipts/lib/receipts';
import { assessAdequacy } from '../../verification-receipts/lib/decision';
import { finalizeVerificationOutcome } from '../../verification-receipts/lib/outcomes';

export default function uiRegressionStatus(pi:{cwd:string;typebox:{Type:any}}) {
 const T=pi.typebox.Type;
 return {
  name:'ui_regression_status',label:'UI Regression Status',
  description:'Read one repository-scoped UI metadata receipt and recompute source freshness. Browser state is NOT reobserved and build binding remains unverified. Automatically attempt Jev adequacy every lookup at https://openrouter.ai/api/alpha/decisions (typesafe/jev-1.13), including stale or missing evidence. Optional assessment supplies non-sensitive context, not an opt-in switch. Only selected summaries/notes and bounded host facts leave; no account, fill values, source, snapshots, paths or logs. Missing context, failures and stale evidence cannot establish sufficient current verification. Warning-only.',
  parameters:T.Object({receiptId:T.String(),assessment:T.Optional(T.Object({changeSummary:T.String({maxLength:2000}),expectedBehavior:T.String({maxLength:2000}),caseNotes:T.Optional(T.Array(T.Object({id:T.String(),note:T.String({maxLength:300})}),{maxItems:8}))},{additionalProperties:false}))},{additionalProperties:false}),
  async execute(_toolCallId:string,params:{receiptId:string;assessment?:unknown}) {
   const text=async(value:Record<string,any>)=>({content:[{type:'text',text:JSON.stringify(await finalizeVerificationOutcome('ui-regression','status',value))}]});
   try {
    if(!params||Object.keys(params).some(k=>!['receiptId','assessment'].includes(k)))throw Error('invalid_input');
    const root=await actualRepository(pi.cwd),receipt=await loadReceipt(root,params.receiptId);
    if(!receipt||receipt.plugin!=='ui-regression')throw Error('unavailable');
    const freshness=await currentReceiptFreshness(root,receipt);
    const assertions=receipt.execution.assertions as {step:number;id:string;kind:'visible'|'text_exact'|'text_substring';status:string}[];
    const caseIds=assertions.map(a=>a.id);
    const assessment=await assessAdequacy(params.assessment,{status:String(receipt.execution.status),counts:null,freshness,caseIds,assertions});
    return text({receipt,freshness,currentUiState:'not_reobserved',browserBuildBinding:'unverified',assessment,...staticReceiptGuidance(receipt.execution,freshness,assessment)});
   }catch{
    const execution={status:'unavailable',reason:'receipt_unavailable'};
    const assessment=await assessAdequacy(undefined,{status:execution.status,counts:null,freshness:'unavailable'});
    const guidance=staticReceiptGuidance(execution,'unavailable',assessment);
    return text({execution,freshness:'unavailable',currentUiState:'not_reobserved',browserBuildBinding:'unverified',assessment,...guidance,warnings:['receipt_unavailable',...guidance.warnings]});
   }
  }
 };
}
