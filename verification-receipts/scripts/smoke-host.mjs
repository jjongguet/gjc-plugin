import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createSmokeEnvironment,assertSmokeIsolation} from './smoke-environment.mjs';
const worktree=process.cwd();
const uiMode=process.argv.includes('--ui');
const advisorMode=process.argv.includes('--advisor');
assert.ok(!(uiMode&&advisorMode),'ambiguous_smoke_surface');
const installedMode=process.argv.includes('--installed');
const plugin=advisorMode?'jev-advisor':uiMode?'ui-regression':'verification-receipts';
const toolNames=advisorMode?['jev_advise']:uiMode?['ui_regression_run','ui_regression_status']:['verification_run','verification_status'];
const account=process.env.UI_REGRESSION_ACCOUNT;
if(uiMode&&!account)throw Error('explicit_ephemeral_account_required');
const userAgent=path.resolve(process.env.GJC_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(),'.gjc','agent'));
const userConfig=path.join(userAgent,'config.yml');
async function configDigest(){try{return createHash('sha256').update(await fs.readFile(userConfig)).digest('hex');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
const beforeConfig=await configDigest();
const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gjc-installed-smoke-')));
const root=path.join(owned,'repo');
let env,server,report;
async function child(args,timeout=60000){await assertSmokeIsolation(env,owned);return new Promise((resolve,reject)=>{let output='',errors='',bytes=0;const p=spawn('gjc',args,{cwd:root,env,shell:false,detached:true});const timer=setTimeout(()=>{try{process.kill(-p.pid,'SIGKILL');}catch{} reject(Error('host_timeout'));},timeout);p.stdout.on('data',c=>{bytes+=c.length;if(bytes<4e6)output+=c;});p.stderr.on('data',c=>{bytes+=c.length;if(bytes<4e6)errors+=c;});p.on('error',reject);p.on('close',code=>{clearTimeout(timer);resolve({code,output,errors});});});}
try {
 env=await createSmokeEnvironment(owned);
 await fs.mkdir(root,{mode:0o700});
 if(uiMode){
  const bin=path.join(owned,'bin');await fs.mkdir(bin,{mode:0o700});
  const realAside=execFileSync('which',['aside'],{encoding:'utf8',env:{PATH:process.env.PATH}}).trim();
  // Test-only router preserves existing Aside HOME while GJC and receipts stay isolated.
  const wrapper='#!/usr/bin/env node\nimport {spawn} from "node:child_process";const p=spawn('+JSON.stringify(realAside)+',process.argv.slice(2),{env:{HOME:'+JSON.stringify(process.env.HOME)+',PATH:'+JSON.stringify(process.env.PATH)+',TMPDIR:'+JSON.stringify(owned)+'},stdio:"inherit",shell:false});p.on("error",()=>process.exit(1));p.on("close",code=>process.exit(code??1));\n';
  await fs.writeFile(path.join(bin,'aside'),wrapper,{mode:0o700});env.PATH=bin+path.delimiter+process.env.PATH;
 }
 const git=(...args)=>execFileSync('git',args,{cwd:root,env:{PATH:process.env.PATH},stdio:'pipe'});
 git('init','-q');
 await fs.writeFile(path.join(root,'pass.mjs'),"import test from 'node:test';test('local fixture',()=>{});");
 await fs.writeFile(path.join(root,'fail.mjs'),"import test from 'node:test';test('deliberate local mismatch',()=>{throw Error('SYNTHETIC_CANARY');});");
 await fs.writeFile(path.join(root,'empty.mjs'),'');await fs.writeFile(path.join(root,'.gitignore'),'ignored/\n');await fs.mkdir(path.join(root,'ignored'));
 await fs.writeFile(path.join(root,'ignored','case.mjs'),"import test from 'node:test';test('explicit ignored fixture',()=>{});");
 git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
 // Installed bundles are read-only inputs; never run a test against the live user agent root.
 const bundle=installedMode?path.join(userAgent,'gjc-plugins',plugin):path.join(worktree,plugin);
 const install=await child(['plugin','install',bundle,'--user','--json']);
 assert.equal(install.code,0,'isolated_install_failed');
 const listing=await child(['plugin','list','--json']);assert.equal(listing.code,0,'isolated_list_failed');assert.ok(listing.output.includes(plugin),'installed_catalog_missing');
 if(uiMode)assert.ok(!listing.output.includes('verification-receipts'),'unexpected_sibling_install');
 let step=0,passId,capacitySeeds=0;const evidence=[],journalIds=[];let discovered=[];let mockError='';
 let scenario;let submissions=0;
 const fixtureBody=uiMode?await fs.readFile(path.join(worktree,'ui-regression/tests/fixtures/index.html')):null;
 const calls=advisorMode?[
  ()=>({name:'jev_advise',args:{assignment:'Non-sensitive local fixture advice',role:'executor'}}),
  ()=>({name:'jev_advise',args:{report:'calibration'}}),
  ()=>({name:'jev_advise',args:{}})
 ]:uiMode?[
  ()=>({name:toolNames[0],args:{account,scenario}}),
  ()=>({name:toolNames[1],args:{receiptId:passId}}),
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'local-mismatch',steps:scenario.steps.map((s,i)=>i===4?{...s,expected:'Deliberate mismatch'}:s)}}}),
  ()=>({name:toolNames[1],args:{receiptId:passId}}),
  ()=>({name:toolNames[0],args:{account,scenario:{...scenario,id:'empty-substring',steps:scenario.steps.map((s,i)=>i===4?{...s,match:'substring',expected:'   '}:s)}}}),
  ()=>({name:toolNames[1],args:{receiptId:'missing'}})
 ]:[()=>({name:'verification_run',args:{files:['ignored/case.mjs']}}),()=>({name:'verification_status',args:{receiptId:passId}}),()=>({name:'verification_run',args:{files:['fail.mjs']}}),()=>({name:'verification_run',args:{files:['empty.mjs']}}),()=>({name:'verification_status',args:{receiptId:passId}}),()=>({name:'verification_run',args:{files:['ignored/case.mjs']}}),()=>({name:'verification_run',args:{files:['../escape.mjs']}}),()=>({name:'verification_status',args:{receiptId:'missing'}}),()=>({name:'verification_run',args:{files:['pass.mjs']}}),()=>({name:'verification_status',args:{receiptId:passId}}),()=>({name:'verification_run',args:{files:['pass.mjs']}})];
 const journalLock=()=>path.join(env.HOME,'.gjc-plugin',plugin,'journal','v1','.append.lock');
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
   const data=JSON.parse(body);
   if(step===0){discovered=(data.tools??[]).map(t=>t.function?.name??t.name);assert.ok(toolNames.every(n=>discovered.includes(n)),'installed_tool_discovery_failed');}
   else {
    const tool=[...(data.messages??data.input)].reverse().find(m=>m.role==='tool'||m.type==='function_call_output');assert.ok(tool,'host_tool_result_missing');
    const content=tool.output??tool.content;
    const text=typeof content==='string'?content:content.map(c=>c.text??'').join('');
    const begin=advisorMode&&step===2?text.lastIndexOf('{"journalStorage":'):text.indexOf('{'),end=text.lastIndexOf('}');const result=JSON.parse(text.slice(begin,end+1));
    const expectedJournalFailure=!advisorMode&&!uiMode&&step===11;
    assert.equal(result.journalStorage.persisted,!expectedJournalFailure,'outcome_journal_confirmation_mismatch');if(!expectedJournalFailure)journalIds.push(result.journalStorage.id);
    if(!advisorMode)assert.deepEqual(result.assessment,{status:'unavailable',reason:'off'},'automatic_assessment_missing_or_offline_guard_failed');
    if(advisorMode){
     if(step===1||step===3){assert.equal(result.status,'no_decision');assert.equal(result.reason,step===1?'disabled':'invalid_task');evidence.push({probe:step===1?'manual_disabled':'manual_invalid',status:result.status,reason:result.reason});}
     if(step===2){assert.ok(text.includes('No v2 store exists yet.'));evidence.push({probe:'calibration',networkFree:true,correlationReadOnly:true});}
    }else if(uiMode){
     assert.equal(result.advisoryOnly,true);
     if(step===1){assert.equal(result.receipt.execution.status,'passed');assert.equal(result.receipt.execution.assertions.length,2);assert.equal(result.receipt.execution.cleanup,'confirmed');assert.equal(result.persisted,true);passId=result.receipt.id;evidence.push({probe:'pass',status:'passed',assertions:result.receipt.execution.assertions,cleanup:'confirmed'});}
     if(step===2){assert.equal(result.freshness,'fresh');assert.equal(result.currentUiState,'not_reobserved');assert.equal(result.browserBuildBinding,'unverified');evidence.push({probe:'status',freshness:'fresh',currentUiState:'not_reobserved'});}
     if(step===3){assert.equal(result.receipt.execution.status,'failed');assert.equal(result.receipt.execution.reason,'assertion_failed');assert.equal(result.receipt.execution.cleanup,'confirmed');assert.ok(result.recommendedNextActions.length>0);await fs.writeFile(path.join(root,'pass.mjs'),'// changed source\n');evidence.push({probe:'mismatch',status:'failed',assertions:result.receipt.execution.assertions,cleanup:'confirmed',warningOnly:true});}
     if(step===4){assert.equal(result.freshness,'stale');assert.equal(result.receipt.execution.status,'passed');evidence.push({probe:'source_change',freshness:'stale',historicalStatus:'passed'});}
     if(step===5){assert.equal(result.execution.status,'not_run');assert.equal(result.receiptLoadable,false);evidence.push({probe:'empty_substring',status:'not_run'});}
     if(step===6){assert.equal(result.execution.status,'unavailable');evidence.push({probe:'missing_receipt',status:'unavailable'});}
     assert.ok(!text.includes('fixture message')&&!text.includes(account),'private_ui_data_in_result');
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
    if(step===11){assert.equal(result.receipt.execution.status,'passed');assert.equal(result.receipt.execution.counts.passed,1);assert.equal(result.journalStorage.reason,'store_busy');assert.ok(result.warnings.includes('journal_not_persisted'));assert.equal(await fs.readFile(journalLock(),'utf8'),'foreign-owned-smoke-lock');await fs.unlink(journalLock());evidence.push({probe:'journal_busy',status:'passed',receiptPersisted:false,journalPersisted:false,journalReason:'store_busy',foreignLockUnchanged:true});}
    }
   }
   res.writeHead(200,{'content-type':'text/event-stream'});
   if(responses){
    const send=e=>res.write('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');
    const response={id:'resp_local_'+step,status:'completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
    send({type:'response.created',response:{...response,status:'in_progress'}});
    if(step<calls.length){const call=calls[step]();const item={id:'fc_local_'+step,type:'function_call',call_id:'local_call_'+step,name:call.name,arguments:JSON.stringify(call.args),status:'completed'};
     send({type:'response.output_item.added',output_index:0,item:{...item,arguments:''}});
     send({type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments});
     send({type:'response.output_item.done',output_index:0,item});
     send({type:'response.completed',response:{...response,output:[item]}});
    }else{const item={id:'msg_local',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Installed isolated host smoke finished.',annotations:[]}]};
     send({type:'response.output_item.added',output_index:0,item:{...item,content:[]}});
     send({type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:item.content[0].text});
     send({type:'response.output_item.done',output_index:0,item});send({type:'response.completed',response:{...response,output:[item]}});
    }
    step++;res.end();return;
   }
   const base={id:'local-'+step,object:'chat.completion.chunk',created:0,model:'gpt-4o'};
   if(step<calls.length){const call=calls[step]();res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'local_call_'+step,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');}
   else {res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'Installed isolated host smoke finished.'},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');}
   step++;res.end('data: [DONE]\n\n');
  }catch(error){mockError='step='+step+' '+error.message;res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'local_probe_failed'}}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));env.OPENAI_BASE_URL='http://127.0.0.1:'+server.address().port+'/v1';
 if(uiMode){scenario=JSON.parse(await fs.readFile(path.join(worktree,'ui-regression/tests/fixtures/scenario.json'),'utf8'));scenario.steps[0].url='http://127.0.0.1:'+server.address().port+'/';}
 const host=await child(['--print','--no-session','--no-title','--no-mcp','--no-lsp','--no-rules','--no-pty','--model','openai/gpt-4o','--thinking','off','--tools',toolNames.join(','),'Execute explicitly authorized non-sensitive local fixture tools selected by the local test provider. Do not assess or use other tools.'],90000);
 assert.equal(mockError,'',mockError);assert.equal(host.code,0,'installed_dispatch_failed');assert.equal(step,calls.length+1,'installed_dispatch_incomplete');assert.equal(submissions,0);
 const journal=path.join(env.HOME,'.gjc-plugin',plugin,'journal','v1'),inventory=JSON.parse(await fs.readFile(path.join(journal,'inventory.json'),'utf8'));
 const records=[];for(const segment of inventory.segments){const file=path.join(journal,segment.name),body=await fs.readFile(file);assert.equal(body.length,segment.bytes);assert.equal(createHash('sha256').update(body).digest('hex'),segment.digest);assert.equal((await fs.stat(file)).mode&0o777,0o600);records.push(...body.toString().trimEnd().split('\n').map(line=>JSON.parse(line)));}
 assert.deepEqual(records.map(record=>record.id),journalIds);assert.equal((await fs.stat(journal)).mode&0o777,0o700);
 let receiptCount=0;
 if(!advisorMode){const base=path.join(env.HOME,'.gjc-plugin','verification-receipts','receipts','v1');for(const dir of await fs.readdir(base)){for(const name of await fs.readdir(path.join(base,dir))){const envelope=JSON.parse(await fs.readFile(path.join(base,dir,name),'utf8'));assert.equal(envelope.storageSchemaVersion,1);assert.equal((await fs.stat(path.join(base,dir,name))).nlink,1);assert.ok(envelope.receipt.id);receiptCount++;}}assert.equal(receiptCount,uiMode?2:200);}
 report={schemaVersion:1,kind:'package-consumer-report',hostVersion:execFileSync('gjc',['--version'],{env,encoding:'utf8'}).trim(),isolated:true,installedBundle:installedMode,productionCredentials:false,remoteProviderRequests:0,submissions,standalone:uiMode,tools:discovered.filter(n=>toolNames.includes(n)),probes:evidence,persistence:{root:'.gjc-plugin',receiptCount,syntheticCapacityMetadataEntries:capacitySeeds,journalIds,operations:records.map(record=>record.operation),privateModes:true}};
} finally {
 try {if(server)await new Promise(resolve=>server.close(resolve));}
 finally {
  await fs.rm(owned,{recursive:true,force:true});
  assert.equal(await configDigest(),beforeConfig,'user_config_changed_during_smoke');
 }
}
console.log(JSON.stringify({...report,userConfigUnchanged:true}));
