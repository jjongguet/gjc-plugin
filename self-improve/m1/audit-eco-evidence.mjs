#!/usr/bin/env node
/** Offline audit of original executor events, never provider credentials or holdout inputs. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pairedBenefit } from "../lib/behavior-eval.mjs";

export const ORIGINAL_RUNS = [
  ["jjo945-pilot-20261028", "live-run"],
  ["jjo664-eco-pilot-20261110T132535Z", "live-run"],
  ["jjo664-eco-resume-20261110T144158Z", "live-run"],
  ["jjo664-eco-resume-20261110T144158Z", "live-run2"],
  ["jjo664-eco-resume-20261110T144158Z", "live-run3"],
];
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const nano = (usd) => {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("unknown_or_negative_cost");
  const result = Math.round(usd * 1e9);
  if (!Number.isSafeInteger(result)) throw new Error("cost_overflow");
  return result;
};
const dollars = (n) => (n / 1e9).toFixed(9);

/** Deduplicate by reservation id *within* a run. Repeated unresolved events are not new charges. */
export function reconcileEvents(events) {
  const calls = new Map();
  for (const event of events) {
    if (event.kind === "reserved") {
      if (calls.has(event.id)) throw new Error("duplicate_reservation");
      calls.set(event.id, { id: event.id, reservationNano: nano(event.reservationUsd), settlement: null });
    } else if (event.kind === "settled" || event.kind === "unresolved") {
      const call = calls.get(event.id);
      if (!call) throw new Error("event_without_reservation");
      if (event.kind === "settled") {
        if (call.settlement) throw new Error("duplicate_settlement");
        call.settlement = { ...event.usage, usdNano: nano(event.usage?.usd) };
      }
    }
  }
  const rows = [...calls.values()].map((call) => ({
    id: call.id,
    usdNano: call.settlement?.usdNano ?? call.reservationNano,
    reservationNano: call.reservationNano,
    basis: call.settlement?.basis ?? (call.settlement ? "provider_reported_cost" : "conservative_unresolved_bound"),
    input: call.settlement?.input ?? null,
    output: call.settlement?.output ?? null,
  }));
  return { rows, totalNano: rows.reduce((sum, row) => sum + row.usdNano, 0) };
}

export function auditOriginalRuns(root) {
  const hashes = [];
  const json = (relative) => {
    const file = path.join(root, relative);
    const bytes = readFileSync(file);
    hashes.push({ path: relative, sha256: sha256(bytes) });
    return JSON.parse(bytes);
  };
  const runs = ORIGINAL_RUNS.map(([bundle, run]) => {
    const relative = `${bundle}/${run}`;
    const report = json(`${relative}/report.json`);
    const frozen = json(`${relative}/frozen.json`);
    const bytes = readFileSync(path.join(root, relative, "events.jsonl"));
    hashes.push({ path: `${relative}/events.jsonl`, sha256: sha256(bytes) });
    const ledger = reconcileEvents(bytes.toString().trim().split("\n").map(JSON.parse));
    if (ledger.rows.length !== report.cost.calls) throw new Error("call_denominator_mismatch");
    return { path: relative, frozenAt: frozen.createdAt, sourceDigest: report.sourceDigest, attempts: report.attemptsDenominator, cells: report.cellsDenominator, stopped: report.stopped, report, ledger };
  });
  const originalAccounting = json("jjo664-eco-resume-20261110T144158Z/accounting.json");
  const pricing = json("jjo664-eco-resume-20261110T144158Z/pricing.json");
  const priorNano = nano(runs[0].report.cost.priorSpentUsd);
  const addedNano = runs.reduce((sum, run) => sum + run.ledger.totalNano, 0);
  const correctedNano = priorNano + addedNano;
  const originalNano = nano(originalAccounting.priorSpentUsd);
  const calls = runs.flatMap((run) => run.ledger.rows.map((row) => ({ run: run.path, ...row, usd: dollars(row.usdNano) })));
  for (const run of runs.slice(1)) {
    for (const row of run.ledger.rows) {
      if (row.basis === "computed_tokens") {
        if (!Number.isSafeInteger(row.input) || !Number.isSafeInteger(row.output)) throw new Error("token_evidence_missing");
        if (nano(row.input * pricing.inputPrice + row.output * pricing.outputPrice) !== row.usdNano) throw new Error("computed_cost_mismatch");
      }
    }
  }
  const completed = runs.at(-1).report;
  const pairs = [1, 2, 3].map((repeat) => {
    const a = completed.receipts.find((r) => r.arm === "B1" && r.repeat === repeat);
    const b = completed.receipts.find((r) => r.arm === "B2" && r.repeat === repeat);
    return { id: `development-r${repeat}`, qualityDelta: Number(b.outcome === "passed") - Number(a.outcome === "passed"), baselineCost: a.cost.usd, costRatio: b.cost.usd / a.cost.usd, coverageDelta: 0 };
  });
  return {
    schema: "jjo664.eco_evidence_audit.v1",
    costBasis: "computed reconstruction; conservative prior includes a key-wide upper bound and an estimated decision allowance, not task billing",
    originalRecordedUsd: dollars(originalNano), correctedConservativeUsd: dollars(correctedNano), correctionUsd: dollars(correctedNano - originalNano),
    priorConservativeUsd: dollars(priorNano), recordedCallsUsd: dollars(addedNano),
    unresolvedTreatment: "Keep full reservation as a conservative bound; not provider settlement or permission to resume",
    measuredTaskBillingUsd: null,
    paidCallsThisAudit: 0,
    incrementalUsd: "0.000000000",
    calls,
    runs: runs.map(({ report, ...run }) => ({ ...run, receiptSplits: [...new Set(report.receipts.map((r) => r.split))], taskIds: [...new Set(report.receipts.map((r) => r.taskId))] })),
    completedPilot: {
      sourceDigest: completed.sourceDigest,
      armPassed: Object.fromEntries(["B0", "B1", "B2"].map((arm) => [arm, completed.receipts.filter((r) => r.arm === arm && r.outcome === "passed").length])),
      computedUsd: dollars(nano(completed.cost.computedUsd)),
      comparison: pairedBenefit(pairs, { plannedPairs: 3 }), pairs,
      comparisonScope: "Retrospective descriptive pairing by repeat; not a prospective efficacy test or price-savings claim",
      costFlagCaveat: "Original quality_trial.cost.measured=true means priced resource evidence in that producer. ProviderMetered=false and basis=computed_tokens; it is NOT provider-measured billing.",
    },
    hashes,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("usage: audit-eco-evidence.mjs ORIGINAL_ARTIFACT_ROOT NEW_OUTPUT_JSON");
  const result = auditOriginalRuns(process.argv[2]);
  mkdirSync(path.dirname(process.argv[3]), { recursive: true });
  writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ corrected: result.correctedConservativeUsd, calls: result.calls.length, pilot: result.completedPilot.armPassed, comparison: result.completedPilot.comparison }));
}
