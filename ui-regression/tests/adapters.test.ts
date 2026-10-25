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
let calls:any[];
beforeEach(()=>{
 originalFetch=globalThis.fetch;originalProvider=process.env.JEV_ADVISOR_PROVIDER;originalKey=process.env.JEV_ADVISOR_API_KEY;calls=[];
 globalThis.fetch=(async(url,options)=>{expect(String(url)).toBe('https://openrouter.ai/api/alpha/decisions');calls.push(JSON.parse(String(options?.body)));return new Response(JSON.stringify({answers:{coverage_alignment:{type:'choice',choice:'aligned'},boundary_evidence:{type:'choice',choice:'present'}}}));}) as typeof fetch;
 process.env.JEV_ADVISOR_PROVIDER='jev';process.env.JEV_ADVISOR_API_KEY='synthetic-ui-adapter-key';
});
afterEach(()=>{
 globalThis.fetch=originalFetch;
 if(originalProvider===undefined)delete process.env.JEV_ADVISOR_PROVIDER;else process.env.JEV_ADVISOR_PROVIDER=originalProvider;
 if(originalKey===undefined)delete process.env.JEV_ADVISOR_API_KEY;else process.env.JEV_ADVISOR_API_KEY=originalKey;
});
test('closed run adapter rejects passed imports missing account and no assertion',async()=>{
 const tool=uiRun({cwd:process.cwd(),typebox:{Type}});
 for(const input of [{passed:true},{account:'route',scenario:{id:'none',expectedBehavior:'Ready',steps:[{action:'goto',url:'http://localhost:4311/'}]}},{account:'route',scenario:{id:'case',expectedBehavior:'Ready',steps:[]}},{}]){
  const result=parse(await tool.execute('fixture',input as any));expect(result.execution.status).toBe('not_run');expect(result.advisoryOnly).toBe(true);expect(result.recommendedNextActions.length).toBeGreaterThan(0);expect(result.assessment.reason).toBe('insufficient_evidence');
 }
 expect(calls.length).toBe(4);expect(calls.every(c=>c.state.observed.status==='not_run')).toBe(true);expect(JSON.stringify(calls)).not.toContain('localhost');
});
test('UI status metadata fixture remains historical and source scoped',async()=>{
 const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ui-adapter-')));const root=path.join(owned,'repo'),home=path.join(owned,'home');await fs.mkdir(root);await fs.mkdir(home,{mode:0o700});const old=process.env.HOME;process.env.HOME=home;
 try{
  execFileSync('git',['init','-q'],{cwd:root});await fs.writeFile(path.join(root,'fixture.js'),'fixture');execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:root});
  const specDigest=specFingerprint({fixture:'metadata-only'}),fp=await fingerprintSource(root,specDigest);
  const receipt=createReceipt({plugin:'ui-regression',toolCallId:'metadata-fixture',repositoryDigest:await repositoryDigest(root),durationMs:1,specDigest,before:fp,after:fp,freshness:'fresh',execution:{status:'passed',reason:'complete',exitCode:0,signal:null,runnerVersion:null,counts:null,assertions:[{step:1,id:'step-1',kind:'text_exact',status:'passed'}],steps:[{step:0,action:'goto',status:'passed'},{step:1,action:'assert',status:'passed'}],cleanup:'confirmed',currentUiState:'not_reobserved',browserBuildBinding:'unverified',scenarioDigest:specDigest},warnings:[],limitations:['Test fixture metadata, not live browser evidence.']});
  expect((await persistReceipt(receipt)).persisted).toBe(true);const tool=uiStatus({cwd:root,typebox:{Type}});
  const fresh=parse(await tool.execute('status',{receiptId:receipt.id}));expect(fresh.freshness).toBe('fresh');expect(fresh.currentUiState).toBe('not_reobserved');expect(fresh.browserBuildBinding).toBe('unverified');expect(fresh.assessment.reason).toBe('missing_context');expect(calls.length).toBe(1);
  await fs.writeFile(path.join(root,'fixture.js'),'changed');const stale=parse(await tool.execute('stale',{receiptId:receipt.id}));expect(stale.freshness).toBe('stale');expect(stale.receipt.execution.status).toBe('passed');expect(stale.warnings).toContain('source_not_fresh');
  const missing=parse(await tool.execute('missing',{receiptId:'../escape'}));expect(missing.execution.status).toBe('unavailable');
  expect(calls.length).toBe(3);expect(calls[0].state.observed.assertions).toEqual([{step:1,id:'step-1',kind:'text_exact',status:'passed'}]);expect(calls[1].state.observed.freshness).toBe('stale');expect(calls[2].state.observed.status).toBe('unavailable');expect(stale.assessment.reason).toBe('insufficient_evidence');
 }finally{if(old===undefined)delete process.env.HOME;else process.env.HOME=old;await fs.rm(owned,{recursive:true,force:true});}
});
test('standalone generated UI tools load with only declared installed files',async()=>{
 const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ui-standalone-')));
 try{for(const [file,name] of [['ui-regression-run.ts','ui_regression_run'],['ui-regression-status.ts','ui_regression_status']]){await fs.copyFile(path.resolve(import.meta.dir,'../tools',file),path.join(owned,file));const module=await import(path.join(owned,file));expect(module.default({cwd:process.cwd(),typebox:{Type}}).name).toBe(name);}}
 finally{await fs.rm(owned,{recursive:true,force:true});}
});
