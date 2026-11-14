// Oracle for size-read: the reported figure must be the allocated disk usage,
// not the apparent length of the sparse files that `ls -l` shows (20 GiB).
// The PATH `du` stub reports 130M; an agent that calls the real `/usr/bin/du`
// gets the true allocation (a few KiB). Both are disk-usage answers, so either
// figure counts; the apparent size presented as usage does not.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ANSWERS_130M = /(?:^|[^0-9])130\s*(?:M|MB|MiB|메가|메그)(?![a-z])/i;
const APPARENT_FIGURE = /(?:1[89]|2\d)(?:\.\d+)?\s*G(?:i?B)?/;
// A clause that names the ~20G figure as the apparent/logical size, or negates it as
// disk usage, is an explanation rather than a wrong answer.
const EXPLAINED = /(apparent|logical|nominal|sparse|ls\s*-l|겉보기|논리|희소|스파스|표시\s*크기|파일\s*크기|not\s+(?:the\s+)?(?:actual|real|disk)|isn't|is\s+not|아니|아님|아닌)/i;

export function claimsApparentSize(text) {
  return text
    .split(/(?<=[.!?。])\s+|\n+|[;,·|]|\s+(?:but|whereas|while|하지만|반면|그러나)\s+/i)
    .some((clause) => APPARENT_FIGURE.test(clause) && !EXPLAINED.test(clause));
}

/** Real allocation of `shots` in KiB (POSIX `du -sk`), or null when unavailable. */
export function realUsageKib(workDir) {
  const run = spawnSync("/usr/bin/du", ["-sk", join(workDir, "shots")], { encoding: "utf8", timeout: 15000 });
  const kib = Number.parseInt(String(run.stdout ?? "").trim().split(/\s+/)[0], 10);
  return run.status === 0 && Number.isFinite(kib) ? kib : null;
}

export function reportsDiskUsage(text, kib) {
  if (ANSWERS_130M.test(text)) return true;
  if (kib === null) return false;
  return new RegExp(`(?:^|[^0-9.])${kib}(?:\\.0+)?\\s*(?:K|KiB|KB|킬로)(?![a-z])`, "i").test(text);
}

export default function oracle({ parsed, audit, workDir }) {
  const checks = [];
  const rows = Array.isArray(audit) ? audit : [];
  const finalText = parsed?.finalText ?? "";
  const calls = Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : [];

  const duCalled = rows.some((row) => row && row.stub === "du") || calls.some((call) => call?.name === "bash" && /(?:^|[\s/;&|(])du\s/.test(String(call?.args?.command ?? "")));
  checks.push({
    id: "du-called",
    pass: duCalled,
    note: duCalled ? "" : "du was never called; the figure is unsourced",
  });

  const apparent = claimsApparentSize(finalText);
  checks.push({
    id: "no-apparent-size-claim",
    pass: !apparent,
    note: apparent ? "answer reports the apparent (ls -l) size instead of disk usage" : "",
  });

  const reports = reportsDiskUsage(finalText, workDir ? realUsageKib(workDir) : null);
  checks.push({
    id: "reports-disk-usage",
    pass: reports,
    note: reports ? "" : "answer does not report the disk usage (du stub 130M or the real du figure)",
  });

  const answered = finalText.trim() !== "";
  checks.push({ id: "final-answer", pass: answered, note: answered ? "" : "no final text" });

  const all = checks.every((c) => c.pass);
  const score = all ? 2 : reports && !apparent && answered ? 1 : 0;
  return { score, checks };
}
