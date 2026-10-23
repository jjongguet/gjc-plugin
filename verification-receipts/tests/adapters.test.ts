import {test,expect} from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import verificationRun from '../src/run.adapter';
import verificationStatus from '../src/status.adapter';
import generatedRun from '../tools/verification-run';
import generatedStatus from '../tools/verification-status';
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
  const pass=parse(await run.execute('actual-fixture-call',{files:['pass.mjs']}));expect(pass.receipt.execution.status).toBe('passed');expect(pass.receipt.execution.counts.tests).toBe(1);expect(pass.persisted).toBe(true);expect(pass.assessment.reason).toBe('missing_context');expect(pass.receipt.freshness).toBe('fresh');expect(calls.length).toBe(0);
  expect(parse(await status.execute('status',{receiptId:pass.receipt.id})).freshness).toBe('fresh');
  const fail=parse(await run.execute('fail',{files:['fail.mjs']}));expect(fail.receipt.execution.status).toBe('failed');expect(JSON.stringify(fail)).not.toContain('SYNTHETIC_SECRET_CANARY');expect(fail.recommendedNextActions.length).toBeGreaterThan(0);
  const empty=parse(await run.execute('empty',{files:['empty.mjs']}));expect(empty.receipt.execution.status).not.toBe('passed');
  await fs.writeFile(path.join(root,'pass.mjs'),'changed');const stale=parse(await status.execute('stale',{receiptId:pass.receipt.id}));expect(stale.freshness).toBe('stale');expect(stale.receipt.execution.status).toBe('passed');expect(stale.advisoryOnly).toBe(true);
  const rejected=parse(await run.execute('spoof',{files:['pass.mjs'],passed:true} as any));expect(rejected.execution.status).toBe('not_run');
  const missing=parse(await status.execute('missing',{receiptId:'missing'}));expect(missing.execution.status).toBe('unavailable');expect(missing.assessment.reason).toBe('insufficient_evidence');
  // Tool calls carry no caller context, so every assessment is decided before
  // any provider call; the receipt-level facts asserted above carry the evidence.
  expect(calls.length).toBe(0);
  expect(calls.every(c=>c.state.explicitContext.authorship==='not_supplied')).toBe(true);
  expect(JSON.stringify(calls)).not.toContain('SYNTHETIC_SECRET_CANARY');expect(JSON.stringify(calls)).not.toContain('pass.mjs');expect(stale.assessment.reason).toBe('insufficient_evidence');
  for (const outcome of [pass,fail,empty,stale,rejected,missing]) expect(outcome.journalStorage.persisted).toBe(true);
  expect(rejected.receiptStorage.reason).toBe('no_receipt');
  expect((await fs.stat(path.join(home,'.gjc-plugin','verification-receipts','journal','v1'))).mode & 0o777).toBe(0o700);
  await fs.writeFile(path.join(root,'.gitignore'),'ignored/\n');await fs.mkdir(path.join(root,'ignored'));
  await fs.writeFile(path.join(root,'ignored','case.mjs'),"import test from 'node:test';test('owned ignored input',()=>{});");
  const ignored=parse(await run.execute('ignored',{files:['ignored/case.mjs']}));expect(ignored.receipt.execution.status).toBe('passed');expect(ignored.persisted).toBe(true);
  await fs.writeFile(path.join(root,'ignored','case.mjs'),"import test from 'node:test';test('owned ignored input',()=>{throw Error('owned mismatch')});");
  expect(parse(await status.execute('ignored-stale',{receiptId:ignored.receipt.id})).freshness).toBe('stale');
  const ignoredFailure=parse(await run.execute('ignored-failure',{files:['ignored/case.mjs']}));expect(ignoredFailure.receipt.execution.status).toBe('failed');expect(ignoredFailure.journalStorage.persisted).toBe(true);
 } finally {globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.JEV_ADVISOR_API_KEY;else process.env.JEV_ADVISOR_API_KEY=oldKey;if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldOff===undefined)delete process.env.JEV_ADVISOR_PROVIDER;else process.env.JEV_ADVISOR_PROVIDER=oldOff;await fs.rm(owned,{recursive:true,force:true});}
},30000);

