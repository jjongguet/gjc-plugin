import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProposerPrompt,
  buildTrialCommand,
  extractProposalJson,
  main,
  normalizeProposal,
} from "../../scripts/propose-with-gjc.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "self-improve-propose-gjc-"));
}

test("extractProposalJson takes the first complete object and tolerates fences and prose", () => {
  assert.deepEqual(extractProposalJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractProposalJson("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(extractProposalJson('Here it is:\n{"a":1}\nThanks'), { a: 1 });
  assert.deepEqual(extractProposalJson('noise {"a":{"b":"}"},"c":2} trailing'), { a: { b: "}" }, c: 2 });
  assert.deepEqual(extractProposalJson('{"patch":"line\\n{\\"x\\":1}"}'), { patch: 'line\n{"x":1}' });
  assert.equal(extractProposalJson('{"broken":1'), null);
  assert.equal(extractProposalJson("no object at all"), null);
  assert.equal(extractProposalJson("{not json at all}"), null);
  assert.equal(extractProposalJson(undefined), null);
});

test("normalizeProposal defaults the objective and rejects incomplete replies", () => {
  const request = { objective: "probe.decision_accuracy" };
  const ok = normalizeProposal({ hypothesis: "h", commitMessage: "chore(x): y", patch: "diff" }, request);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.proposal, {
    hypothesis: "h",
    objective: "probe.decision_accuracy",
    commitMessage: "chore(x): y",
    patch: "diff",
  });
  const pathForm = normalizeProposal({ hypothesis: "h", objective: "probe.b", commitMessage: "m", patchPath: "p.patch" }, request);
  assert.equal(pathForm.proposal.patchPath, "p.patch");
  assert.equal(normalizeProposal({ commitMessage: "m", patch: "d" }, request).reason, "proposer_reply_missing_hypothesis");
  assert.equal(normalizeProposal({ hypothesis: "h", patch: "d" }, request).reason, "proposer_reply_missing_commit_message");
  assert.equal(normalizeProposal({ hypothesis: "h", commitMessage: "m" }, request).reason, "proposer_reply_missing_patch");
  assert.equal(normalizeProposal([1, 2], request).reason, "proposer_reply_not_an_object");
});

test("buildTrialCommand pins the non-interactive gjc surface and appends extra args", () => {
  const command = buildTrialCommand({ bin: "/tmp/shim", model: "vendor/model", extraArgs: "--foo bar", prompt: "P" });
  assert.equal(command[0], "/tmp/shim");
  assert.ok(command.includes("--print"));
  assert.ok(command.includes("--no-tools"));
  assert.deepEqual(command.slice(command.indexOf("--model"), command.indexOf("--model") + 2), ["--model", "vendor/model"]);
  assert.deepEqual(command.slice(-3), ["--foo", "bar", "P"]);
});

test("main writes the response and never surfaces environment values", () => {
  const root = tempRoot();
  try {
    const requestFile = join(root, "request.json");
    const responseFile = join(root, "response.json");
    writeFileSync(requestFile, JSON.stringify({ objective: "probe.decision_accuracy", baseCommit: "abcdef0", budget: { maxFiles: 3, maxHunks: 12 } }));
    const seen = {};
    const env = { GJC_PROPOSER_BIN: "/tmp/shim-gjc", GJC_PROPOSER_MODEL: "vendor/pinned", SECRET_SENTINEL: "sentinel-value-xyz" };
    const status = main([requestFile, responseFile], env, {
      spawn: (bin, args) => {
        seen.bin = bin;
        seen.args = args;
        return { status: 0, stdout: '```json\n{"hypothesis":"from shim","commitMessage":"chore(x): shim","patch":"diff --git a/x b/x\\n"}\n```', stderr: "sentinel-value-xyz" };
      },
    });
    assert.equal(status, 0);
    assert.equal(seen.bin, "/tmp/shim-gjc");
    assert.ok(seen.args.includes("vendor/pinned"), "model pin must reach the command line");
    assert.ok(seen.args.at(-1).includes("REQUEST:"), "prompt must embed the request");
    assert.equal(seen.args.at(-1).includes("sentinel-value-xyz"), false, "env values must not enter the prompt");
    const response = JSON.parse(readFileSync(responseFile, "utf8"));
    assert.deepEqual(response, {
      hypothesis: "from shim",
      objective: "probe.decision_accuracy",
      commitMessage: "chore(x): shim",
      patch: "diff --git a/x b/x\n",
    });
    assert.equal(JSON.stringify(response).includes("sentinel-value-xyz"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main fails closed on missing args, bad request, failed spawn and unparsable replies", () => {
  const root = tempRoot();
  try {
    const requestFile = join(root, "request.json");
    const responseFile = join(root, "response.json");
    writeFileSync(requestFile, JSON.stringify({ objective: "probe.decision_accuracy" }));
    assert.equal(main([], process.env, {}), 2);
    assert.equal(main([join(root, "missing.json"), responseFile], process.env, {}), 2);
    assert.equal(
      main([requestFile, responseFile], process.env, { spawn: () => ({ status: 3, stdout: "", stderr: "" }) }),
      1,
    );
    assert.equal(
      main([requestFile, responseFile], process.env, { spawn: () => ({ status: 0, stdout: "no json here", stderr: "" }) }),
      1,
    );
    assert.equal(
      main([requestFile, responseFile], process.env, {
        spawn: () => ({ status: 0, stdout: '{"hypothesis":"only"}', stderr: "" }),
      }),
      1,
    );
    assert.equal(existsSync(responseFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main drives a real executable fake-gjc shim without model calls", () => {
  const root = tempRoot();
  try {
    const shim = join(root, "shim-gjc.mjs");
    writeFileSync(
      shim,
      [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.SHIM_ARGS_OUT, JSON.stringify(process.argv.slice(2)));",
        "process.stdout.write(JSON.stringify({ hypothesis: 'shim hypothesis', commitMessage: 'chore(verification-receipts): shim', patch: 'diff --git a/verification-receipts/lib/shim.ts b/verification-receipts/lib/shim.ts\\nnew file mode 100644\\n--- /dev/null\\n+++ b/verification-receipts/lib/shim.ts\\n@@ -0,0 +1,1 @@\\n+export const shim = 1;\\n' }));",
        "",
      ].join("\n"),
    );
    chmodSync(shim, 0o755);
    const requestFile = join(root, "request.json");
    const responseFile = join(root, "response.json");
    const argsOut = join(root, "args.json");
    writeFileSync(requestFile, JSON.stringify({ objective: "probe.decision_accuracy", baseCommit: "abcdef0" }));
    const status = main([requestFile, responseFile], { ...process.env, GJC_PROPOSER_BIN: shim, SHIM_ARGS_OUT: argsOut });
    assert.equal(status, 0);
    const response = JSON.parse(readFileSync(responseFile, "utf8"));
    assert.equal(response.hypothesis, "shim hypothesis");
    assert.match(response.patch, /verification-receipts\/lib\/shim\.ts/);
    const args = JSON.parse(readFileSync(argsOut, "utf8"));
    assert.ok(args.includes("--print"));
    assert.ok(args.at(-1).includes('"objective": "probe.decision_accuracy"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
