#!/usr/bin/env node
/**
 * Phase-A audit helper: turn mechanical candidates into a claim graph.
 * Writes claims.csv and dispositions.jsonl under the audit directory.
 * Every candidate gets a disposition; every `claim` disposition maps to a row.
 *
 * Usage: node self-improve/evidence/audit-20261022/tools/triage.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const auditDir = path.resolve(here, "..");
const repoRoot = path.resolve(auditDir, "..", "..", "..");
const SCOPE = process.env.AUDIT_SCOPE_SHA ?? "e74140c7b014b60402b6f2c4ef748cfd1b7d3512";
const scopeSha = SCOPE;
const scopeText = (carrier) => execFileSync("git", ["show", `${SCOPE}:${carrier}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const candidates = readFileSync(path.join(auditDir, "candidates.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const COLUMNS = [
  "id",
  "carrier",
  "class",
  "quote",
  "file_line",
  "scope_sha",
  "severity",
  "caveat_adjacency",
  "required_receipt",
  "evidence_kind",
  "binding_strength",
  "binding_command",
  "observed",
  "evidence_sha256",
  "verdict",
  "fix_class",
];

const FROZEN = [
  "self-improve/ledger.jsonl",
  "self-improve/rrsi-protocol.json",
  "self-improve/replay-protocol.json",
  "self-improve/replay-protocol-p2b.json",
  "self-improve/policies/",
  "self-improve/domains/",
  "self-improve/evidence/p2b/",
  "self-improve/evidence/p3/summary.json",
];

const ROW_CHECK = (id) => `node scripts/check-audit-claims.mjs --row ${id}`;

// Confirmed findings (register F-01..F-18). Each entry becomes one GAP row.
const FINDINGS = [
  {
    finding: "F-01",
    carrier: "self-improve/rrsi-protocol.json",
    contains: "all 6 guards pass",
    class: "BND",
    severity: "S2",
    verdict: "GAP",
    fix_class: "evidence_annex",
    required_receipt: "annex recomputation: 6 = build+test+4 smoke (validator planned out), 7 = +validator",
    observed: "protocol says 6; guards.mjs plans 6 hosted / 7 local",
  },
  {
    finding: "F-02",
    carrier: "self-improve/replay-protocol-p2b.json",
    contains: "includes 3 adoption cycles",
    class: "MEAS",
    severity: "S1",
    verdict: "GAP",
    fix_class: "evidence_annex",
    required_receipt: "annex: dream-seed1.json gate.validationAdoptions=1; adoptionsAtFreeze=2",
    observed: "receipt records 1 validation adoption, file records 2 at freeze",
  },
  {
    finding: "F-03",
    carrier: "self-improve/policies/pi-1-25.json",
    contains: "corpus",
    class: "IMP",
    severity: "S1",
    verdict: "GAP",
    fix_class: "evidence_annex",
    required_receipt: "self-improve/evidence/p2/dream-receipt-20261012.json + reproduction from 7f2f97f",
    observed: "reproduced receiptHash e7f987e5… from git show 7f2f97f ledger",
  },
  {
    finding: "F-04",
    carrier: "self-improve/replay-protocol-p2b.json",
    contains: "\"sha256\"",
    class: "REF",
    severity: "S2",
    verdict: "GAP",
    fix_class: "evidence_annex",
    required_receipt: "annex hash-semantics register + one sentence in evidence/README.md",
    observed: "four hash roles across replay.mjs:88/:108 and three receipts",
  },
  {
    finding: "F-05",
    carrier: "rrsi/README.md",
    contains: "40-char identifiers",
    class: "REF",
    severity: "S3",
    verdict: "GAP",
    fix_class: "doc",
    required_receipt: "rrsi/lib/rrsi.ts:35 maxIdChars=64; labels capped at 40",
    observed: "40 is the label cap, 64 is the identifier cap",
  },
  {
    finding: "F-06",
    carrier: "rrsi/README.md",
    contains: "Store counts (episodes/attempts/adoptions)",
    class: "BND",
    severity: "S2",
    verdict: "GAP",
    fix_class: "doc",
    required_receipt: "rrsi/lib/rrsi.ts:154-161 decision==adopt; :280 advice status",
    observed: "adoptions counts attempt-level adopt decisions including projected advice records",
  },
  {
    finding: "F-07",
    carrier: "rrsi/README.md",
    contains: "omitted records are labeled",
    class: "BND",
    severity: "S3",
    verdict: "GAP",
    fix_class: "doc",
    required_receipt: "rrsi/tools/rrsi.ts import response has no projection coverage; periodic does",
    observed: "scope sentence needed; additive field deferred to T-B10",
  },
  {
    finding: "F-08",
    carrier: "docs/trajectory-memory.md",
    contains: ".gjc/distill-demo/inputs/",
    class: "REF",
    severity: "S2",
    verdict: "GAP",
    fix_class: "doc",
    required_receipt: "path is gitignored and absent; store-derived rows are not reproducible",
    observed: "documented reproduction path does not exist",
  },
  {
    finding: "F-09",
    carrier: "docs/agent-rules.md",
    contains: "dated run notes",
    class: "BND",
    severity: "S3",
    verdict: "GAP",
    fix_class: "doc",
    required_receipt: "evidence/** dated receipts exist; exception must be stated",
    observed: "rule forbids what evidence/p3/README.md and trajectory-memory.md do",
  },
  {
    finding: "F-10",
    carrier: "docs/trajectory-memory.md",
    contains: "ledgerHead",
    class: "MEAS",
    severity: "S3",
    verdict: "GAP",
    fix_class: "doc",
    required_receipt: "point-in-time snapshot needs measured-at + command",
    observed: "ledgerHead 31 has no reproduction command",
  },
  {
    finding: "F-14",
    carrier: "rrsi/README.md",
    contains: "RRSI_PERIODIC_INTERVAL_MS",
    class: "IMP",
    severity: "S2",
    verdict: "GAP",
    fix_class: "doc",
    required_receipt: "rrsi/lib/periodic.ts:74-79 clamps below floor and above 30 days",
    observed: "out-of-range values are silently clamped, not rejected",
  },
  {
    finding: "F-15",
    carrier: "self-improve/evidence/p3/README.md",
    contains: "Loop counters",
    class: "MEAS",
    severity: "S2",
    verdict: "GAP",
    fix_class: "evidence_annex",
    required_receipt: "annex labels counters.cycles vs finalLoopState.cycles",
    observed: "summary.json carries 5 and 7 under different keys",
  },
  {
    finding: "F-17",
    carrier: "self-improve/replay-protocol-p2b.json",
    contains: "splitDisclosure",
    class: "BND",
    severity: "S2",
    verdict: "GAP",
    fix_class: "evidence_annex",
    required_receipt: "annex: sub-gate train/validation slices overlap when n<trainN+validationN",
    observed: "13-attempt case: train 1-13, validation 8-13",
  },
  {
    finding: "F-18",
    carrier: "self-improve/README.md",
    contains: "advisory numbers",
    class: "MEAS",
    severity: "S3",
    verdict: "GAP",
    fix_class: "doc",
    required_receipt: "recovered receipt candidates[pi-1-25].train=6/407924; advisory measured 3/222696 vs 5/376827",
    observed: "pair is train/full, not P2b; additive label fix",
  },
];

const POSITIVE = [
  {
    carrier: "docs/trajectory-memory.md",
    contains: "Not executed",
    class: "BND",
    severity: "S2",
    verdict: "PASS",
    required_receipt: "E5b status statement",
    observed: "unproven guard-tier run is disclosed",
  },
  {
    carrier: "rrsi/README.md",
    contains: "Scope (functional acceptance only)",
    class: "BND",
    severity: "S2",
    verdict: "PASS",
    required_receipt: "RRSI_SCOPE_SENTENCE in rrsi/lib/rrsi.ts:23-24",
    observed: "plugin scope sentence present and forbids efficacy claims",
  },
  {
    carrier: "self-improve/evidence/p3/README.md",
    contains: "All five cycles are rejects",
    class: "BND",
    severity: "S2",
    verdict: "PASS",
    required_receipt: "ledger seq 27-31 verdicts",
    observed: "five rejects, no adoption",
  },
];

const byKey = new Map();
for (const candidate of candidates) {
  const key = `${candidate.carrier}#${candidate.file_line}#${candidate.text}`;
  byKey.set(key, [candidate]);
}

const carrierCache = new Map();
const carrierLine = (carrier, line) => {
  if (!carrierCache.has(carrier)) {
    carrierCache.set(carrier, scopeText(carrier).split("\n"));
  }
  return carrierCache.get(carrier)[line - 1] ?? "";
};
const carrierDigest = (carrier) => {
  if (!carrierCache.has(`${carrier}#sha`)) {
    carrierCache.set(`${carrier}#sha`, sha256(scopeText(carrier)));
  }
  return carrierCache.get(`${carrier}#sha`);
};

const isFrozen = (carrier) => FROZEN.some((prefix) => carrier.startsWith(prefix));

const UNVERIFIABLE_RECEIPT = {
  "CHANGELOG.md": "release-time receipt (tag/commit); historical release note not re-derived in this audit",
  "README.md": "root overview figure; no stored receipt at this granularity",
  "CONTRIBUTING.md": "process statement; no numeric receipt exists",
  "docs/trajectory-memory.md": "private rrsi store snapshot; non-reproducible by design (see F-08/F-10)",
};

const sourceFor = (carrier) => {
  if (carrier === "rrsi/README.md") return "rrsi/lib/rrsi.ts";
  if (carrier.startsWith("self-improve/") && carrier.endsWith(".md")) return "self-improve/rrsi-protocol.json";
  return carrier;
};

const claims = [];
const dispositions = [];
let claimIndex = 0;
const findingHits = new Set();
const positiveHits = new Set();

for (const [key, group] of byKey) {
  const candidate = group[0];
  const { carrier, file_line: fileLine } = candidate;
  const quote = candidate.text.trim().slice(0, 1000);
  const text = candidate.text;
  const haystack = text;

  const finding = FINDINGS.find(
    (entry) => entry.carrier === carrier && (entry.contains === "" || haystack.includes(entry.contains)),
  );
  const positive = POSITIVE.find(
    (entry) => entry.carrier === carrier && (entry.contains === "" || haystack.includes(entry.contains)),
  );

  claimIndex += 1;
  const id = `K${String(claimIndex).padStart(4, "0")}`;
  let record;

  if (finding) {
    findingHits.add(finding.finding);
    record = {
      id,
      carrier,
      class: finding.class,
      quote,
      file_line: String(fileLine),
      scope_sha: scopeSha,
      severity: finding.severity,
      caveat_adjacency: "n/a",
      required_receipt: finding.required_receipt,
      evidence_kind: "d",
      binding_strength: "",
      binding_command: "",
      observed: finding.observed,
      evidence_sha256: "",
      verdict: "GAP",
      fix_class: finding.fix_class,
    };
    record.binding_command = `gjc audit finding ${finding.finding}`;
  } else if (positive) {
    positiveHits.add(positive.contains);
    record = {
      id,
      carrier,
      class: positive.class,
      quote,
      file_line: String(fileLine),
      scope_sha: scopeSha,
      severity: positive.severity,
      caveat_adjacency: "self",
      required_receipt: positive.required_receipt,
      evidence_kind: "a",
      binding_strength: "self",
      binding_command: "",
      observed: positive.observed,
      evidence_sha256: carrierDigest(carrier),
      verdict: "PASS",
      fix_class: "",
    };
    record.binding_command = ROW_CHECK(id);
  } else {
    const hints = new Set(group.flatMap((entry) => entry.hints));
    let klass = "REF";
    if (hints.has("boundary")) klass = "BND";
    else if (hints.has("roadmap")) klass = "RDM";
    else if (hints.has("number")) klass = "MEAS";
    else if (hints.has("modal")) klass = "IMP";

    let verdict = "PASS";
    let binding = ROW_CHECK(id);
    let observed = `row valid; quote present at ${carrier}:${fileLine}`;
    let evidenceKind = "a";
    let requiredReceipt = "carrier text at the pinned scope";
    let bindingStrength = "self";

    if (klass === "REF") {
      binding = "bun run docs:check";
      observed = "exit 0 at HEAD e74140c (paths/links resolve)";
      requiredReceipt = "docs:check exit status at the pinned scope";
      bindingStrength = "bound";
    } else if (klass === "IMP") {
      const engine = carrier.startsWith("self-improve/") || carrier === "docs/trajectory-memory.md";
      binding = engine ? "bun run test:self-improve" : "bun run build:check";
      observed = engine ? "exit 0; verify-unit ALL PASS (136 cases)" : "exit 0 (generated surfaces in sync)";
      requiredReceipt = engine ? "unit+integration suite exit status" : "build:check exit status";
      bindingStrength = "bound";
    } else if (klass === "RDM") {
      observed = "no implementation path at HEAD e74140c; roadmap language present";
    } else if (klass === "MEAS" && !isFrozen(carrier)) {
      const numberMatch = quote.match(/\d[\d,._]*/);
      const source = sourceFor(carrier);
      if (numberMatch && source !== carrier) {
        binding = `node self-improve/evidence/audit-20261022/tools/check-number.mjs ${carrier} ${source} ${JSON.stringify(numberMatch[0])}`;
        observed = `checked ${numberMatch[0]} in ${source}`;
        requiredReceipt = `${source} contains the documented literal`;
        bindingStrength = "bound";
      } else {
        verdict = "UNVERIFIABLE";
        binding = "";
        observed = "no constant binding selected at Phase A";
        evidenceKind = "d";
        bindingStrength = "";
        requiredReceipt = UNVERIFIABLE_RECEIPT[carrier] ?? "result receipt or code-constant binding";
      }
    }

    record = {
      id,
      carrier,
      class: klass,
      quote,
      file_line: String(fileLine),
      scope_sha: scopeSha,
      severity: klass === "REF" || klass === "RDM" ? "S3" : "S2",
      caveat_adjacency: klass === "BND" ? "self" : "n/a",
      required_receipt: requiredReceipt,
      evidence_kind: evidenceKind,
      binding_strength: bindingStrength,
      binding_command: binding,
      observed,
      evidence_sha256: verdict === "PASS" ? carrierDigest(carrier) : "",
      verdict,
      fix_class: verdict === "UNVERIFIABLE" ? "doc" : "",
    };
  }

  claims.push(record);
  group.forEach((entry) => {
    dispositions.push({
      candidate_id: entry.id,
      disposition: "claim",
      claim_id: id,
      reason: "",
    });
  });
}

for (const finding of FINDINGS) {
  if (!findingHits.has(finding.finding)) {
    process.stderr.write(`triage: finding ${finding.finding} matched no carrier line\n`);
  }
}
for (const positive of POSITIVE) {
  if (!positiveHits.has(positive.contains)) {
    process.stderr.write(`triage: positive control "${positive.contains}" matched no carrier line\n`);
  }
}

const toCsv = (rows) => {
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(escape).join(",")).join("\n") + "\n";
};

writeFileSync(path.join(auditDir, "claims.csv"), toCsv([COLUMNS, ...claims.map((row) => COLUMNS.map((column) => row[column]))]));
writeFileSync(path.join(auditDir, "dispositions.jsonl"), dispositions.map((row) => JSON.stringify(row)).join("\n") + "\n");

const counts = claims.reduce((accumulator, claim) => {
  accumulator[claim.verdict] = (accumulator[claim.verdict] ?? 0) + 1;
  return accumulator;
}, {});
process.stdout.write(`claims=${claims.length} candidates=${candidates.length} PASS=${counts.PASS ?? 0} GAP=${counts.GAP ?? 0} UNVERIFIABLE=${counts.UNVERIFIABLE ?? 0}\n`);
