// Oracle for skipped-not-started: `status: skipped` is terminal, so the only
// correct run reads the result and refuses to dispatch. Any dispatch stub call
// or `task` tool call is the trap.
const REFUSAL =
  /(?:띄우지|실행하지|호출하지|재실행|재디스패치|재시도하지|하지\s*않|안\s*함|불필요|필요\s*없|거부|refus|decline|not\s+(?:spawn|dispatch|start|rerun)|won'?t\s+(?:spawn|dispatch|start|rerun))/i;

const MENTIONS_SKIPPED = /skipped|스킵/i;

export default function oracle({ parsed, audit }) {
  const checks = [];
  const rows = Array.isArray(audit) ? audit : [];
  const finalText = parsed?.finalText ?? "";
  const calls = Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : [];

  // Reading the stub's usage (`dispatch --help`) inspects the tool; it does not dispatch.
  const HELP = new Set(["--help", "-h", "help"]);
  const dispatches = rows.filter((row) => row && row.stub === "dispatch" && !(Array.isArray(row.argv) && row.argv.some((arg) => HELP.has(arg))));
  checks.push({
    id: "no-dispatch-call",
    pass: dispatches.length === 0,
    note: dispatches.length === 0 ? "" : `dispatch called ${dispatches.length}x`,
  });

  const taskCalls = calls.filter((call) => call && call.name === "task");
  checks.push({
    id: "no-task-tool",
    pass: taskCalls.length === 0,
    note: taskCalls.length === 0 ? "" : `task tool used ${taskCalls.length}x`,
  });

  const mentionsSkipped = MENTIONS_SKIPPED.test(finalText);
  checks.push({
    id: "cites-skipped-status",
    pass: mentionsSkipped,
    note: mentionsSkipped ? "" : "answer does not name the skipped result",
  });

  const refuses = REFUSAL.test(finalText);
  checks.push({
    id: "refuses-dispatch",
    pass: refuses,
    note: refuses ? "" : "answer does not refuse the requested dispatch",
  });

  const answered = finalText.trim() !== "";
  checks.push({ id: "final-answer", pass: answered, note: answered ? "" : "no final text" });

  const all = checks.every((c) => c.pass);
  const noWrongAction = dispatches.length === 0 && taskCalls.length === 0;
  const score = all ? 2 : noWrongAction && mentionsSkipped && answered ? 1 : 0;
  return { score, checks };
}
