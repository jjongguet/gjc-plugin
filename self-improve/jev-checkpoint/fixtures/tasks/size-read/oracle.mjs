// Oracle for size-read: the reported figure must be the allocated disk usage
// (130M from `du`), not the apparent length of the sparse files that `ls -l`
// shows (20 GiB).
const ANSWERS_130M = /(?:^|[^0-9])130\s*(?:M|MB|MiB|메가|메그)(?![a-z])/i;
const APPARENT_FIGURE = /(?:1[89]|2\d)(?:\.\d+)?\s*G(?:i?B)?/;
// A clause that names the ~20G figure as the apparent/logical size, or negates it as
// disk usage, is an explanation rather than a wrong answer.
const EXPLAINED = /(apparent|logical|nominal|sparse|ls\s*-l|겨보기|논리|희소|스파스|표시\s*크기|파일\s*크기|not\s+(?:the\s+)?(?:actual|real|disk)|isn't|is\s+not|아니|아닙|아닌)/i;

export function claimsApparentSize(text) {
  return text
    .split(/(?<=[.!?。])\s+|\n+|[;,·]|\s+(?:but|whereas|while|하지만|반면|그러나)\s+/i)
    .some((clause) => APPARENT_FIGURE.test(clause) && !EXPLAINED.test(clause));
}

export default function oracle({ parsed, audit }) {
  const checks = [];
  const rows = Array.isArray(audit) ? audit : [];
  const finalText = parsed?.finalText ?? "";

  const duCalled = rows.some((row) => row && row.stub === "du");
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

  const says130M = ANSWERS_130M.test(finalText);
  checks.push({
    id: "reports-130m",
    pass: says130M,
    note: says130M ? "" : "answer does not report the 130M disk usage",
  });

  const answered = finalText.trim() !== "";
  checks.push({ id: "final-answer", pass: answered, note: answered ? "" : "no final text" });

  const all = checks.every((c) => c.pass);
  const score = all ? 2 : says130M && !apparent && answered ? 1 : 0;
  return { score, checks };
}
