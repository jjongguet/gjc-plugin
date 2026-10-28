import {test,expect,afterEach,spyOn} from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {actualRepository,repositoryDigest,specFingerprint,fingerprintSource,createReceipt,persistReceipt,loadReceipt,currentReceiptFreshness,freshnessFor,staticReceiptGuidance,receiptStoreBase} from '../lib/receipts';
import {runNodeTests} from '../lib/runner';
import {createHash} from 'node:crypto';
import verificationStatus from '../src/status.adapter';
import {finalizeVerificationOutcome} from '../lib/outcomes';
import {RESULTS_UI_SCENARIO_REASONS} from '../../shared/lib/results';
import {uiScenarioReason} from '../../ui-regression/lib/scenario';
import {readFileSync} from 'node:fs';
const owned:string[]=[];
test('every allowlisted UI rejection has a safe mapping and actionable non-retry guidance',()=>{
 for(const reason of RESULTS_UI_SCENARIO_REASONS){
  expect(uiScenarioReason('UI_'+reason.toUpperCase())).toBe(reason);
  const guidance=staticReceiptGuidance({status:'not_run',reason},'unavailable',{status:'unavailable',reason:'off'},[],{tool:'ui'});
  expect(guidance.warnings).toContain('scenario_rejected');
  expect(guidance.recommendedNextActions[0]).toContain(reason);
  expect(guidance.recommendedNextActions.join(' ')).not.toMatch(/tests|Run verification again/);
 }
 for(const message of ['UI_SCENARIO_UNKNOWN','UI_SCENARIO_URL_HOST PRIVATE_CANARY','PRIVATE_CANARY','ui_scenario_url_host']) expect(uiScenarioReason(message)).toBeUndefined();
 // Closed set in the other direction: every code validateScenario can throw is allowlisted.
 const source=readFileSync(new URL('../../ui-regression/lib/scenario.ts',import.meta.url),'utf8');
 const thrown=new Set([...source.matchAll(/uiScenarioFail\('([A-Z_]+)'\)/g)].map(match=>match[1]));
 for(const match of source.matchAll(/uiScenarioString\([^)]*?, \d+, '([A-Z_]+)'/g)) thrown.add(match[1]);
 expect([...thrown].sort()).toEqual(['ACTION','ASSERT_KIND','EXPECTED','EXPECTED_BEHAVIOR','FIELDS','FIRST_GOTO','ID','MATCH','NO_ASSERTION','OBJECT','ORIGIN','SELECTOR','SELECTOR_UNSAFE','SENSITIVE','STEP','STEPS','URL','URL_HOST','URL_SCHEME','URL_SENSITIVE','URL_UNSAFE','VALUE']);
 for(const code of thrown) expect(uiScenarioReason('UI_SCENARIO_'+code)).toBe('scenario_'+code.toLowerCase());
 const rejected=staticReceiptGuidance({status:'passed',reason:'complete'},'fresh',{status:'invalid_input',reason:'invalid_case_id'},[],{tool:'ui',allowedCaseIds:['step-1','PRIVATE_CANARY','step-2']});
 expect(rejected.recommendedNextActions[0]).toContain('step-1, step-2');
 expect(JSON.stringify(rejected)).not.toContain('PRIVATE_CANARY');
});
afterEach(async()=>{for(const p of owned.splice(0)) await fs.rm(p,{recursive:true,force:true});});
async function setup(){const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'receipt-test-')));owned.push(dir);const root=path.join(dir,'repo');await fs.mkdir(root);const git=(...args:string[])=>execFileSync('git',args,{cwd:root,env:{PATH:process.env.PATH},stdio:'pipe'});git('init','-q');await fs.writeFile(path.join(root,'a.mjs'),'export const value=1;');git('add','a.mjs');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');const base=path.join(dir,'store');return {root,base,git};}
async function make(root:string){const specDigest=specFingerprint({files:['a.mjs']});const before=await fingerprintSource(root,specDigest);return createReceipt({plugin:'verification-receipts',toolCallId:'fixture',repositoryDigest:await repositoryDigest(root),durationMs:1,specDigest,before,after:before,freshness:'fresh',execution:{status:'passed',reason:'native_success',counts:{tests:1,suites:0,topLevel:1,passed:1,failed:0,skipped:0,todo:0,cancelled:0},exitCode:0,signal:null,runnerVersion:'v24.15.0'},warnings:[],limitations:[]});}
test('actual repo identity and private immutable envelope storage',async()=>{
 const{root,base}=await setup();expect(await actualRepository(root)).toBe(await fs.realpath(root));const r=await make(root);
 const stored=await persistReceipt(r,base);expect(stored.persisted).toBe(true);expect(stored.count).toBe(1);expect(stored.nearCapacity).toBe(false);
 const file=path.join(base,r.repositoryDigest,r.id+'.json');const original=await fs.readFile(file,'utf8');
 expect(stored.bytes).toBe(Buffer.byteLength(original));expect((await fs.stat(file)).mode&0o777).toBe(0o600);expect((await fs.stat(file)).nlink).toBe(1);
 expect((await fs.stat(base)).mode&0o777).toBe(0o700);expect((await fs.stat(path.dirname(file))).mode&0o777).toBe(0o700);
 expect(JSON.parse(original)).toEqual(storageEnvelope(r));expect(await loadReceipt(root,r.id,base)).toEqual(r);
 expect((await persistReceipt(r,base)).persisted).toBe(false);expect(await fs.readFile(file,'utf8')).toBe(original);
 expect(await currentReceiptFreshness(root,r,base)).toBe('fresh');expect(await fs.readdir(path.dirname(file))).toEqual([r.id+'.json']);
});
test('working bytes, deletion, untracked, mode, spec and index stale evidence',async()=>{
 const{root,base,git}=await setup();const r=await make(root);expect((await persistReceipt(r,base)).persisted).toBe(true);
 await fs.writeFile(path.join(root,'a.mjs'),'changed');expect(await currentReceiptFreshness(root,r,base)).toBe('stale');
 git('checkout','--','a.mjs');await fs.chmod(path.join(root,'a.mjs'),0o755);expect(await currentReceiptFreshness(root,r,base)).toBe('stale');
 await fs.chmod(path.join(root,'a.mjs'),0o644);await fs.writeFile(path.join(root,'new.mjs'),'new');expect(await currentReceiptFreshness(root,r,base)).toBe('stale');
 await fs.unlink(path.join(root,'new.mjs'));await fs.unlink(path.join(root,'a.mjs'));expect(await currentReceiptFreshness(root,r,base)).toBe('stale');
 git('checkout','--','a.mjs');expect((await fingerprintSource(root,specFingerprint({files:['other.mjs']}))).digest).not.toBe(r.before.digest);
 await fs.writeFile(path.join(root,'a.mjs'),'index');git('add','a.mjs');await fs.writeFile(path.join(root,'a.mjs'),'export const value=1;');expect(await currentReceiptFreshness(root,r,base)).toBe('stale');
});
test('HEAD change invalidates freshness',async()=>{const{root,base,git}=await setup();const r=await make(root);await persistReceipt(r,base);git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','head');expect(await currentReceiptFreshness(root,r,base)).toBe('stale');});
test('credential and result exclusions explicit; ordinary symlink text never followed',async()=>{
 const{root,base}=await setup();const r=await make(root);await persistReceipt(r,base);
 await fs.writeFile(path.join(root,'.env'),'SECRET_CANARY');await fs.mkdir(path.join(root,'.gjc-plugin'));await fs.writeFile(path.join(root,'.gjc-plugin','result.json'),'RESULT_CANARY');
 expect(await currentReceiptFreshness(root,r,base)).toBe('fresh');await fs.symlink('/nonexistent-external',path.join(root,'linked'));
 const fp=await fingerprintSource(root,r.specDigest);expect(fp.status).toBe('available');expect(fp.digest).not.toBe(r.before.digest);expect(JSON.stringify(fp)).not.toContain('SECRET_CANARY');expect(JSON.stringify(fp)).not.toContain('RESULT_CANARY');
});
test('during-run unavailable and guidance are independent from execution',async()=>{
 const{root,base}=await setup();const r=await make(root);await fs.writeFile(path.join(root,'a.mjs'),'change');r.after=await fingerprintSource(root,r.specDigest);r.freshness=freshnessFor(r.before,r.after);
 expect(r.freshness).toBe('changed_during_run');await persistReceipt(r,base);expect(await currentReceiptFreshness(root,r,base)).toBe('changed_during_run');
 expect(staticReceiptGuidance(r.execution,r.freshness,{status:'unscored'}).recommendedNextActions.length).toBeLessThanOrEqual(3);
});
test('locked store never stolen; corrupt metadata not accepted',async()=>{const{root,base}=await setup();const r=await make(root);await persistReceipt(r,base);const dir=path.join(base,r.repositoryDigest);await fs.writeFile(path.join(dir,'.admission.lock'),'owned',{mode:0o600});expect((await persistReceipt({...r,id:crypto.randomUUID()},base)).reason).toBe('store_busy');expect(await fs.readFile(path.join(dir,'.admission.lock'),'utf8')).toBe('owned');await fs.unlink(path.join(dir,'.admission.lock'));await fs.writeFile(path.join(dir,r.id+'.json'),'{broken');expect(await loadReceipt(root,r.id,base)).toBeNull();expect((await persistReceipt({...r,id:crypto.randomUUID()},base)).persisted).toBe(false);});
test('symlink and permissive store rejected without writes',async()=>{const{root,base}=await setup();const r=await make(root);await fs.mkdir(base,{mode:0o755});expect((await persistReceipt(r,base)).persisted).toBe(false);await fs.rmdir(base);await fs.symlink(root,base);expect((await persistReceipt(r,base)).persisted).toBe(false);expect(await fs.readdir(root)).toEqual(expect.arrayContaining(['a.mjs']));});
test('cross repository and imported extra fields rejected',async()=>{const a=await setup(),b=await setup();const r=await make(a.root);expect((await persistReceipt({...r,rawLogs:'SECRET_CANARY'} as any,a.base)).persisted).toBe(false);await persistReceipt(r,a.base);expect(await loadReceipt(b.root,r.id,a.base)).toBeNull();expect(await loadReceipt(a.root,'../escape',a.base)).toBeNull();});
test('concurrent admissions do not join or overwrite',async()=>{const{root,base}=await setup();const r=await make(root);await persistReceipt(r,base);const results=await Promise.all(Array.from({length:8},()=>persistReceipt({...r,id:crypto.randomUUID()},base)));expect(results.filter(v=>v.persisted).length).toBeGreaterThan(0);expect(results.every(v=>v.persisted || v.reason==='store_busy')).toBe(true);});
test('count capacity warns at 180, admits 200 and preserves history at 201',async()=>{
 const{root,base}=await setup();const r=await make(root);await persistReceipt(r,base);const dir=path.join(base,r.repositoryDigest);
 const original=await fs.readFile(path.join(dir,r.id+'.json'),'utf8');
 const seed=async(count:number)=>Promise.all(Array.from({length:count},async()=>{const id=crypto.randomUUID();await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify(storageEnvelope({...r,id})),{mode:0o600});}));
 await seed(178);const at180=await persistReceipt({...r,id:crypto.randomUUID()},base);expect(at180).toMatchObject({persisted:true,count:180,nearCapacity:true});
 await seed(19);const at200=await persistReceipt({...r,id:crypto.randomUUID()},base);expect(at200).toMatchObject({persisted:true,count:200,nearCapacity:true});
 const rejected={...r,id:crypto.randomUUID()},full=await persistReceipt(rejected,base);
 expect(full).toMatchObject({persisted:false,reason:'store_full',count:200,bytes:at200.bytes,nearCapacity:true});
 const home=process.env.HOME;process.env.HOME=path.dirname(base);
 try {
  const result=await finalizeVerificationOutcome('verification-receipts','run',{receipt:rejected,...full,assessment:{status:'unavailable',reason:'off'}});
  expect(result.receipt.execution.status).toBe('passed');expect(result.receiptStorage.reason).toBe('store_full');expect(result.journalStorage.persisted).toBe(true);
  expect(result.receiptLoadable).toBe(false);expect(result.warnings).toContain('receipt_store_full');expect(await loadReceipt(root,rejected.id,base)).toBeNull();
 }finally{if(home===undefined)delete process.env.HOME;else process.env.HOME=home;}
 expect((await fs.readdir(dir)).length).toBe(200);expect(await fs.readFile(path.join(dir,r.id+'.json'),'utf8')).toBe(original);
},30000);
test('extra raw execution fields, missing counts and low-score guidance rejected honestly',async()=>{const{root,base}=await setup();const r=await make(root);for(const execution of [{...r.execution,rawLog:'CANARY'},{...r.execution,signal:'private-canary'},{...r.execution,counts:{tests:1}}])expect((await persistReceipt({...r,execution},base)).persisted).toBe(false);const guidance=staticReceiptGuidance(r.execution,'fresh',{status:'scored',answers:{coverage_alignment:{choice:'aligned',confidence:0.1,probabilities:{aligned:0.95}}}});expect(guidance.warnings).toContain('adequacy_unknown');expect(guidance.recommendedNextActions.length).toBe(1);});
function uiReceipt(r:Awaited<ReturnType<typeof make>>){return {...r,plugin:'ui-regression' as const,execution:{status:'passed',reason:'observed_success',exitCode:0,signal:null,runnerVersion:null,counts:null,assertions:[{step:1,id:'step-1',kind:'visible',status:'passed'}],steps:[{step:0,action:'goto',status:'passed'},{step:1,action:'assert',status:'passed'}],cleanup:'confirmed',currentUiState:'not_reobserved',browserBuildBinding:'unverified',scenarioDigest:r.specDigest}};}
function storageEnvelope(r:Awaited<ReturnType<typeof make>>,files:string[]=[]){
 const normalized=files.map(file=>path.posix.normalize(file)).sort();
 return {storageSchemaVersion:1,receipt:r,selectedInputs:{receiptId:r.id,repositoryDigest:r.repositoryDigest,specDigest:r.specDigest,files:normalized,digest:createHash('sha256').update(JSON.stringify([r.id,r.repositoryDigest,r.specDigest,normalized])).digest('hex')}};
}
async function rejectStoredVariants(root:string,base:string,r:Awaited<ReturnType<typeof make>>,variants:any[]){
 expect((await persistReceipt(r,base)).persisted).toBe(true);
 const file=path.join(base,r.repositoryDigest,r.id+'.json');
 for(const corrupt of variants){
  expect(await persistReceipt(corrupt,base)).toMatchObject({persisted:false,reason:'invalid_metadata'});
  await fs.writeFile(file,JSON.stringify(storageEnvelope(corrupt)),{mode:0o600});
  expect(await loadReceipt(root,r.id,base)).toBeNull();
  expect(await persistReceipt({...r,id:crypto.randomUUID()},base)).toMatchObject({persisted:false,reason:'store_corrupt'});
  await fs.writeFile(file,JSON.stringify(storageEnvelope(r)),{mode:0o600});
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
  const store=path.join(home,'.gjc-plugin','verification-receipts','receipts','v1');const r=await make(root);expect((await persistReceipt(r,store)).persisted).toBe(true);
  const Type=new Proxy({}, {get:()=> (...args:unknown[])=>({args})});const status=verificationStatus({cwd:root,typebox:{Type}});
  const missingCounts={...r.execution};delete missingCounts.counts;
  const corruptReceipts=[...(['before','after'] as const).map(side=>({...r,[side]:{...r[side],rawSource:'STATUS_RAW_CANARY',snapshot:{source:'STATUS_RAW_CANARY'}}})),{...r,execution:missingCounts},{...r,execution:{...r.execution,exitCode:1}}];
  for(const corrupt of corruptReceipts){
   await fs.writeFile(path.join(store,r.repositoryDigest,r.id+'.json'),JSON.stringify(storageEnvelope(corrupt)),{mode:0o600});
   const result=await status.execute('corrupt',{receiptId:r.id});const text=result.content[0].text;const value=JSON.parse(text);
   expect(value.execution).toEqual({status:'unavailable',reason:'receipt_unavailable'});expect(value.freshness).toBe('unavailable');expect(value.receipt).toBeUndefined();
   expect(text).not.toContain('STATUS_RAW_CANARY');expect(text).not.toContain('rawSource');expect(text).not.toContain('snapshot');
  }
 }finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;}
});

