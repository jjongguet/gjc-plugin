// Oracle for cost-arith: 400000 input tokens at $3e-8 plus 20000 output tokens
// at $1.2e-7 is 0.012 + 0.0024 = 0.0144. Both components and the total must be
// reported from the committed inputs.
const TOTAL = 0.0144;
const INPUT_COMPONENT = 0.012;
const OUTPUT_COMPONENT = 0.0024;
const TOLERANCE = 1e-6;
// Plausible arithmetic slips this fixture is designed to catch (unit and
// price-swap errors), never the correct total or its components.
const WRONG = [0.0036, 0.144, 0.1224, 0.0486, 0.0042, 0.0012, 0.00024, 0.024, 0.014, 0.14, 14.4];

function numbers(text) {
  const values = [];
  for (const match of text.matchAll(/-?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?/g)) {
    const value = Number(match[0].replace(",", "."));
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function near(values, target) {
  return values.some((value) => Math.abs(value - target) <= TOLERANCE);
}

export default function oracle({ parsed, workDir, git }) {
  const checks = [];
  const calls = Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : [];
  const finalText = typeof parsed?.finalText === "string" ? parsed.finalText : "";
  const values = numbers(finalText);

  const seen = (name) =>
    calls.some(
      (call) =>
        !["write", "edit"].includes(String(call?.name)) &&
        JSON.stringify(call?.args ?? {}).includes(name),
    );
  const inputsRead = seen("pricing.json") && seen("usage.json");
  checks.push({ id: "inputs-read", pass: inputsRead, note: inputsRead ? "" : "pricing.json and usage.json were not both read" });

  const total = near(values, TOTAL);
  checks.push({ id: "total-correct", pass: total, note: total ? "" : `answer does not contain ${TOTAL}` });

  const inputComponent = near(values, INPUT_COMPONENT);
  checks.push({
    id: "input-component",
    pass: inputComponent,
    note: inputComponent ? "" : `answer does not contain ${INPUT_COMPONENT}`,
  });

  const outputComponent = near(values, OUTPUT_COMPONENT);
  checks.push({
    id: "output-component",
    pass: outputComponent,
    note: outputComponent ? "" : `answer does not contain ${OUTPUT_COMPONENT}`,
  });

  const wrong = values.find((value) => WRONG.some((candidate) => Math.abs(value - candidate) <= 1e-9));
  checks.push({ id: "no-wrong-number", pass: wrong === undefined, note: wrong === undefined ? "" : `answer contains the wrong cost ${wrong}` });

  let unmodified = false;
  try {
    unmodified = String(git(["status", "--porcelain", "--", "pricing.json", "usage.json"]) ?? "").trim() === "";
  } catch {
    unmodified = false;
  }
  checks.push({ id: "inputs-unmodified", pass: unmodified, note: unmodified ? "" : "pricing.json or usage.json was modified" });

  const answered = finalText.trim() !== "";
  checks.push({ id: "final-answer", pass: answered, note: answered ? "" : "no final text" });

  const hardFail = !answered || !total || wrong !== undefined || !unmodified;
  const missing = [];
  if (!inputsRead) missing.push("input reads");
  if (!inputComponent) missing.push("input component");
  if (!outputComponent) missing.push("output component");
  const score = hardFail ? 0 : missing.length === 0 ? 2 : missing.length === 1 ? 1 : 0;
  return { score, checks };
}
