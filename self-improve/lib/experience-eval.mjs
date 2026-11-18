/**
 * Frozen on/off evaluation for bounded experience reuse (Harness² M3).
 *
 * The contract file is authored and content-hashed before any run: the digest
 * covers every field except `contractSha256` itself, so changing a case, a
 * threshold or the misleading rule produces a different contract and invalidates
 * every earlier receipt. A run executes the frozen contract over deterministic
 * stub cases (no model, no network, no clock, no spend) and writes a receipt
 * whose bytes depend only on the contract and the library.
 *
 * The comparison is honest about what it measures: `learningOff` has no
 * experience input at all (declared by construction), so the paired delta is a
 * predicate check, not evidence that a model improves. `misleadingGain` is a
 * separate field that must stay 0; a run that counts the misleading lesson as a
 * gain fails even if every other threshold is met. A missing or unmeasurable
 * case is an exclusion, never a pass.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./types.mjs";
import {
  DEFAULT_SELECT_LIMIT,
  DEFAULT_SELECT_MAX_BYTES,
  MIN_LEAK_TOKENS,
  assertHeldoutSeparation,
  selectExperience,
  validateExperienceEntry,
} from "./experience.mjs";

export const EXPERIENCE_EVAL_CONTRACT_SCHEMA = "gjc.self-improve.experience-eval-contract.v1";
export const EXPERIENCE_EVAL_RECEIPT_SCHEMA = "gjc.self-improve.experience-eval-receipt.v1";
export const EXPERIENCE_EVAL_CONTRACT_PATH = fileURLToPath(
  new URL("../policies/experience-eval-contract.json", import.meta.url),
);

/** Recursively sorted JSON: a stable digest input independent of key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

/** Digest of the contract body; `contractSha256` pins the frozen file. */
export function contractDigest(contract) {
  const { contractSha256, ...body } = contract ?? {};
  return sha256Hex(canonicalJson(body));
}

/** Read, verify and freeze-check a contract file. */
function checkContract(contract) {
  const digest = contractDigest(contract);
  if (contract?.schema !== EXPERIENCE_EVAL_CONTRACT_SCHEMA) {
    return { ok: false, reason: "contract_schema_mismatch", contractSha256: digest };
  }
  if (contract.status !== "frozen") return { ok: false, reason: "contract_not_frozen", contractSha256: digest };
  if (contract.contractSha256 !== digest) {
    return { ok: false, reason: "contract_hash_mismatch", contractSha256: digest, declared: contract.contractSha256 ?? null };
  }
  return { ok: true, reason: null, contract, contractSha256: digest };
}

/** Read, verify and freeze-check a contract file. */
export function loadExperienceEvalContract(contractPath = EXPERIENCE_EVAL_CONTRACT_PATH) {
  let raw;
  try {
    raw = readFileSync(contractPath, "utf8");
  } catch {
    return { ok: false, reason: "contract_missing", contractSha256: null };
  }
  let contract;
  try {
    contract = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "contract_parse_error", contractSha256: null };
  }
  return { ...checkContract(contract), raw };
}

const rate = (hits, planned) => (planned > 0 ? Number((hits / planned).toFixed(4)) : 0);

function emptyControl(countedAsGain) {
  return { entryId: null, selected: false, effect: "none", verdict: "neutral", countedAsGain, gainContribution: 0 };
}

function failureReceipt(contractSha256, failures, control) {
  const planned = 0;
  return {
    schema: EXPERIENCE_EVAL_RECEIPT_SCHEMA,
    contractSha256,
    cases: { planned, passed: 0, failed: 0 },
    learningOn: { cases: planned, hits: 0, hitRate: 0, misleadingGain: 0 },
    learningOff: { cases: planned, hits: 0, hitRate: 0 },
    misleadingControl: control,
    pass: false,
    reason: failures.join(","),
  };
}

/** Locate an entry by the id the contract pins; ids are recomputed, not trusted. */
function indexLibrary(entries) {
  const byId = new Map();
  const failures = [];
  const valid = [];
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const checked = validateExperienceEntry(entry);
    if (!checked.ok) {
      failures.push(`library_entry_invalid:${index}:${checked.reason}`);
      continue;
    }
    if (checked.entry.status !== "active") {
      failures.push(`library_entry_inactive:${index}`);
      continue;
    }
    if (byId.has(checked.id)) {
      failures.push(`library_entry_duplicate:${checked.id}`);
      continue;
    }
    byId.set(checked.id, { ...checked.entry, id: checked.id });
    valid.push({ ...checked.entry, id: checked.id });
  }
  return { byId, valid, failures };
}