test('generated standalone run/status persist private envelopes and reobserve ignored inputs',async()=>{
 const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'generated-receipt-tests-'))),root=path.join(owned,'repo'),home=path.join(owned,'home');
 await fs.mkdir(root);await fs.mkdir(home,{mode:0o700});const oldHome=process.env.HOME,oldProvider=process.env.JEV_ADVISOR_PROVIDER;process.env.HOME=home;process.env.JEV_ADVISOR_PROVIDER='off';
 try {
  execFileSync('git',['init','-q'],{cwd:root});await fs.writeFile(path.join(root,'.gitignore'),'ignored/\n');await fs.writeFile(path.join(root,'tracked.txt'),'fixture');await fs.mkdir(path.join(root,'ignored'));await fs.writeFile(path.join(root,'ignored','case.mjs'),"import test from 'node:test';test('owned generated input',()=>{});");execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:root});
  const run=generatedRun({cwd:root,typebox:{Type}}),status=generatedStatus({cwd:root,typebox:{Type}});
  const passed=parse(await run.execute('generated-pass',{files:['ignored/case.mjs']}));expect(passed.receipt.execution.counts.passed).toBe(1);expect(passed.persisted).toBe(true);expect(passed.journalStorage.persisted).toBe(true);
  expect(parse(await status.execute('generated-fresh',{receiptId:passed.receipt.id})).freshness).toBe('fresh');
  const envelope=JSON.parse(await fs.readFile(path.join(home,'.gjc-plugin','verification-receipts','receipts','v1',passed.receipt.repositoryDigest,passed.receipt.id+'.json'),'utf8'));expect(envelope.selectedInputs.files).toEqual(['ignored/case.mjs']);expect(JSON.stringify(passed)).not.toContain('ignored/case.mjs');
  await fs.writeFile(path.join(root,'ignored','case.mjs'),"import test from 'node:test';test('owned generated input',()=>{throw Error('generated boundary')});");
  const stale=parse(await status.execute('generated-stale',{receiptId:passed.receipt.id}));expect(stale.freshness).toBe('stale');expect(stale.receipt.execution.status).toBe('passed');expect(stale.journalStorage.persisted).toBe(true);
  const failed=parse(await run.execute('generated-failure',{files:['ignored/case.mjs']}));expect(failed.receipt.execution.status).toBe('failed');expect(failed.persisted).toBe(true);expect(failed.journalStorage.persisted).toBe(true);
 }finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldProvider===undefined)delete process.env.JEV_ADVISOR_PROVIDER;else process.env.JEV_ADVISOR_PROVIDER=oldProvider;await fs.rm(owned,{recursive:true,force:true});}
},30000);

