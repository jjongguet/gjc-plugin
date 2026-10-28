import {test,expect} from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {createSmokeEnvironment,assertSmokeIsolation,asideLaunchCounterPath,asideLaunchCount,writeAsideProbeWrapper,parseAdapterResult,receiptFileCount,journalRecordCount,journalText,advertisedAssessmentContract,rejectableConstraints} from '../scripts/smoke-environment.mjs';

async function fixture(run: (root: string, owned: string, user: string) => Promise<void>) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'smoke-isolation-')));
 const owned=path.join(root,'owned'),user=path.join(root,'user');
 await fs.mkdir(owned);await fs.mkdir(user);
 try {await run(root,owned,user);} finally {await fs.rm(root,{recursive:true,force:true});}
}

test('test model persistence stays inside private agent root despite inherited overrides',async()=>fixture(async(_root,owned,user)=>{
 const original='modelRoles:\n  default: current-session-model\n';
 await fs.writeFile(path.join(user,'config.yml'),original);
 const env=await createSmokeEnvironment(owned,{
  PATH:process.env.PATH,HOME:user,GJC_CODING_AGENT_DIR:user,GJC_AGENT_DIR:user,
  PI_CODING_AGENT_DIR:user,XDG_CONFIG_HOME:user,GJC_SESSION_ID:'live-session',
  OPENAI_API_KEY:'synthetic-parent-key',OPENROUTER_API_KEY:'synthetic-parent-key',NODE_OPTIONS:'--invalid-parent-option',
 });
 expect(env.HOME).toBe(path.join(owned,'home'));
 expect(env.GJC_CODING_AGENT_DIR).toBe(path.join(owned,'home','.gjc','agent'));
 for(const key of ['PI_CODING_AGENT_DIR','XDG_CONFIG_HOME','GJC_SESSION_ID','OPENROUTER_API_KEY','NODE_OPTIONS'])expect(env).not.toHaveProperty(key);
 execFileSync(process.execPath,['-e',"require('node:fs').writeFileSync(require('node:path').join(process.env.GJC_CODING_AGENT_DIR,'config.yml'),'modelRoles:\\n  default: synthetic-test-model\\n')"],{env,stdio:'pipe'});
 expect(await fs.readFile(path.join(user,'config.yml'),'utf8')).toBe(original);
 expect(await fs.readFile(path.join(env.GJC_CODING_AGENT_DIR,'config.yml'),'utf8')).toContain('synthetic-test-model');
}));

test('live HOME and either live agent override are refused before spawning',async()=>fixture(async(_root,owned,user)=>{
 const env=await createSmokeEnvironment(owned);
 for(const key of ['HOME','GJC_CODING_AGENT_DIR','GJC_AGENT_DIR','TMPDIR']){
  await expect(assertSmokeIsolation({...env,[key]:user},owned)).rejects.toThrow('unsafe_smoke_environment');
 }
}));

test('a symlinked private agent cannot redirect the child to user configuration',async()=>fixture(async(_root,owned,user)=>{
 const env=await createSmokeEnvironment(owned);
 await fs.rm(env.GJC_CODING_AGENT_DIR,{recursive:true});
 await fs.symlink(user,env.GJC_CODING_AGENT_DIR);
 await expect(assertSmokeIsolation(env,owned)).rejects.toThrow('unsafe_smoke_environment');
}));

test('extra overrides, external providers and real credentials fail closed',async()=>fixture(async(_root,owned,user)=>{
 const env=await createSmokeEnvironment(owned);
 await expect(assertSmokeIsolation({...env,PI_CODING_AGENT_DIR:user},owned)).rejects.toThrow('unexpected_smoke_environment');
 await expect(assertSmokeIsolation({...env,OPENAI_API_KEY:'synthetic-unapproved-key'},owned)).rejects.toThrow('real_smoke_credential');
 await expect(assertSmokeIsolation({...env,JEV_ADVISOR_PROVIDER:'openrouter'},owned)).rejects.toThrow('unexpected_smoke_assessment');
 await expect(assertSmokeIsolation({...env,GJC_MODEL_PRESET_REGISTRY_DISABLED:'0'},owned)).rejects.toThrow('unexpected_smoke_registry');
 for(const url of ['https://example.invalid/v1','http://127.0.0.1.example.invalid/v1','http://user:password@127.0.0.1/v1']){
  await expect(assertSmokeIsolation({...env,OPENAI_BASE_URL:url},owned)).rejects.toThrow('nonlocal_smoke_provider');
 }
 await assertSmokeIsolation({...env,OPENAI_BASE_URL:'http://127.0.0.1:12345/v1'},owned);
}));

test('native host validation is never mistaken for an adapter response',()=>{
 const adapter=JSON.stringify({execution:{status:'not_run',reason:'invalid_context'},journalStorage:{persisted:true,id:'x'}});
 expect(parseAdapterResult('Tool result: '+adapter)?.execution.reason).toBe('invalid_context');
 expect(parseAdapterResult('prefix {"report":"plugin_metrics"} suffix')?.report).toBe('plugin_metrics');
 expect(parseAdapterResult('Tool "verification_run" failed: invalid arguments for tool call')).toBeNull();
 expect(parseAdapterResult('{"some":"json"}')).toBeNull();
 expect(parseAdapterResult('{"execution":')).toBeNull();
 // A begin hint keeps the advisor-mode journal prefix selection working.
 expect(parseAdapterResult('noise {"execution":{}} trailing {"journalStorage":{"persisted":true}}','noise {"execution":{}} trailing '.length)?.journalStorage.persisted).toBe(true);
});

