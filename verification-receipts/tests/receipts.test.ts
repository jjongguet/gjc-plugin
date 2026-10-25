import {test,expect,afterEach} from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {actualRepository,repositoryDigest,specFingerprint,fingerprintSource,createReceipt,persistReceipt,loadReceipt,currentReceiptFreshness,freshnessFor,staticReceiptGuidance} from '../lib/receipts';
import verificationStatus from '../src/status.adapter';
const owned:string[]=[];
afterEach(async()=>{for(const p of owned.splice(0)) await fs.rm(p,{recursive:true,force:true});});
async function setup(){const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'receipt-test-')));owned.push(dir);const root=path.join(dir,'repo');await fs.mkdir(root);const git=(...args:string[])=>execFileSync('git',args,{cwd:root,env:{PATH:process.env.PATH},stdio:'pipe'});git('init','-q');await fs.writeFile(path.join(root,'a.mjs'),'export const value=1;');git('add','a.mjs');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');const base=path.join(dir,'store');return {root,base,git};}
async function make(root:string){const specDigest=specFingerprint({files:['a.mjs']});const before=await fingerprintSource(root,specDigest);return createReceipt({plugin:'verification-receipts',toolCallId:'fixture',repositoryDigest:await repositoryDigest(root),durationMs:1,specDigest,before,after:before,freshness:'fresh',execution:{status:'passed',reason:'native_success',counts:{tests:1,suites:0,topLevel:1,passed:1,failed:0,skipped:0,todo:0,cancelled:0},exitCode:0,signal:null,runnerVersion:'v24.15.0'},warnings:[],limitations:[]});}
test('actual repo identity and private immutable storage',async()=>{const{root,base}=await setup();expect(await actualRepository(root)).toBe(await fs.realpath(root));const r=await make(root);expect((await persistReceipt(r,base)).persisted).toBe(true);expect((await fs.stat(path.join(base,r.repositoryDigest,r.id+'.json'))).mode&0o777).toBe(0o600);expect((await fs.stat(base)).mode&0o777).toBe(0o700);expect(await loadReceipt(root,r.id,base)).toEqual(r);expect((await persistReceipt(r,base)).persisted).toBe(false);expect(await currentReceiptFreshness(root,r)).toBe('fresh');});
test('working bytes, deletion, untracked, mode, spec and index stale evidence',async()=>{const{root,git}=await setup();const r=await make(root);await fs.writeFile(path.join(root,'a.mjs'),'changed');expect(await currentReceiptFreshness(root,r)).toBe('stale');git('checkout','--','a.mjs');await fs.chmod(path.join(root,'a.mjs'),0o755);expect(await currentReceiptFreshness(root,r)).toBe('stale');await fs.chmod(path.join(root,'a.mjs'),0o644);await fs.writeFile(path.join(root,'new.mjs'),'new');expect(await currentReceiptFreshness(root,r)).toBe('stale');await fs.unlink(path.join(root,'new.mjs'));await fs.unlink(path.join(root,'a.mjs'));expect(await currentReceiptFreshness(root,r)).toBe('stale');git('checkout','--','a.mjs');expect((await fingerprintSource(root,specFingerprint({files:['other.mjs']}))).digest).not.toBe(r.before.digest);await fs.writeFile(path.join(root,'a.mjs'),'index');git('add','a.mjs');await fs.writeFile(path.join(root,'a.mjs'),'export const value=1;');expect(await currentReceiptFreshness(root,r)).toBe('stale');});
test('HEAD change invalidates freshness',async()=>{const{root,git}=await setup();const r=await make(root);git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','head');expect(await currentReceiptFreshness(root,r)).toBe('stale');});
test('private credential exclusions explicit; symlink text never followed',async()=>{const{root}=await setup();const r=await make(root);await fs.writeFile(path.join(root,'.env'),'SECRET_CANARY');expect(await currentReceiptFreshness(root,r)).toBe('fresh');await fs.symlink('/nonexistent-external',path.join(root,'linked'));const fp=await fingerprintSource(root,r.specDigest);expect(fp.status).toBe('available');expect(fp.digest).not.toBe(r.before.digest);expect(JSON.stringify(fp)).not.toContain('SECRET_CANARY');});
test('during-run unavailable and guidance are independent from execution',async()=>{const{root}=await setup();const r=await make(root);await fs.writeFile(path.join(root,'a.mjs'),'change');r.after=await fingerprintSource(root,r.specDigest);r.freshness=freshnessFor(r.before,r.after);expect(r.freshness).toBe('changed_during_run');expect(await currentReceiptFreshness(root,r)).toBe('changed_during_run');expect(staticReceiptGuidance(r.execution,r.freshness,{status:'unscored'}).recommendedNextActions.length).toBeLessThanOrEqual(3);});
test('locked store never stolen; corrupt metadata not accepted',async()=>{const{root,base}=await setup();const r=await make(root);await persistReceipt(r,base);const dir=path.join(base,r.repositoryDigest);await fs.writeFile(path.join(dir,'.admission.lock'),'owned',{mode:0o600});expect((await persistReceipt({...r,id:crypto.randomUUID()},base)).reason).toBe('store_busy');expect(await fs.readFile(path.join(dir,'.admission.lock'),'utf8')).toBe('owned');await fs.unlink(path.join(dir,'.admission.lock'));await fs.writeFile(path.join(dir,r.id+'.json'),'{broken');expect(await loadReceipt(root,r.id,base)).toBeNull();expect((await persistReceipt({...r,id:crypto.randomUUID()},base)).persisted).toBe(false);});
test('symlink and permissive store rejected without writes',async()=>{const{root,base}=await setup();const r=await make(root);await fs.mkdir(base,{mode:0o755});expect((await persistReceipt(r,base)).persisted).toBe(false);await fs.rmdir(base);await fs.symlink(root,base);expect((await persistReceipt(r,base)).persisted).toBe(false);expect(await fs.readdir(root)).toEqual(expect.arrayContaining(['a.mjs']));});
test('cross repository and imported extra fields rejected',async()=>{const a=await setup(),b=await setup();const r=await make(a.root);expect((await persistReceipt({...r,rawLogs:'SECRET_CANARY'} as any,a.base)).persisted).toBe(false);await persistReceipt(r,a.base);expect(await loadReceipt(b.root,r.id,a.base)).toBeNull();expect(await loadReceipt(a.root,'../escape',a.base)).toBeNull();});
test('concurrent admissions do not join or overwrite',async()=>{const{root,base}=await setup();const r=await make(root);await persistReceipt(r,base);const results=await Promise.all(Array.from({length:8},()=>persistReceipt({...r,id:crypto.randomUUID()},base)));expect(results.filter(v=>v.persisted).length).toBeGreaterThan(0);expect(results.every(v=>v.persisted || v.reason==='store_busy')).toBe(true);});
test('full store preserves history and rejects admission',async()=>{const{root,base}=await setup();const r=await make(root);await persistReceipt(r,base);const dir=path.join(base,r.repositoryDigest);await Promise.all(Array.from({length:199},async()=>{const id=crypto.randomUUID();await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify({...r,id}),{mode:0o600});}));expect((await persistReceipt({...r,id:crypto.randomUUID()},base)).reason).toBe('store_full');expect((await fs.readdir(dir)).length).toBe(200);});
test('extra raw execution fields, missing counts and low-score guidance rejected honestly',async()=>{const{root,base}=await setup();const r=await make(root);for(const execution of [{...r.execution,rawLog:'CANARY'},{...r.execution,signal:'private-canary'},{...r.execution,counts:{tests:1}}])expect((await persistReceipt({...r,execution},base)).persisted).toBe(false);const guidance=staticReceiptGuidance(r.execution,'fresh',{status:'scored',answers:{coverage_alignment:{choice:'aligned',confidence:0.1,probabilities:{aligned:0.95}}}});expect(guidance.warnings).toContain('adequacy_unknown');expect(guidance.recommendedNextActions.length).toBe(1);});
function uiReceipt(r:Awaited<ReturnType<typeof make>>){return {...r,plugin:'ui-regression' as const,execution:{status:'passed',reason:'observed_success',exitCode:0,signal:null,runnerVersion:null,counts:null,assertions:[{step:1,id:'step-1',kind:'visible',status:'passed'}],steps:[{step:0,action:'goto',status:'passed'},{step:1,action:'assert',status:'passed'}],cleanup:'confirmed',currentUiState:'not_reobserved',browserBuildBinding:'unverified',scenarioDigest:r.specDigest}};}
async function rejectStoredVariants(root:string,base:string,r:Awaited<ReturnType<typeof make>>,variants:any[]){
 expect((await persistReceipt(r,base)).persisted).toBe(true);
 const file=path.join(base,r.repositoryDigest,r.id+'.json');
 for(const corrupt of variants){
  expect(await persistReceipt(corrupt,base)).toEqual({persisted:false,reason:'invalid_metadata'});
  await fs.writeFile(file,JSON.stringify(corrupt),{mode:0o600});
  expect(await loadReceipt(root,r.id,base)).toBeNull();
  expect(await persistReceipt({...r,id:crypto.randomUUID()},base)).toEqual({persisted:false,reason:'store_corrupt'});
  await fs.writeFile(file,JSON.stringify(r),{mode:0o600});
 }
 expect(await loadReceipt(root,r.id,base)).toEqual(r);
}
test('fingerprints reject nested raw canaries, missing keys, mismatched status and resource bounds on admission and load',async()=>{
 const{root,base}=await setup();const r=await make(root);const variants:any[]=[];
 for(const side of ['before','after'] as const){
  for(const extra of [{rawSource:'NESTED_RAW_CANARY'},{snapshot:{source:'NESTED_RAW_CANARY'}}])variants.push({...r,[side]:{...r[side],...extra}});
  for(const key of Object.keys(r[side])){const fp:any={...r[side]};delete fp[key];variants.push({...r,[side]:fp});}
  for(const change of [{digest:null},{status:'unavailable'},{files:20001},{bytes:128*1024*1024+1},{files:-1},{bytes:0.5},{status:'unavailable',digest:null,files:1},{status:'unavailable',digest:null,files:0,bytes:1}])variants.push({...r,[side]:{...r[side],...change}});
 }
 await rejectStoredVariants(root,base,r,variants);
 const unavailable={status:'unavailable' as const,digest:null,reason:'source_unavailable',files:0,bytes:0,exclusions:r.before.exclusions};
 const incomplete={...r,id:crypto.randomUUID(),before:unavailable,after:unavailable,freshness:'unavailable' as const,execution:{status:'incomplete',reason:'missing_summary',exitCode:null,signal:null,runnerVersion:null,counts:null}};
 expect((await persistReceipt(incomplete,base)).persisted).toBe(true);expect(await loadReceipt(root,incomplete.id,base)).toEqual(incomplete);
 const atLimits={...r,id:crypto.randomUUID(),before:{...r.before,files:20000,bytes:128*1024*1024}};
 expect((await persistReceipt(atLimits,base)).persisted).toBe(true);
});
test('Node exact fields and passed invariants reject corrupt metadata but preserve nonpass placeholder counts',async()=>{
 const{root,base}=await setup();const r=await make(root);const variants:any[]=[];
 for(const key of Object.keys(r.execution)){const execution={...r.execution};delete execution[key];variants.push({...r,execution});}
 for(const change of [{counts:null},{exitCode:1},{exitCode:null},{signal:'SIGTERM'},{steps:[]}])variants.push({...r,execution:{...r.execution,...change}});
 for(const change of [{tests:0},{topLevel:0},{passed:0},{failed:1},{cancelled:1}])variants.push({...r,execution:{...r.execution,counts:{...(r.execution.counts as object),...change}}});
 await rejectStoredVariants(root,base,r,variants);
 for(const status of ['no_tests','failed','incomplete','not_run','unavailable']){
  const nonpass={...r,id:crypto.randomUUID(),execution:{...r.execution,status,reason:status==='no_tests'?'no_actual_passes':'fixture_nonpass'}};
  expect((await persistReceipt(nonpass,base)).persisted).toBe(true);expect(await loadReceipt(root,nonpass.id,base)).toEqual(nonpass);
 }
});
test('UI exact fields and actual passed observations reject impossible passes while preserving partial failures',async()=>{
 const{root,base}=await setup();const r=uiReceipt(await make(root));const variants:any[]=[];
 for(const key of Object.keys(r.execution)){const execution:any={...r.execution};delete execution[key];variants.push({...r,execution});}
 for(const change of [{steps:[],assertions:[]},{cleanup:'unconfirmed'},{exitCode:1},{exitCode:null},{signal:'SIGTERM'},{rawLog:'UI_RAW_CANARY'},{steps:[{step:0,action:'goto',status:'failed'},r.execution.steps[1]]},{steps:[r.execution.steps[0],{...r.execution.steps[1],status:'failed'}],assertions:[{...r.execution.assertions[0],status:'failed'}]}])variants.push({...r,execution:{...r.execution,...change}});
 await rejectStoredVariants(root,base,r,variants);
 for(const status of ['failed','incomplete','not_run','unavailable']){
  const partial={...r,id:crypto.randomUUID(),execution:{...r.execution,status,reason:'fixture_partial',exitCode:null,steps:[],assertions:[],cleanup:'unconfirmed'}};
  expect((await persistReceipt(partial,base)).persisted).toBe(true);expect(await loadReceipt(root,partial.id,base)).toEqual(partial);
 }
});
test('status hides corrupt nested evidence and returns unavailable without raw fields',async()=>{
 const{root,base}=await setup();const home=path.join(path.dirname(base),'home');await fs.mkdir(home,{mode:0o700});const oldHome=process.env.HOME;process.env.HOME=home;
 try{
  const store=path.join(home,'.gjc','agent','verification-receipts','receipts','v1');const r=await make(root);expect((await persistReceipt(r,store)).persisted).toBe(true);
  const Type=new Proxy({}, {get:()=> (...args:unknown[])=>({args})});const status=verificationStatus({cwd:root,typebox:{Type}});
  const missingCounts={...r.execution};delete missingCounts.counts;
  const corruptReceipts=[...(['before','after'] as const).map(side=>({...r,[side]:{...r[side],rawSource:'STATUS_RAW_CANARY',snapshot:{source:'STATUS_RAW_CANARY'}}})),{...r,execution:missingCounts},{...r,execution:{...r.execution,exitCode:1}}];
  for(const corrupt of corruptReceipts){
   await fs.writeFile(path.join(store,r.repositoryDigest,r.id+'.json'),JSON.stringify(corrupt),{mode:0o600});
   const result=await status.execute('corrupt',{receiptId:r.id});const text=result.content[0].text;const value=JSON.parse(text);
   expect(value.execution).toEqual({status:'unavailable',reason:'receipt_unavailable'});expect(value.freshness).toBe('unavailable');expect(value.receipt).toBeUndefined();
   expect(text).not.toContain('STATUS_RAW_CANARY');expect(text).not.toContain('rawSource');expect(text).not.toContain('snapshot');
  }
 }finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;}
});