test('explicit ignored test actually passes, becomes stale on ignored-only mutation and then fails',async()=>{
 const{root,base,git}=await setup();const files=['ignored-inputs/receipt-canary.mjs'];
 await fs.writeFile(path.join(root,'.gitignore'),'ignored-inputs/\n');await fs.mkdir(path.join(root,'ignored-inputs'));
 const file=path.join(root,files[0]);const source=(value:number)=>`import test from 'node:test';import assert from 'node:assert/strict';test('bounded input',()=>assert.equal(${value},1));`;
 await fs.writeFile(file,source(1));git('check-ignore','--',files[0]);
 const specDigest=specFingerprint({files}),before=await fingerprintSource(root,specDigest,files),ordinary=await fingerprintSource(root,specDigest);
 expect(before.status).toBe('available');expect(before.digest).not.toBe(ordinary.digest);
 const execution=await runNodeTests(root,files,10000);expect(execution.status).toBe('passed');expect(execution.counts?.tests).toBe(1);expect(execution.counts?.passed).toBe(1);
 const after=await fingerprintSource(root,specDigest,files);
 const r=createReceipt({plugin:'verification-receipts',toolCallId:'ignored-fixture',repositoryDigest:await repositoryDigest(root),durationMs:1,specDigest,before,after,freshness:freshnessFor(before,after),execution,warnings:[],limitations:[]});
 const stored=await persistReceipt(r,base,files);expect(stored.persisted).toBe(true);expect(await currentReceiptFreshness(root,r,base)).toBe('fresh');
 const original=await fs.readFile(path.join(base,r.repositoryDigest,r.id+'.json'),'utf8');
 await fs.writeFile(file,source(2));expect((await fingerprintSource(root,specDigest)).digest).toBe(ordinary.digest);
 expect(await currentReceiptFreshness(root,r,base)).toBe('stale');const loaded=await loadReceipt(root,r.id,base);expect(loaded?.execution.status).toBe('passed');
 const failed=await runNodeTests(root,files,10000);expect(failed.status).toBe('failed');expect(failed.counts?.failed).toBe(1);
 expect(await fs.readFile(path.join(base,r.repositoryDigest,r.id+'.json'),'utf8')).toBe(original);
 const publicText=JSON.stringify({loaded,stored,before,after,failed});
 for(const technical of [root,base,files[0],'selectedInputs','storageSchemaVersion','bounded input'])expect(publicText).not.toContain(technical);
},30000);

