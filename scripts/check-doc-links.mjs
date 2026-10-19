#!/usr/bin/env node
// Fails when a relative Markdown link in a tracked .md file does not resolve.
// External (http/https/mailto) links and pure #anchors are not checked.
//
//   node scripts/check-doc-links.mjs [--root <dir>]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const rootFlag = process.argv.indexOf("--root");
const root = path.resolve(rootFlag === -1 ? process.cwd() : process.argv[rootFlag + 1]);

let files;
try {
	files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
} catch {
	console.error(`docs:check: ${root} is not a git checkout`);
	process.exit(2);
}

const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const broken = [];
let checked = 0;
for (const file of files) {
	let inFence = false;
	readFileSync(path.join(root, file), "utf8").split("\n").forEach((line, index) => {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		if (inFence) return;
		for (const match of line.replace(/`[^`]*`/g, "").matchAll(LINK)) {
			const href = match[1];
			if (/^(https?:|mailto:|#)/i.test(href)) continue;
			const target = decodeURIComponent(href.split("#")[0]);
			if (target === "") continue;
			checked += 1;
			const resolved = path.resolve(path.dirname(path.join(root, file)), target);
			if (!resolved.startsWith(root) || !existsSync(resolved)) broken.push(`${file}:${index + 1}: ${href}`);
		}
	});
}

if (broken.length > 0) {
	for (const entry of broken) console.error(`broken_link:${entry}`);
	console.error(`docs:check failed: ${broken.length} broken relative link(s)`);
	process.exit(1);
}
console.log(`docs:check ok: ${checked} relative links in ${files.length} tracked Markdown files`);
