#!/usr/bin/env bun
// CLI surface for the skill audit. The gjc tool (tools/skill-audit.ts) returns the same report;
// this entry adds --json/--out for a written, committable report.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { auditSkills, formatSummary } from "../lib/report";

const USAGE = `skill-audit — installed-vs-used audit of the GJC skill catalog (read-only)

usage:
  skill-audit [--json] [--out <file>] [--quiet]

  --json        print the full report as JSON
  --out <file>  also write the JSON report to <file>
  --quiet       print nothing on stdout
  -h, --help    show this help

exit codes:
  0  audit complete, no unused or duplicate candidate
  1  audit complete, candidates found
  2  usage unknown or degraded — zero uses cannot be claimed
  64 invalid arguments
`;

function fail(message: string): never {
	process.stderr.write(`skill-audit: ${message}\n${USAGE}`);
	process.exit(64);
}

let asJson = false;
let quiet = false;
let out: string | null = null;
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
	const arg = argv[index];
	if (arg === "--json") asJson = true;
	else if (arg === "--quiet") quiet = true;
	else if (arg === "--out") {
		const value = argv[++index];
		if (!value || value.startsWith("--")) fail("--out needs a file path");
		out = value;
	} else if (arg === "-h" || arg === "--help") {
		process.stdout.write(USAGE);
		process.exit(0);
	} else fail(`unknown argument: ${arg}`);
}

try {
	const report = auditSkills({ home: process.env.HOME || homedir(), cwd: process.cwd() });
	const payload = `${JSON.stringify(report, null, 2)}\n`;
	if (out) {
		const target = path.resolve(out);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, payload);
	}
	if (!quiet) process.stdout.write(asJson ? payload : `${formatSummary(report)}\n`);
	process.exitCode =
		report.status !== "complete" ? 2 : report.candidates.unused.length > 0 || report.candidates.duplicates.length > 0 ? 1 : 0;
} catch {
	process.stderr.write("skill-audit: unexpected_error — the report could not be produced\n");
	process.exitCode = 2;
}
