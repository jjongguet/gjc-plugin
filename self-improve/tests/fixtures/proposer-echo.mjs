#!/usr/bin/env node
/**
 * Hermetic cmd-proposer stand-in for the trajectory-distill handoff test.
 *
 * Usage: node proposer-echo.mjs <request.json> <response.json>
 *
 * It refuses to respond unless the request carries the pinned candidate
 * contrast, then writes a deterministic response with a fixed new-file patch
 * inside the editable `verification-receipts/lib/**` surface.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [requestPath, responsePath] = process.argv.slice(2);
if (!requestPath || !responsePath) {
  process.stderr.write("usage: proposer-echo.mjs <request.json> <response.json>\n");
  process.exit(2);
}

const request = JSON.parse(readFileSync(requestPath, "utf8"));
if (!request.contrast || typeof request.contrast.candidateId !== "string") {
  process.stderr.write("proposer-echo: request.contrast.candidateId missing\n");
  process.exit(3);
}

const patch = [
  "diff --git a/verification-receipts/lib/gjc-proposer-smoke.ts b/verification-receipts/lib/gjc-proposer-smoke.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/verification-receipts/lib/gjc-proposer-smoke.ts",
  "@@ -0,0 +1,1 @@",
  "+export const gjcProposerSmoke = 1;",
  "",
].join("\n");

const response = {
  hypothesis: `Apply the pinned contrast rule for ${request.contrast.objective}: ${request.contrast.rule}`,
  objective: request.contrast.objective,
  commitMessage: "chore(fixture): apply pinned candidate rule",
  patch,
};
writeFileSync(responsePath, `${JSON.stringify(response, null, 2)}\n`);
