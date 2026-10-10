import {test,expect} from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createSmokeEnvironment,assertSmokeIsolation} from '../scripts/smoke-environment.mjs';

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
