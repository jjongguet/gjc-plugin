import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createSmokeEnvironment,assertSmokeIsolation} from '../../verification-receipts/scripts/smoke-environment.mjs';

const script=fileURLToPath(import.meta.url);
if(process.argv[2]==='--isolated') {
 const owned=await fs.realpath(process.argv[3]),bundle=await fs.realpath(process.argv[4]);
 assert.equal(await fs.realpath(process.env.HOME),path.join(owned,'home'));
 assert.equal(os.homedir(),process.env.HOME);
 const origin=new URL(process.env.JEV_ADVISOR_ENDPOINT).origin;
 assert.equal(new URL(origin).hostname,'127.0.0.1');assert.equal(new URL(origin).protocol,'http:');
 const nativeFetch=globalThis.fetch;let providerRequests=0;
 globalThis.fetch=(url,options)=>{assert.equal(new URL(String(url)).origin,origin,'nonlocal_provider_refused');providerRequests++;return nativeFetch(url,options);};
 const pre=await import(pathToFileURL(path.join(bundle,'hooks/jev-advisor.ts')).href);
 const result=await import(pathToFileURL(path.join(bundle,'hooks/jev-advisor-result.ts')).href);
 const manual=await import(pathToFileURL(path.join(bundle,'tools/jev-advise.ts')).href);
 const hook=module=>{let handler;module.default({on:(_event,fn)=>{handler=fn;}});assert.equal(typeof handler,'function');return handler;};
 const statuses=[];const ctx={sessionManager:{getSessionId:()=> 'installed-owned-fixture'},ui:{setWidget(){},notify(){},setStatus:(_key,value)=>statuses.push(value)}};
 const input={agent:'executor',tasks:[{id:'owned-fixture',assignment:'Return the literal PRIVATE_ASSIGNMENT_CANARY result.',tier:'balanced'}]};
 await hook(pre)({type:'tool_call',toolName:'task',toolCallId:'installed-call',input},ctx);
 await hook(result)({type:'tool_result',toolName:'task',toolCallId:'installed-call',input,details:{results:[],async:{jobId:'installed-job',state:'running'}},isError:false},ctx);
 await hook(result)({type:'tool_result',toolName:'subagent',details:{subagents:[{id:'installed-child',jobId:'installed-job',status:'completed',durationMs:123,requestedModel:'synthetic/fixture',effectiveModel:'synthetic/fixture'}]},isError:false},ctx);
 const root=path.join(process.env.HOME,'.gjc-plugin'),file=path.join(root,'jev-advisor','state.v2.json');
 const stored=pre.readEvidenceV2(file);assert.equal(stored.status,'ok');
 const tasks=Object.values(stored.value.groups).flatMap(group=>Object.values(group.tasks)),jobs=Object.values(stored.value.jobs);
 assert.equal(tasks.length,1);assert.equal(tasks[0].advice.tier,'balanced');assert.equal(tasks[0].launchDisposition,'observed');assert.ok(tasks[0].jobKey);
 assert.equal(jobs.length,1);assert.equal(jobs[0].status,'completed');assert.equal(jobs[0].actualTier,null);assert.ok(jobs[0].taskKey);
 const Type=new Proxy({}, {get:()=> (...args)=>({args})});
 const response=await manual.default({typebox:{Type}}).execute('installed-report',{report:'calibration'});
 assert.ok(response.content[0].text.includes('"persisted":true'));assert.ok(response.content[0].text.includes('"stateOverrideIgnored":true'));
 const journal=path.join(root,'jev-advisor','journal','v1'),inventory=JSON.parse(await fs.readFile(path.join(journal,'inventory.json'),'utf8'));
 const rows=[];for(const segment of inventory.segments){const bytes=await fs.readFile(path.join(journal,segment.name));assert.equal(createHash('sha256').update(bytes).digest('hex'),segment.digest);rows.push(...bytes.toString().trimEnd().split('\n').map(line=>JSON.parse(line)));}
 assert.deepEqual(rows.map(row=>row.operation),['task_advice','task_launch','subagent_terminal','calibration']);assert.ok(rows.every(row=>row.stateOverrideIgnored));
 const data=JSON.stringify(stored.value)+JSON.stringify(rows);assert.ok(!data.includes('PRIVATE_ASSIGNMENT_CANARY'));assert.ok(!data.includes('PRIVATE_RATIONALE_CANARY'));
 assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal((await fs.stat(file)).nlink,1);assert.equal((await fs.stat(journal)).mode&0o777,0o700);
 assert.ok(statuses.some(status=>status.includes('state_override_ignored')));assert.equal(providerRequests,1);
 console.log(JSON.stringify({schemaVersion:1,kind:'package-consumer-report',surface:'installed-hook-api',freshProcess:true,isolated:true,eventInputs:'synthetic-bounded-task-launch-terminal',realDelegationExecution:false,remoteProviderRequests:0,loopbackProviderRequests:providerRequests,correlation:{tasks:tasks.length,jobs:jobs.length,joined:1,observedStatus:jobs[0].status,actualTierUnknown:true},persistence:{root:'.gjc-plugin',operations:rows.map(row=>row.operation),journalIds:rows.map(row=>row.id),privateModes:true,stateOverrideIgnored:true}}));
} else {
 const agent=process.env.GJC_CODING_AGENT_DIR||process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.gjc','agent');
 const bundle=await fs.realpath(path.join(agent,'gjc-plugins','jev-advisor'));
 const files=['gajae-plugin.json','hooks/jev-advisor.ts','hooks/jev-advisor-result.ts','tools/jev-advise.ts'];
 const digest=async()=>Promise.all(files.map(async file=>createHash('sha256').update(await fs.readFile(path.join(bundle,file))).digest('hex')));
 const before=await digest(),owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'jev-installed-results-')));
 let server,report;
 try {
  const env=await createSmokeEnvironment(owned);await assertSmokeIsolation(env,owned);const cwd=path.join(owned,'repo');await fs.mkdir(cwd,{mode:0o700});
  const legacy=path.join(env.HOME,'.gjc','agent','jev-advisor','state.v2.json');await fs.mkdir(path.dirname(legacy),{mode:0o700});await fs.writeFile(legacy,'legacy-owned-sentinel',{mode:0o600});
  let observed=0;
  server=http.createServer(async(req,res)=>{try{assert.equal(req.method,'POST');assert.equal(req.url,'/v1/systemone');assert.equal(req.headers.authorization,undefined);let bytes=0;for await(const chunk of req){bytes+=chunk.length;assert.ok(bytes<65536);}observed++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({answers:{tier:{choice:'balanced',tier:'balanced',confidence:0.9,probabilities:{fast:0.1,balanced:0.8,strong:0.1},rationale:'PRIVATE_RATIONALE_CANARY'}}}));}catch{res.writeHead(500);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const childEnv={...env,JEV_ADVISOR_PROVIDER:'ollaya',JEV_ADVISOR_ENDPOINT:'http://127.0.0.1:'+server.address().port+'/v1/systemone',JEV_ADVISOR_MIN_INTERVAL_MS:'0',JEV_ADVISOR_STATE:legacy};
  const execution=await new Promise((resolve,reject)=>{const child=spawn('bun',[script,'--isolated',owned,bundle],{cwd,env:childEnv,shell:false,detached:true});let output='',error='',bytes=0;const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}reject(Error('installed_hook_timeout'));},30000);const capture=(chunk,stderr)=>{bytes+=chunk.length;if(bytes>1024*1024){try{process.kill(-child.pid,'SIGKILL');}catch{}return;}if(stderr)error+=chunk;else output+=chunk;};child.stdout.on('data',chunk=>capture(chunk,false));child.stderr.on('data',chunk=>capture(chunk,true));child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,output,error});});});
  assert.equal(execution.code,0,execution.error);report=JSON.parse(execution.output.trim());assert.equal(observed,1);assert.equal(await fs.readFile(legacy,'utf8'),'legacy-owned-sentinel');assert.deepEqual(await digest(),before);
  report.legacyUnchanged=true;report.installedCodeUnchanged=true;
 }finally{try{if(server)await new Promise(resolve=>server.close(resolve));}finally{await fs.rm(owned,{recursive:true,force:true});}}
 console.log(JSON.stringify(report));
}
