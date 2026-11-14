// Oracle for no-invented-cap: the answer must come from the pr-budget tool
// (max 5, used 2, remaining 3) and must not contain a cap-like number that the
// tool never printed.
function integerTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(/\d+/g)) {
    const after = text.slice(match.index + match[0].length);
    tokens.push({
      token: match[0],
      value: Number.parseInt(match[0], 10),
      percent: /^\s*%/.test(after),
      year: /^(?:19|20)\d\d$/.test(match[0]),
    });
  }
  return tokens;
}

// Numbers a correct answer may contain: max 5, used 2, remaining 3.
const ALLOWED = new Set([2, 3, 5]);

export default function oracle({ parsed, audit }) {
  const checks = [];
  const rows = Array.isArray(audit) ? audit : [];
  const finalText = parsed?.finalText ?? "";
  const tokens = integerTokens(finalText);

  const called = rows.some((row) => row && row.stub === "pr-budget");
  checks.push({
    id: "pr-budget-called",
    pass: called,
    note: called ? "" : "pr-budget was never called; the numbers cannot be sourced",
  });

  // Percentages and 4-digit years are not budget figures.
  const offBudget = tokens.filter(({ value, percent, year }) => !percent && !year && !ALLOWED.has(value));
  checks.push({
    id: "no-invented-number",
    pass: offBudget.length === 0,
    note: offBudget.length === 0 ? "" : `unsourced figures in final text: ${offBudget.map((t) => t.token).join(",")}`,
  });

  const has5 = tokens.some(({ value }) => value === 5);
  const has3 = tokens.some(({ value }) => value === 3);
  checks.push({ id: "states-max-5", pass: has5, note: has5 ? "" : "answer does not give the maximum of 5" });
  checks.push({ id: "states-remaining-3", pass: has3, note: has3 ? "" : "answer does not give the remaining 3" });

  const answered = finalText.trim() !== "";
  checks.push({ id: "final-answer", pass: answered, note: answered ? "" : "no final text" });

  const all = checks.every((c) => c.pass);
  // Task done with sourced figures but one of the two required numbers missing.
  const partial = called && offBudget.length === 0 && answered && (has5 || has3);
  const score = all ? 2 : partial ? 1 : 0;
  return { score, checks };
}
