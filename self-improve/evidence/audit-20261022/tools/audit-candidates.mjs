#!/usr/bin/env node
/**
 * Phase-A audit helper: mechanical candidate generation over the enumerated
 * carriers. Emits one JSONL row per sentence that contains a number, a modal
 * claim verb, a path/sha/link, or a boundary phrase. It does not decide
 * falsifiability; every candidate must receive a disposition in
 * dispositions.jsonl and every `claim` disposition must appear in claims.csv.
 *
 * Usage: node self-improve/evidence/audit-20261022/tools/audit-candidates.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = process.env.AUDIT_SCOPE_SHA ?? "e74140c7b014b60402b6f2c4ef748cfd1b7d3512";
const here = path.dirname(fileURLToPath(import.meta.url));
const auditDir = path.resolve(here, "..");
const repoRoot = path.resolve(auditDir, "..", "..", "..");
const carriersRoot = process.env.AUDIT_CARRIERS_DIR ? path.resolve(process.env.AUDIT_CARRIERS_DIR) : null;
const stdoutMode = process.argv.includes("--stdout");

const readCarrier = (carrier) => {
  if (carriersRoot) return readFileSync(path.join(carriersRoot, carrier), "utf8");
  return execFileSync("git", ["show", `${SCOPE}:${carrier}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
};

export const CARRIERS = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "docs/agent-rules.md",
  "docs/trajectory-memory.md",
  "rrsi/README.md",
  "self-improve/README.md",
  "self-improve/DREAM.md",
  "self-improve/PATTERNS.md",
  "self-improve/HARNESS2.md",
  "self-improve/evidence/README.md",
  "self-improve/evidence/p2b/README.md",
  "self-improve/evidence/p3/README.md",
  "self-improve/policies/pi-1-25.json",
  "self-improve/policies/current.json",
  "self-improve/rrsi-protocol.json",
  "self-improve/replay-protocol.json",
  "self-improve/replay-protocol-p2b.json",
];

const NUMBER = /\d/;
const BOUNDARY = /\b(do(?:es)? not|must not|never|not|no|without|cannot|insufficient|unproven|degraded|reject(?:s|ed)?|fail(?:s|ed)?|absent|missing|zero|refus(?:e|es|ed))\b/i;
const MODAL = /\b(implement(?:s|ed)?|install(?:s|ed)?|provid(?:e|es|ed)|expos(?:e|es|ed)|support(?:s|ed)?|emit(?:s|ted)?|return(?:s|ed)?|writ(?:e|es|ten)|captur(?:e|es|ed)|project(?:s|ed)?|rank(?:s|ed)?|keeps?|reports?|records?|binds?|freezes?|frozen|met|meets|passes?|failed|reproduce(?:s|d)?|adopt(?:s|ed)?|reject(?:s|ed)?|prove(?:s|n)?|establish(?:es)?|demonstrat(?:e|es|ed)|disclos(?:e|es|ed)|forbid(?:s)?|require(?:s|d)?|allow(?:s|ed)?|guard(?:s|ed)?|land(?:s|ed)?|commit(?:s|ted)?)\b/i;
const REF = /(?:[\w.-]+\/[\w./-]+|[a-f0-9]{7,40}|https?:\/\/[^\s)>\]]+|JJO-\d+)/i;
const ROADMAP = /\b(planned|future|roadmap|not (?:yet )?installed|M[123]\b|follow-up|proposal)\b/i;

function splitSentences(line) {
  const text = line.trim();
  if (text.length === 0) return [];
  if (text.startsWith("|")) return [text];
  if (/^[-*]\s+/.test(text)) return [text];
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"`*([])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const rows = [];
let index = 0;
for (const carrier of CARRIERS) {
  const text = readCarrier(carrier);
  const lines = text.split("\n");
  let inFence = false;
  for (let lineNo = 1; lineNo <= lines.length; lineNo += 1) {
    const line = lines[lineNo - 1];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*$/.test(line)) continue;
    if (carrier.endsWith(".json") && !/"[^"]{10,}"/.test(line)) continue;
    for (const sentence of splitSentences(line)) {
      const hints = [];
      if (NUMBER.test(sentence)) hints.push("number");
      if (BOUNDARY.test(sentence)) hints.push("boundary");
      if (MODAL.test(sentence)) hints.push("modal");
      if (REF.test(sentence)) hints.push("ref");
      if (ROADMAP.test(sentence)) hints.push("roadmap");
      if (hints.length === 0) continue;
      index += 1;
      rows.push({
        id: `A${String(index).padStart(4, "0")}`,
        carrier,
        file_line: lineNo,
        text: sentence.replace(/\s+/g, " ").slice(0, 2000),
        hints,
      });
    }
  }
}

const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
if (stdoutMode) {
  process.stdout.write(body);
} else {
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(path.join(auditDir, "candidates.jsonl"), body);
  process.stdout.write(`candidates=${rows.length} carriers=${CARRIERS.length} out=${path.relative(repoRoot, path.join(auditDir, "candidates.jsonl"))}\n`);
}