test('selected inputs normalize once and ignored-only changes during a run remain changed_during_run',async()=>{
 const{root,base}=await setup();await fs.writeFile(path.join(root,'.gitignore'),'ignored/\n');await fs.mkdir(path.join(root,'ignored'));
 const files=['./ignored//b.cjs','./a.mjs'];await fs.writeFile(path.join(root,'ignored','b.cjs'),'module.exports=1;');
 const specDigest=specFingerprint({files}),before=await fingerprintSource(root,specDigest,files);
 expect(before.status).toBe('available');expect((await fingerprintSource(root,specDigest,['a.mjs','ignored/b.cjs'])).digest).toBe(before.digest);
 await fs.writeFile(path.join(root,'ignored','b.cjs'),'module.exports=2;');const after=await fingerprintSource(root,specDigest,files);
 const r={...await make(root),specDigest,before,after,freshness:freshnessFor(before,after)};
 expect(r.freshness).toBe('changed_during_run');expect((await persistReceipt(r,base,files)).persisted).toBe(true);
 const envelope=JSON.parse(await fs.readFile(path.join(base,r.repositoryDigest,r.id+'.json'),'utf8'));
 expect(envelope.selectedInputs.files).toEqual(['a.mjs','ignored/b.cjs']);expect(await currentReceiptFreshness(root,r,base)).toBe('changed_during_run');
 await fs.unlink(path.join(root,'ignored','b.cjs'));expect(await currentReceiptFreshness(root,r,base)).toBe('unavailable');
 await fs.symlink('../a.mjs',path.join(root,'ignored','b.cjs'));expect(await currentReceiptFreshness(root,r,base)).toBe('unavailable');
});

