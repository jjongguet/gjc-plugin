import { resolveReceiptRepository, RECEIPT_REPOSITORY_REASONS, loadReceipt, currentReceiptFreshness, staticReceiptGuidance } from '../lib/receipts';
import { assessAdequacy } from '../lib/decision';
import { finalizeVerificationOutcome } from '../lib/outcomes';

export default function verificationStatus(pi: {cwd:string;typebox:{Type:any}}) {
 const T=pi.typebox.Type;
 return {
  name:'verification_status',label:'Verification Status',
  description:'Read one immutable repository-scoped local verification receipt and recompute source freshness. Historical execution is never rerun. Automatically attempt Jev adequacy on every lookup, including stale or missing evidence, at https://openrouter.ai/api/alpha/decisions (typesafe/jev-1.14). Optional assessment supplies non-sensitive context, not an opt-in switch. Only selected summaries/notes and bounded status/counts/freshness leave; no logs, diffs, source, test names, paths, keys or accounts. Missing context, failures and stale evidence cannot establish sufficient current verification. Warning-only; no automatic repair or blocking.',
  parameters:T.Object({receiptId:T.String(),repository:T.Optional(T.String({minLength:1,maxLength:4096,description:'The repository the receipt was recorded for, as passed to verification_run; defaults to the repository containing the session directory.'})),assessment:T.Optional(T.Object({changeSummary:T.String({description:'Non-sensitive summary of the change, 1-2000 characters; no secrets, URLs, paths, logs or source.'}),expectedBehavior:T.String({description:'Non-sensitive expected behavior, 1-2000 characters; same restrictions as changeSummary.'}),caseNotes:T.Optional(T.Array(T.Object({id:T.String({description:'Case note id. Use run, the only eligible id for this tool. Ids must be unique. Any other id is rejected in-plugin as invalid_case_id and the result lists the allowed ids.'}),note:T.String({description:'Non-sensitive case note, 1-300 characters.'})}),{description:'At most 8 case notes with unique ids.'}))},{description:'Optional non-sensitive context. Malformed or sensitive context is rejected in-plugin as invalid_context without echoing it.'}))},{additionalProperties:false}),
  async execute(_toolCallId:string,params:{receiptId:string;repository?:string;assessment?:unknown}) {
   const text=async(v:Record<string,any>)=>({content:[{type:'text',text:JSON.stringify(await finalizeVerificationOutcome('verification-receipts','status',v))}]});
   try {
    if (!params || Object.keys(params).some(k=>!['receiptId','repository','assessment'].includes(k))) throw new Error('invalid_input');
    const root=await resolveReceiptRepository(pi.cwd,params.repository); const receipt=await loadReceipt(root,params.receiptId);
    if (!receipt || receipt.plugin !== 'verification-receipts') throw new Error('receipt_unavailable');
    const freshness=await currentReceiptFreshness(root,receipt);
    const assessment=await assessAdequacy(params.assessment,{status:String(receipt.execution.status),counts:receipt.execution.counts,freshness,caseIds:['run']});
    return text({receipt,freshness,assessment,...staticReceiptGuidance(receipt.execution,freshness,assessment,receipt.warnings,{allowedCaseIds:['run']})});
   } catch (error) {
    const cause=error instanceof Error ? error.message : '';
    const reason=(RECEIPT_REPOSITORY_REASONS as readonly string[]).includes(cause) ? cause : 'receipt_unavailable';
    const execution={status:'unavailable',reason};
    const assessment=await assessAdequacy(undefined,{status:execution.status,counts:null,freshness:'unavailable'});
    const guidance=staticReceiptGuidance(execution,'unavailable',assessment);
    return text({execution,freshness:'unavailable',assessment,...guidance,warnings:[reason,...guidance.warnings]});
   }
  }
 };
}