test('rejectable constraints are found through nullable wrappers, literal unions and arrays',()=>{
 // Every keyword a host can reject on before dispatch is reported by JSON path.
 const literal={anyOf:[{anyOf:[{const:'run'}]},{type:'null'}]};
 expect(rejectableConstraints(literal,'id')).toEqual(['id.anyOf']);
 expect(rejectableConstraints({anyOf:[{type:'string',enum:['run']},{type:'null'}]},'id')).toEqual(['id.enum']);
 expect(rejectableConstraints({type:'string',pattern:'^run$',maxLength:64},'id')).toEqual(['id.pattern','id.maxLength']);
 expect(rejectableConstraints({type:'array',maxItems:8,items:{type:'object',additionalProperties:false,properties:{note:{type:'string',maxLength:300}}}},'notes')).toEqual(['notes.maxItems','notes[].additionalProperties','notes[].note.maxLength']);
 expect(rejectableConstraints({type:'string',description:'Use run.'},'id')).toEqual([]);
 expect(rejectableConstraints(undefined,'id')).toEqual([]);
});

test('the advertised assessment contract reads the plain-string case id and its description',()=>{
 const id={type:'string',description:'Use run. Other ids are invalid_case_id.'};
 const note={type:'object',properties:{id,note:{type:'string'}}};
 const assessment={type:'object',properties:{caseNotes:{anyOf:[{type:'array',items:note},{type:'null'}]}}};
 const plain=advertisedAssessmentContract({properties:{assessment:{anyOf:[assessment,{type:'null'}]}}});
 expect(plain).toEqual({present:true,idType:'string',idDescription:id.description,constraints:[]});
 // The previous enum-era wire shape is reported, not accepted.
 const enumId={anyOf:[{type:'string',const:'run'},{type:'null'}]};
 const legacy=advertisedAssessmentContract({properties:{assessment:{type:'object',additionalProperties:false,properties:{caseNotes:{type:'array',maxItems:8,items:{type:'object',properties:{id:enumId}}}}}}});
 expect(legacy.idType).toBe('string');
 expect(legacy.constraints).toEqual(['assessment.additionalProperties','assessment.caseNotes.maxItems','assessment.caseNotes[].id.const']);
 expect(advertisedAssessmentContract({properties:{}})).toEqual({present:false,idType:null,idDescription:'',constraints:[]});
});

test('journal text reads every retained segment and treats a missing journal as empty',async()=>fixture(async(_root,owned)=>{
 const env={HOME:path.join(owned,'home')};
 expect(await journalText(env,'verification-receipts')).toBe('');
 const dir=path.join(env.HOME,'.gjc-plugin','verification-receipts','journal','v1');
 await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'a.jsonl'),'{"id":1}\n');await fs.writeFile(path.join(dir,'b.jsonl'),'{"id":2}\n');
 await fs.writeFile(path.join(dir,'inventory.json'),JSON.stringify({segments:[{name:'a.jsonl'},{name:'b.jsonl'}]}));
 expect(await journalText(env,'verification-receipts')).toBe('{"id":1}\n{"id":2}\n');
 expect(await journalRecordCount(env,'verification-receipts')).toBe(2);
}));

test('the aside probe wrapper counts each launch and preserves the exit code',async()=>fixture(async(_root,owned,user)=>{
 const counter=asideLaunchCounterPath(owned);
 expect(await asideLaunchCount(counter)).toBe(0);
 const fake=path.join(owned,'fake-aside');
 await fs.writeFile(fake,'#!/bin/sh\nexit 7\n',{mode:0o755});
 const wrapper=await writeAsideProbeWrapper({binDir:path.join(owned,'bin'),realAside:fake,counterFile:counter,env:{HOME:user,PATH:process.env.PATH,TMPDIR:owned}});
 const result=spawnSync(process.execPath,[wrapper,'repl'],{stdio:'pipe'});
 expect(result.status).toBe(7);
 expect(await asideLaunchCount(counter)).toBe(1);
 expect(spawnSync(process.execPath,[wrapper,'repl'],{stdio:'pipe'}).status).toBe(7);
 expect(await asideLaunchCount(counter)).toBe(2);
}));

test('receipt and journal counters are zero before any store exists',async()=>fixture(async(_root,owned,_user)=>{
 const env=await createSmokeEnvironment(owned);
 expect(await receiptFileCount(env)).toBe(0);
 expect(await journalRecordCount(env,'verification-receipts')).toBe(0);
 const receipts=path.join(env.HOME,'.gjc-plugin','verification-receipts','receipts','v1','repo-digest');
 await fs.mkdir(receipts,{recursive:true});
 await fs.writeFile(path.join(receipts,'one.json'),'{}');
 await fs.writeFile(path.join(receipts,'two.json'),'{}');
 await fs.writeFile(path.join(receipts,'.admission.lock'),'');
 expect(await receiptFileCount(env)).toBe(2);
 const journal=path.join(env.HOME,'.gjc-plugin','verification-receipts','journal','v1');
 await fs.mkdir(journal,{recursive:true});
 await fs.writeFile(path.join(journal,'segment-a.jsonl'),'{"id":"a"}\n{"id":"b"}\n');
 await fs.writeFile(path.join(journal,'inventory.json'),JSON.stringify({segments:[{name:'segment-a.jsonl',bytes:26,digest:'d'}]}));
 expect(await journalRecordCount(env,'verification-receipts')).toBe(2);
}));
