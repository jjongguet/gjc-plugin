import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dir,'..');
const env={PATH:process.env.PATH??'',HOME:process.env.HOME??'',TMPDIR:process.env.TMPDIR??'/tmp',JEV_ADVISOR_PROVIDER:'off'};
for(const args of [['scripts/build.mjs','--check'],['test','tests/scenario.test.ts','tests/aside.test.ts','tests/adapters.test.ts']]) {
 const result=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',maxBuffer:4*1024*1024});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 if(result.status!==0)process.exit(result.status??1);
 if(args[0]==='test'&&!/[1-9]\d* pass/.test((result.stdout??'')+(result.stderr??'')))throw Error('zero_test_discovery');
}
