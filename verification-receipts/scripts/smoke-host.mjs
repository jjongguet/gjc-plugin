import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createSmokeEnvironment,assertSmokeIsolation,asideLaunchCounterPath,asideLaunchCount,writeAsideProbeWrapper,parseAdapterResult,receiptFileCount,journalRecordCount,journalText,advertisedAssessmentContract,rejectableConstraints} from './smoke-environment.mjs';
// Synthetic canary for the caller-text echo privacy checks. Never a real value.
const nativeCanary='SYNTHETIC_NATIVE_PROBE_CANARY';
const worktree=process.cwd();
const uiMode=process.argv.includes('--ui');
// Bounded deviation surface: proves the UI rejection preflight without a browser or an
// installed Aside. Never a substitute for the real positive browser observation.
const uiRejectionsMode=process.argv.includes('--ui-rejections');
const advisorMode=process.argv.includes('--advisor');
const checkMode=process.argv.includes('--check');
const metricsMode=process.argv.includes('--metrics');
const loopMode=process.argv.includes('--loop');
const delegationMode=process.argv.includes('--delegation');
assert.ok([uiMode,uiRejectionsMode,advisorMode,checkMode,metricsMode,loopMode,delegationMode].filter(Boolean).length<=1,'ambiguous_smoke_surface');
const installedMode=process.argv.includes('--installed');
const plugin=advisorMode||checkMode||metricsMode?'jev-advisor':uiMode||uiRejectionsMode?'ui-regression':'verification-receipts';
const toolNames=delegationMode?['task','subagent','job','verification_run','verification_loop']:metricsMode?['plugin_metrics']:advisorMode?['jev_advise']:checkMode?['jev_check']:uiMode||uiRejectionsMode?['ui_regression_run','ui_regression_status']:['verification_run','verification_status'];
const account=process.env.UI_REGRESSION_ACCOUNT;
if((uiMode||uiRejectionsMode)&&!account)throw Error('explicit_ephemeral_account_required');
const userAgent=path.resolve(process.env.GJC_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(),'.gjc','agent'));
const userConfig=path.join(userAgent,'config.yml');
async function configDigest(){try{return createHash('sha256').update(await fs.readFile(userConfig)).digest('hex');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
const beforeConfig=await configDigest();
const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gjc-installed-smoke-')));
const root=path.join(owned,'repo');
let asideControlLaunches=0,asideObserverControl=false;
let env,server,report;
async function child(args,timeout=60000,command='gjc'){await assertSmokeIsolation(env,owned);return new Promise((resolve,reject)=>{let output='',errors='',bytes=0;const p=spawn(command,args,{cwd:root,env,shell:false,detached:true});const timer=setTimeout(()=>{try{process.kill(-p.pid,'SIGKILL');}catch{} reject(Error('host_timeout'));},timeout);p.stdout.on('data',c=>{bytes+=c.length;if(bytes<4e6)output+=c;});p.stderr.on('data',c=>{bytes+=c.length;if(bytes<4e6)errors+=c;});p.on('error',reject);p.on('close',code=>{clearTimeout(timer);resolve({code,output,errors});});});}
try {
 env=await createSmokeEnvironment(owned);
 await fs.mkdir(root,{mode:0o700});
 if(loopMode){
  // Host-level wrapper: install the worktree bundle into the isolated env and delegate to the
  // passing smoke-loop surface (parent mode), then merge its report. No mock server is started.
  const bundle=path.join(worktree,'verification-receipts');
  const install=await child(['plugin','install',bundle,'--user','--json']);
  assert.equal(install.code,0,'isolated_install_failed');
  const loop=await child([path.join(bundle,'scripts','smoke-loop.mjs')],150000,'bun');
  assert.equal(loop.code,0,'host_loop_child_failed:'+loop.errors.slice(0,400));
  report={...JSON.parse(loop.output.trim().split('\n').filter(Boolean).pop()),delegatedFromHost:true,hostMode:'loop'};
 }else{
 if(uiMode){
  const bin=path.join(owned,'bin');await fs.mkdir(bin,{mode:0o700});
  const realAside=execFileSync('which',['aside'],{encoding:'utf8',env:{PATH:process.env.PATH}}).trim();
  // Test-only router preserves existing Aside HOME while GJC and receipts stay isolated,
  // and appends one line per launch to the owned counter (the launch oracle).
  await writeAsideProbeWrapper({binDir:bin,realAside,counterFile:asideLaunchCounterPath(owned),env:{HOME:process.env.HOME,PATH:process.env.PATH,TMPDIR:owned}});
  env.PATH=bin+path.delimiter+process.env.PATH;
 }else if(uiRejectionsMode){
  // Inert Aside fixture: records the invocation, then fails. Rejections must never reach it.
  const bin=path.join(owned,'bin');await fs.mkdir(bin,{mode:0o700});
  const inertAside=path.join(owned,'inert-aside');await fs.writeFile(inertAside,'#!/bin/sh\nexit 1\n',{mode:0o755});
  const counter=asideLaunchCounterPath(owned);
  const wrapper=await writeAsideProbeWrapper({binDir:bin,realAside:inertAside,counterFile:counter,env:{HOME:process.env.HOME,PATH:process.env.PATH,TMPDIR:owned}});
  env.PATH=bin+path.delimiter+process.env.PATH;
  // Positive control for the observer itself: one direct synthetic launch is counted,
  // then the counter becomes the baseline every rejected probe must not move.
  const control=spawnSync(process.execPath,[wrapper,'repl'],{env,stdio:'pipe'});
  assert.equal(control.status,1,'inert_aside_control_exit');
  asideControlLaunches=await asideLaunchCount(counter);
  assert.equal(asideControlLaunches,1,'aside_observer_control_missing');
  asideObserverControl=true;
 }
 const git=(...args)=>execFileSync('git',args,{cwd:root,env:{PATH:process.env.PATH},stdio:'pipe'});
 git('init','-q');
 await fs.writeFile(path.join(root,'pass.mjs'),"import test from 'node:test';test('local fixture',()=>{});");
 await fs.writeFile(path.join(root,'fail.mjs'),"import test from 'node:test';test('deliberate local mismatch',()=>{throw Error('SYNTHETIC_CANARY');});");
 await fs.writeFile(path.join(root,'empty.mjs'),'');await fs.writeFile(path.join(root,'.gitignore'),'ignored/\n');await fs.mkdir(path.join(root,'ignored'));
 await fs.writeFile(path.join(root,'ignored','case.mjs'),"import test from 'node:test';test('explicit ignored fixture',()=>{});");
 git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
 // Owned repository outside the session cwd: exercises repository_outside_session_cwd, never launched.
 const external=path.join(owned,'external');await fs.mkdir(external,{mode:0o700});
 execFileSync('git',['init','-q'],{cwd:external,env:{PATH:process.env.PATH},stdio:'pipe'});
 await fs.writeFile(path.join(external,'fixture.mjs'),'');
 execFileSync('git',['add','.'],{cwd:external,env:{PATH:process.env.PATH},stdio:'pipe'});
 execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:external,env:{PATH:process.env.PATH},stdio:'pipe'});
 // Installed bundles are read-only inputs; never run a test against the live user agent root.
 const bundle=installedMode?path.join(userAgent,'gjc-plugins',plugin):path.join(worktree,plugin);
 const install=await child(['plugin','install',bundle,'--user','--json']);
 assert.equal(install.code,0,'isolated_install_failed');
 const listing=await child(['plugin','list','--json']);assert.equal(listing.code,0,'isolated_list_failed');assert.ok(listing.output.includes(plugin),'installed_catalog_missing');
 if(uiMode)assert.ok(!listing.output.includes('verification-receipts'),'unexpected_sibling_install');
 let step=0,passId,capacitySeeds=0;const evidence=[],journalIds=[],discoveredSchemas=[];let discovered=[];let mockError='';
 let scenario;let submissions=0;
 // Launch/receipt deltas per probe; the Aside counter is the only launch oracle.
 let launchSnapshot=asideControlLaunches,receiptSnapshot=0;
 const fixtureBody=uiMode?await fs.readFile(path.join(worktree,'ui-regression/tests/fixtures/index.html')):null;
 const calls=metricsMode?[
  ()=>({name:'plugin_metrics',args:{}}),
  ()=>({name:'plugin_metrics',args:{}})
 ]:advisorMode?[
  ()=>({name:'jev_advise',args:{assignment:'Non-sensitive local fixture advice',role:'executor'}}),
  ()=>({name:'jev_advise',args:{report:'calibration'}}),
  ()=>({name:'jev_advise',args:{}})
 ]:checkMode?[
  ()=>({name:'jev_check',args:{question:'Does the label match the primary topic of the artifact? PRIVATE-CHECK-QUESTION',artifact:'text: the stadium roared; label: sports'}}),
	 ()=>({name:'jev_check',args:{question:'Is this acceptable?',artifact:'   '}}),
  ()=>({name:'jev_check',args:{question:'q'.repeat(4000),artifact:'a'}})
 ]:uiMode?[
  ()=>({name:toolNames[0],args:{account,scenario}}),
  ()=>({name:toolNames[1],args:{receiptId:passId}}),
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'local-mismatch',steps:scenario.steps.map((s,i)=>i===4?{...s,expected:'Deliberate mismatch'}:s)}}}),
  ()=>({name:toolNames[1],args:{receiptId:passId}}),
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'empty-substring',steps:scenario.steps.map((s,i)=>i===4?{...s,match:'substring',expected:'   '}:s)}}}),
  ()=>({name:toolNames[1],args:{receiptId:'missing'}}),
  // Bounded rejection probes: each must fail before any Aside launch or receipt.
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'unsafe-selector',steps:scenario.steps.map((s,i)=>i===1?{action:'assert',selector:'#password',kind:'visible'}:s)}}}),
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'sensitive-fill',steps:scenario.steps.map((s,i)=>i===2?{...s,value:'user@example.com'}:s)}}}),
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'non-loopback',steps:scenario.steps.map((s,i)=>i===0?{action:'goto',url:'http://example.invalid/'}:s)}}}),
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'sensitive-url',steps:scenario.steps.map((s,i)=>i===0?{action:'goto',url:'http://127.0.0.1:9/login'}:s)}}}),
  ()=>({name:toolNames[0],args:{account,scenario,repository:'../external'}}),
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'unsupported-action',expectedBehavior:nativeCanary,steps:scenario.steps.map((s,i)=>i===2?{action:'screenshot'}:s)}}}),
  // Shape-valid but unobserved assertion id: executes, then journaled invalid_case_id.
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'unobserved-case',steps:scenario.steps.slice(0,4)},assessment:{changeSummary:'Local fixture change.',expectedBehavior:'Local fixture behavior.',caseNotes:[{id:'step-3',note:'Local fixture case note.'}]}}}),
  // Shape/unsafe assessment text with a valid scenario: invalid_context before any browser.
  ()=>({name:toolNames[0],args:{account,scenario,assessment:{changeSummary:'Local fixture change.',expectedBehavior:'Local fixture behavior.',caseNotes:[{id:'step-1',note:'See https://example.invalid/private for details.'}]}}})
 ]:uiRejectionsMode?[
  // Pre-browser rejection surface only: sensitive URL, sensitive value, non-loopback,
  // outside repository and unsafe assessment. No browser, no Aside, no receipt.
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'sensitive-url',steps:scenario.steps.map((s,i)=>i===0?{action:'goto',url:'http://127.0.0.1:9/login'}:s)}}}),
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'sensitive-fill',steps:scenario.steps.map((s,i)=>i===2?{...s,value:'user@example.com'}:s)}}}),
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'non-loopback',steps:scenario.steps.map((s,i)=>i===0?{action:'goto',url:'http://example.invalid/'}:s)}}}),
  ()=>({name:toolNames[0],args:{account,scenario,repository:'../external'}}),
  ()=>({name:toolNames[0],args:{account,scenario,assessment:{changeSummary:'Local fixture change.',expectedBehavior:'Local fixture behavior.',caseNotes:[{id:'step-1',note:'See https://example.invalid/private for details.'}]}}}),
  // Unsupported action plus a caller canary: the plugin, not the host schema, rejects it.
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'unsupported-action',expectedBehavior:nativeCanary,steps:scenario.steps.map((s,i)=>i===2?{action:'screenshot'}:s)}}})
 ]:[()=>({name:'verification_run',args:{files:['ignored/case.mjs']}}),()=>({name:'verification_status',args:{receiptId:passId}}),()=>({name:'verification_run',args:{files:['fail.mjs']}}),()=>({name:'verification_run',args:{files:['empty.mjs']}}),()=>({name:'verification_status',args:{receiptId:passId}}),()=>({name:'verification_run',args:{files:['ignored/case.mjs']}}),()=>({name:'verification_run',args:{files:['../escape.mjs']}}),()=>({name:'verification_status',args:{receiptId:'missing'}}),()=>({name:'verification_run',args:{files:['pass.mjs']}}),()=>({name:'verification_status',args:{receiptId:passId}}),()=>({name:'verification_run',args:{files:['pass.mjs']}}),
  // Case-id membership probe: a well-formed non-member id with a caller canary note
  // reaches the plugin, which rejects it as invalid_case_id without echoing either.
  ()=>({name:'verification_run',args:{files:['pass.mjs'],assessment:{changeSummary:'Local fixture change.',expectedBehavior:'Local fixture behavior.',caseNotes:[{id:'policy',note:nativeCanary}]}}}),
  // The same tool remains usable in the same session with an eligible id.
  ()=>({name:'verification_run',args:{files:['pass.mjs'],assessment:{changeSummary:'Local fixture change.',expectedBehavior:'Local fixture behavior.',caseNotes:[{id:'run',note:'Local fixture case note.'}]}}})];
 // Fixed, non-sensitive expectations for the ui-rejections surface (reasons only).
 const uiRejectionExpectations=[
  {probe:'sensitive_url',reason:'scenario_url_sensitive',assessment:null,forbidden:['127.0.0.1:9']},
  {probe:'sensitive_fill',reason:'scenario_sensitive',assessment:null,forbidden:['user@example.com']},
  {probe:'non_loopback',reason:'scenario_url_host',assessment:null,forbidden:['example.invalid']},
  {probe:'outside_repository',reason:'repository_outside_session_cwd',assessment:null,forbidden:['"../external"']},
  {probe:'unsafe_assessment',reason:'invalid_or_unavailable_input',assessment:'invalid_context',forbidden:['example.invalid']},
  {probe:'unsupported_action',reason:'scenario_action',assessment:null,forbidden:[nativeCanary]},
 ];
 // Content-reactive delegation router. Parent and child sessions share one loopback provider;
 // dispatch keys on the child executor system prompt and each step keys on tool-result content.
 const delegationMarker='Fixture delegated slice',delegationGate='[delegation-verification-gate]';
 const childStallMs=Number.parseInt(process.env.SMOKE_DELEGATION_STALL_MS??'0',10)||0;
 let delegationTurn='launch',delegationPolls=0,mockHits=0;
 const delegationChain={launchEnvelope:'pending_async',jobId:null,terminalGate:false,loopStatuses:[],runStatus:null,receiptPersisted:null};
 const toolResultTexts=data=>[...((data.messages??data.input)??[])].filter(m=>m.role==='tool'||m.type==='function_call_output').map(m=>{const content=m.output??m.content;return typeof content==='string'?content:Array.isArray(content)?content.map(entry=>entry?.text??'').join(''):JSON.stringify(content??'');});
 async function delegationDecision(data){
  const body=JSON.stringify(data);
  const results=toolResultTexts(data);
  const last=results[results.length-1]??'';
  if(body.includes('You are Executor')){
   assert.ok(body.includes(delegationMarker),'child_assignment_marker_missing');
   // Optional bounded stall (SMOKE_DELEGATION_STALL_MS > pollWaitDuration) exercises the
   // running-snapshot re-poll path; the default keeps the acceptance run fast.
   if(results.length===0){if(childStallMs>0)await new Promise(resolve=>setTimeout(resolve,childStallMs));return {call:{name:'write',args:{path:'feature.mjs',content:"export const fixture = 'delegated-slice';\n"}}};}
   if(results.length===1)return {call:{name:'write',args:{path:'feature.test.mjs',content:"import test from 'node:test';test('fixture', () => {});\n"}}};
   return {final:'Fixture delegated slice complete: feature.mjs and feature.test.mjs written.'};
  }
  if(results.length===0){delegationTurn='launch';return {call:{name:'task',args:{agent:'executor',tasks:[{id:'fixture-slice',description:'Fixture slice',assignment:delegationMarker+': create feature.mjs and a passing feature.test.mjs in the repository.'}]}}};}
  if(last.includes('Results will be delivered when complete')){
   assert.ok(!last.includes(delegationGate),'launch_envelope_gated');
   const job=/\(job `([^`]+)`\)/.exec(last);assert.ok(job,'launch_envelope_job_id_missing');
   delegationChain.jobId=job[1];delegationTurn='poll';
   return {call:{name:'job',args:{poll:[job[1]]}}};
  }
  if(last.includes('## Still Running')||last.includes('## Waiting')){
   delegationPolls++;assert.ok(delegationPolls<=10,'delegation_poll_bound_exceeded');delegationTurn='poll';
   return {call:{name:'job',args:{poll:[delegationChain.jobId]}}};
  }
  if(last.includes(delegationGate)){
   assert.ok(delegationTurn==='poll','terminal_gate_unexpected_turn:'+delegationTurn);
   assert.ok(last.includes('## Completed'),'terminal_gate_without_completed_section');
   delegationChain.terminalGate=true;delegationTurn='loop-gaps';
   return {call:{name:'verification_loop',args:{}}};
  }
  const begin=last.indexOf('{'),end=last.lastIndexOf('}');
  let parsed=null;if(begin>=0&&end>begin){try{parsed=JSON.parse(last.slice(begin,end+1));}catch{}}
  if(parsed&&parsed.openGates!==undefined&&parsed.resolvedGates!==undefined){
   if(parsed.status==='gaps'){assert.ok(parsed.openGates>=1,'first_loop_missing_open_gates');delegationChain.loopStatuses.push('gaps');delegationTurn='run';
    return {call:{name:'verification_run',args:{files:['feature.mjs','feature.test.mjs']}}};}
   assert.equal(parsed.status,'clean','second_loop_not_clean:'+JSON.stringify(parsed.gapKinds));
   assert.ok(parsed.resolvedGates>=1,'second_loop_missing_resolved_gates');delegationChain.loopStatuses.push('clean');delegationTurn='done';
   return {final:'Delegated slice verified: verification_loop is clean.'};
  }
  if(parsed&&parsed.receipt!==undefined){
   assert.equal(parsed.receipt.execution.status,'passed','delegation_run_not_passed:'+parsed.receipt.execution.status);
   assert.equal(parsed.persisted,true,'delegation_receipt_not_persisted:'+parsed.reason);
   assert.deepEqual(parsed.assessment,{status:'unavailable',reason:'off'},'automatic_assessment_missing_or_offline_guard_failed');
   delegationChain.runStatus=parsed.receipt.execution.status;delegationChain.receiptPersisted=parsed.persisted;delegationTurn='loop-clean';
   return {call:{name:'verification_loop',args:{}}};
  }
  throw Error('unexpected_turn:'+step+':'+last.slice(0,160));
 }
 const journalLock=()=>path.join(env.HOME,'.gjc-plugin',plugin,'journal','v1','.append.lock');
 const metricsBase=path.join(env.HOME,'.gjc-plugin');
 let metricsBefore;
 async function metricsFingerprint(){
  const entries=[];
  async function visit(dir){
   for(const name of (await fs.readdir(dir)).sort()){
    const file=path.join(dir,name),info=await fs.lstat(file);
    assert.ok(!info.isSymbolicLink(),'unexpected_fixture_symlink');
    entries.push([path.relative(metricsBase,file),info.mode,info.nlink,info.size,info.isFile()?createHash('sha256').update(await fs.readFile(file)).digest('hex'):null]);
    if(info.isDirectory())await visit(file);
   }
  }
  try{await visit(metricsBase);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  return entries;
 }
 async function seedMetrics(){
  await assertSmokeIsolation(env,owned);
  // Execute the canonical TS writer only in the sanitized fixture HOME.
  // Explicit baseDir is required even with the isolated child environment.
  const seedFile=path.join(owned,'seed-metrics.ts');
  await fs.writeFile(seedFile,`
import {appendPluginOutcome} from ${JSON.stringify(path.join(worktree,'shared/lib/results.ts'))};
const baseDir=${JSON.stringify(metricsBase)};
const cases=[
 // Seed the new enum reasons so the installed reader must accept them, without
 // changing the asserted operation/duration counts.
 ['verification-receipts',{operation:'run',durationMs:1234,assessment:{status:'invalid_input',reason:'invalid_case_id'}}],
 ['verification-receipts',{operation:'status',durationMs:9999}],
 ['ui-regression',{operation:'run',durationMs:0,execution:{status:'not_run',reason:'scenario_url_host'}}],
 ['jev-advisor',{operation:'task_advice',durationMs:42,taskAdvice:[{index:0,status:'no_decision',reason:'disabled'}]}],
 ['jev-advisor',{operation:'advise',advice:{status:'no_decision',reason:'disabled'}}],
];
for(const [plugin,outcome] of cases){
 const result=await appendPluginOutcome(plugin as any,outcome,{baseDir});
 if(!result.persisted)throw Error('isolated_seed_failed:'+result.reason);
}
`,{mode:0o600,flag:'wx'});
  execFileSync('bun',['--no-env-file',seedFile],{env,cwd:root,stdio:'pipe',timeout:30000});
  metricsBefore=await metricsFingerprint();
 }
 async function seedCapacityFixtures(){
  // Owned isolated metadata fixtures, not new execution claims or production history.
  const base=path.join(env.HOME,'.gjc-plugin','verification-receipts','receipts','v1'),dirs=await fs.readdir(base);assert.equal(dirs.length,1);
  const dir=path.join(base,dirs[0]),existing=await fs.readdir(dir);assert.equal(existing.length,4);
  const reference=JSON.parse(await fs.readFile(path.join(dir,passId+'.json'),'utf8'));
  capacitySeeds=200-existing.length;
  for(let index=0;index<capacitySeeds;index++){
   const envelope=structuredClone(reference),id=randomUUID();envelope.receipt.id=id;envelope.selectedInputs.receiptId=id;
   envelope.selectedInputs.digest=createHash('sha256').update(JSON.stringify([id,envelope.receipt.repositoryDigest,envelope.receipt.specDigest,envelope.selectedInputs.files])).digest('hex');
   await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify(envelope),{mode:0o600,flag:'wx'});
  }
 }
 server=http.createServer(async(req,res)=>{
  try {
   if(uiMode&&req.url==='/'){if(req.method!=='GET'){submissions++;res.writeHead(405);res.end();return;}res.writeHead(200,{'content-type':'text/html'});res.end(fixtureBody);return;}
   if(uiMode&&req.url==='/favicon.ico'){res.writeHead(404);res.end();return;}
   if(req.method==='GET'&&req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'gpt-4o',object:'model',owned_by:'local'}]}));return;}
   assert.ok(['/v1/chat/completions','/v1/responses'].includes(req.url),'unexpected_local_endpoint:'+req.method+':'+req.url);
   const responses=req.url==='/v1/responses';
   let body='';for await(const c of req){body+=c;if(body.length>2e6)throw Error('local_request_cap');}
   const data=JSON.parse(body);mockHits++;
   if(step===0){
    const schemas=new Map((data.tools??[]).map(t=>{const f=t.function??t;return [f.name,f.parameters??f.input_schema];}));
    discovered=[...schemas.keys()];assert.ok(toolNames.every(n=>discovered.includes(n)),'installed_tool_discovery_failed');
    if(!advisorMode&&!checkMode&&!metricsMode&&!delegationMode){
     // Caller text must reach the plugin: inside assessment (and the UI scenario) the wire
     // schema carries no host-rejectable keyword; eligible ids live only in the description.
     const expectedIds=uiMode||uiRejectionsMode?['step-0','step-19']:['run'];
     for(const name of toolNames){
      const parameters=schemas.get(name),contract=advertisedAssessmentContract(parameters);
      const scenarioConstraints=name==='ui_regression_run'?rejectableConstraints(parameters?.properties?.scenario,'scenario'):[];
      // Record the advertised schema first so a mismatch still leaves an observation.
      discoveredSchemas.push({tool:name,assessment:contract.present,idType:contract.idType,descriptionLength:contract.idDescription.length,descriptionNamesIds:expectedIds.every(id=>contract.idDescription.includes(id)),descriptionNamesRejection:contract.idDescription.includes('invalid_case_id'),assessmentConstraints:contract.constraints,scenarioConstraints});
      assert.ok(contract.present,`assessment_schema_missing:${name}`);
      assert.equal(contract.idType,'string',`case_note_id_not_plain_string:${name}`);
      assert.deepEqual(contract.constraints,[],`assessment_host_rejectable_keywords:${name}`);
      assert.deepEqual(scenarioConstraints,[],`scenario_host_rejectable_keywords:${name}`);
      assert.ok(expectedIds.every(id=>contract.idDescription.includes(id)),`case_note_id_description_missing_ids:${name}`);
      assert.ok(contract.idDescription.includes('invalid_case_id'),`case_note_id_description_missing_rejection:${name}`);
     }
    }
   }
   else if(!delegationMode){
    const tool=[...(data.messages??data.input)].reverse().find(m=>m.role==='tool'||m.type==='function_call_output');assert.ok(tool,'host_tool_result_missing');
    const content=tool.output??tool.content;
    const text=typeof content==='string'?content:content.map(c=>c.text??'').join('');
    const begin=advisorMode&&step===2?text.lastIndexOf('{"journalStorage":'):text.indexOf('{');
    const result=parseAdapterResult(text,begin);
    if(!result){
     // Every probe must reach the adapter: a host-side rejection here is the echo path this
     // smoke exists to forbid. Record whether caller text leaked, then fail.
     assert.fail('unexpected_unparsable_tool_result:'+step+':'+JSON.stringify({canaryEcho:text.includes(nativeCanary),idEcho:text.includes('policy')}));
    }else if(metricsMode){
     assert.equal(result.schemaVersion,1);assert.equal(result.report,'plugin_metrics');
     assert.equal(result.mode,'offline_descriptive');assert.equal(result.window,'all_retained');
     assert.equal(result.scope,'current_process_home_all_repositories');
     assert.equal(result.correlation.status,'missing');
     assert.ok(Object.values(result.unavailableMeasures).every(value=>value===null));
     assert.equal(result.limitations[0],'retained_not_lifetime');
     for(const source of Object.values(result.plugins))assert.equal(source.status,step===1?'missing':'ok');
     if(step===1){
      assert.equal(result.status,'unavailable');assert.equal(await metricsFingerprint(),null,'missing_report_created_store');
      evidence.push({probe:'metrics_missing',status:'passed',nonmutating:true});
      await seedMetrics();
     }else{
      assert.equal(result.status,'partial');
      const verification=result.plugins['verification-receipts'].metrics;
      assert.deepEqual(verification.operations,{run:1,status:1});
      assert.deepEqual(verification.run.recordedReceiptDurationMs,{measured:1,sum:1234,average:1234});
      assert.equal(verification.status.recordedReceiptDurationMs,null);
      assert.deepEqual(result.plugins['ui-regression'].metrics.run.recordedReceiptDurationMs,{measured:1,sum:0,average:0});
      assert.equal(result.plugins['jev-advisor'].metrics.taskAdvice.entries,1);
      assert.deepEqual(await metricsFingerprint(),metricsBefore,'metrics_mutated_retained_sources');
      evidence.push({probe:'metrics_seeded',status:'passed',runStatusSeparated:true,measuredZeroPreserved:true,nonmutating:true});
     }
    }else{
    const expectedJournalFailure=!advisorMode&&!uiMode&&!checkMode&&step===11;
    assert.equal(result.journalStorage.persisted,!expectedJournalFailure,'outcome_journal_confirmation_mismatch');if(!expectedJournalFailure)journalIds.push(result.journalStorage.id);
    // Deliberate assessment outcomes: ui steps 13/14 (invalid_case_id / invalid_context),
    // the default case-id membership probe (step 12) and the ui-rejections unsafe assessment.
    const deliberateAssessment=uiMode?step===13||step===14:uiRejectionsMode?step===5:step===12;
    if(!advisorMode&&!checkMode&&!deliberateAssessment)assert.deepEqual(result.assessment,{status:'unavailable',reason:'off'},'automatic_assessment_missing_or_offline_guard_failed');
    if(advisorMode){
     if(step===1||step===3){assert.equal(result.status,'no_decision');assert.equal(result.reason,step===1?'disabled':'invalid_task');evidence.push({probe:step===1?'manual_disabled':'manual_invalid',status:result.status,reason:result.reason});}
     if(step===2){assert.ok(text.includes('No v2 store exists yet.'));evidence.push({probe:'calibration',networkFree:true,correlationReadOnly:true});}
    }else if(checkMode){
     assert.equal(result.status,'no_decision');
     if(step===1){assert.equal(result.reason,'disabled');evidence.push({probe:'check_offline',status:result.status,reason:result.reason});}
     if(step===2){assert.equal(result.reason,'invalid_task');evidence.push({probe:'check_invalid_input',status:result.status,reason:result.reason});}
     if(step===3){assert.equal(result.reason,'input_too_large');evidence.push({probe:'check_oversized',status:result.status,reason:result.reason});}
	     assert.ok(!text.includes('PRIVATE-CHECK-QUESTION'),'check_result_leaked_private_text');
    }else if(uiMode){
     assert.equal(result.advisoryOnly,true);
     // Deltas cover the call emitted by the previous step; the Aside counter is the launch oracle.
     const launches=await asideLaunchCount(asideLaunchCounterPath(owned)),receipts=await receiptFileCount(env);
     const launchDelta=launches-launchSnapshot,receiptDelta=receipts-receiptSnapshot;launchSnapshot=launches;receiptSnapshot=receipts;
     if(step===1){assert.equal(result.receipt.execution.status,'passed');assert.equal(result.receipt.execution.assertions.length,2);assert.equal(result.receipt.execution.cleanup,'confirmed');assert.equal(result.persisted,true);assert.ok(launchDelta>=1,'positive_control_not_launched');passId=result.receipt.id;evidence.push({probe:'pass',status:'passed',assertions:result.receipt.execution.assertions,cleanup:'confirmed',launchDelta});}
     if(step===2){assert.equal(result.freshness,'fresh');assert.equal(result.currentUiState,'not_reobserved');assert.equal(result.browserBuildBinding,'unverified');evidence.push({probe:'status',freshness:'fresh',currentUiState:'not_reobserved'});}
     if(step===3){assert.equal(result.receipt.execution.status,'failed');assert.equal(result.receipt.execution.reason,'assertion_failed');assert.equal(result.receipt.execution.cleanup,'confirmed');assert.ok(result.recommendedNextActions.length>0);await fs.writeFile(path.join(root,'pass.mjs'),'// changed source\n');evidence.push({probe:'mismatch',status:'failed',assertions:result.receipt.execution.assertions,cleanup:'confirmed',warningOnly:true});}
     if(step===4){assert.equal(result.freshness,'stale');assert.equal(result.receipt.execution.status,'passed');evidence.push({probe:'source_change',freshness:'stale',historicalStatus:'passed'});}
     if(step===5){assert.equal(result.execution.status,'not_run');assert.equal(result.receiptLoadable,false);evidence.push({probe:'empty_substring',status:'not_run'});}
     if(step===6){assert.equal(result.execution.status,'unavailable');evidence.push({probe:'missing_receipt',status:'unavailable'});}
     const rejected=(probe,reason,forbidden)=>{assert.equal(result.execution.status,'not_run');assert.equal(result.execution.reason,reason);assert.ok(!result.receipt,'rejection_wrote_receipt');assert.equal(launchDelta,0,'rejection_launched_browser');assert.equal(receiptDelta,0,'rejection_wrote_receipt_file');assert.ok(!text.includes(forbidden),'rejection_echoed_input');evidence.push({probe,status:'rejected',reason,launchDelta,receiptDelta});};
     if(step===7)rejected('scene_selector_unsafe','scenario_selector_unsafe','#password');
     if(step===8)rejected('scene_sensitive_fill','scenario_sensitive','user@example.com');
     if(step===9)rejected('scene_non_loopback','scenario_url_host','example.invalid');
     if(step===10)rejected('scene_sensitive_url','scenario_url_sensitive','127.0.0.1:9');
     if(step===12)rejected('scene_unsupported_action','scenario_action',nativeCanary);
     if(step===11){assert.equal(result.execution.status,'not_run');assert.equal(result.execution.reason,'repository_outside_session_cwd');assert.ok(!result.receipt);assert.equal(launchDelta,0,'external_repository_launched_browser');assert.equal(receiptDelta,0,'external_repository_wrote_receipt');evidence.push({probe:'external_repository',status:'rejected',reason:result.execution.reason,launchDelta,receiptDelta});}
     if(step===13){
      // Shape-valid but unobserved id: the scenario really runs, then membership rejects the note.
      assert.equal(result.receipt?.execution.status,'passed','unobserved_case_did_not_execute');
      assert.equal(result.assessment?.reason,'invalid_case_id');
      assert.ok(launchDelta>=1,'unobserved_case_not_launched');assert.equal(receiptDelta,1,'unobserved_case_receipt_delta');
      const allowed=result.guidance?.allowedCaseIds??result.allowedCaseIds;if(allowed!==undefined)assert.deepEqual(allowed,['step-1']);
      assert.ok(text.includes('step-1'),'guidance_missing_observed_case_id');
      assert.ok(!text.includes('step-3'),'unobserved_case_id_echoed');
      evidence.push({probe:'unobserved_case_id',status:'invalid_case_id',reason:result.assessment.reason,launchDelta,receiptDelta,allowedCaseIds:allowed??['step-1'],guidanceNamesObservedId:true});
     }
     if(step===14){
      // Unsafe/shape assessment: deterministic invalid_context before any launch; the
      // execution reason stays the generic not_run reason, not a caller value.
      assert.equal(result.execution.status,'not_run');assert.equal(result.execution.reason,'invalid_or_unavailable_input');
      assert.equal(result.assessment?.reason,'invalid_context');assert.ok(!result.receipt);
      assert.equal(launchDelta,0,'unsafe_assessment_launched_browser');assert.equal(receiptDelta,0,'unsafe_assessment_wrote_receipt');
      assert.ok(!text.includes('example.invalid'),'unsafe_assessment_echoed');
      evidence.push({probe:'unsafe_assessment',status:'invalid_context',launchDelta,receiptDelta,executionReason:result.execution.reason});
     }
     assert.ok(!text.includes('fixture message')&&!text.includes(account),'private_ui_data_in_result');
    }else if(uiRejectionsMode){
     // Pre-browser rejection proof: the inert Aside observer must never move, no receipt
     // may be written, and only fixed reasons may reach the journal.
     assert.equal(result.advisoryOnly,true);
     const launches=await asideLaunchCount(asideLaunchCounterPath(owned)),receipts=await receiptFileCount(env);
     const launchDelta=launches-launchSnapshot,receiptDelta=receipts-receiptSnapshot;launchSnapshot=launches;receiptSnapshot=receipts;
     const expected=uiRejectionExpectations[step-1];assert.ok(expected,'ui_rejection_probe_unexpected_step:'+step);
     assert.equal(result.execution.status,'not_run');assert.equal(result.execution.reason,expected.reason);
     assert.ok(!result.receipt,'ui_rejection_returned_receipt');
     assert.equal(launchDelta,0,'ui_rejection_launched_aside');assert.equal(receiptDelta,0,'ui_rejection_wrote_receipt');
     if(expected.assessment){assert.equal(result.assessment?.status,'invalid_input');assert.equal(result.assessment?.reason,expected.assessment);}
     for(const value of expected.forbidden)assert.ok(!text.includes(value),'ui_rejection_echoed_input:'+expected.probe);
     assert.ok(!text.includes(account),'ui_rejection_echoed_account');
     evidence.push({probe:expected.probe,status:'rejected',reason:result.execution.reason,assessmentReason:result.assessment?.reason??null,launchDelta,receiptDelta});
    }else{
    if(step===1){assert.equal(result.receipt.execution.status,'passed');assert.equal(result.receipt.execution.counts.tests,1);assert.equal(result.persisted,true,'receipt_admission:'+result.reason);passId=result.receipt.id;evidence.push({probe:'pass',status:'passed',counts:result.receipt.execution.counts});}
    if(step===2){assert.equal(result.freshness,'fresh');evidence.push({probe:'status',freshness:'fresh'});}
    if(step===3){assert.equal(result.receipt.execution.status,'failed');assert.ok(result.recommendedNextActions.length>0);assert.equal(result.advisoryOnly,true);assert.ok(!text.includes('SYNTHETIC_CANARY'));evidence.push({probe:'failure',status:'failed',counts:result.receipt.execution.counts,warningOnly:true});}
    if(step===4){assert.equal(result.receipt.execution.status,'no_tests');await fs.writeFile(path.join(root,'ignored','case.mjs'),"import test from 'node:test';test('ignored mismatch',()=>{throw Error('OWNED_MISMATCH');});");evidence.push({probe:'empty',status:'no_tests',counts:result.receipt.execution.counts});}
    if(step===5){assert.equal(result.freshness,'stale');assert.equal(result.receipt.execution.status,'passed');assert.equal(result.advisoryOnly,true);evidence.push({probe:'ignored_only_source_change',freshness:'stale',historicalStatus:'passed'});}
    if(step===6){assert.equal(result.receipt.execution.status,'failed');evidence.push({probe:'ignored_failed_run',status:'failed',counts:result.receipt.execution.counts});}
    if(step===7){assert.equal(result.execution.status,'not_run');evidence.push({probe:'invalid_input',status:'not_run'});}
    if(step===8){assert.equal(result.execution.status,'unavailable');evidence.push({probe:'missing_receipt',status:'unavailable'});await seedCapacityFixtures();}
    if(step===9){assert.equal(result.receipt.execution.status,'passed');assert.equal(result.receipt.execution.counts.passed,1);assert.equal(result.persisted,false);assert.equal(result.reason,'store_full');assert.equal(result.receiptLoadable,false);assert.ok(result.warnings.includes('receipt_store_full'));evidence.push({probe:'receipt_full',status:'passed',receiptPersisted:false,receiptLoadable:false,journalPersisted:true,count:result.count});}
    if(step===10){assert.equal(result.freshness,'stale');assert.equal(result.receiptLoadable,true);evidence.push({probe:'status_after_full',freshness:'stale',journalPersisted:true});await fs.writeFile(journalLock(),'foreign-owned-smoke-lock',{mode:0o600,flag:'wx'});}
    if(step===11){assert.equal(result.receipt.execution.status,'passed');assert.equal(result.receipt.execution.counts.passed,1);assert.equal(result.journalStorage.reason,'store_busy');assert.ok(result.warnings.includes('journal_not_persisted'));assert.equal(await fs.readFile(journalLock(),'utf8'),'foreign-owned-smoke-lock');await fs.unlink(journalLock());evidence.push({probe:'journal_busy',status:'passed',receiptPersisted:false,journalPersisted:false,journalReason:'store_busy',foreignLockUnchanged:true});
    }
    if(step===12){
     // Privacy is asserted unconditionally on result and journal bytes; the receipt-store
     // outcome is recorded as evidence only, never as the condition of this probe.
     assert.equal(result.receipt.execution.status,'passed');
     assert.deepEqual(result.assessment,{status:'invalid_input',reason:'invalid_case_id'});
     assert.ok(result.warnings.includes('assessment_case_id_rejected'),'case_id_rejection_warning_missing');
     assert.ok(result.recommendedNextActions.some(action=>action.includes('run')),'case_id_guidance_missing_allowed_ids');
     assert.equal(result.journalStorage.persisted,true);
     const journal=await journalText(env,plugin);
     const canaryEcho=text.includes(nativeCanary),idEcho=text.includes('policy'),journalCanaryEcho=journal.includes(nativeCanary),journalIdEcho=journal.includes('policy');
     assert.ok(!canaryEcho,'case_id_result_echoed_canary');assert.ok(!idEcho,'case_id_result_echoed_id');
     assert.ok(!journalCanaryEcho,'case_id_journal_echoed_canary');assert.ok(!journalIdEcho,'case_id_journal_echoed_id');
     evidence.push({probe:'case_id_membership',status:'invalid_case_id',canaryEcho,idEcho,journalCanaryEcho,journalIdEcho,journalPersisted:true,receiptStorageObserved:{persisted:result.persisted,reason:result.reason??null}});
    }
    if(step===13){assert.equal(result.receipt.execution.status,'passed');assert.deepEqual(result.assessment,{status:'unavailable',reason:'off'});assert.ok(result.journalStorage.persisted);evidence.push({probe:'valid_after_rejection',status:'passed',assessmentReason:result.assessment.reason,receiptStorageObserved:{persisted:result.persisted,reason:result.reason??null}});}
    }
   }
   }
   const decision=delegationMode?(await delegationDecision(data)):(step<calls.length?{call:calls[step]()}:{final:'Installed isolated host smoke finished.'});
   res.writeHead(200,{'content-type':'text/event-stream'});
   if(responses){
    const send=e=>res.write('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');
    const response={id:'resp_local_'+step,status:'completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
    send({type:'response.created',response:{...response,status:'in_progress'}});
    if(decision.call){const item={id:'fc_local_'+step,type:'function_call',call_id:'local_call_'+step,name:decision.call.name,arguments:JSON.stringify(decision.call.args),status:'completed'};
     send({type:'response.output_item.added',output_index:0,item:{...item,arguments:''}});
     send({type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments});
     send({type:'response.output_item.done',output_index:0,item});
     send({type:'response.completed',response:{...response,output:[item]}});
    }else{const item={id:'msg_local',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:decision.final,annotations:[]}]};
     send({type:'response.output_item.added',output_index:0,item:{...item,content:[]}});
     send({type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:decision.final});
     send({type:'response.output_item.done',output_index:0,item});send({type:'response.completed',response:{...response,output:[item]}});
    }
    step++;res.end();return;
   }
   const base={id:'local-'+step,object:'chat.completion.chunk',created:0,model:'gpt-4o'};
   if(decision.call){res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'local_call_'+step,type:'function',function:{name:decision.call.name,arguments:JSON.stringify(decision.call.args)}}]},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');}
   else {res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:decision.final},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');}
   step++;res.end('data: [DONE]\n\n');
  }catch(error){mockError='step='+step+' '+error.message;res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'local_probe_failed'}}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));env.OPENAI_BASE_URL='http://127.0.0.1:'+server.address().port+'/v1';
 if(uiMode||uiRejectionsMode){scenario=JSON.parse(await fs.readFile(path.join(worktree,'ui-regression/tests/fixtures/scenario.json'),'utf8'));scenario.steps[0].url='http://127.0.0.1:'+server.address().port+'/';}
 let host,hostTimeout=false;
 try{host=await child(['--print','--no-session','--no-title','--no-mcp','--no-lsp','--no-rules','--no-pty','--model','openai/gpt-4o','--thinking','off','--tools',toolNames.join(','),'Execute explicitly authorized non-sensitive local fixture tools selected by the local test provider. Do not assess or use other tools.'],delegationMode?180000:90000);}
 catch(error){if(!(delegationMode&&error.message==='host_timeout'))throw error;hostTimeout=true;host={code:'timeout',output:'',errors:''};}
 assert.equal(mockError,'',mockError);
 if(!hostTimeout){assert.equal(host.code,0,'installed_dispatch_failed');if(!delegationMode)assert.equal(step,calls.length+1,'installed_dispatch_incomplete');assert.equal(submissions,0);if(!loopMode)assert.ok(mockHits>0,'host_chat_router_requests_missing');}
 if(hostTimeout){
  report={schemaVersion:1,kind:'package-consumer-report',mode:'delegation',hostMode:'delegation',timedOut:true,lastTurn:delegationTurn,polls:delegationPolls,providerRequests:mockHits,step};
  process.exitCode=1;
 }else if(delegationMode){
  assert.equal(delegationTurn,'done','delegation_incomplete:'+delegationTurn);
  assert.deepEqual(delegationChain.loopStatuses,['gaps','clean'],'delegation_loop_statuses');
  assert.equal(delegationChain.terminalGate,true,'delegation_terminal_gate_missing');
  assert.equal(delegationChain.runStatus,'passed');assert.equal(delegationChain.receiptPersisted,true);
  await fs.access(path.join(root,'feature.mjs'));await fs.access(path.join(root,'feature.test.mjs'));
  const loopRoot=path.join(env.HOME,'.gjc-plugin','verification-receipts','loop','v1'),repoDirs=await fs.readdir(loopRoot);assert.equal(repoDirs.length,1,'delegation_loop_state_missing');
  const sessionFiles=(await fs.readdir(path.join(loopRoot,repoDirs[0]))).filter(name=>name.endsWith('.json'));assert.equal(sessionFiles.length,1,'delegation_loop_session_files');
  const loopState=JSON.parse(await fs.readFile(path.join(loopRoot,repoDirs[0],sessionFiles[0]),'utf8'));
  const gateRecord=loopState.gates.find(entry=>entry.trigger==='job_terminal');assert.ok(gateRecord,'delegation_job_terminal_gate_missing');
  assert.ok(gateRecord.baselineToolCallId,'delegation_gate_missing_baseline_link');assert.equal(gateRecord.resolution,'receipt','delegation_gate_resolution');
  assert.equal(loopState.pendingAsync.length,1);assert.ok(loopState.pendingAsync[0].consumedAtGateId,'delegation_pending_async_not_consumed');
  const journal=path.join(env.HOME,'.gjc-plugin','verification-receipts','journal','v1'),inventory=JSON.parse(await fs.readFile(path.join(journal,'inventory.json'),'utf8'));
  const records=[];for(const segment of inventory.segments){const file=path.join(journal,segment.name),chunk=await fs.readFile(file);assert.equal(chunk.length,segment.bytes);assert.equal(createHash('sha256').update(chunk).digest('hex'),segment.digest);assert.equal((await fs.stat(file)).mode&0o777,0o600);records.push(...chunk.toString().trimEnd().split('\n').map(line=>JSON.parse(line)));}
  assert.deepEqual(records.map(record=>record.operation),['gate_emitted','loop_run','run','loop_run'],'journal_operation_sequence');
  assert.equal((await fs.stat(journal)).mode&0o777,0o700);
  const receipts=path.join(env.HOME,'.gjc-plugin','verification-receipts','receipts','v1');let receiptCount=0;for(const dir of await fs.readdir(receipts))for(const name of await fs.readdir(path.join(receipts,dir))){assert.ok(JSON.parse(await fs.readFile(path.join(receipts,dir,name),'utf8')).receipt.id);receiptCount++;}
  assert.equal(receiptCount,1,'delegation_receipt_count');
  report={schemaVersion:1,kind:'package-consumer-report',mode:'delegation',hostMode:'delegation',delegatedFromHost:true,hostVersion:execFileSync('gjc',['--version'],{env,encoding:'utf8'}).trim(),isolated:true,installedBundle:installedMode,productionCredentials:false,remoteProviderRequests:null,providerRequests:mockHits,submissions,standalone:false,tools:discovered.filter(n=>toolNames.includes(n)),chain:{launchEnvelope:delegationChain.launchEnvelope,jobId:delegationChain.jobId,polls:delegationPolls,terminalGate:delegationChain.terminalGate,loopStatuses:delegationChain.loopStatuses,run:{status:delegationChain.runStatus,persisted:delegationChain.receiptPersisted}},persistence:{root:'.gjc-plugin',operations:records.map(record=>record.operation),journalIds:records.map(record=>record.id),receiptCount,scratchArtifacts:['feature.mjs','feature.test.mjs'],privateModes:true}};
 }else if(metricsMode){
  report={schemaVersion:1,kind:'package-consumer-report',isolated:true,installedBundle:installedMode,productionCredentials:false,tools:discovered.filter(n=>toolNames.includes(n)),probes:evidence,nonmutating:true};
 }else{
 const journal=path.join(env.HOME,'.gjc-plugin',plugin,'journal','v1'),inventory=JSON.parse(await fs.readFile(path.join(journal,'inventory.json'),'utf8'));
 const records=[];for(const segment of inventory.segments){const file=path.join(journal,segment.name),body=await fs.readFile(file);assert.equal(body.length,segment.bytes);assert.equal(createHash('sha256').update(body).digest('hex'),segment.digest);assert.equal((await fs.stat(file)).mode&0o777,0o600);records.push(...body.toString().trimEnd().split('\n').map(line=>JSON.parse(line)));}
 assert.deepEqual(records.map(record=>record.id),journalIds);assert.equal((await fs.stat(journal)).mode&0o777,0o700);
 let receiptCount=0;
 if(uiRejectionsMode){
  // Zero receipts and exactly the fixed rejection reasons in the journal.
  receiptCount=await receiptFileCount(env);assert.equal(receiptCount,0,'ui_rejections_wrote_receipt');
  assert.deepEqual(records.map(record=>record.execution?.reason).filter(Boolean),uiRejectionExpectations.map(entry=>entry.reason),'ui_rejection_journal_reasons');
 }else if(!advisorMode&&!checkMode){const base=path.join(env.HOME,'.gjc-plugin','verification-receipts','receipts','v1');for(const dir of await fs.readdir(base)){for(const name of await fs.readdir(path.join(base,dir))){const envelope=JSON.parse(await fs.readFile(path.join(base,dir,name),'utf8'));assert.equal(envelope.storageSchemaVersion,1);assert.equal((await fs.stat(path.join(base,dir,name))).nlink,1);assert.ok(envelope.receipt.id);receiptCount++;}}assert.equal(receiptCount,uiMode?3:200);}
 const asideLaunches=uiMode||uiRejectionsMode?await asideLaunchCount(asideLaunchCounterPath(owned)):null;
 assert.equal(submissions,0,'local_fixture_mutation');
 report={schemaVersion:1,kind:'package-consumer-report',mode:uiRejectionsMode?'ui-rejections':null,realBrowserObserved:uiMode,counterControl:uiRejectionsMode?'synthetic-launch-only':null,hostVersion:execFileSync('gjc',['--version'],{env,encoding:'utf8'}).trim(),isolated:true,installedBundle:installedMode,productionCredentials:false,remoteProviderRequests:null,submissions,standalone:uiMode,tools:discovered.filter(n=>toolNames.includes(n)),schemas:discoveredSchemas,probes:evidence,evidenceScopes:{assessment:'explicit_off_isolated_home_configuration_only',hostChatRequests:mockHits,asideLaunches,asideLaunchCounterControl:asideObserverControl?'synthetic-launch-counted':'not_run',measuredAdequacyCalls:null},persistence:{root:'.gjc-plugin',receiptCount,syntheticCapacityMetadataEntries:capacitySeeds,journalIds,operations:records.map(record=>record.operation),privateModes:true}};
 }
 }
} finally {
 try {if(server)await new Promise(resolve=>server.close(resolve));}
 finally {
  await fs.rm(owned,{recursive:true,force:true});
  assert.equal(await configDigest(),beforeConfig,'user_config_changed_during_smoke');
 }
}
console.log(JSON.stringify({...report,userConfigUnchanged:true}));