test('unsafe, sensitive, excluded, duplicate and oversized selections never silently fall back',async()=>{
 const{root,base}=await setup();const r=await make(root);
 const invalid=[['../outside.mjs'],[path.join(root,'a.mjs')],['C:\\outside.mjs'],['a.mjs','./a.mjs'],['a.mjs','a.mjs'],['a.ts'],['--a.mjs'],['a\0.mjs'],['.envfoo.mjs'],['secret.mjs'],['.gjc-plugin/result.mjs'],['.git/a.mjs'],['node_modules/test.mjs'],['dist/test.mjs'],['coverage/test.mjs'],['.next/test.mjs'],['.gjc/test.mjs'],['private/test.js'],['cookies.cjs'],['credentials.js'],['x'.repeat(4097)+'.mjs'],Array.from({length:33},(_,i)=>`${i}.mjs`)];
 for(const files of invalid){
  expect((await fingerprintSource(root,r.specDigest,files)).status).toBe('unavailable');
  expect(await persistReceipt(r,base,files)).toMatchObject({persisted:false,reason:'invalid_metadata'});
 }
 expect((await fingerprintSource(root,r.specDigest,['missing.mjs'])).status).toBe('unavailable');
 await fs.mkdir(path.join(root,'directory.mjs'));expect((await fingerprintSource(root,r.specDigest,['directory.mjs'])).status).toBe('unavailable');
 await fs.symlink('a.mjs',path.join(root,'linked.mjs'));expect((await fingerprintSource(root,r.specDigest,['linked.mjs'])).status).toBe('unavailable');
 await fs.mkdir(path.join(root,'nested'));await fs.writeFile(path.join(root,'nested','test.js'),'');
 await fs.symlink('nested',path.join(root,'linked-parent'));expect((await fingerprintSource(root,r.specDigest,['linked-parent/test.js'])).status).toBe('unavailable');
 const alias=path.join(path.dirname(root),'repo-link');await fs.symlink(root,alias);expect((await fingerprintSource(alias,r.specDigest,['a.mjs'])).status).toBe('unavailable');
});

