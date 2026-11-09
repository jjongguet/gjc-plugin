// The active supervisor verifies provider pricing/context bounds before issuing
// this short-lived authorization. Runtime keeps the entire worst-case workload
// reserved, including the runner's one possible size retry; deadline is not money.
const finite = (n) => Number.isFinite(n) && n >= 0;
export function reviewBudget({ supervision, lenses, calls, now = Date.now() }) {
  if (supervision?.active !== true || !supervision.supervisor || !(Date.parse(supervision.expiresAt) > now) || Date.parse(supervision.expiresAt) - now > 3600000) throw new Error('review requires an active short-lived supervisor');
  const budget = supervision.budget;
  if (!budget || !['capUsd', 'spentUsd', 'reservedUsd'].every((k) => finite(budget[k])) || budget.capUsd > 5) throw new Error('invalid task budget');
  let upperUsd = 0;
  for (const lens of lenses) {
    const bound = supervision.modelBounds?.[lens.model];
    if (!bound || bound.verified !== true || !/^https:\/\//.test(bound.source ?? '') || !Number.isSafeInteger(bound.maxContextTokens) || bound.maxContextTokens <= 0 || !Number.isSafeInteger(bound.maxOutputTokens) || bound.maxOutputTokens <= 0 || !finite(bound.inputUsdPerMillion) || !finite(bound.outputUsdPerMillion) || !Number.isFinite(Date.parse(bound.observedAt)) || now - Date.parse(bound.observedAt) > 3600000 || Date.parse(bound.observedAt) > now) throw new Error(`unverified provider cost bound: ${lens.model}`);
    const cost = (bound.maxContextTokens * bound.inputUsdPerMillion + bound.maxOutputTokens * bound.outputUsdPerMillion) / 1000000;
    upperUsd += 2 * calls * cost;
  }
  if (!finite(upperUsd) || budget.spentUsd + budget.reservedUsd + upperUsd > budget.capUsd) throw new Error('worst-case review exceeds task budget');
  return { upperUsd, capUsd: budget.capUsd, spentUsd: budget.spentUsd, reservedUsd: budget.reservedUsd, calls: calls * lenses.length, includesRetry: true };
}
