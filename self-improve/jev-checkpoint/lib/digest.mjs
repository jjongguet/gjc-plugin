/**
 * Content digests the manifest freezes (D12, D4): the harness source (every
 * file the runner, proxy, plugin, oracles and analyzer read; tests excluded),
 * the analyzer alone, and the installed jev-advisor bundle. Paths are recorded
 * relative to the harness root; timestamps never enter a digest.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_PARTS = Object.freeze(["lib", "plugin", "fixtures", "scripts"]);

function walk(dir, base, out) {
	for (const name of readdirSync(dir).sort()) {
		const full = path.join(dir, name);
		const stats = statSync(full);
		if (stats.isDirectory()) walk(full, base, out);
		else if (stats.isFile()) out.push([path.relative(base, full), createHash("sha256").update(readFileSync(full)).digest("hex")]);
	}
	return out;
}

export function treeDigest(root, parts = null) {
	const rows = [];
	for (const part of parts ?? [""]) walk(path.join(root, part), root, rows);
	return { files: rows.length, digest: createHash("sha256").update(rows.map(([file, sha]) => `${sha}  ${file}`).join("\n")).digest("hex") };
}

export function harnessDigest() {
	return treeDigest(HARNESS_ROOT, HARNESS_PARTS);
}

export function analyzerDigest() {
	return createHash("sha256").update(readFileSync(path.join(HARNESS_ROOT, "lib", "analyze.mjs"))).digest("hex");
}

export function bundleDigest(bundleDir) {
	return treeDigest(bundleDir);
}

/**
 * Paid steps before the manifest (L0, J0) must run on the harness that passed
 * S0: refuse unless s0-pass.json passed on the current digest. Returns the digest
 * so the step can bind its own receipt to it.
 */
export function requireS0Harness(runDir) {
	const file = path.join(runDir, "s0-pass.json");
	if (!existsSync(file)) throw new Error("s0_pass_missing");
	const receipt = JSON.parse(readFileSync(file, "utf8"));
	const current = harnessDigest().digest;
	if (receipt.pass !== true || receipt.harnessDigest !== current) throw new Error("harness_changed_since_s0");
	return current;
}
