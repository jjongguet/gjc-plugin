import { resolveReceiptRepository, RECEIPT_REPOSITORY_REASONS, RECEIPT_TEST_PATH_REASONS, repositoryDigest, specFingerprint, fingerprintSource, freshnessFor, createReceipt, persistReceipt, staticReceiptGuidance } from '../lib/receipts';
import { runNodeTests, validateTestFiles } from '../lib/runner';
import { assessAdequacy } from '../lib/decision';
import { finalizeVerificationOutcome } from '../lib/outcomes';

// Rejections that name their cause instead of the generic invalid_or_unavailable_input.
const RUN_INPUT_REASONS: readonly string[] = [...RECEIPT_REPOSITORY_REASONS, ...RECEIPT_TEST_PATH_REASONS];

export default function verificationRun(pi: {cwd: string; typebox: {Type: any}}) {
 const T = pi.typebox.Type;
 return {
  name: 'verification_run', label: 'Verification Run',
  description: 'Execute explicitly authorized non-sensitive JavaScript or TypeScript node:test files with a fixed native reporter. This is not a sandbox: inspect test effects first. Tests see LANG, TZ and the host PATH only (no HOME or other inherited variables); a program a failing test could not start from PATH is named as missing_binary. Actual execution/counts and source fingerprints are advisory evidence, not coverage proof. No arbitrary commands, result imports or repair loops. Automatically attempt Jev adequacy on every invocation at https://openrouter.ai/api/alpha/decisions (typesafe/jev-1.14). Supply assessment context when known: selected non-sensitive changeSummary, expectedBehavior and caseNotes improve the automatic judgment; omission does not disable it. Only bounded host facts and validated supplied context leave; no raw logs/source/paths/keys. Missing context or unavailable assessment is not a pass.',
  parameters: T.Object({
   files: T.Array(T.String(), {minItems:1,maxItems:32,description:'Explicit repository-relative .js/.mjs/.cjs/.ts/.mts/.cts test files; no globs, symlinks, custom flags or loaders. TypeScript needs Node >= 22.18 for native type stripping.'}),
   repository: T.Optional(T.String({minLength:1,maxLength:4096,description:'Root of the Git work tree to run in, absolute or relative to the session directory. Needed when the session directory is not inside a repository; it must be the session repository or lie inside the session directory. Defaults to the repository containing the session directory.'})),
   timeoutMs: T.Optional(T.Number({minimum:1,maximum:120000})),
   assessment:T.Optional(T.Object({changeSummary:T.String({description:'Non-sensitive summary of the change, 1-2000 characters; no secrets, URLs, paths, logs or source.'}),expectedBehavior:T.String({description:'Non-sensitive expected behavior, 1-2000 characters; same restrictions as changeSummary.'}),caseNotes:T.Optional(T.Array(T.Object({id:T.String({description:'Case note id. Use run, the only eligible id for this tool. Ids must be unique. Any other id is rejected in-plugin as invalid_case_id and the result lists the allowed ids.'}),note:T.String({description:'Non-sensitive case note, 1-300 characters.'})}),{description:'At most 8 case notes with unique ids.'}))},{description:'Optional non-sensitive context. Malformed or sensitive context is rejected in-plugin as invalid_context without echoing it.'}))
  }, {additionalProperties:false}),
  async execute(toolCallId: string, params: {files:string[];repository?:string;timeoutMs?:number;assessment?:unknown}, _update?:unknown, _ctx?:unknown, signal?:AbortSignal) {
   const started = performance.now();
   let execution: Record<string, any> = {status:'not_run',reason:'invalid_or_unavailable_input'};
   const text = async (value: Record<string, any>) => ({content:[{type:'text',text:JSON.stringify(await finalizeVerificationOutcome('verification-receipts','run',value))}]});
   try {
    if (!params || Object.keys(params).some(k => !['files','repository','timeoutMs','assessment'].includes(k)) || (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > 120000))) throw new Error('invalid_input');
    const root = await resolveReceiptRepository(pi.cwd, params.repository);
    await validateTestFiles(root, params.files);
    const specDigest = specFingerprint({runner:'node:test',files:params.files,timeoutMs:params.timeoutMs ?? 30000});
    const before = await fingerprintSource(root,specDigest,params.files);
    const diagnostics = {missingBinaries: [] as string[]};
    execution = await runNodeTests(root,params.files,params.timeoutMs ?? 30000,signal,diagnostics);
    const after = await fingerprintSource(root,specDigest,params.files); const freshness = freshnessFor(before,after);
    const receipt = createReceipt({plugin:'verification-receipts',toolCallId,repositoryDigest:await repositoryDigest(root),durationMs:Math.round(performance.now()-started),specDigest,before,after,freshness,execution,warnings:diagnostics.missingBinaries.map(name => `missing_binary:${name}`),limitations:['Native counts are not assertion counts or coverage proof.','Excluded credential and cache paths are not freshness-covered.','Local test code is not sandboxed; timestamps are descriptive.']});
    const storage = await persistReceipt(receipt,undefined,params.files);
    const assessment = await assessAdequacy(params.assessment,{status:execution.status,counts:execution.counts,freshness,caseIds:['run']});
    return text({receipt,...storage,assessment,...staticReceiptGuidance(execution,freshness,assessment,receipt.warnings,{allowedCaseIds:['run']})});
   } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (execution.status === 'not_run' && RUN_INPUT_REASONS.includes(reason)) execution = {status:'not_run',reason};
    const assessment=await assessAdequacy(undefined,{status:execution.status,counts:execution.counts ?? null,freshness:'unavailable'});
    return text({execution,assessment,...staticReceiptGuidance(execution,'unavailable',assessment)});
   }
  }
 };
}
