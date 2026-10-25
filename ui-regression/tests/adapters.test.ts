import {test,expect,beforeEach,afterEach} from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import uiRun from '../src/run.adapter';
import uiStatus from '../src/status.adapter';
import {createReceipt,persistReceipt,fingerprintSource,specFingerprint,repositoryDigest} from '../../verification-receipts/lib/receipts';
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
