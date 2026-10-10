import { appendPluginOutcome } from '../../shared/lib/results';

// Explicit task advice and an offline correlation report; both journal sanitized outcomes.
export default function jevAdvise(pi: {
 typebox: {Type: {Object:(fields:Record<string,unknown>)=>unknown;String:(options?:Record<string,unknown>)=>unknown;Optional:(schema:unknown)=>unknown}};
}) {
 return {
  name:'jev_advise',label:'JEV Advise',
  description:'Ask for bounded fast/balanced/strong advice, or report="calibration" for an offline descriptive correlation report. Every handled outcome is journaled privately under ~/.gjc-plugin; calibration never calls a provider or modifies correlation state. No quality or correctness is inferred.',
  parameters:pi.typebox.Type.Object({
   assignment:pi.typebox.Type.Optional(pi.typebox.Type.String({description:'One complete task assignment to evaluate'})),
   role:pi.typebox.Type.Optional(pi.typebox.Type.String({description:'Intended subagent role'})),
   report:pi.typebox.Type.Optional(pi.typebox.Type.String({description:'Offline correlation report; only "calibration" is valid. Appends a private outcome record.'})),
  }),
  async execute(_toolCallId:string,params:{assignment?:string;role?:string;report?:string}) {
   const cfg=readConfig();
   const operation=params?.report==='calibration'?'calibration':'advise';
   const finish=async(value:string|Advice,evidenceStorage?:{status:string;reason?:string})=>{
    const advice=typeof value==='string'?undefined:value.status==='decision'?{status:value.status,tier:value.tier,confidence:value.confidence,confidenceKind:value.confidenceKind,...(value.probabilities?{probabilities:value.probabilities}:{})}:{status:value.status,reason:value.reason};
    let journalStorage;
    try { journalStorage=await appendPluginOutcome('jev-advisor',{
     operation,toolCallDigest:createHash('sha256').update(_toolCallId).digest('hex'),stateOverrideIgnored:cfg.stateOverrideIgnored,
     ...(advice?{advice}:{}),...(evidenceStorage?{evidenceStorage}:{}),
    }); } catch { journalStorage={persisted:false,reason:'store_unavailable'}; }
    const persistence={journalStorage,stateOverrideIgnored:cfg.stateOverrideIgnored};
    const text=typeof value==='string'?value+'\n'+JSON.stringify(persistence):JSON.stringify({...value,...persistence},null,2);
    return {content:[{type:'text',text}]};
   };
   if(operation==='calibration') {
    try {
     const result=readEvidenceV2(version2StateFile(cfg.stateFile));
     if(result.status==='unavailable') return finish(`jev_advise: retained v2 report unavailable (${result.reason}); correlation state was not changed.`,{status:result.status,reason:result.reason});
     const state=result.status==='missing'?emptyEvidenceV2():result.value;
     const {text}=calibrationSummary(state);
     return finish((result.status==='missing'?'No v2 store exists yet. ':'')+text,{status:result.status});
    } catch { return finish('jev_advise: retained v2 report unavailable (io_error); correlation state was not changed.',{status:'unavailable',reason:'io_error'}); }
   }
   if(params?.report!==undefined&&params.report!=='') return finish('jev_advise: unknown report. The only valid value is report="calibration".',{status:'unavailable',reason:'invalid_input'});
   if(typeof params?.assignment!=='string'||!params.assignment.trim()||(params.role!==undefined&&typeof params.role!=='string')) return finish(noDecision('invalid_task'));
   const extraction=extractTasks({agent:params.role??'',tasks:[{assignment:params.assignment}]},providerPromptLimit(cfg));
   const task=extraction.tasks[0];
   if(!task) return finish(noDecision('invalid_task'));
   try { return finish(await askDecisionModel(cfg,task,(input,init)=>fetch(input,init))); }
   catch { return finish(noDecision('provider_error')); }
  },
 };
}
