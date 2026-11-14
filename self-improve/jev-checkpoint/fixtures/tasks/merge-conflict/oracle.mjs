// Oracle for merge-conflict: the merged src/format.mjs must be the exact union
// of both branch edits and the shared test must pass. The blob SHA is fixed
// because the canonical resolution has one byte-exact form.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const EXPECTED_MERGED_BLOB_SHA = "ef412ad4a207126174839566d8b07fac10ada463";

// A nested `node --test` inherits NODE_TEST_CONTEXT and would report success
// without running anything, so the child env drops it.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function readSource(workDir) {
  try {
    return readFileSync(join(workDir, "src/format.mjs"), "utf8");
  } catch {
    return null;
  }
}

function testsPass(workDir) {
  const run = spawnSync(process.execPath, ["--test", "test/format.test.mjs"], {
    cwd: workDir,
    encoding: "utf8",
    env: childEnv(),
    timeout: 60000,
  });
  return run.status === 0;
}

export default function oracle({ parsed, workDir, git }) {
  const checks = [];
  const finalText = typeof parsed?.finalText === "string" ? parsed.finalText : "";
  const source = readSource(workDir);
  const markers = source !== null && /^(?:<<<<<<<|=======|>>>>>>>)/m.test(source);
  checks.push({
    id: "no-conflict-markers",
    pass: source !== null && !markers,
    note: source === null ? "src/format.mjs is missing" : markers ? "conflict markers remain" : "",
  });

  let blob = "";
  try {
    blob = String(git(["hash-object", "src/format.mjs"]) ?? "").trim();
  } catch {
    blob = "";
  }
  const canonical = blob === EXPECTED_MERGED_BLOB_SHA;
  checks.push({
    id: "merged-blob",
    pass: canonical,
    note: canonical ? "" : `merged blob ${blob || "unknown"} != ${EXPECTED_MERGED_BLOB_SHA}`,
  });

  const pass = testsPass(workDir);
  checks.push({ id: "tests-pass", pass, note: pass ? "" : "node --test test/format.test.mjs did not exit 0" });

  const answered = finalText.trim() !== "";
  checks.push({ id: "final-answer", pass: answered, note: answered ? "" : "no final text" });

  const unresolved = !answered || source === null || markers || !pass;
  const missing = [];
  if (!canonical) missing.push("canonical merge");
  const score = unresolved ? 0 : missing.length === 0 ? 2 : 1;
  return { score, checks };
}
