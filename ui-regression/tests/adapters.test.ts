import {test,expect,beforeEach,afterEach} from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import uiRun from '../src/run.adapter';
import uiStatus from '../src/status.adapter';
import {createReceipt,persistReceipt,fingerprintSource,specFingerprint,repositoryDigest} from '../../verification-receipts/lib/receipts';
import {readPluginOutcomeSnapshot} from '../../shared/lib/results';
const Type=new Proxy({}, {get:()=> (...args:unknown[])=>({args})});
const parse=(r:any)=>JSON.parse(r.content[0].text);
let originalFetch:typeof fetch,originalProvider:string|undefined,originalKey:string|undefined;
let originalHome:string|undefined,adapterHome:string;
let calls:any[];
beforeEach(async()=>{
 originalHome=process.env.HOME;adapterHome=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ui-adapter-home-')));process.env.HOME=adapterHome;
 originalFetch=globalThis.fetch;originalProvider=process.env.JEV_ADVISOR_PROVIDER;originalKey=process.env.JEV_ADVISOR_API_KEY;calls=[];
 globalThis.fetch=(async(url,options)=>{expect(String(url)).toBe('https://openrouter.ai/api/alpha/decisions');calls.push(JSON.parse(String(options?.body)));return new Response(JSON.stringify({answers:{coverage_alignment:{type:'choice',choice:'aligned'},boundary_evidence:{type:'choice',choice:'present'}}}));}) as typeof fetch;
 process.env.JEV_ADVISOR_PROVIDER='jev';process.env.JEV_ADVISOR_API_KEY='synthetic-ui-adapter-key';
});
afterEach(async()=>{
 globalThis.fetch=originalFetch;
 if(originalProvider===undefined)delete process.env.JEV_ADVISOR_PROVIDER;else process.env.JEV_ADVISOR_PROVIDER=originalProvider;
 if(originalKey===undefined)delete process.env.JEV_ADVISOR_API_KEY;else process.env.JEV_ADVISOR_API_KEY=originalKey;
 if(originalHome===undefined)delete process.env.HOME;else process.env.HOME=originalHome;
 await fs.rm(adapterHome,{recursive:true,force:true});
});
test('closed run adapter rejects passed imports missing account and no assertion',async()=>{
 const tool=uiRun({cwd:process.cwd(),typebox:{Type}});
 for(const input of [{passed:true},{account:'route',scenario:{id:'none',expectedBehavior:'Ready',steps:[{action:'goto',url:'http://localhost:4311/'}]}},{account:'route',scenario:{id:'case',expectedBehavior:'Ready',steps:[]}},{}]){
  const result=parse(await tool.execute('fixture',input as any));expect(result.execution.status).toBe('not_run');expect(result.advisoryOnly).toBe(true);expect(result.recommendedNextActions.length).toBeGreaterThan(0);expect(result.assessment.reason).toBe('insufficient_evidence');
  expect(result.journalStorage.persisted).toBe(true);
 }
 expect(calls.length).toBe(0);
});
test('empty substring input is rejected without invoking the browser and is journaled',async()=>{
 const result=parse(await uiRun({cwd:process.cwd(),typebox:{Type}}).execute('empty-substring',{account:'route',scenario:{id:'empty',expectedBehavior:'Required text is present',steps:[{action:'goto',url:'http://127.0.0.1:4311/'},{action:'assert',selector:'#result',kind:'text',match:'substring',expected:'   '}]}}));
 expect(result.execution.status).toBe('not_run');expect(result.journalStorage.persisted).toBe(true);
 await expect(fs.stat(path.join(adapterHome,'.gjc-plugin','ui-regression','locks'))).rejects.toThrow();
});
test('UI status metadata fixture remains historical and source scoped',async()=>{
 const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ui-adapter-')));const root=path.join(owned,'repo'),home=path.join(owned,'home');await fs.mkdir(root);await fs.mkdir(home,{mode:0o700});const old=process.env.HOME;process.env.HOME=home;
 try{
  execFileSync('git',['init','-q'],{cwd:root});await fs.writeFile(path.join(root,'fixture.js'),'fixture');execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:root});
  const specDigest=specFingerprint({fixture:'metadata-only'}),fp=await fingerprintSource(root,specDigest);
  const receipt=createReceipt({plugin:'ui-regression',toolCallId:'metadata-fixture',repositoryDigest:await repositoryDigest(root),durationMs:1,specDigest,before:fp,after:fp,freshness:'fresh',execution:{status:'passed',reason:'complete',exitCode:0,signal:null,runnerVersion:null,counts:null,assertions:[{step:1,id:'step-1',kind:'text_exact',status:'passed'}],steps:[{step:0,action:'goto',status:'passed'},{step:1,action:'assert',status:'passed'}],cleanup:'confirmed',currentUiState:'not_reobserved',browserBuildBinding:'unverified',scenarioDigest:specDigest},warnings:[],limitations:['Test fixture metadata, not live browser evidence.']});
  expect((await persistReceipt(receipt)).persisted).toBe(true);const tool=uiStatus({cwd:root,typebox:{Type}});
  const fresh=parse(await tool.execute('status',{receiptId:receipt.id}));expect(fresh.freshness).toBe('fresh');expect(fresh.currentUiState).toBe('not_reobserved');expect(fresh.browserBuildBinding).toBe('unverified');expect(fresh.assessment.reason).toBe('missing_context');expect(calls.length).toBe(0);
  await fs.writeFile(path.join(root,'fixture.js'),'changed');const stale=parse(await tool.execute('stale',{receiptId:receipt.id}));expect(stale.freshness).toBe('stale');expect(stale.receipt.execution.status).toBe('passed');expect(stale.warnings).toContain('source_not_fresh');
  const missing=parse(await tool.execute('missing',{receiptId:'../escape'}));expect(missing.execution.status).toBe('unavailable');
  expect(calls.length).toBe(0);expect(stale.assessment.reason).toBe('insufficient_evidence');
 }finally{if(old===undefined)delete process.env.HOME;else process.env.HOME=old;await fs.rm(owned,{recursive:true,force:true});}
});
test('non-Git session cwd records and reads ui receipts through repository',async()=>{
 const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ui-repository-'))),workspace=path.join(owned,'workspace'),repo=path.join(workspace,'lanes','repo'),outside=path.join(owned,'outside'),home=path.join(owned,'home'),bin=path.join(owned,'bin');
 await fs.mkdir(path.join(workspace,'lanes'),{recursive:true});await fs.mkdir(repo);await fs.mkdir(outside);await fs.mkdir(home,{mode:0o700});await fs.mkdir(bin);
 await fs.writeFile(path.join(bin,'aside'),'#!/bin/sh\nexit 1\n',{mode:0o755});
 const oldHome=process.env.HOME,oldPath=process.env.PATH,oldProvider=process.env.JEV_ADVISOR_PROVIDER;
 process.env.HOME=home;process.env.PATH=`${bin}${path.delimiter}${oldPath??''}`;process.env.JEV_ADVISOR_PROVIDER='off';
 const scenario={id:'repository',expectedBehavior:'Fixture page renders',steps:[{action:'goto',url:'http://127.0.0.1:4311/'},{action:'assert',selector:'#result',kind:'visible'}]};
 try{
  execFileSync('git',['init','-q'],{cwd:repo});await fs.writeFile(path.join(repo,'fixture.js'),'fixture');execFileSync('git',['add','.'],{cwd:repo});execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:repo});
  await fs.mkdir(path.join(repo,'nested'));await fs.writeFile(path.join(outside,'case.js'),'outside');execFileSync('git',['init','-q'],{cwd:outside});
  const run=uiRun({cwd:workspace,typebox:{Type}}),lookup=uiStatus({cwd:workspace,typebox:{Type}});
  const implicit=parse(await run.execute('non-git',{account:'route',scenario}));
  expect(implicit.execution).toEqual({status:'not_run',reason:'not_a_repository'});expect(implicit.journalStorage.persisted).toBe(true);
  const relative=parse(await run.execute('relative',{account:'route',scenario,repository:'lanes/repo'}));
  expect(relative.receipt.repositoryDigest).toBe(await repositoryDigest(repo));expect(relative.journalStorage.persisted).toBe(true);
  expect(relative.receipt.execution.status).toBe('incomplete');expect(relative.persisted).toBe(true);
  const absolute=parse(await run.execute('absolute',{account:'route',scenario,repository:repo}));expect(absolute.receipt.repositoryDigest).toBe(relative.receipt.repositoryDigest);
  const fresh=parse(await lookup.execute('lookup',{receiptId:relative.receipt.id,repository:'lanes/repo'}));expect(fresh.receipt.id).toBe(relative.receipt.id);expect(fresh.freshness).toBe('fresh');expect(fresh.currentUiState).toBe('not_reobserved');
  const unscoped=parse(await lookup.execute('unscoped',{receiptId:relative.receipt.id}));expect(unscoped.execution).toEqual({status:'unavailable',reason:'not_a_repository'});expect(unscoped.warnings[0]).toBe('not_a_repository');expect(unscoped.journalStorage.persisted).toBe(true);
  for(const [repository,reason] of [['lanes/repo/nested','invalid_repository'],['lanes/missing','invalid_repository'],['lanes','not_a_repository'],[outside,'repository_outside_session_cwd'],['../outside','repository_outside_session_cwd']] as const){
   const rejected=parse(await run.execute('rejected',{account:'route',scenario,repository}));
   expect(rejected.execution).toEqual({status:'not_run',reason});expect(rejected.journalStorage.persisted).toBe(true);expect(JSON.stringify(rejected)).not.toContain(owned);
   const unreadable=parse(await lookup.execute('rejected-lookup',{receiptId:relative.receipt.id,repository}));expect(unreadable.execution).toEqual({status:'unavailable',reason});expect(unreadable.warnings[0]).toBe(reason);
  }
 }finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;if(oldProvider===undefined)delete process.env.JEV_ADVISOR_PROVIDER;else process.env.JEV_ADVISOR_PROVIDER=oldProvider;await fs.rm(owned,{recursive:true,force:true});}
},60000);