test('missing, tampered, misbound, noncanonical and bare legacy manifests are unavailable',async()=>{
 const{root,base}=await setup();const r=await make(root);expect(await currentReceiptFreshness(root,r,base)).toBe('unavailable');
 expect((await persistReceipt(r,base,['a.mjs'])).persisted).toBe(true);
 const file=path.join(base,r.repositoryDigest,r.id+'.json'),valid=storageEnvelope(r,['a.mjs']);
 const changedReceipt={...r,id:crypto.randomUUID()},changedSpec={...r,specDigest:specFingerprint({other:true})};
 const variants:any[]=[
  r,{storageSchemaVersion:1,receipt:r},{...valid,storageSchemaVersion:2},{...valid,rawLogs:'ENVELOPE_RAW_CANARY'},
  {...valid,selectedInputs:{...valid.selectedInputs,rawSource:'MANIFEST_RAW_CANARY'}},
  {...valid,selectedInputs:{...valid.selectedInputs,files:[]}},
  {...valid,selectedInputs:{...valid.selectedInputs,digest:'0'.repeat(64)}},
  {...valid,selectedInputs:storageEnvelope(changedReceipt,['a.mjs']).selectedInputs},
  {...valid,selectedInputs:storageEnvelope({...r,repositoryDigest:'1'.repeat(64)},['a.mjs']).selectedInputs},
  {...valid,selectedInputs:storageEnvelope(changedSpec,['a.mjs']).selectedInputs},
  {...valid,selectedInputs:{...valid.selectedInputs,files:['./a.mjs']}},
  storageEnvelope(r,['../outside.mjs']),storageEnvelope(r,['.gjc-plugin/a.mjs']),storageEnvelope(r,Array.from({length:33},(_,i)=>`${i}.mjs`))
 ];
 for(const key of Object.keys(valid.selectedInputs)){const selectedInputs:any={...valid.selectedInputs};delete selectedInputs[key];variants.push({...valid,selectedInputs});}
 for(const variant of variants){
  await fs.writeFile(file,JSON.stringify(variant),{mode:0o600});
  expect(await loadReceipt(root,r.id,base)).toBeNull();expect(await currentReceiptFreshness(root,r,base)).toBe('unavailable');
  expect(await persistReceipt({...r,id:crypto.randomUUID()},base)).toMatchObject({persisted:false,reason:'store_corrupt'});
 }
 await fs.writeFile(file,JSON.stringify(valid),{mode:0o600});expect(await currentReceiptFreshness(root,r,base)).toBe('fresh');
 expect(await currentReceiptFreshness(root,changedSpec,base)).toBe('unavailable');
 await fs.unlink(path.join(root,'a.mjs'));expect(await currentReceiptFreshness(root,r,base)).toBe('unavailable');
 await fs.unlink(file);expect(await currentReceiptFreshness(root,r,base)).toBe('unavailable');
});