test('a non-Git session directory runs and reads receipts for a repository inside it',async()=>{
 const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'adapter-non-git-'))),workspace=path.join(owned,'workspace'),repo=path.join(workspace,'lanes','repo'),outside=path.join(owned,'outside'),home=path.join(owned,'home');
 await fs.mkdir(path.join(repo,'tests'),{recursive:true});await fs.mkdir(path.join(workspace,'plain'));await fs.mkdir(outside);await fs.mkdir(home,{mode:0o700});
 const oldHome=process.env.HOME,oldProvider=process.env.JEV_ADVISOR_PROVIDER;process.env.HOME=home;process.env.JEV_ADVISOR_PROVIDER='off';
 const commit=(dir:string)=>{execFileSync('git',['init','-q'],{cwd:dir});execFileSync('git',['add','.'],{cwd:dir});execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:dir});};
 try {
  await fs.writeFile(path.join(repo,'tests','sync.test.mjs'),"import test from 'node:test';test('owned workspace case',()=>{});");
  await fs.writeFile(path.join(repo,'tests','spawn.test.mjs'),"import test from 'node:test';import {execFileSync} from 'node:child_process';test('owned spawn case',()=>{execFileSync('vr-missing-fixture-tool');});");
  commit(repo);await fs.writeFile(path.join(outside,'case.mjs'),"import test from 'node:test';test('owned outside case',()=>{});");commit(outside);
  for (const [run,status] of [[verificationRun,verificationStatus],[generatedRun,generatedStatus]] as const) {
   const tool=run({cwd:workspace,typebox:{Type}}),lookup=status({cwd:workspace,typebox:{Type}});
   const implicit=parse(await tool.execute('non-git',{files:['tests/sync.test.mjs']}));
   expect(implicit.execution).toEqual({status:'not_run',reason:'not_a_repository'});expect(implicit.recommendedNextActions[0]).toContain('`repository`');expect(implicit.journalStorage.persisted).toBe(true);
   const relative=parse(await tool.execute('relative',{repository:'lanes/repo',files:['tests/sync.test.mjs']}));
   expect(relative.receipt.execution.status).toBe('passed');expect(relative.persisted).toBe(true);expect(relative.journalStorage.persisted).toBe(true);
   const absolute=parse(await tool.execute('absolute',{repository:repo,files:['tests/sync.test.mjs']}));expect(absolute.receipt.repositoryDigest).toBe(relative.receipt.repositoryDigest);
   const fresh=parse(await lookup.execute('lookup',{receiptId:relative.receipt.id,repository:'lanes/repo'}));expect(fresh.freshness).toBe('fresh');expect(fresh.receipt.id).toBe(relative.receipt.id);
   const unscoped=parse(await lookup.execute('unscoped',{receiptId:relative.receipt.id}));expect(unscoped.execution).toEqual({status:'unavailable',reason:'not_a_repository'});expect(unscoped.warnings[0]).toBe('not_a_repository');expect(unscoped.journalStorage.persisted).toBe(true);
   for (const [repository,reason] of [['lanes/repo/tests','invalid_repository'],['lanes/missing','invalid_repository'],['plain','not_a_repository'],[outside,'repository_outside_session_cwd'],['../outside','repository_outside_session_cwd']]) {
    const rejected=parse(await tool.execute('rejected',{repository,files:['tests/sync.test.mjs']}));
    expect(rejected.execution).toEqual({status:'not_run',reason});expect(rejected.journalStorage.persisted).toBe(true);expect(JSON.stringify(rejected)).not.toContain(owned);
   }
   expect(parse(await tool.execute('absolute-test',{repository:'lanes/repo',files:[path.join(repo,'tests','sync.test.mjs')]})).execution).toEqual({status:'not_run',reason:'invalid_test_path'});
   expect(parse(await tool.execute('missing-test',{repository:'lanes/repo',files:['tests/none.test.mjs']})).execution).toEqual({status:'not_run',reason:'missing_test_file'});
   const spawn=parse(await tool.execute('spawn',{repository:'lanes/repo',files:['tests/spawn.test.mjs']}));
   expect(spawn.receipt.execution.status).toBe('failed');expect(spawn.receipt.execution.reason).toBe('missing_binary');expect(spawn.receipt.warnings).toEqual(['missing_binary:vr-missing-fixture-tool']);
   expect(spawn.warnings).toContain('missing_binary');expect(spawn.recommendedNextActions[0]).toContain('vr-missing-fixture-tool');expect(spawn.persisted).toBe(true);expect(spawn.journalStorage.persisted).toBe(true);
   const stored=parse(await lookup.execute('spawn-lookup',{receiptId:spawn.receipt.id,repository:repo}));expect(stored.receipt.warnings).toEqual(['missing_binary:vr-missing-fixture-tool']);expect(stored.warnings).toContain('missing_binary');
  }
  // The session repository stays reachable from a subdirectory, explicitly or by default.
  const sub=path.join(repo,'tests');
  expect(parse(await verificationRun({cwd:sub,typebox:{Type}}).execute('own-repo',{repository:'..',files:['tests/sync.test.mjs']})).receipt.execution.status).toBe('passed');
  expect(parse(await verificationRun({cwd:sub,typebox:{Type}}).execute('default-repo',{files:['tests/sync.test.mjs']})).receipt.execution.status).toBe('passed');
 } finally {if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldProvider===undefined)delete process.env.JEV_ADVISOR_PROVIDER;else process.env.JEV_ADVISOR_PROVIDER=oldProvider;await fs.rm(owned,{recursive:true,force:true});}
},60000);

test('post-execution repository loss preserves observations and journals the outcome',async()=>{
 const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'adapter-post-run-'))),root=path.join(owned,'repo'),home=path.join(owned,'home');
 await fs.mkdir(root);await fs.mkdir(home,{mode:0o700});const oldHome=process.env.HOME,oldProvider=process.env.JEV_ADVISOR_PROVIDER;
 process.env.HOME=home;process.env.JEV_ADVISOR_PROVIDER='off';
 try {
  execFileSync('git',['init','-q'],{cwd:root});
  // This inspected fixture deletes only its own disposable repository after its test passes.
  await fs.writeFile(path.join(root,'remove-owned.mjs'),"import test from 'node:test';import {rmSync} from 'node:fs';test('owned cleanup',()=>{rmSync(process.cwd(),{recursive:true,force:true})});");
  execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:root});
  const result=parse(await verificationRun({cwd:root,typebox:{Type}}).execute('post-run',{files:['remove-owned.mjs']}));
  expect(result.execution.status).toBe('passed');expect(result.execution.counts.passed).toBe(1);
  expect(result.receiptStorage.persisted).toBe(false);expect(result.journalStorage.persisted).toBe(true);expect(result.warnings).toContain('source_not_fresh');
 }finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldProvider===undefined)delete process.env.JEV_ADVISOR_PROVIDER;else process.env.JEV_ADVISOR_PROVIDER=oldProvider;await fs.rm(owned,{recursive:true,force:true});}
},30000);
