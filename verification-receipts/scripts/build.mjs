import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const check=process.argv.includes('--check');
for (const [adapter,out,cores] of [
 ['src/run.adapter.ts','tools/verification-run.ts',['../shared/lib/decision-contract.ts','../shared/lib/results.ts','lib/receipts.ts','lib/runner.ts','lib/decision.ts','lib/outcomes.ts']],
 ['src/status.adapter.ts','tools/verification-status.ts',['../shared/lib/decision-contract.ts','../shared/lib/results.ts','lib/receipts.ts','lib/decision.ts','lib/outcomes.ts']],
 ['src/loop.adapter.ts','tools/verification-loop.ts',['../shared/lib/decision-contract.ts','../shared/lib/results.ts','lib/receipts.ts','lib/loop.ts']],
 ['src/gate-baseline.adapter.ts','hooks/verification-gate-baseline.ts',['../shared/lib/decision-contract.ts','../shared/lib/results.ts','lib/receipts.ts','lib/loop.ts']],
 ['src/gate-result.adapter.ts','hooks/verification-gate.ts',['../shared/lib/decision-contract.ts','../shared/lib/results.ts','lib/receipts.ts','lib/loop.ts']]
]) {
 const parts=await Promise.all([...cores,adapter].map(async p=>(await readFile(path.join(root,p),'utf8')).replace(/^import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)?\s*from\s+['"]\.[^'"]*['"];?\r?\n/gm,'')));
 const body='// GENERATED — edit lib/ and src/, then bun scripts/build.mjs. Keyless standalone '+(out.startsWith('hooks/')?'hook':'tool')+'.\n'+parts.join('\n');
 if (check) { if ((await readFile(path.join(root,out),'utf8')) !== body) throw new Error('generated_out_of_sync:'+out); }
 else { await mkdir(path.dirname(path.join(root,out)),{recursive:true}); await writeFile(path.join(root,out),body); }
 console.log((check?'checked ':'built ')+out);
}
