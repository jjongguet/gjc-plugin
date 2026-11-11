import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "verify-installed-surface.mjs");
const NODE = process.execPath;

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function write(root, files) {
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(root, rel);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
}

function git(root, args) {
	return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
		cwd: root,
		encoding: "utf8",
	});
}

function manifest(name, version, tools = []) {
	return JSON.stringify({
		kind: "plugin",
		name,
		version,
		tools: tools.map(tool => ({ name: tool, path: `tools/${tool}.ts` })),
	});
}

// A checkout tagged v0.0.1 plus a later `main` commit. The fixture keeps every
// classification distinct: pinned, later-release, drift, missing, post-tag and
// out-of-repo.
function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "installed-surface-"));
	const repo = path.join(root, "repo");
	const installed = path.join(root, "installed");
	write(repo, {
		"gjc-plugin.json": JSON.stringify({ plugins: ["pinned/gajae-plugin.json", "moving/gajae-plugin.json"] }),
		"pinned/gajae-plugin.json": manifest("pinned", "0.0.1", ["stable"]),
		"pinned/tools/stable.ts": "stable\n",
		"moving/gajae-plugin.json": manifest("moving", "0.0.1", ["tool"]),
		"moving/tools/tool.ts": "v0.0.1\n",
	});
	git(repo, ["init", "-q"]);
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "v0.0.1"]);
	git(repo, ["tag", "v0.0.1"]);

	write(repo, {
		"moving/gajae-plugin.json": manifest("moving", "0.0.2", ["tool"]),
		"moving/tools/tool.ts": "main\n",
		"gjc-plugin.json": JSON.stringify({
			plugins: ["pinned/gajae-plugin.json", "moving/gajae-plugin.json", "later/gajae-plugin.json"],
		}),
		"later/gajae-plugin.json": manifest("later", "0.0.1", ["later"]),
		"later/tools/later.ts": "later\n",
	});
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "post-tag plugin"]);

	write(installed, {
		"pinned/gajae-plugin.json": manifest("pinned", "0.0.1", ["stable"]),
		"pinned/tools/stable.ts": "stable\n",
		"moving/gajae-plugin.json": manifest("moving", "0.0.2", ["tool"]),
		"moving/tools/tool.ts": "main\n",
		"later/gajae-plugin.json": manifest("later", "0.0.1", ["later"]),
		"later/tools/later.ts": "later\n",
		"external/gajae-plugin.json": manifest("external", "0.1.0"),
		"external/tools/external.ts": "outside\n",
	});
	const registry = path.join(root, "registry.json");
	write(root, {
		"registry.json": JSON.stringify({
			plugins: [
				{ name: "pinned", version: "0.0.1", pluginRoot: path.join(installed, "pinned"), source: { kind: "path", uri: "~/.gjc-plugin/pinned" }, copiedFiles: [] },
				{ name: "moving", version: "0.0.2", pluginRoot: path.join(installed, "moving"), source: { kind: "path", uri: "~/.gjc-plugin/moving" }, copiedFiles: [] },
				{ name: "later", version: "0.0.1", pluginRoot: path.join(installed, "later"), source: { kind: "path", uri: "~/.gjc-plugin/later" }, copiedFiles: [] },
				{ name: "external", version: "0.1.0", pluginRoot: path.join(installed, "external"), source: { kind: "path", uri: "~/.gjc-user-policy/plugins/external" }, copiedFiles: [] },
			],
		}),
	});
	return { root, repo, registry, json: path.join(root, "out.json") };
}

function run(args) {
	const result = spawnSync(NODE, [SCRIPT, ...args], { encoding: "utf8" });
	return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

test("installed walk classifies later releases, drift, post-tag and out-of-repo plugins", () => {
	const { root, repo, registry, json } = fixture();
	try {
		write(path.join(root, "installed", "moving", "tools"), { "tool.ts": "unreleased\n" });
		const result = run(["--repo", repo, "--tag", "v0.0.1", "--registry", registry, "--json", json]);
		assert.equal(result.status, 2, result.out);
		const out = readJson(json);
		assert.equal(out.mode, "installed");
		assert.equal(out.tagCommit.length, 40);
		assert.equal(out.summary.tagSurfaceFiles, 4);
		assert.equal(out.summary.installedFiles, 8);
		assert.equal(out.summary.inScopeFiles, 6);
		assert.equal(out.summary.match, 2);
		assert.equal(out.summary.missing, 0);
		assert.equal(out.summary.outOfRepoPlugins, 1);
		assert.equal(out.summary.outOfRepoFiles, 2);
		const byName = new Map(out.plugins.map(plugin => [plugin.name, plugin]));
		assert.equal(byName.get("pinned").classification, "pinned");
		assert.equal(byName.get("moving").classification, "drift");
		assert.equal(byName.get("moving").files.find(file => file.path === "gajae-plugin.json").status, "later-release");
		assert.equal(byName.get("moving").files.find(file => file.path === "tools/tool.ts").status, "unexplained-drift");
		assert.equal(byName.get("later").classification, "post-tag");
		assert.equal(byName.get("external").classification, "out-of-repo");
		assert.equal(byName.get("external").files.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("installed walk pins an unchanged tree and reports missing declared files", () => {
	const { root, repo, registry, json } = fixture();
	try {
		write(path.join(root, "installed", "pinned"), { "gajae-plugin.json": manifest("pinned", "0.0.1", ["stable"]) });
		rmSync(path.join(root, "installed", "pinned", "tools", "stable.ts"));
		const result = run(["--repo", repo, "--tag", "v0.0.1", "--registry", registry, "--json", json]);
		assert.equal(result.status, 2, result.out);
		const out = readJson(json);
		assert.equal(out.plugins.find(plugin => plugin.name === "pinned").missing[0], "tools/stable.ts");
		assert.equal(out.summary.missing, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("recorded surface hashes are checked against tag blobs", () => {
	const { root, repo } = fixture();
	try {
		const stable = sha256("stable\n");
		const surface = path.join(root, "surface.json");
		write(root, {
			"surface.json": JSON.stringify({
				tag: "v0.0.1",
				installedSurfaceDigest: "a".repeat(64),
				plugins: [
					{ name: "pinned", version: "0.0.1", files: [["gajae-plugin.json", sha256(manifest("pinned", "0.0.1", ["stable"]))], ["tools/stable.ts", stable]] },
				],
			}),
		});
		const good = run(["--repo", repo, "--tag", "v0.0.1", "--recorded", surface]);
		assert.equal(good.status, 0, good.out);

		write(root, {
			"surface.json": JSON.stringify({
				tag: "v0.0.1",
				plugins: [{ name: "pinned", version: "0.0.1", files: [["tools/stable.ts", "0".repeat(64)]] }],
			}),
		});
		const bad = run(["--repo", repo, "--tag", "v0.0.1", "--recorded", surface]);
		assert.equal(bad.status, 2, bad.out);
		assert.match(bad.out, /0\/1 match/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