test('entire envelope counts toward the 32KiB record bound',async()=>{
 const{root,base}=await setup();const r=await make(root);
 const files=Array.from({length:32},(_,i)=>`${i}-${'x'.repeat(1100)}.mjs`);
 expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(32768);expect(Buffer.byteLength(JSON.stringify(storageEnvelope(r,files)))).toBeGreaterThan(32768);
 expect(await persistReceipt(r,base,files)).toMatchObject({persisted:false,reason:'store_full',count:0,bytes:0,nearCapacity:false});
 expect(await fs.readdir(path.join(base,r.repositoryDigest))).toEqual([]);
});

test('byte capacity includes manifests, warns at ninety percent and never deletes history',async()=>{
 const{root,base}=await setup();const r=await make(root);await persistReceipt(r,base);
 const dir=path.join(base,r.repositoryDigest),files=Array.from({length:32},(_,i)=>`${i}-${'x'.repeat(600)}.mjs`);
 const size=Buffer.byteLength(JSON.stringify(storageEnvelope(r,files))),limit=2*1024*1024;
 expect(size).toBeLessThan(32768);
 let bytes=(await fs.stat(path.join(dir,r.id+'.json'))).size,count=1;
 while(bytes<limit*0.9){
  const id=crypto.randomUUID(),body=JSON.stringify(storageEnvelope({...r,id},files));await fs.writeFile(path.join(dir,id+'.json'),body,{mode:0o600});bytes+=Buffer.byteLength(body);count++;
 }
 const warning=await persistReceipt({...r,id:crypto.randomUUID()},base,files);
 expect(warning).toMatchObject({persisted:true,nearCapacity:true,count:count+1,bytes:bytes+size});bytes+=size;count++;
 while(bytes+size<=limit){
  const id=crypto.randomUUID(),body=JSON.stringify(storageEnvelope({...r,id},files));await fs.writeFile(path.join(dir,id+'.json'),body,{mode:0o600});bytes+=Buffer.byteLength(body);count++;
 }
 expect(count).toBeLessThan(180);expect(bytes).toBeLessThanOrEqual(limit);
 expect(await persistReceipt({...r,id:crypto.randomUUID()},base,files)).toMatchObject({persisted:false,reason:'store_full',count,bytes,nearCapacity:true});
 expect((await fs.readdir(dir)).length).toBe(count);expect(await loadReceipt(root,r.id,base)).toEqual(r);
},30000);

