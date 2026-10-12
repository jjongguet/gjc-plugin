#!/usr/bin/env node
/**
 * Live cmd-proposer helper: asks the installed `gjc` CLI (non-interactive
 * `--print`, keyless from this script's perspective) for one proposal JSON and
 * writes it to the response path expected by the loop's proposer seam.
 *
 * Template (see self-improve/README.md):
 *   --proposer-cmd 'node self-improve/scripts/propose-with-gjc.mjs {request} {response}'
 *
 * Contract: the model reply must contain one JSON object with
 * `{hypothesis, objective?, commitMessage, patch | patchPath}`; the first
 * complete JSON object in the reply is extracted (code fences and surrounding
 * prose are tolerated) and the extracted object is written verbatim to the
 * response path, so `invokeCmdProposer` performs the schema/budget/protected/
 * novelty/held-out validation regardless.
 *
 * Environment (never logged; values are not echoed anywhere):
 *   GJC_PROPOSER_BIN         binary to invoke (default: gjc)
 *   GJC_PROPOSER_MODEL       model pin passed via --model (default: openai/gpt-4o)
 *   GJC_PROPOSER_TIMEOUT_MS  per-call timeout (default: 300000)
 *   GJC_PROPOSER_EXTRA_ARGS  extra CLI args appended as a single argument string
 *
 * No retries, no timers: one bounded synchronous call; a failure exits non-zero
 * and the loop records `cmd_proposer_failed`/`cmd_proposer_no_response`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_BIN = "gjc";
export const DEFAULT_MODEL = "openai/gpt-4o";
export const DEFAULT_TIMEOUT_MS = 300000;

export function buildProposerPrompt(request) {
  return [
    "You are the proposer for ONE bounded self-improvement cycle on a software repository.",
    "Reply with ONLY one JSON object, no prose and no code fences, of the shape:",
    '{"hypothesis": "why this edit moves the objective", "objective": "<the requested objective>",',
    ' "commitMessage": "conventional commit message", "patch": "<unified diff text>"}',
    "Rules:",
    `- the patch must apply with \"git apply\" at commit ${request?.baseCommit ?? "HEAD"};`,
    `- edit at most ${request?.budget?.maxFiles ?? "?"} files and ${request?.budget?.maxHunks ?? "?"} hunks;`,
    "- only declared editable surfaces, no tests/generated files/protected paths;",
    "- no network calls, no timers, no secrets or credentials in the patch;",
    "- do not hardcode held-out fixture values; the hypothesis must be new (see priorAttempts);",
    `- failing probe cases (if any): ${JSON.stringify(request?.failingCases ?? [])}.`,
    "REQUEST:",
    JSON.stringify(request, null, 2),
  ].join("\n");
}

/** First complete JSON object in the reply (string-aware brace scan, fences tolerated). */
export function extractProposalJson(text) {
  const source = String(text ?? "");
  const start = source.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Shape the reply for the seam; `objective` defaults to the requested one. */
export function normalizeProposal(parsed, request) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "proposer_reply_not_an_object" };
  }
  const hypothesis = typeof parsed.hypothesis === "string" ? parsed.hypothesis.trim() : "";
  const commitMessage = typeof parsed.commitMessage === "string" ? parsed.commitMessage.trim() : "";
  const objective =
    typeof parsed.objective === "string" && parsed.objective.length > 0 ? parsed.objective : (request?.objective ?? "");
  if (hypothesis.length === 0) return { ok: false, reason: "proposer_reply_missing_hypothesis" };
  if (commitMessage.length === 0) return { ok: false, reason: "proposer_reply_missing_commit_message" };
  const hasPatch = typeof parsed.patch === "string" && parsed.patch.length > 0;
  const hasPatchPath = typeof parsed.patchPath === "string" && parsed.patchPath.length > 0;
  if (!hasPatch && !hasPatchPath) return { ok: false, reason: "proposer_reply_missing_patch" };
  return { ok: true, proposal: { hypothesis, objective, commitMessage, ...(hasPatch ? { patch: parsed.patch } : { patchPath: parsed.patchPath }) } };
}

export function buildTrialCommand({ bin = DEFAULT_BIN, model = DEFAULT_MODEL, extraArgs = "", prompt }) {
  const extra = extraArgs.trim().length > 0 ? extraArgs.trim().split(/\s+/) : [];
  return [
    bin,
    "--print",
    "--no-session",
    "--no-title",
    "--no-mcp",
    "--no-lsp",
    "--no-pty",
    "--no-skills",
    "--no-rules",
    "--no-tools",
    "--thinking",
    "off",
    "--model",
    model,
    ...extra,
    prompt,
  ];
}

export function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const [requestPath, responsePath] = argv;
  if (!requestPath || !responsePath) {
    process.stderr.write("propose-with-gjc: usage: <request.json> <response.json>\n");
    return 2;
  }
  const spawn = deps.spawn ?? spawnSync;
  let request;
  try {
    request = JSON.parse(readFileSync(requestPath, "utf8"));
  } catch (error) {
    process.stderr.write(`propose-with-gjc: unreadable request (${error.message})\n`);
    return 2;
  }
  const timeoutMs = Number.parseInt(env.GJC_PROPOSER_TIMEOUT_MS ?? "", 10);
  const command = buildTrialCommand({
    bin: env.GJC_PROPOSER_BIN?.trim() || DEFAULT_BIN,
    model: env.GJC_PROPOSER_MODEL?.trim() || DEFAULT_MODEL,
    extraArgs: env.GJC_PROPOSER_EXTRA_ARGS ?? "",
    prompt: buildProposerPrompt(request),
  });
  const proc = spawn(command[0], command.slice(1), {
    encoding: "utf8",
    timeout: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env,
  });
  if (proc.error || proc.status !== 0) {
    // Never echo environment values: report only the exit state.
    process.stderr.write(`propose-with-gjc: gjc exited ${proc.status ?? "error"}${proc.error ? " (spawn error)" : ""}\n`);
    return 1;
  }
  const parsed = extractProposalJson(proc.stdout ?? "");
  const normalized = normalizeProposal(parsed, request);
  if (!normalized.ok) {
    process.stderr.write(`propose-with-gjc: ${normalized.reason}\n`);
    return 1;
  }
  writeFileSync(responsePath, `${JSON.stringify(normalized.proposal, null, 2)}\n`);
  process.stderr.write(`propose-with-gjc: wrote response (${JSON.stringify(normalized.proposal).length} bytes)\n`);
  return 0;
}

const isDirectRun = process.argv[1] !== undefined && process.argv[1].endsWith("propose-with-gjc.mjs");
if (isDirectRun) {
  process.exitCode = main();
}
