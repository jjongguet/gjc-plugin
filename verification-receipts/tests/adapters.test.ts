import {test,expect} from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import verificationRun from '../src/run.adapter';
import verificationStatus from '../src/status.adapter';
const Type=new Proxy({}, {get:()=> (...args:unknown[])=>({args})});
const parse=(r:any)=>JSON.parse(r.content[0].text);
test('run/status automatically assess pass failure no-tests stale and rejected execution',async()=>{
 const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'adapter-tests-')));const root=path.join(owned,'repo');await fs.mkdir(root);const home=path.join(owned,'home');await fs.mkdir(home,{mode:0o700});const oldHome=process.env.HOME,oldOff=process.env.JEV_ADVISOR_PROVIDER,oldKey=process.env.JEV_ADVISOR_API_KEY,oldFetch=globalThis.fetch;process.env.HOME=home;process.env.JEV_ADVISOR_PROVIDER='jev';process.env.JEV_ADVISOR_API_KEY='synthetic-adapter-key';
 const calls:any[]=[];globalThis.fetch=(async(url,options)=>{expect(String(url)).toBe('https://openrouter.ai/api/alpha/decisions');calls.push(JSON.parse(String(options?.body)));return new Response(JSON.stringify({answers:{coverage_alignment:{type:'choice',choice:'aligned'},boundary_evidence:{type:'choice',choice:'present'}}}));}) as typeof fetch;
 try {
  execFileSync('git',['init','-q'],{cwd:root});
  await fs.writeFile(path.join(root,'pass.mjs'),"import test from 'node:test';test('pass',()=>{});");
  await fs.writeFile(path.join(root,'fail.mjs'),"import test from 'node:test';test('fail',()=>{throw Error('SYNTHETIC_SECRET_CANARY');});");
  await fs.writeFile(path.join(root,'empty.mjs'),'');
  execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:root});
  const run=verificationRun({cwd:root,typebox:{Type}});const status=verificationStatus({cwd:root,typebox:{Type}});
  const pass=parse(await run.execute('actual-fixture-call',{files:['pass.mjs']}));expect(pass.receipt.execution.status).toBe('passed');expect(pass.receipt.execution.counts.tests).toBe(1);expect(pass.persisted).toBe(true);expect(pass.assessment.reason).toBe('missing_context');expect(pass.receipt.freshness).toBe('fresh');expect(calls.length).toBe(1);
  expect(parse(await status.execute('status',{receiptId:pass.receipt.id})).freshness).toBe('fresh');
  const fail=parse(await run.execute('fail',{files:['fail.mjs']}));expect(fail.receipt.execution.status).toBe('failed');expect(JSON.stringify(fail)).not.toContain('SYNTHETIC_SECRET_CANARY');expect(fail.recommendedNextActions.length).toBeGreaterThan(0);
  const empty=parse(await run.execute('empty',{files:['empty.mjs']}));expect(empty.receipt.execution.status).not.toBe('passed');
  await fs.writeFile(path.join(root,'pass.mjs'),'changed');const stale=parse(await status.execute('stale',{receiptId:pass.receipt.id}));expect(stale.freshness).toBe('stale');expect(stale.receipt.execution.status).toBe('passed');expect(stale.advisoryOnly).toBe(true);
  const rejected=parse(await run.execute('spoof',{files:['pass.mjs'],passed:true} as any));expect(rejected.execution.status).toBe('not_run');
  const missing=parse(await status.execute('missing',{receiptId:'missing'}));expect(missing.execution.status).toBe('unavailable');expect(missing.assessment.reason).toBe('insufficient_evidence');
  expect(calls.length).toBe(7);expect(calls.map(c=>c.state.observed.status)).toEqual(['passed','passed','failed','no_tests','passed','not_run','unavailable']);expect(calls[4].state.observed.freshness).toBe('stale');
  expect(calls.every(c=>c.state.explicitContext.authorship==='not_supplied')).toBe(true);
  expect(JSON.stringify(calls)).not.toContain('SYNTHETIC_SECRET_CANARY');expect(JSON.stringify(calls)).not.toContain('pass.mjs');expect(stale.assessment.reason).toBe('insufficient_evidence');
 } finally {globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.JEV_ADVISOR_API_KEY;else process.env.JEV_ADVISOR_API_KEY=oldKey;if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldOff===undefined)delete process.env.JEV_ADVISOR_PROVIDER;else process.env.JEV_ADVISOR_PROVIDER=oldOff;await fs.rm(owned,{recursive:true,force:true});}
},30000);