test('source byte and enumeration bounds include explicitly selected ignored files',async()=>{
 const{root,git}=await setup();const spec=specFingerprint({files:['large.mjs']});
 await fs.writeFile(path.join(root,'.gitignore'),'large.mjs\n');await fs.writeFile(path.join(root,'large.mjs'),'');
 await fs.truncate(path.join(root,'large.mjs'),128*1024*1024+1);
 expect((await fingerprintSource(root,spec)).status).toBe('available');
 expect(await fingerprintSource(root,spec,['large.mjs'])).toMatchObject({status:'unavailable',reason:'byte_limit',digest:null});
 const blob=git('rev-parse','HEAD:a.mjs').toString().trim();
 execFileSync('git',['update-index','--index-info'],{cwd:root,env:{PATH:process.env.PATH},stdio:'pipe',input:Array.from({length:20001},(_,i)=>`100644 ${blob}\tentry-${i}.js\n`).join('')});
 expect(await fingerprintSource(root,spec)).toMatchObject({status:'unavailable',reason:'file_limit',digest:null});
},30000);

test('hardlinks, permissive receipt files and symlink ancestors fail closed without external writes',async()=>{
 const{root,base}=await setup();const r=await make(root);expect((await persistReceipt(r,base)).persisted).toBe(true);
 const file=path.join(base,r.repositoryDigest,r.id+'.json'),original=await fs.readFile(file,'utf8'),alias=path.join(path.dirname(base),'receipt-alias.json');
 await fs.link(file,alias);expect(await loadReceipt(root,r.id,base)).toBeNull();expect((await persistReceipt({...r,id:crypto.randomUUID()},base)).reason).toBe('store_corrupt');await fs.unlink(alias);
 await fs.chmod(file,0o644);expect(await loadReceipt(root,r.id,base)).toBeNull();await fs.chmod(file,0o600);
 await fs.rename(file,alias);await fs.symlink(alias,file);expect(await loadReceipt(root,r.id,base)).toBeNull();expect((await persistReceipt({...r,id:crypto.randomUUID()},base)).reason).toBe('store_corrupt');
 expect(await fs.readFile(alias,'utf8')).toBe(original);
 const link=path.join(path.dirname(base),'ancestor-link');await fs.symlink(base,link);
 expect((await persistReceipt({...r,id:crypto.randomUUID()},path.join(link,'new-store'))).persisted).toBe(false);
 expect(await fs.readdir(base)).toEqual([r.repositoryDigest]);
});