function measureCase(caseDef, library, minLeakTokens) {
  const selection = selectExperience({
    entries: library.valid,
    repo: caseDef.repo,
    cueText: caseDef.cue,
    limit: DEFAULT_SELECT_LIMIT,
    maxBytes: DEFAULT_SELECT_MAX_BYTES,
  });
  const expected = library.byId.get(caseDef.expectedLesson);
  if (!expected) return { measured: false, reason: "missing_measurement", selection };
  if (typeof caseDef.expectToken !== "string" || caseDef.expectToken.trim().length === 0) {
    return { measured: false, reason: "missing_measurement", selection };
  }
  let separation = null;
  for (const selected of selection.selected) {
    const checked = assertHeldoutSeparation({ entry: selected, heldoutTexts: caseDef.heldoutTexts, minTokens: minLeakTokens });
    if (!checked.ok) {
      separation = { field: selected.id, reason: checked.reason, overlaps: checked.overlaps };
      break;
    }
  }
  const selectedExpected = selection.selected.find((selected) => selected.id === expected.id) ?? null;
  const hit = Boolean(selectedExpected) && selectedExpected.lesson.includes(caseDef.expectToken) && separation === null;
  return { measured: true, hit, separation, selection };
}

function measureMisleading({ misleading, library, countedAsGain, requireExercised, minLeakTokens }) {
  const control = emptyControl(countedAsGain);
  const entry = library.byId.get(misleading?.entryId);
  if (!entry) return { control, failures: ["missing_measurement:misleading"] };
  control.entryId = entry.id;
  const selection = selectExperience({
    entries: library.valid,
    repo: misleading.repo,
    cueText: misleading.cue,
    limit: DEFAULT_SELECT_LIMIT,
    maxBytes: DEFAULT_SELECT_MAX_BYTES,
  });
  control.selected = selection.selected.some((selected) => selected.id === entry.id);
  control.effect = !control.selected ? "none" : String(entry.lesson).includes(String(misleading.expectToken)) ? "pass" : "harm";
  control.verdict = control.selected ? (control.effect === "pass" ? "accepted" : "rejected") : "neutral";
  const failures = [];
  if (countedAsGain) {
    control.gainContribution = 1;
    failures.push("misleading_counted_as_gain");
  }
  if (control.verdict === "accepted") failures.push("misleading_accepted");
  if (!control.selected && requireExercised) failures.push("misleading_control_vacuous");
  const separation = assertHeldoutSeparation({ entry, heldoutTexts: misleading.heldoutTexts, minTokens: minLeakTokens });
  if (!separation.ok) failures.push(`heldout_overlap:misleading:${separation.reason}`);
  return { control, failures };
}

function evaluateThresholds({ planned, onHits, offHits, thresholds }) {
  const failures = [];
  const minCases = thresholds?.minCases;
  const minRate = thresholds?.minLearningOnHitRate;
  const minGain = thresholds?.minCaseGain;
  const maxOffRate = thresholds?.maxLearningOffHitRate;
  if (!Number.isSafeInteger(minCases) || minCases < 1) failures.push("invalid_threshold:minCases");
  else if (planned < minCases) failures.push("case_count_below_min");
  if (!Number.isFinite(minRate) || minRate < 0 || minRate > 1) failures.push("invalid_threshold:minLearningOnHitRate");
  else if (rate(onHits, planned) < minRate) failures.push("learning_hit_rate_below_threshold");
  if (!Number.isSafeInteger(minGain) || minGain < 0) failures.push("invalid_threshold:minCaseGain");
  else if (onHits - offHits < minGain) failures.push("case_gain_below_threshold");
  if (!Number.isFinite(maxOffRate) || maxOffRate < 0 || maxOffRate > 1) failures.push("invalid_threshold:maxLearningOffHitRate");
  else if (rate(offHits, planned) > maxOffRate) failures.push("learning_off_above_ceiling");
  if (thresholds?.forbidMisleadingGain !== true) failures.push("invalid_threshold:forbidMisleadingGain");
  if (typeof thresholds?.requireMisleadingExercised !== "boolean") failures.push("invalid_threshold:requireMisleadingExercised");
  return failures;
}

