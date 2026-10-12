// Installed verification-receipts loop smoke.
//
// Parent mode (no args) resolves the user-installed bundle, digests the three
// loop surfaces, then runs the isolated child below in a fresh bun process.
// Child mode (--isolated) imports the installed hooks/tools from the bundle,
// builds a fixture git repository and drives synthetic delegation events end
// to end: compact no-change gate, full gate, async terminal gate, first loop
// (gaps), a real verification_run receipt, second loop (clean). The loop must
// never touch the network: global fetch is replaced with a hard counter that
// fails the run on any call.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createSmokeEnvironment,assertSmokeIsolation} from './smoke-environment.mjs';

const script=fileURLToPath(import.meta.url);
const SURFACE_FILES=['hooks/verification-gate.ts','hooks/verification-gate-baseline.ts','tools/verification-loop.ts'];
const PRIVATE_CANARY='PRIVATE_DELEGATED_ASSIGNMENT_CANARY';

if(process.argv[2]==='--isolated'){
 const owned=await fs.realpath(process.argv[3]),bundle=await fs.realpath(process.argv[4]);
 assert.equal(await fs.realpath(process.env.HOME),path.join(owned,'home'));
 assert.equal(os.homedir(),process.env.HOME);
 let fetchCalls=0;
 globalThis.fetch=()=>{fetchCalls++;throw Error('unexpected_network_fetch');};

 const baselineModule=await import(pathToFileURL(path.join(bundle,'hooks/verification-gate-baseline.ts')).href);
 const gateModule=await import(pathToFileURL(path.join(bundle,'hooks/verification-gate.ts')).href);
 const loopModule=await import(pathToFileURL(path.join(bundle,'tools/verification-loop.ts')).href);
 const runModule=await import(pathToFileURL(path.join(bundle,'tools/verification-run.ts')).href);
 const hook=module=>{let handler;module.default({on:(_event,fn)=>{handler=fn;}});assert.equal(typeof handler,'function');return handler;};
 const baselineHook=hook(baselineModule),gateHook=hook(gateModule);
 const Type=new Proxy({},{get:()=> (...args)=>({args})});

 const repo=path.join(owned,'repo');
 await fs.mkdir(repo,{mode:0o700});
 const git=(...args)=>execFileSync('git',args,{cwd:repo,env:{PATH:process.env.PATH},stdio:'pipe'});
 git('init','-q');
 await fs.writeFile(path.join(repo,'pass.mjs'),"import test from 'node:test';test('local fixture',()=>{});\n");
 git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');

 const ctx={cwd:repo,sessionManager:{getSessionId:()=> 'installed-loop-fixture'}};
 const texts=result=>Array.isArray(result?.content)?result.content.filter(entry=>entry?.type==='text').map(entry=>String(entry.text)):[];
 const taskResult=(toolCallId,extra)=> ({type:'tool_result',toolName:'task',toolCallId,input:{tasks:[{id:'fixture-task',description:'fixture',assignment:PRIVATE_CANARY+' create a committed fixture change'}]},details:{results:[{status:'completed'}],...extra},content:[{type:'text',text:'ORIGINAL RESULT BODY'}]});

 // (a) compact no-change gate, then a committed change producing the full gate.
 await baselineHook({type:'tool_call',toolName:'task',toolCallId:'sync-clean'},ctx);
 const compact=await gateHook(taskResult('sync-clean'),ctx);
 const compactTexts=texts(compact);
 assert.equal(compactTexts.length,2,'compact_gate_not_appended');
 assert.equal(compactTexts[0],'ORIGINAL RESULT BODY');
 assert.ok(compactTexts[1].includes('[delegation-verification-gate]'),'compact_gate_marker_missing');
 assert.ok(compactTexts[1].includes('machine-checked no repo change'),'compact_gate_not_compact:'+compactTexts[1].slice(0,200));
 assert.ok(!compactTexts[1].includes(repo),'compact_gate_leaked_absolute_path');
 assert.equal(await gateHook(taskResult('sync-clean'),ctx),undefined,'compact_gate_not_deduped');
 await baselineHook({type:'tool_call',toolName:'task',toolCallId:'sync-changed'},ctx);
 await fs.writeFile(path.join(repo,'pass.mjs'),"import test from 'node:test';test('local fixture (delegated change)',()=>{});\n");
 git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','delegated change');
 const full=await gateHook(taskResult('sync-changed'),ctx);
 const fullTexts=texts(full);
 assert.equal(fullTexts.length,2,'full_gate_not_appended');
 assert.ok(fullTexts[1].includes('REQUIRED: call verification_loop now'),'full_gate_requirement_missing:'+fullTexts[1].slice(0,300));
 assert.ok(fullTexts[1].includes('Machine facts:'),'full_gate_machine_facts_missing');
 assert.ok(!fullTexts[1].includes(repo),'full_gate_leaked_absolute_path');
 assert.equal(await gateHook(taskResult('sync-changed'),ctx),undefined,'full_gate_not_deduped');

 // (b) async launch envelope is pending, the subagent terminal gate is appended once.
 await baselineHook({type:'tool_call',toolName:'task',toolCallId:'async-call'},ctx);
 assert.equal(await gateHook(taskResult('async-call',{results:[],async:{jobId:'job-async-fixture',state:'running',type:'task'}}),ctx),undefined,'async_envelope_gated_early');
 const terminalResult={type:'tool_result',toolName:'subagent',input:{},details:{subagents:[{jobId:'job-async-fixture',status:'completed',durationMs:12}]},content:[{type:'text',text:'ORIGINAL CHILD RESULT'}]};
 const terminal=await gateHook(terminalResult,ctx);
 const terminalTexts=texts(terminal);
 assert.equal(terminalTexts.length,2,'async_terminal_gate_not_appended');
 assert.ok(terminalTexts[1].includes('[delegation-verification-gate]'),'async_terminal_gate_marker_missing');
 assert.equal(await gateHook(terminalResult,ctx),undefined,'async_terminal_gate_not_deduped');

 // (c) loop blocks on gaps, a real receipt resolves both open gates.
 const loop=loopModule.default({cwd:repo,typebox:{Type}});
 const run=runModule.default({cwd:repo,typebox:{Type}});
 const first=JSON.parse(texts(await loop.execute('installed-loop-1',{},undefined,ctx))[0]);
 assert.equal(first.status,'gaps','first_loop_not_gaps:'+first.status);
 assert.ok(first.openGates>=1,'first_loop_missing_open_gates');
 const receiptResult=JSON.parse(texts(await run.execute('installed-run-1',{files:['pass.mjs']},undefined,ctx))[0]);
 assert.equal(receiptResult.receipt.execution.status,'passed','fixture_run_not_passed:'+receiptResult.receipt.execution.status);
 assert.equal(receiptResult.persisted,true,'fixture_receipt_not_persisted:'+receiptResult.reason);
 assert.deepEqual(receiptResult.assessment,{status:'unavailable',reason:'off'},'automatic_assessment_missing_or_offline_guard_failed');
 const second=JSON.parse(texts(await loop.execute('installed-loop-2',{},undefined,ctx))[0]);
 assert.equal(second.status,'clean','second_loop_not_clean:'+second.status+':'+JSON.stringify(second.gapKinds));
 assert.ok(second.resolvedGates>=1,'second_loop_missing_resolved_gates');

 // (d) journal, state and privacy assertions.
 const journal=path.join(process.env.HOME,'.gjc-plugin','verification-receipts','journal','v1');
 const inventory=JSON.parse(await fs.readFile(path.join(journal,'inventory.json'),'utf8'));
 const records=[];
 for(const segment of inventory.segments){const file=path.join(journal,segment.name),body=await fs.readFile(file);assert.equal(body.length,segment.bytes);assert.equal(createHash('sha256').update(body).digest('hex'),segment.digest);assert.equal((await fs.stat(file)).mode&0o777,0o600);records.push(...body.toString().trimEnd().split('\n').map(line=>JSON.parse(line)));}
 assert.deepEqual(records.map(record=>record.operation),['gate_emitted','gate_emitted','gate_emitted','loop_run','run','loop_run'],'journal_operation_sequence');
 const repoDigest=createHash('sha256').update(repo).digest('hex');
 const sessionDigest=createHash('sha256').update('installed-loop-fixture').digest('hex');
 const stateDir=path.join(process.env.HOME,'.gjc-plugin','verification-receipts','loop','v1',repoDigest);
 const stateFile=path.join(stateDir,sessionDigest+'.json');
 assert.equal((await fs.stat(stateDir)).mode&0o777,0o700,'loop_state_dir_mode');
 assert.equal((await fs.stat(stateFile)).mode&0o777,0o600,'loop_state_file_mode');
 const stateBody=await fs.readFile(stateFile,'utf8');
 const state=JSON.parse(stateBody);
 assert.deepEqual(state.gates.map(gate=>gate.resolution),['no_change','receipt','receipt'],'gate_resolutions');
 assert.ok(state.gates.filter(gate=>gate.resolution==='receipt').every(gate=>typeof gate.resolvedReceiptId==='string'&&gate.resolvedReceiptId.length===36),'receipt_resolution_missing_id');
 const privateScope=JSON.stringify(records)+stateBody;
 assert.ok(!privateScope.includes(PRIVATE_CANARY),'private_canary_leaked');
 assert.equal(fetchCalls,0,'network_fetch_observed');

 console.log(JSON.stringify({schemaVersion:1,kind:'package-consumer-report',surface:'installed-verification-loop',isolated:true,freshProcess:true,operations:records.map(record=>record.operation),loopStatuses:[first.status,second.status],openGates:{first:first.openGates,second:second.openGates},resolvedGates:second.resolvedGates,gateResolutions:state.gates.map(gate=>gate.resolution),privateModes:true,remoteProviderRequests:0,fetchCalls}));
} else {
 const agent=path.resolve(process.env.GJC_CODING_AGENT_DIR||process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.gjc','agent'));
 const bundle=await fs.realpath(path.join(agent,'gjc-plugins','verification-receipts'));
 for(const file of SURFACE_FILES)await fs.access(path.join(bundle,file));
 const digest=async()=>Promise.all(SURFACE_FILES.map(async file=>createHash('sha256').update(await fs.readFile(path.join(bundle,file))).digest('hex')));
 const before=await digest();
 const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gjc-loop-smoke-')));
 let report;
 try {
  const env=await createSmokeEnvironment(owned);
  await assertSmokeIsolation(env,owned);
  const execution=await new Promise((resolve,reject)=>{const child=spawn('bun',[script,'--isolated',owned,bundle],{cwd:owned,env,shell:false,detached:true});let output='',error='',bytes=0;const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{} reject(Error('installed_loop_timeout'));},45000);const capture=(chunk,stderr)=>{bytes+=chunk.length;if(bytes>1024*1024){try{process.kill(-child.pid,'SIGKILL');}catch{} return;}if(stderr)error+=chunk;else output+=chunk;};child.stdout.on('data',chunk=>capture(chunk,false));child.stderr.on('data',chunk=>capture(chunk,true));child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,output,error});});});
  assert.equal(execution.code,0,execution.error||execution.output);
  report=JSON.parse(execution.output.trim().split('\n').filter(Boolean).pop());
  assert.deepEqual(await digest(),before,'installed_bundle_changed_during_smoke');
  report.installedCodeUnchanged=true;
 } finally { await fs.rm(owned,{recursive:true,force:true}); }
 console.log(JSON.stringify(report));
}
