#!/usr/bin/env node
// Arm-blind verifier process: argv = <taskDir> <workDir> <transcriptPath> <auditPath>.
// It receives no arm, condition, journal or proxy rows. Prints {score, checks, evidenceDigest}.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseTranscript } from "../lib/transcript.mjs";

const [taskDir, workDir, transcriptPath, auditPath] = process.argv.slice(2);
if (!taskDir || !workDir || !transcriptPath || !auditPath) {
	process.stderr.write("usage: score-cell.mjs <taskDir> <workDir> <transcriptPath> <auditPath>\n");
	process.exit(2);
}
const spec = JSON.parse(readFileSync(path.join(taskDir, "spec.json"), "utf8"));
const oracle = (await import(pathToFileURL(path.join(taskDir, "oracle.mjs")).href)).default;
let parsed;
try {
	parsed = parseTranscript(readFileSync(transcriptPath, "utf8"));
} catch {
	parsed = parseTranscript("");
}
const audit = readFileSync(auditPath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
	try { return [JSON.parse(line)]; } catch { return []; }
});
const git = (args) => execFileSync("git", ["-C", workDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let result;
try {
	result = await oracle({ spec, parsed, audit, workDir, git });
} catch (error) {
	result = { score: 0, checks: [{ id: "oracle_error", pass: false, note: String(error?.message ?? error).slice(0, 120) }] };
}
const score = [0, 1, 2].includes(result?.score) ? result.score : 0;
const checks = Array.isArray(result?.checks) ? result.checks : [];
const evidenceDigest = createHash("sha256").update(JSON.stringify({ taskId: spec.id, score, checks, finalText: parsed.finalText, calls: parsed.toolCalls.map((call) => [call.name, call.isError]) })).digest("hex");
process.stdout.write(`${JSON.stringify({ score, checks, evidenceDigest })}\n`);
