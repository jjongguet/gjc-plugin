// Decision-model adapter for the only ambiguous classification.
//
// The deterministic rules decide everything they can. When `judgeSession`
// reports an ambiguity, one bounded `decision-ask` call picks between the
// offered labels; any failure (missing CLI, abstain, provider error, invalid
// label) falls back to the deterministic default and records why. A decision is
// never treated as evidence of progress.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultRunner } from "./exec.mjs";

export const DECISION_MODEL = "jev-omni";
export const DECISION_MIN_CONFIDENCE = 0.6;

/**
 * @param {object} session
 * @param {ReturnType<import("./judge.mjs").judgeSession>} judgment
 * @param {object} [options]
 * @returns {Promise<object>} judgment with `source`, `model`, `confidence`, `error`
 */
export async function resolveJudgment(session, judgment, {
  runner = defaultRunner,
  decisionAsk = process.env.SUPERVISOR_DECISION_ASK ?? path.join(os.homedir(), ".gjc-user-policy", "bin", "decision-ask"),
  model = DECISION_MODEL,
  timeoutMs = 8000,
  now = Date.now(),
} = {}) {
  const deterministic = { ...judgment, source: "deterministic" };
  if (!judgment.ambiguous) return deterministic;

  const { labels, defaultState, question } = judgment.ambiguous;
  const dir = await mkdtemp(path.join(os.tmpdir(), "supervisor-decision-"));
  const statePath = path.join(dir, "state.txt");
  try {
    await writeFile(statePath, decisionState({ session, judgment, now }), { mode: 0o600 });
    const result = await runner(
      decisionAsk,
      [
        "--question",
        question,
        "--criteria",
        labels.join(","),
        "--state-file",
        statePath,
        "--model",
        model,
        "--min-confidence",
        String(DECISION_MIN_CONFIDENCE),
        "--timeout-ms",
        String(timeoutMs),
        "--json",
      ],
      { timeoutMs: timeoutMs + 5000 },
    );
    if (!result.ok) {
      return fallback(judgment, `decision_exit_${result.code ?? "error"}:${result.error ?? ""}`.replace(/:$/, ""));
    }
    let receipt;
    try {
      receipt = JSON.parse(result.stdout.trim());
    } catch {
      return fallback(judgment, "decision_invalid_json");
    }
    const choice = receipt.choice ?? receipt.answer ?? null;
    const confidence = Number(receipt.confidence ?? NaN);
    if (!labels.includes(choice)) return fallback(judgment, `decision_unknown_label:${String(choice).slice(0, 24)}`);
    if (!Number.isFinite(confidence) || confidence < DECISION_MIN_CONFIDENCE) return fallback(judgment, "decision_low_confidence");
    return {
      ...judgment,
      state: choice,
      source: "decision",
      model: receipt.model ?? model,
      confidence,
      rationale: judgment.reasons,
    };
  } catch (error) {
    return fallback(judgment, `decision_error:${error.message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fallback(judgment, error) {
  return {
    ...judgment,
    state: judgment.ambiguous?.defaultState ?? judgment.state,
    source: "deterministic_fallback",
    error,
  };
}

function decisionState({ session, judgment, now }) {
  const age = session.ageMinutes === null ? "unknown" : `${session.ageMinutes} minutes`;
  return [
    "Workspace coding session (one agent session in a git worktree):",
    `target: ${session.target}`,
    `name: ${session.name}`,
    `branch: ${session.branch ?? "unknown"}`,
    `session age: ${age}`,
    `commits since session start: ${session.commitsSinceStart ?? "unknown"}`,
    `commits in the last 10 minutes: ${session.commitsLastWindow ?? 0}`,
    `uncommitted changed files: ${session.dirty ?? 0}`,
    `last commit: ${session.lastCommit?.at ?? "none"}`,
    `last observed file activity: ${session.lastActivityAt ?? "none"}`,
    `observed at: ${new Date(now).toISOString()}`,
    `deterministic signals: ${judgment.reasons.join(", ")}`,
    "",
    "stalled = no commit for a whole stall window; thrashing = edits accumulate without commits; progressing = a commit landed inside the progress window.",
  ].join("\n");
}
