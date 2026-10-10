import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),check=process.argv.includes('--check');
for(const [adapter,out,cores] of [
 ['src/run.adapter.ts','tools/ui-regression-run.ts',['../shared/lib/results.ts','../verification-receipts/lib/receipts.ts','../verification-receipts/lib/decision.ts','../verification-receipts/lib/outcomes.ts','lib/scenario.ts','lib/aside.ts']],
 ['src/status.adapter.ts','tools/ui-regression-status.ts',['../shared/lib/results.ts','../verification-receipts/lib/receipts.ts','../verification-receipts/lib/decision.ts','../verification-receipts/lib/outcomes.ts']]
]) {
 const parts=await Promise.all([...cores,adapter].map(async p=>(await readFile(path.join(root,p),'utf8')).replace(/^import .* from ['"]\..*['"];?\r?\n/gm,'')));
 const body='// GENERATED — shared source embedded at build time; no installed sibling imports. Keyless.\n'+parts.join('\n');
 if(check){if(await readFile(path.join(root,out),'utf8')!==body)throw Error('generated_out_of_sync:'+out);}
 else{await mkdir(path.dirname(path.join(root,out)),{recursive:true});await writeFile(path.join(root,out),body);}
 console.log((check?'checked ':'built ')+out);
}
