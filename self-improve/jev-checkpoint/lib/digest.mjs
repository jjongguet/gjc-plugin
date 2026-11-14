/**
 * Content digests the manifest freezes (D12, D4): the harness source (every
 * file the runner, proxy, plugin, oracles and analyzer read; tests excluded),
 * the analyzer alone, and the installed jev-advisor bundle. Paths are recorded
 * relative to the harness root; timestamps never enter a digest.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
