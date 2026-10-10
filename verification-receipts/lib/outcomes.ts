import { appendPluginOutcome, type PluginOutcome } from '../../shared/lib/results';

// Project only host-owned metadata; caller context and private input locators never enter the journal.
export async function finalizeVerificationOutcome(plugin: 'verification-receipts' | 'ui-regression', operation: 'run' | 'status', value: Record<string, any>) {
 const receipt = value.receipt;
 const execution = receipt?.execution ?? value.execution;
 const projected: Record<string, unknown> = {status: execution.status, reason: execution.reason};
 if ('counts' in execution) projected.counts = execution.counts;
 if ('assertions' in execution) projected.assertions = execution.assertions;
 if ('cleanup' in execution) projected.cleanup = execution.cleanup;
 const receiptStorage = value.receiptStorage ?? (typeof value.persisted === 'boolean' ? {
  persisted: value.persisted, reason: value.reason,
  ...(value.count !== undefined ? {count:value.count} : {}),
  ...(value.bytes !== undefined ? {bytes:value.bytes} : {}),
  ...(value.nearCapacity !== undefined ? {nearCapacity:value.nearCapacity} : {}),
 } : {persisted:false,reason:operation === 'status' && receipt ? 'not_requested' : 'no_receipt'});
 const outcome: PluginOutcome = {
  operation, repositoryDigest:receipt?.repositoryDigest ?? null, receiptId:receipt?.id ?? null,
  freshness:value.freshness ?? receipt?.freshness ?? 'unavailable',
  execution:projected as PluginOutcome['execution'], assessment:value.assessment, receiptStorage,
  ...(receipt ? {toolCallDigest:receipt.toolCallDigest,durationMs:receipt.durationMs} : {}),
 };
 let journalStorage;
 try { journalStorage = await appendPluginOutcome(plugin,outcome); }
 catch { journalStorage = {persisted:false,reason:'store_unavailable'}; }
 const warnings = [...(value.warnings ?? [])];
 if (receiptStorage.nearCapacity) warnings.push('receipt_store_near_capacity');
 if (receiptStorage.reason === 'store_full') warnings.push('receipt_store_full');
 if (!journalStorage.persisted) warnings.push('journal_not_persisted');
 return {...value,receiptStorage,journalStorage,receiptLoadable:Boolean(receipt && (operation === 'status' || receiptStorage.persisted)),warnings};
}