/**
 * Execute the frozen contract over its deterministic stub cases and return a
 * receipt. Passing `countMisleadingAsGain` only exists to prove the negative
 * control fails: it adds `misleadingGain:1` and an exclusion, never a pass.
 */
export function runExperienceEval({
  contractPath = EXPERIENCE_EVAL_CONTRACT_PATH,
  contract: suppliedContract = null,
  outPath = null,
  countMisleadingAsGain = false,
  minLeakTokens = MIN_LEAK_TOKENS,
} = {}) {
  const loaded = suppliedContract ? checkContract(suppliedContract) : loadExperienceEvalContract(contractPath);

  let receipt;
  if (!loaded.ok) {
    receipt = failureReceipt(loaded.contractSha256 ?? null, [loaded.reason], emptyControl(countMisleadingAsGain));
  } else {
    const contract = loaded.contract;
    const failures = [];
    const cases = Array.isArray(contract.cases) ? contract.cases : [];
    const ids = new Set();
    for (const caseDef of cases) {
      if (typeof caseDef?.id !== "string" || caseDef.id.length === 0) failures.push("missing_measurement:case_id");
      else if (ids.has(caseDef.id)) failures.push(`duplicate_case_id:${caseDef.id}`);
      else ids.add(caseDef.id);
    }
    const library = indexLibrary(contract.stubLibrary);
    failures.push(...library.failures);
    if (contract.misleading?.countsAsGain !== false) failures.push("misleading_rule_invalid");

    let onHits = 0;
    for (const caseDef of cases) {
      if (typeof caseDef?.id !== "string" || caseDef.id.length === 0) continue;
      const measured = measureCase(caseDef, library, minLeakTokens);
      if (!measured.measured) failures.push(`missing_measurement:${caseDef.id}`);
      else if (measured.separation) {
        const kind = measured.separation.reason === "heldout_texts_missing" ? "missing_measurement" : "heldout_overlap";
        failures.push(`${kind}:${caseDef.id}:${measured.separation.reason}`);
      } else if (measured.hit) onHits += 1;
    }
    const control = measureMisleading({
      misleading: contract.misleading,
      library,
      countedAsGain: countMisleadingAsGain,
      requireExercised: contract.thresholds?.requireMisleadingExercised === true,
      minLeakTokens,
    });
    failures.push(...control.failures);

    const offHits = 0; // By design: the off arm has no experience input at all.
    const planned = cases.length;
    failures.push(...evaluateThresholds({ planned, onHits, offHits, thresholds: contract.thresholds }));
    receipt = {
      schema: EXPERIENCE_EVAL_RECEIPT_SCHEMA,
      contractSha256: loaded.contractSha256,
      cases: { planned, passed: onHits, failed: planned - onHits },
      learningOn: { cases: planned, hits: onHits, hitRate: rate(onHits, planned), misleadingGain: control.control.gainContribution },
      learningOff: { cases: planned, hits: offHits, hitRate: rate(offHits, planned) },
      misleadingControl: control.control,
      pass: failures.length === 0,
      reason: failures.length === 0 ? null : failures.join(","),
    };
  }

  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  let written = null;
  if (typeof outPath === "string" && outPath.length > 0) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text);
    written = outPath;
  }
  return { ok: true, receipt, text, bytes: Buffer.byteLength(text, "utf8"), outPath: written };
}

function parseArgs(argv) {
  const parsed = { contractPath: EXPERIENCE_EVAL_CONTRACT_PATH, outPath: null, countMisleadingAsGain: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--contract") parsed.contractPath = resolve(argv[(i += 1)]);
    else if (arg === "--out") parsed.outPath = resolve(argv[(i += 1)]);
    else if (arg === "--misleading-as-gain") parsed.countMisleadingAsGain = true;
  }
  return parsed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runExperienceEval(parseArgs(process.argv.slice(2)));
  process.stdout.write(result.text);
  process.exitCode = result.receipt.pass ? 0 : 1;
}