test('default root never loads or migrates legacy receipts and refuses unsafe new-root ancestors',async()=>{
 const{root,base}=await setup();const home=path.join(path.dirname(base),'isolated-home');await fs.mkdir(home,{mode:0o700});
 const oldHome=process.env.HOME;process.env.HOME=home;
 try{
  const r=await make(root),legacy=path.join(home,'.gjc','agent','verification-receipts','receipts','v1',r.repositoryDigest);
  await fs.mkdir(legacy,{recursive:true,mode:0o700});const legacyFile=path.join(legacy,r.id+'.json');await fs.writeFile(legacyFile,JSON.stringify(r),{mode:0o600});
  const expected=path.join(home,'.gjc-plugin','verification-receipts','receipts','v1');expect(receiptStoreBase()).toBe(expected);
  expect(await loadReceipt(root,r.id)).toBeNull();expect(await currentReceiptFreshness(root,r)).toBe('unavailable');
  await fs.mkdir(path.join(home,'.gjc-plugin'),{mode:0o755});expect((await persistReceipt(r)).persisted).toBe(false);
  expect((await fs.stat(path.join(home,'.gjc-plugin'))).mode&0o777).toBe(0o755);await fs.rmdir(path.join(home,'.gjc-plugin'));
  expect((await persistReceipt(r)).persisted).toBe(true);expect(await currentReceiptFreshness(root,r)).toBe('fresh');
  expect(await fs.readFile(legacyFile,'utf8')).toBe(JSON.stringify(r));expect(await fs.readdir(legacy)).toEqual([r.id+'.json']);
 }finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;}
});

test('metadata getters, custom serializers and hidden raw fields are not invoked or stored',async()=>{
 const{root,base}=await setup();const r=await make(root);let invoked=0;
 const getter={...r};Object.defineProperty(getter,'specDigest',{get(){invoked++;return r.specDigest;},enumerable:true});
 const serializer={...r,toJSON(){invoked++;return r;}};
 const hidden={...r};Object.defineProperty(hidden,'rawLog',{value:'HIDDEN_RAW_CANARY'});
 const nested={...r,before:{...r.before}};Object.defineProperty(nested.before,'digest',{get(){invoked++;return r.before.digest;},enumerable:true});
 for(const bad of [getter,serializer,hidden,nested])expect(await persistReceipt(bad,base)).toMatchObject({persisted:false,reason:'invalid_metadata'});
 expect(invoked).toBe(0);
});

test('source replacement between lstat and descriptor inspection is unavailable',async()=>{
 const{root}=await setup();const file=path.join(root,'a.mjs'),spec=specFingerprint({files:['a.mjs']}),originalOpen=fs.open;
 let changed=false;
 const intercepted=spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
  const handle=await originalOpen(...args);
  if(args[0]===file && !changed){changed=true;await fs.appendFile(file,'\n// changed during observation');}
  return handle;
 });
 try{
  expect(await fingerprintSource(root,spec,['a.mjs'])).toMatchObject({status:'unavailable',reason:'changed_while_hashing',digest:null});
  expect(changed).toBe(true);
 }finally{intercepted.mockRestore();}
});

test('staged write or fsync failures do not publish partial receipts or delete prior history',async()=>{
 const{root,base}=await setup();const r=await make(root);expect((await persistReceipt(r,base)).persisted).toBe(true);
 const dir=path.join(base,r.repositoryDigest),file=path.join(dir,r.id+'.json'),original=await fs.readFile(file,'utf8');
 for(const stage of ['writeFile','sync'] as const){
  const originalOpen=fs.open;
  const intercepted=spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
   const handle=await originalOpen(...args);
   if(typeof args[0]==='string' && args[0].startsWith(dir+path.sep) && args[0].endsWith('.tmp')){
    if(stage==='writeFile')spyOn(handle,'writeFile').mockImplementation(async()=>{throw new Error('fixture_write_failure');});
    else spyOn(handle,'sync').mockImplementation(async()=>{throw new Error('fixture_sync_failure');});
   }
   return handle;
  });
  try{expect(await persistReceipt({...r,id:crypto.randomUUID()},base)).toMatchObject({persisted:false,reason:'store_unavailable'});}
  finally{intercepted.mockRestore();}
  expect(await fs.readdir(dir)).toEqual([r.id+'.json']);expect(await fs.readFile(file,'utf8')).toBe(original);
 }
});
