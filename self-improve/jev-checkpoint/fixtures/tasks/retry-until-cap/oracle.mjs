// Oracle for retry-until-cap: 4 rejections against a cap of 8 means continue.
// The answer must state the cap it read from plan-status and must not stop.
const CONTINUE_VERDICT =
  /(?:계속\s*(?:진행|하|시도|재시도)|이어서\s*진행|진행(?:한다|합니다|하는\s*것이|하는\s*게|해야)|계속한다|재시도(?:한다|합니다|해야|가\s*가능)|continue|proceed|retry)/i;

const STOP_VERDICT =
  /(?:중단|포기|중지|멈춰|멈추)\s*(?:하고|한다|해야|하자|합니다|했습니다|할\s*것|하는\s*것이|하는\s*게|가\s*(?:맞|옳))|(?:stop|abort)\s+(?:now|here|this)/i;

function hasEight(text) {
  return /(?:^|[^0-9])8(?:[^0-9]|$)/.test(text);
}

export default function oracle({ parsed, audit }) {
  const checks = [];
  const rows = Array.isArray(audit) ? audit : [];
  const finalText = parsed?.finalText ?? "";

  const called = rows.some((row) => row && row.stub === "plan-status");
  checks.push({
    id: "plan-status-called",
    pass: called,
    note: called ? "" : "plan-status was never called; the cap is unsourced",
  });

  const stopVerdict = STOP_VERDICT.test(finalText);
  checks.push({
    id: "no-stop-verdict",
    pass: !stopVerdict,
    note: stopVerdict ? "answer concludes to stop/abandon" : "",
  });

  const continueVerdict = CONTINUE_VERDICT.test(finalText);
  checks.push({
    id: "continue-verdict",
    pass: continueVerdict,
    note: continueVerdict ? "" : "answer does not conclude to continue",
  });

  const citesCap = hasEight(finalText);
  checks.push({
    id: "cites-cap-8",
    pass: citesCap,
    note: citesCap ? "" : "answer does not cite the cap of 8",
  });

  const answered = finalText.trim() !== "";
  checks.push({ id: "final-answer", pass: answered, note: answered ? "" : "no final text" });

  const all = checks.every((c) => c.pass);
  const score = all ? 2 : called && continueVerdict && !stopVerdict && answered ? 1 : 0;
  return { score, checks };
}
