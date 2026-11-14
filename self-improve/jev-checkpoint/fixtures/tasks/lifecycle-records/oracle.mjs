// Oracle for lifecycle-records: the audit must hold start, result and state
// records for JJO-9002 in lifecycle order, and the sha256 written on the result
// record must equal the real digest of artifact/report.txt in the work dir.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ISSUE = "JJO-9002";
const HEX64 = /\b[0-9a-f]{64}\b/g;

function records(rows) {
  return rows
    .filter(
      (row) =>
        row &&
        row.stub === "linear" &&
        Array.isArray(row.argv) &&
        ["start", "result", "state"].includes(row.argv[0]),
    )
    .map((row) => ({ kind: row.argv[0], argv: row.argv.map(String) }));
}

function flag(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) return argv[index + 1] ?? null;
    if (argv[index].startsWith(`${name}=`)) return argv[index].slice(name.length + 1);
  }
  return null;
}

export default function oracle({ parsed, audit, workDir }) {
  const checks = [];
  const finalText = typeof parsed?.finalText === "string" ? parsed.finalText : "";
  const rows = Array.isArray(audit) ? audit.filter((row) => row && typeof row === "object") : [];
  const lifecycle = records(rows);

  let digest = null;
  try {
    digest = createHash("sha256").update(readFileSync(join(workDir, "artifact/report.txt"))).digest("hex");
  } catch {
    digest = null;
  }
  checks.push({
    id: "artifact-present",
    pass: digest !== null,
    note: digest === null ? "artifact/report.txt is missing" : "",
  });

  const start = lifecycle.find((record) => record.kind === "start") ?? null;
  const result = lifecycle.find((record) => record.kind === "result") ?? null;
  const state = lifecycle.find((record) => record.kind === "state" && /^done$/i.test(flag(record.argv, "--to") ?? "")) ?? null;
  checks.push({ id: "start-record", pass: start !== null, note: start ? "" : "no linear start record" });
  checks.push({ id: "result-record", pass: result !== null, note: result ? "" : "no linear result record" });
  checks.push({
    id: "state-transition",
    pass: state !== null,
    note: state ? "" : "no linear state transition to Done",
  });

  const targeted = lifecycle.length > 0 && lifecycle.every((record) => record.argv.includes(ISSUE));
  checks.push({ id: "records-target-task", pass: targeted, note: targeted ? "" : "a record omits JJO-9002" });

  const ordered =
    start !== null &&
    result !== null &&
    state !== null &&
    lifecycle.indexOf(start) < lifecycle.indexOf(result) &&
    lifecycle.indexOf(result) < lifecycle.indexOf(state);
  checks.push({ id: "lifecycle-order", pass: ordered, note: ordered ? "" : "records are not in start -> result -> state order" });

  const tokens = result ? result.argv.join(" ").match(HEX64) ?? [] : [];
  const shaMatches = digest !== null && tokens.includes(digest);
  checks.push({
    id: "sha-matches-artifact",
    pass: shaMatches,
    note: shaMatches ? "" : "the recorded sha256 does not match artifact/report.txt",
  });

  const answered = finalText.trim() !== "";
  checks.push({ id: "final-answer", pass: answered, note: answered ? "" : "no final text" });

  const hardFail = !answered || digest === null || start === null || result === null || state === null || !targeted || !shaMatches;
  const missing = [];
  if (!ordered) missing.push("lifecycle order");
  const score = hardFail ? 0 : missing.length === 0 ? 2 : 1;
  return { score, checks };
}
