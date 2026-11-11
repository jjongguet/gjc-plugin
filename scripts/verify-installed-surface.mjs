#!/usr/bin/env node
// Compares installed plugin files with a git tag's blobs, byte for byte.
//
// The denominator is the installed surface, not the repository tree: the
// installer copies only a manifest plus the files that manifest declares
// (`gajae-plugin.json`, `tools/*`, `hooks/*`), so `git ls-tree -r <tag>`
// reports source files the installer never writes as MISSING (JJO-1093).
//
// Two modes:
//   --recorded <surface.json>  verify a recorded surface against
//                              `git show <tag>:<plugin>/<rel>`; `files` entries may be
//                              installer `[rel, sha256]` pairs or this script's
//                              `{path, sha256, ...}` objects (extra keys are ignored)
//   (default)                  walk every pluginRoot in the installer registry,
//                              hash each installed file and compare it with the tag blob
//
//   node scripts/verify-installed-surface.mjs --repo <checkout> --tag v0.0.15 \
//     [--registry <registry.json>] [--recorded <surface.json>] [--json <out.json>]
//
// Exit codes: 0 = every in-scope file matches the tag, 2 = the installed set is
// not exactly the tag (differences are classified, not collapsed), 1 = usage or
// environment error.
//
// Paths written to --json are home-relative, never absolute: committed evidence
// must pass scripts/check-paths.mjs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const USAGE = `usage: node scripts/verify-installed-surface.mjs --repo <checkout> --tag <tag>
  [--registry <registry.json>] [--recorded <surface.json>] [--json <out.json>]`;

function arg(name, fallback = null) {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) fail(`--${name} requires a value`);
	return value;
}

function fail(message) {
	process.stderr.write(`verify-installed-surface: ${message}\n${USAGE}\n`);
	process.exit(1);
}

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

function git(repo, args, { allowFailure = false } = {}) {
	try {
		return execFileSync("git", ["-C", repo, ...args], {
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", allowFailure ? "ignore" : "pipe"],
		});
	} catch (error) {
		if (allowFailure) return null;
		throw error;
	}
}

function gitText(repo, args, options) {
	const out = git(repo, args, options);
	return out === null ? null : out.toString("utf8").trim();
}

// Absolute home paths must not land in committed evidence. Keep the meaning
// (this host vs another) while removing the home prefix.
function displayPath(value) {
	if (typeof value !== "string" || !value) return value;
	const home = homedir();
	if (value === home) return "~";
	if (value.startsWith(`${home}${path.sep}`)) return `~${value.slice(home.length)}`;
	const foreign = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/.exec(value);
	if (foreign) return `<home>${value.slice(foreign[0].length)}`;
	return value;
}

function displaySource(source) {
	if (!source) return null;
	return { kind: source.kind ?? null, uri: displayPath(source.uri ?? null) };
}

function walkFiles(root) {
	const files = [];
	const symlinks = [];
	const visit = (dir, prefix) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(absolute, rel);
			else if (entry.isFile()) files.push(rel);
			else if (entry.isSymbolicLink()) symlinks.push(rel);
		}
	};
	visit(root, "");
	return { files: files.sort(), symlinks: symlinks.sort() };
}

function tagBlob(repo, tag, plugin, rel) {
	return git(repo, ["show", `${tag}:${plugin}/${rel}`], { allowFailure: true });
}

function indexPlugins(repo, ref) {
	const raw = git(repo, ["show", `${ref}:gjc-plugin.json`], { allowFailure: true });
	if (!raw) return new Set();
	try {
		return new Set((JSON.parse(raw.toString("utf8")).plugins ?? []).map(entry => entry.split("/")[0]));
	} catch {
		return new Set();
	}
}

function manifestSurface(manifest) {
	const files = new Set(["gajae-plugin.json"]);
	for (const tool of manifest.tools ?? []) if (tool?.path) files.add(tool.path);
	for (const hook of manifest.hooks ?? []) if (hook?.path) files.add(hook.path);
	return [...files].sort();
}

function readManifest(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

// Every declared install-surface file of every plugin the tag ships.
function tagSurface(repo, tag) {
	const entries = execFileSync("git", ["-C", repo, "ls-tree", "-d", "--name-only", `${tag}`], { encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
	const surface = [];
	for (const plugin of entries) {
		const raw = tagBlob(repo, tag, plugin, "gajae-plugin.json");
		if (!raw) continue;
		let manifest;
		try {
			manifest = JSON.parse(raw.toString("utf8"));
		} catch {
			continue;
		}
		surface.push({
			name: plugin,
			version: manifest.version ?? null,
			files: manifestSurface(manifest),
		});
	}
	return surface.sort((a, b) => a.name.localeCompare(b.name));
}

function laterRefs(repo, tag, repoRef) {
	const tags = execFileSync("git", ["-C", repo, "tag", "--list", "v*", "--sort=v:refname"], { encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
	const index = tags.indexOf(tag);
	const refs = index === -1 ? [] : tags.slice(index + 1);
	if (repoRef) refs.push(repoRef);
	return refs;
}

function resolveRepoRef(repo) {
	for (const ref of ["origin/main", "main", "HEAD"]) {
		if (git(repo, ["rev-parse", "--verify", "--quiet", ref], { allowFailure: true }) !== null) return ref;
	}
	return null;
}

function summarize(plugins) {
	const summary = {
		tagSurfaceFiles: 0,
		installedFiles: 0,
		inScopeFiles: 0,
		match: 0,
		notInTag: 0,
		missing: 0,
		laterRelease: 0,
		snapshotNotInGit: 0,
		unexplainedDrift: 0,
		outOfRepoPlugins: 0,
		outOfRepoFiles: 0,
		symlinks: 0,
	};
	for (const plugin of plugins) {
		if (plugin.classification !== "out-of-repo") summary.tagSurfaceFiles += plugin.tagSurfaceFiles;
		summary.installedFiles += plugin.files.length;
		if (plugin.classification === "out-of-repo") {
			summary.outOfRepoPlugins += 1;
			summary.outOfRepoFiles += plugin.files.length;
			continue;
		}
		summary.inScopeFiles += plugin.files.length;
		for (const file of plugin.files) {
			if (file.status === "match") summary.match += 1;
			else if (file.status === "not-in-tag") summary.notInTag += 1;
			else if (file.status === "later-release") summary.laterRelease += 1;
			else if (file.status === "snapshot-not-in-git") summary.snapshotNotInGit += 1;
			else if (file.status === "unexplained-drift") summary.unexplainedDrift += 1;
		}
		summary.missing += plugin.missing.length;
		summary.symlinks += (plugin.symlinks ?? []).length;
	}
	return summary;
}

// A recorded `files` entry is either an installer pair `[rel, sha256]` or this
// script's `{path, sha256, ...}` object; keys other than path/sha256 are ignored.
// Every other shape is a malformed record, not a hash mismatch, so it exits 1.
function recordedFile(plugin, entry, index) {
	const where = `plugin ${JSON.stringify(plugin.name)} files[${index}]`;
	let rel;
	let expected;
	if (Array.isArray(entry)) {
		[rel, expected] = entry;
	} else if (entry !== null && typeof entry === "object") {
		rel = entry.path;
		expected = entry.sha256;
	} else {
		fail(`recorded surface ${where} must be a [path, sha256] pair or a {path, sha256} object`);
	}
	if (typeof rel !== "string" || rel.length === 0) fail(`recorded surface ${where} has no path`);
	if (typeof expected !== "string" || !/^[0-9a-f]{64}$/i.test(expected)) {
		fail(`recorded surface ${where} needs a 64-character hex sha256`);
	}
	return { path: rel, sha256: expected.toLowerCase() };
}

function verifyRecorded(repo, tag, recordedPath) {
	let recorded;
	try {
		recorded = JSON.parse(readFileSync(recordedPath, "utf8"));
	} catch (error) {
		fail(`cannot read recorded surface ${displayPath(recordedPath)}: ${error.message}`);
	}
	if (recorded === null || typeof recorded !== "object" || Array.isArray(recorded)) {
		fail(`recorded surface ${displayPath(recordedPath)} must be a JSON object`);
	}
	if (!Array.isArray(recorded.plugins)) fail(`recorded surface ${displayPath(recordedPath)} needs a plugins array`);
	const recordTag = recorded.tag ?? tag;
	if (recordTag !== tag) fail(`recorded surface tag ${recordTag} does not match --tag ${tag}`);
	const plugins = [];
	let total = 0;
	let match = 0;
	let missing = 0;
	for (const plugin of recorded.plugins) {
		if (plugin === null || typeof plugin !== "object" || typeof plugin.name !== "string" || plugin.name.length === 0) {
			fail("recorded surface plugins need a name");
		}
		if (!Array.isArray(plugin.files)) fail(`recorded surface plugin ${JSON.stringify(plugin.name)} needs a files array`);
		const files = [];
		plugin.files.forEach((entry, index) => {
			const { path: rel, sha256: expected } = recordedFile(plugin, entry, index);
			total += 1;
			const blob = tagBlob(repo, tag, plugin.name, rel);
			if (!blob) {
				missing += 1;
				files.push({ path: rel, status: "missing-in-tag", expected });
				return;
			}
			const actual = sha256(blob);
			if (actual === expected) {
				match += 1;
				files.push({ path: rel, status: "match", sha256: actual });
			} else {
				files.push({ path: rel, status: "mismatch", expected, actual });
			}
		});
		plugins.push({ name: plugin.name, version: plugin.version ?? null, files });
	}
	const mismatches = total - match - missing;
	return {
		format: "gjc-installed-surface/v1",
		mode: "recorded",
		generatedAt: new Date().toISOString(),
		repo: displayPath(repo),
		tag,
		tagCommit: gitText(repo, ["rev-parse", `${tag}^{commit}`]),
		recorded: { path: displayPath(recordedPath), sha256: sha256(readFileSync(recordedPath)), digest: recorded.installedSurfaceDigest ?? null },
		summary: { recordedFiles: total, match, mismatches, missing },
		plugins,
		ok: mismatches === 0 && missing === 0,
	};
}

function verifyInstalled(repo, tag, registryPath) {
	if (!existsSync(registryPath)) fail(`registry not found: ${displayPath(registryPath)}`);
	const registry = JSON.parse(readFileSync(registryPath, "utf8"));
	const repoRef = resolveRepoRef(repo);
	const refs = laterRefs(repo, tag, repoRef);
	const surface = new Map(tagSurface(repo, tag).map(entry => [entry.name, entry]));
	const shippedAtTag = indexPlugins(repo, tag);
	const shippedNow = repoRef ? indexPlugins(repo, repoRef) : new Set();
	const plugins = [];

	for (const entry of (registry.plugins ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))) {
		const root = entry.pluginRoot;
		const walked = existsSync(root) ? walkFiles(root) : { files: [], symlinks: [] };
		const installed = walked.files;
		const copied = new Map((entry.copiedFiles ?? []).map(file => [file.relativePath, file.sha256]));
		const inTag = surface.has(entry.name);
		const outOfRepo = !inTag && !shippedAtTag.has(entry.name) && !shippedNow.has(entry.name);

		if (outOfRepo) {
			plugins.push({
				name: entry.name,
				installedVersion: readManifest(path.join(root, "gajae-plugin.json"))?.version ?? entry.version ?? null,
				tagVersion: null,
				classification: "out-of-repo",
				reason: `not listed in gjc-plugin.json at ${tag} or ${repoRef ?? "<no repo ref>"}; registry source lies outside this repository`,
				source: displaySource(entry.source),
				installedRoot: displayPath(root),
				tagSurfaceFiles: 0,
				files: installed.map(rel => ({ path: rel, status: "not-in-tag" })),
				symlinks: walked.symlinks,
				missing: [],
			});
			continue;
		}

		if (!inTag) {
			plugins.push({
				name: entry.name,
				installedVersion: readManifest(path.join(root, "gajae-plugin.json"))?.version ?? entry.version ?? null,
				tagVersion: null,
				classification: "post-tag",
				reason: `plugin is shipped by ${repoRef ?? "the repository"} but not by ${tag}`,
				source: displaySource(entry.source),
				installedRoot: displayPath(root),
				tagSurfaceFiles: 0,
				files: installed.map(rel => ({ path: rel, status: "not-in-tag" })),
				symlinks: walked.symlinks,
				missing: [],
			});
			continue;
		}

		const tagEntry = surface.get(entry.name);
		const installedManifest = readManifest(path.join(root, "gajae-plugin.json"));
		const files = installed.map(rel => {
			const localHash = sha256(readFileSync(path.join(root, rel)));
			const blob = tagBlob(repo, tag, entry.name, rel);
			if (!blob) return { path: rel, status: "not-in-tag", sha256: localHash };
			const expected = sha256(blob);
			if (expected === localHash) return { path: rel, status: "match", sha256: localHash };
			const matched = refs.filter(ref => {
				const other = git(repo, ["show", `${ref}:${entry.name}/${rel}`], { allowFailure: true });
				return other && sha256(other) === localHash;
			});
			if (matched.length > 0) return { path: rel, status: "later-release", sha256: localHash, tagSha256: expected, refs: matched };
			if (copied.get(rel) === localHash) {
				return { path: rel, status: "snapshot-not-in-git", sha256: localHash, tagSha256: expected, reason: "registry copiedFiles records these bytes; no tag or repository ref contains them" };
			}
			return { path: rel, status: "unexplained-drift", sha256: localHash, tagSha256: expected };
		});
		const present = new Set(installed);
		const missing = tagEntry.files.filter(rel => !present.has(rel));
		const statuses = new Set(files.map(file => file.status));
		const classification = statuses.has("unexplained-drift") || statuses.has("snapshot-not-in-git") || missing.length > 0
			? "drift"
			: statuses.size === 1 && statuses.has("match")
				? "pinned"
				: "later-release";

		plugins.push({
			name: entry.name,
			installedVersion: installedManifest?.version ?? entry.version ?? null,
			tagVersion: tagEntry.version,
			classification,
			source: displaySource(entry.source),
			installedRoot: displayPath(root),
			tagSurfaceFiles: tagEntry.files.length,
			files,
			symlinks: walked.symlinks,
			missing,
		});
	}

	const summary = summarize(plugins);
	const ok = summary.inScopeFiles === summary.match && summary.missing === 0 && summary.symlinks === 0;
	return {
		format: "gjc-installed-surface/v1",
		mode: "installed",
		generatedAt: new Date().toISOString(),
		repo: displayPath(repo),
		tag,
		tagCommit: gitText(repo, ["rev-parse", `${tag}^{commit}`]),
		registry: displayPath(registryPath),
		registrySha256: sha256(readFileSync(registryPath)),
		laterRefs: refs,
		summary,
		plugins,
		ok,
	};
}

const repoFlag = arg("repo");
const tag = arg("tag");
if (!repoFlag || !tag) fail("--repo and --tag are required");
const repo = path.resolve(repoFlag);
if (!existsSync(repo)) fail(`repository not found: ${displayPath(repo)}`);
const registry = path.resolve(arg("registry", path.join(homedir(), ".gjc", "agent", "gjc-plugins", "registry.json")));
const recorded = arg("recorded");
const jsonOut = arg("json");

const result = recorded ? verifyRecorded(repo, tag, path.resolve(recorded)) : verifyInstalled(repo, tag, registry);
const text = `${JSON.stringify(result, null, 2)}\n`;
if (jsonOut) {
	mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
	writeFileSync(path.resolve(jsonOut), text);
}

const summary = result.summary;
if (result.mode === "recorded") {
	process.stdout.write(`recorded ${result.tag}: ${summary.match}/${summary.recordedFiles} match (${summary.mismatches} mismatch)\n`);
} else {
	process.stdout.write(
		`installed vs ${result.tag}: ${summary.match}/${summary.inScopeFiles} match, ` +
			`${summary.laterRelease} later-release, ${summary.snapshotNotInGit} snapshot-not-in-git, ` +
			`${summary.unexplainedDrift} drift, ${summary.notInTag} not-in-tag, ${summary.missing} missing; ` +
			`${summary.outOfRepoPlugins} out-of-repo plugin(s)/${summary.outOfRepoFiles} file(s) excluded\n`,
	);
}
process.stdout.write(`tag surface: ${summary.tagSurfaceFiles ?? summary.recordedFiles} file(s)\n`);
if (jsonOut) process.stdout.write(`json: ${displayPath(path.resolve(jsonOut))}\n`);
process.exit(result.ok ? 0 : 2);