test('standalone generated UI tools load with only declared installed files',async()=>{
 const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ui-standalone-')));
 try{for(const [file,name] of [['ui-regression-run.ts','ui_regression_run'],['ui-regression-status.ts','ui_regression_status']]){await fs.copyFile(path.resolve(import.meta.dir,'../tools',file),path.join(owned,file));const module=await import(path.join(owned,file));expect(module.default({cwd:process.cwd(),typebox:{Type}}).name).toBe(name);}}
 finally{await fs.rm(owned,{recursive:true,force:true});}
});

test('safe rejection reasons precede launch and observed membership agrees with status',async()=>{
 const repo=path.join(adapterHome,'repo'),bin=path.join(adapterHome,'bin'),launches=path.join(adapterHome,'launches'),outside=path.join(adapterHome,'outside');
 await fs.mkdir(repo);await fs.mkdir(bin);await fs.mkdir(outside);
 execFileSync('git',['init','-q'],{cwd:outside});
 execFileSync('git',['init','-q'],{cwd:repo});
 await fs.writeFile(path.join(repo,'fixture.js'),'export const ready = true;\n');
 execFileSync('git',['add','.'],{cwd:repo});
 execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:repo});
 // Fixed local protocol fixture: no network, browser or production client.
 await fs.writeFile(path.join(bin,'aside'),`#!/usr/bin/env node
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(launches)},'launch\\n');
const code=process.argv.slice(2)[5];
const nonce=JSON.parse(code.match(/const nonce = ("[^"]+");/)[1]);
const emit=frame=>console.log('UI_ASIDE_FRAME '+JSON.stringify({version:1,nonce,...frame}));
emit({type:'step',step:0,status:'passed',assertion:false});
emit({type:'step',step:1,status:'failed',assertion:true});
emit({type:'terminal',completed:1,reason:'assertion_failed'});
emit({type:'cleanup',status:'confirmed'});
`,{mode:0o755});
 const oldPath=process.env.PATH;process.env.PATH=`${bin}${path.delimiter}${oldPath??''}`;
 const scenario={id:'safe-fixture',expectedBehavior:'A local label is visible',steps:[{action:'goto',url:'http://127.0.0.1:4311/'},{action:'assert',selector:'#result',kind:'visible'},{action:'assert',selector:'#later',kind:'visible'}]};
 const assessment={changeSummary:'Change local label behavior',expectedBehavior:'A local label is visible',caseNotes:[{id:'step-2',note:'A later boundary observation'}]};
 const run=uiRun({cwd:repo,typebox:{Type}}),lookup=uiStatus({cwd:repo,typebox:{Type}});
 const count=async()=>{try{return (await fs.readFile(launches,'utf8')).trim().split('\n').length;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e;}};
 try{
  // Positive observer control: an actual child invocation produces a failed observed assertion.
  const observed=parse(await run.execute('observed',{account:'PRIVATE_ROUTE',scenario,assessment}));
  expect(await count()).toBe(1);expect(observed.receipt.execution.reason).toBe('assertion_failed');
  expect(observed.assessment.reason).toBe('invalid_case_id');expect(observed.persisted).toBe(true);
  expect(observed.recommendedNextActions[0]).toContain('step-1');expect(observed.recommendedNextActions[0]).not.toContain('step-2');
  const status=parse(await lookup.execute('lookup',{receiptId:observed.receipt.id,assessment}));
  expect(status.assessment.reason).toBe('invalid_case_id');
  const reached=parse(await lookup.execute('reached',{receiptId:observed.receipt.id,assessment:{...assessment,caseNotes:[{id:'step-1',note:'Reached failed assertion'}]}}));
  expect(reached.assessment.reason).toBe('insufficient_evidence');expect(calls).toHaveLength(0);
  const badScenario=(url:string)=>({...scenario,steps:[{action:'goto',url},scenario.steps[1]]});
  for(const [input,reason] of [
   [{account:'PRIVATE_ROUTE',scenario:badScenario('http://127.0.0.1:4311/login/PRIVATE_PATH')},'scenario_url_sensitive'],
   [{account:'PRIVATE_ROUTE',scenario:badScenario('https://PRIVATE_HOST.invalid/')},'scenario_url_host'],
   [{account:'PRIVATE_ROUTE',scenario:{...scenario,expectedBehavior:'password=PRIVATE_VALUE'}},'scenario_sensitive'],
   [{account:'PRIVATE_ROUTE',scenario:{...scenario,steps:[scenario.steps[0],{action:'screenshot',path:'PRIVATE_OUTPUT'}]}},'scenario_action'],
   [{account:'PRIVATE_ROUTE',scenario,repository:outside},'repository_outside_session_cwd'],
   [{account:'PRIVATE_ROUTE',scenario,unexpected:'PRIVATE_EXTRA'},'invalid_or_unavailable_input'],
   [{account:'PRIVATE_ROUTE',scenario:badScenario('http://127.0.0.1:4311/auth'),assessment:{...assessment,changeSummary:'password=PRIVATE_VALUE'}},'scenario_url_sensitive'],
  ] as const){
   const result=parse(await run.execute('rejection',input as any));
   expect(result.execution).toEqual({status:'not_run',reason});expect(await count()).toBe(1);
   expect(result.receipt).toBeUndefined();expect(result.journalStorage.persisted).toBe(true);
   const text=JSON.stringify(result);expect(text).not.toContain('PRIVATE_');
   expect(result.recommendedNextActions.join(' ')).not.toMatch(/tests|Run verification again/);
  }
  const unsafe=parse(await run.execute('unsafe',{account:'PRIVATE_ROUTE',scenario,repository:outside,assessment:{...assessment,changeSummary:'password=PRIVATE_VALUE'}}));
  expect(unsafe.assessment.reason).toBe('invalid_context');expect(unsafe.execution.reason).not.toBe('repository_outside_session_cwd');
  expect(unsafe.receipt).toBeUndefined();expect(unsafe.journalStorage.persisted).toBe(true);expect(await count()).toBe(1);
  const journal=await readPluginOutcomeSnapshot('ui-regression');
  expect(journal.status).toBe('ok');expect(JSON.stringify(journal)).not.toContain('PRIVATE_');
  expect(JSON.stringify(journal)).toContain('scenario_url_sensitive');expect(JSON.stringify(journal)).toContain('invalid_case_id');
  expect(calls).toHaveLength(0);
 }finally{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;}
},30000);
test('scenario bounds absent from the public schema are rejected in-plugin before any launch',async()=>{
 const bin=path.join(adapterHome,'bin'),counter=path.join(adapterHome,'aside-launches.log');await fs.mkdir(bin);
 await fs.writeFile(path.join(bin,'aside'),`#!/bin/sh\necho launch >> ${JSON.stringify(counter)}\nexit 1\n`,{mode:0o755});
 const oldPath=process.env.PATH;process.env.PATH=`${bin}${path.delimiter}${oldPath??''}`;
 const goto={action:'goto',url:'http://127.0.0.1:4311/'},assert={action:'assert',selector:'#result',kind:'visible'};
 const base={id:'bounds',expectedBehavior:'Fixture page renders',steps:[goto,assert]};
 const cases:[unknown,string][]=[
  [{...base,steps:[]},'scenario_steps'],
  [{...base,steps:[goto,...Array.from({length:20},()=>assert)]},'scenario_steps'],
  [{...base,steps:[goto,{action:'fill',selector:'#name',value:'v '.repeat(500)+'x'},assert]},'scenario_value'],
  [{...base,expectedBehavior:'word '.repeat(400)+'x'},'scenario_expected_behavior'],
  [{...base,id:'a'.repeat(65)},'scenario_id'],
  [{...base,steps:[goto,{action:'screenshot'},assert]},'scenario_action'],
  [{...base,steps:[goto,{action:'assert',selector:'#result',kind:'hidden'}]},'scenario_assert_kind'],
  [{...base,steps:[goto,{action:'assert',selector:'#result',kind:'text',match:'regex',expected:'Ready'}]},'scenario_match'],
  [{...base,extra:'value'},'scenario_fields'],
 ];
 try{
  const tool=uiRun({cwd:process.cwd(),typebox:{Type}});
  for(const [scenario,reason] of cases){
   const result=parse(await tool.execute('bounds',{account:'route',scenario} as any));
   expect(result.execution).toEqual({status:'not_run',reason});
   expect(result.receipt).toBeUndefined();
   expect(result.recommendedNextActions.length).toBeGreaterThan(0);
  }
  await expect(fs.stat(counter)).rejects.toThrow();
  expect(calls.length).toBe(0);
 }finally{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;}
});
