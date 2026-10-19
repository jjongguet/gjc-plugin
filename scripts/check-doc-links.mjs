#!/usr/bin/env node
// Fails when a relative Markdown link in a tracked .md file does not resolve
// inside the repository. Inline links, images and reference definitions are
// checked; external (scheme:, //host) links, pure #anchors, fenced code
// (including inside block quotes), indented code and inline code are not.
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

const INLINE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;
const FENCE = /^\s{0,3}(?:>\s?)*(```|~~~)/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

const broken = [];
let checked = 0;

function check(file, lineNumber, href) {
	if (EXTERNAL.test(href)) return;
	let target = href.split("#")[0];
	if (target === "") return;
	try {
		target = decodeURIComponent(target);
	} catch {
		broken.push(`${file}:${lineNumber}: ${href} (malformed percent-encoding)`);
		return;
	}
	checked += 1;
	const resolved = path.resolve(path.dirname(path.join(root, file)), target);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(resolved)) broken.push(`${file}:${lineNumber}: ${href}`);
}

for (const file of files) {
	let inFence = false;
	let previousBlank = true;
	readFileSync(path.join(root, file), "utf8").split("\n").forEach((line, index) => {
		const lineNumber = index + 1;
		if (FENCE.test(line)) {
			inFence = !inFence;
			return;
		}
		const blank = line.trim() === "";
		const indentedCode = !inFence && previousBlank && INDENTED_CODE.test(line) && !/^\s*([-*+]|\d+\.)\s/.test(line);
		previousBlank = blank || (indentedCode && previousBlank);
		if (inFence || indentedCode) return;
		const text = line.replace(/`[^`]*`/g, "");
		const reference = REFERENCE.exec(text);
		if (reference) check(file, lineNumber, reference[1]);
		for (const match of text.matchAll(INLINE)) check(file, lineNumber, match[1]);
	});
}

if (broken.length > 0) {
	for (const entry of broken) console.error(`broken_link:${entry}`);
	console.error(`docs:check failed: ${broken.length} broken relative link(s)`);
	process.exit(1);
}
console.log(`docs:check ok: ${checked} relative links in ${files.length} tracked Markdown files`);
