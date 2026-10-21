#!/usr/bin/env node
/**
 * Negative cmd-proposer fixture: answers with a different objective than the
 * pinned candidate, so the loop must refuse it as `proposer_objective_mismatch`.
 *
 * Usage: node proposer-mismatch.mjs <request.json> <response.json>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [requestPath, responsePath] = process.argv.slice(2);
if (!requestPath || !responsePath) {
  process.stderr.write("usage: proposer-mismatch.mjs <request.json> <response.json>\n");
  process.exit(2);
}

const request = JSON.parse(readFileSync(requestPath, "utf8"));
if (!request.contrast || typeof request.contrast.candidateId !== "string") {
  process.stderr.write("proposer-mismatch: request.contrast.candidateId missing\n");
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
  hypothesis: "Deliberately moves the objective to prove the pin is enforced.",
  objective: "probe.extract_coverage",
  commitMessage: "chore(fixture): mismatched objective",
  patch,
};
writeFileSync(responsePath, `${JSON.stringify(response, null, 2)}\n`);
