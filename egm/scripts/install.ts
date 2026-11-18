#!/usr/bin/env bun
/**
 * The one EGM install entry: obtain EGM v0.1.1 (a fixed upstream release or a
 * local checkout verified against the pin), check the sha256 of all 31 pinned
 * files and the checkout's git HEAD, write the unmodified upstream files under
 * `<agentDir>/egm/v0.1.1/`, compose the loose skill and reviewer files through
 * the shared `renderLoose` contract, register this checkout's `egm/` readiness
 * bundle through the installed `gjc` CLI, and record ownership in
 * `<bundleRoot>/bundle.json` (`pending`, then `complete`). `lib/readiness.ts`
 * owns the pin, the compose rules and the journal schema; this script only
 * performs the writes, the refusals and the two `gjc plugin` calls. The
 * unchanged fast path reads the user-scope bundle registration and hashes the
 * installed copies instead of trusting `plugin list`; the journal is replaced
 * atomically (`<journal>.tmp` + rename), and an invalid incoming plugin bundle
 * is refused before any `gjc plugin uninstall`.
 *
 * The installer resolves the agent directory exactly like `gjc` (host resolver,
 * `GJC_CODING_AGENT_DIR`, then `PI_CODING_AGENT_DIR`, then `~/.gjc/agent`), so
 * a disposable HOME or agent directory keeps work away from the real install.
 * It never replaces foreign runtime content: an existing file is only rewritten
 * when the ownership journal proves this installer wrote it, and a symlink
 * anywhere on a destination path is refused. An existing user-scope `egm`
 * plugin bundle is replaced only through the native `plugin uninstall` /
 * `plugin install` pair, after the source identity check and never `--force`;
 * the separate `egm@egm` marketplace install is never touched.
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	EGM_INSTALL_COMMAND,
	EGM_PINNED_COMMIT,
	EGM_PINNED_FILES,
	EGM_PINNED_TAG,
	EGM_REPOSITORY,
	bundleRoot,
	journalPath,
	looseFiles,
	readJournal,
	readPluginRecord,
	renderLoose,
	resolveAgentDir,
	sha256Hex,
} from "../lib/readiness";
import type { AgentDirInput, AgentDirResolution, Journal, LooseFile } from "../lib/readiness";

const SOURCE_FILE_MAX_BYTES = 4 * 1024 * 1024;
const INSTALLED_FILE_MAX_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 300_000;
const GJC_TIMEOUT_MS = 180_000;
const GIT_HEAD_MAX_BYTES = 4 * 1024;
/** This checkout's `egm/` plugin bundle; the CLI half registers it by default. */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** `O_NOFOLLOW` where the platform has it; the preflight already refused symlinks. */
const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export const EGM_INSTALL_USAGE = [
	`EGM ${EGM_PINNED_TAG} native install — the loose GJC skill and reviewer surface plus the readiness bundle`,
	"",
	`  ${EGM_INSTALL_COMMAND} [--source <dir>] [--json]`,
	`  bun egm/scripts/install.ts [--source <dir>] [--json]`,
	"",
	"  --source <dir>  verify this checkout of the pinned release instead of cloning it",
	"  --json          print one JSON document on stdout and nothing else",
	"",
	`Writes below the GJC agent directory: <agentDir>/egm/${EGM_PINNED_TAG}/ (31 pinned files + bundle.json),`,
	"<agentDir>/skills/egm-*/ (7 skills and 3 references) and <agentDir>/agents/egm-*.md (8 reviewers),",
	"then registers this checkout's egm/ plugin bundle with `gjc plugin install <checkout>/egm --user`.",
	"Exit codes: 0 installed or unchanged · 1 refused · 2 usage or a missing external prerequisite.",
].join("\n");

/** A refusal carries a stable code so a caller can branch without parsing prose. */
export class InstallRefusal extends Error {
	readonly code: string;
	readonly detail: string | null;

	constructor(code: string, message: string, detail: string | null = null) {
		super(message);
		this.name = "InstallRefusal";
		this.code = code;
		this.detail = detail;
	}
}

export type InstallSource = { kind: "release" } | { kind: "local"; dir: string };

export type InstallOptions = AgentDirInput & {
	/** Where the pinned release comes from; the default fetches the fixed upstream tag. */
	source?: InstallSource;
	/** The pinned digest table; only a module caller (tests) replaces it. */
	pinnedFiles?: Readonly<Record<string, string>>;
	/** The `gjc` executable; only a module caller overrides it (tests use a fake). */
	gjcCommand?: string;
	/** The environment the `gjc plugin` commands run in; defaults to this process. */
	gjcEnv?: Readonly<Record<string, string | undefined>>;
	/** The plugin bundle the CLI half registers; defaults to this checkout's `egm/`. */
	pluginDir?: string;
};

export type InstallCounts = { bundle: number; skills: number; references: number; agents: number };

export type PluginHalf = {
	status: "installed" | "replaced" | "unchanged";
	/** Whether the user-scope egm bundle was listed before the half ran (null: unreadable). */
	listedBefore: boolean | null;
	/** True when an already-installed refusal triggered the one supported uninstall + retry. */
	retried: boolean;
	/** The registry content state this decision came from. */
	content: "current" | "replace" | "missing" | "unknown";
};

export type InstallResult = {
	status: "installed" | "unchanged";
	agentDir: AgentDirResolution;
	bundleRoot: string;
	journal: string;
	pluginDir: string;
	source: InstallSource["kind"];
	tag: string;
	commit: string;
	counts: InstallCounts;
	runtime: "written" | "unchanged";
	plugin: PluginHalf;
};

type VerifiedSource = { root: string; bytes: Map<string, Buffer>; cleanup: () => void };
type Ownership = { state: "pending" | "complete"; journal: Journal };
type PluginSource = { manifestHash: string; files: Array<{ relativePath: string; sha256: string }> };
type ContentState = { state: "current" | "replace" | "missing" | "unknown"; listedBefore: boolean | null; source: string | null };

const refusalOf = (error: unknown): InstallRefusal =>
	error instanceof InstallRefusal ? error : new InstallRefusal("runtime_error", error instanceof Error ? error.message : String(error));

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/**
 * Inspect one relative path below `root` without following any symlink: each
 * existing component is checked, so a linked directory cannot redirect a
 * write. Returns the final file size when the path is a regular file.
 */
function targetState(root: string, relative: string): { state: "missing" } | { state: "file"; size: number; links: number } | { state: "symlink" | "other"; at: string } {
	const parts = relative.split("/");
	let current = root;
	for (let index = 0; index < parts.length; index++) {
		current = path.join(current, parts[index]);
		let info;
		try {
			info = lstatSync(current);
		} catch (error) {
			if (isMissing(error)) return { state: "missing" };
			throw new InstallRefusal("target_unreadable", `cannot inspect ${current}`);
		}
		if (index < parts.length - 1) {
			if (info.isSymbolicLink()) return { state: "symlink", at: current };
			if (!info.isDirectory()) return { state: "other", at: current };
			continue;
		}
		if (info.isSymbolicLink()) return { state: "symlink", at: current };
		if (!info.isFile()) return { state: "other", at: current };
		return { state: "file", size: info.size, links: info.nlink };
	}
	return { state: "missing" };
}

function inspectAgentDir(dir: string): "exists" | "missing" {
	let info;
	try {
		info = lstatSync(dir);
	} catch (error) {
		if (isMissing(error)) return "missing";
		throw new InstallRefusal("agent_dir_unreadable", `cannot inspect the agent directory ${dir}`);
	}
	if (info.isSymbolicLink()) throw new InstallRefusal("agent_dir_symlink", `the agent directory ${dir} is a symlink; refusing to install through it`);
	if (!info.isDirectory()) throw new InstallRefusal("agent_dir_unreadable", `the agent directory ${dir} is not a directory`);
	return "exists";
}

function readSourceFile(root: string, relative: string): Buffer {
	const state = targetState(root, relative);
	if (state.state === "missing") throw new InstallRefusal("source_missing", `the source is missing ${relative}`);
	if (state.state === "symlink") throw new InstallRefusal("source_symlink", `the source ${relative} is a symlink; only regular files are accepted`);
	if (state.state !== "file") throw new InstallRefusal("source_unreadable", `the source ${relative} is not a regular file`);
	if (state.size > SOURCE_FILE_MAX_BYTES) throw new InstallRefusal("source_unreadable", `the source ${relative} exceeds the ${SOURCE_FILE_MAX_BYTES}-byte limit`);
	try {
		return readFileSync(path.join(root, relative));
	} catch {
		throw new InstallRefusal("source_unreadable", `cannot read the source ${relative}`);
	}
}

function readBoundedText(file: string, maxBytes: number): string | null {
	try {
		const info = statSync(file);
		if (!info.isFile() || info.size > maxBytes) return null;
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/** The git directory for a checkout, including a worktree/submodule `.git` file. */
function resolveGitDir(root: string): string | null {
	const dotGit = path.join(root, ".git");
	let info;
	try {
		info = statSync(dotGit);
	} catch {
		return null;
	}
	if (info.isDirectory()) return dotGit;
	if (!info.isFile()) return null;
	const text = readBoundedText(dotGit, GIT_HEAD_MAX_BYTES);
	const target = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
	return target ? path.resolve(root, target) : null;
}

/**
 * Resolve the commit a checked-out source names, without a git process: HEAD,
 * a loose ref, `commondir` and packed-refs. Returns null when the checkout's
 * identity cannot be read, which the installer refuses rather than bypassing.
 */
function readGitHead(root: string): string | null {
	const gitDir = resolveGitDir(root);
	if (!gitDir) return null;
	const commonText = readBoundedText(path.join(gitDir, "commondir"), GIT_HEAD_MAX_BYTES);
	const common = commonText ? path.resolve(gitDir, commonText.trim()) : gitDir;
	const head = readBoundedText(path.join(gitDir, "HEAD"), GIT_HEAD_MAX_BYTES)?.trim();
	if (!head) return null;
	if (/^[0-9a-f]{40}$/.test(head)) return head;
	const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
	if (!ref || ref.startsWith("/") || ref.includes("..")) return null;
	for (const base of [gitDir, common]) {
		const loose = readBoundedText(path.join(base, ...ref.split("/")), 200)?.trim();
		if (loose && /^[0-9a-f]{40}$/.test(loose)) return loose;
	}
	const packed = readBoundedText(path.join(common, "packed-refs"), 4 * 1024 * 1024);
	if (!packed) return null;
	for (const line of packed.split("\n")) {
		const match = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim());
		if (match && match[2] === ref) return match[1];
	}
	return null;
}

function fetchPinnedRelease(): VerifiedSource {
	const probe = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 30_000 });
	if (probe.error?.code === "ENOENT" || probe.status !== 0) {
		throw new InstallRefusal("git_missing", "`git` is required to fetch the pinned EGM release; install git or pass --source <checkout>");
	}
	const root = mkdtempSync(path.join(os.tmpdir(), "egm-release-"));
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	const clone = spawnSync("git", ["clone", "--depth", "1", "--branch", EGM_PINNED_TAG, EGM_REPOSITORY, root], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
	});
	if (clone.status !== 0) {
		cleanup();
		throw new InstallRefusal("git_clone_failed", `cloning ${EGM_REPOSITORY} ${EGM_PINNED_TAG} failed`, (clone.stderr || clone.stdout || "").trim().slice(0, 400) || null);
	}
	const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 60_000 });
	const commit = (head.stdout ?? "").trim();
	if (head.status !== 0 || commit !== EGM_PINNED_COMMIT) {
		cleanup();
		throw new InstallRefusal("source_head_mismatch", `the fetched ${EGM_PINNED_TAG} checkout is ${commit || "unreadable"}, not the pinned ${EGM_PINNED_COMMIT}`);
	}
	return { root, bytes: new Map(), cleanup };
}

function verifySource(source: InstallSource, pinned: Readonly<Record<string, string>>): VerifiedSource {
	const fetched = source.kind === "release" ? fetchPinnedRelease() : null;
	const root = fetched ? fetched.root : path.resolve((source as { dir: string }).dir);
	const cleanup = fetched?.cleanup ?? (() => undefined);
	try {
		let info;
		try {
			info = statSync(root);
		} catch {
			throw new InstallRefusal("source_missing", `the source ${root} is not readable; pass a checkout of EGM ${EGM_PINNED_TAG}`);
		}
		if (!info.isDirectory()) throw new InstallRefusal("source_unreadable", `the source ${root} is not a directory`);
		if (!fetched) {
			const head = readGitHead(root);
			if (head === null) {
				throw new InstallRefusal("source_commit_unknown", `the source ${root} has no readable .git HEAD; pass a git checkout of EGM ${EGM_PINNED_TAG}`, "there is no bypass flag; an extracted archive is not an accepted source");
			}
			if (head !== EGM_PINNED_COMMIT) {
				throw new InstallRefusal("source_head_mismatch", `the source HEAD ${head} is not the pinned ${EGM_PINNED_COMMIT}`);
			}
		}
		const bytes = new Map<string, Buffer>();
		for (const [relative, digest] of Object.entries(pinned)) {
			const data = readSourceFile(root, relative);
			const actual = sha256Hex(data);
			if (actual !== digest) {
				throw new InstallRefusal("source_mismatch", `the source ${relative} does not match the pinned sha256`, `expected ${digest}, found ${actual}`);
			}
			bytes.set(relative, data);
		}
		return { root, bytes, cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}

/** The `gjc` command and the environment its plugin commands run in. */
type GjcContext = { command: string; env: Readonly<Record<string, string | undefined>> };
type CommandResult = { status: number | null; stdout: string; stderr: string; error: NodeJS.ErrnoException | null };

const outputOf = (result: CommandResult): string => `${result.stdout}${result.stderr}${result.error ? `\n${result.error.code ?? "error"}: ${result.error.message}` : ""}`.trim();
const quote = (text: string): string => (text ? text.slice(0, 800) : "(no output)");

/** A prose-only heuristic for the already-installed refusal, which `plugin list` may under-report. */
const alreadyInstalled = (output: string): boolean => /already\s+(?:installed|exists|present)/i.test(output) || /plugin\s+["']?egm["']?\s+is\s+already/i.test(output);

function runGjc(gjc: GjcContext, args: string[]): CommandResult {
	const result = spawnSync(gjc.command, args, {
		encoding: "utf8",
		timeout: GJC_TIMEOUT_MS,
		maxBuffer: 8 * 1024 * 1024,
		env: gjc.env as NodeJS.ProcessEnv,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: (result.error as NodeJS.ErrnoException | undefined) ?? null,
	};
}

/** Refuse before any write when GJC itself is not available for the plugin half. */
function probeGjc(options: InstallOptions): GjcContext {
	const gjc: GjcContext = { command: options.gjcCommand ?? "gjc", env: options.gjcEnv ?? process.env };
	const result = runGjc(gjc, ["--version"]);
	if (result.error?.code === "ENOENT") {
		throw new InstallRefusal("gjc_missing", "`gjc` is not on PATH; install gajae-code before the native EGM install", "nothing was written");
	}
	if (result.status !== 0 || !/gjc\//.test(outputOf(result))) {
		throw new InstallRefusal("gjc_unusable", "`gjc --version` did not report a usable GJC", `exit ${result.status}: ${quote(outputOf(result))}\nNothing was written.`);
	}
	return gjc;
}

type PluginListRead = { listed: boolean | null; output: string };

/**
 * Whether the user-scope GJC **bundle** named `egm` is registered. Only the
 * `gjc` array is read: the `egm@egm` marketplace entry is a different plugin
 * and is never touched by this installer.
 */
function listEgmBundle(gjc: GjcContext): PluginListRead {
	const result = runGjc(gjc, ["plugin", "list", "--json"]);
	if (result.status !== 0) return { listed: null, output: outputOf(result) };
	try {
		const value = JSON.parse(result.stdout) as { gjc?: unknown } | null;
		const entries = Array.isArray(value?.gjc) ? value.gjc : [];
		const listed = entries.some(entry => {
			const identity = (entry as { identity?: { kind?: unknown; name?: unknown; scope?: unknown } } | null)?.identity;
			return identity?.kind === "gjc-bundle" && identity?.name === "egm" && identity?.scope === "user";
		});
		return { listed, output: outputOf(result) };
	} catch {
		return { listed: null, output: outputOf(result) };
	}
}

function uninstallEgmBundle(gjc: GjcContext, partial: string): void {
	const result = runGjc(gjc, ["plugin", "uninstall", "egm", "--user"]);
	if (result.status !== 0) {
		throw new InstallRefusal("plugin_uninstall_failed", "`gjc plugin uninstall egm --user` failed", `exit ${result.status}: ${quote(outputOf(result))}\n${partial}`);
	}
}

function installEgmBundle(gjc: GjcContext, pluginDir: string): CommandResult {
	return runGjc(gjc, ["plugin", "install", pluginDir, "--user"]);
}

function pluginInstallRefusal(result: CommandResult, pluginDir: string, where: string, partial: string): InstallRefusal {
	return new InstallRefusal("plugin_install_failed", `\`gjc plugin install ${pluginDir} --user\` failed ${where}`, `exit ${result.status}: ${quote(outputOf(result))}\n${partial}`);
}

const isSafePluginRelative = (value: string): boolean =>
	value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").includes("..");

function pluginSurface(manifest: unknown): string[] | null {
	if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return null;
	const record = manifest as Record<string, unknown>;
	if (record.kind !== "gajae-code-plugin" || record.name !== "egm") return null;
	const paths = new Set(["gajae-plugin.json"]);
	for (const list of [record.tools, record.hooks]) {
		if (list === undefined) continue;
		if (!Array.isArray(list)) return null;
		for (const entry of list) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
			const relative = (entry as { path?: unknown }).path;
			if (typeof relative !== "string" || !isSafePluginRelative(relative)) return null;
			paths.add(relative);
		}
	}
	return [...paths].sort();
}

function pluginSourceInvalid(pluginDir: string, agentDir: string, reason: string): InstallRefusal {
	const record = readPluginRecord(agentDir);
	const source = record.source ?? (record.status === "unreadable" ? "unreadable registry" : "none");
	return new InstallRefusal("plugin_source_invalid", `the incoming plugin bundle ${pluginDir} is invalid: ${reason}; registered source: ${source}`, reason);
}

/**
 * Validate the incoming plugin bundle before any `gjc plugin` mutation. The
 * manifest, its declared tool/hook files and the resulting digest are all
 * required; nothing is passed to `gjc` until this succeeds.
 */
function validatePluginSource(pluginDir: string, agentDir: string): PluginSource {
	const fail = (reason: string): never => {
		throw pluginSourceInvalid(pluginDir, agentDir, reason);
	};
	const manifestState = targetState(pluginDir, "gajae-plugin.json");
	if (manifestState.state !== "file" || manifestState.size > SOURCE_FILE_MAX_BYTES) fail("gajae-plugin.json is missing, not a regular file, or too large");
	let manifestBytes: Buffer;
	try {
		manifestBytes = readFileSync(path.join(pluginDir, "gajae-plugin.json"));
	} catch {
		fail("gajae-plugin.json is unreadable");
	}
	let manifest: unknown;
	try {
		manifest = JSON.parse(manifestBytes.toString("utf8"));
	} catch {
		fail("gajae-plugin.json is not valid JSON");
	}
	const surface = pluginSurface(manifest) ?? fail("gajae-plugin.json is not a valid egm gajae-code-plugin manifest");
	const files: Array<{ relativePath: string; sha256: string }> = [];
	for (const relativePath of surface) {
		const state = targetState(pluginDir, relativePath);
		if (state.state !== "file" || state.size > SOURCE_FILE_MAX_BYTES) fail(`${relativePath} is missing, not a regular file, or too large`);
		let bytes: Buffer;
		try {
			bytes = readFileSync(path.join(pluginDir, relativePath));
		} catch {
			fail(`${relativePath} is unreadable`);
		}
		files.push({ relativePath, sha256: sha256Hex(bytes) });
	}
	return { manifestHash: sha256Hex(manifestBytes), files };
}

/**
 * Compare the registered bundle with this checkout's bytes. The registry is a
 * record, so the installed copies are hashed too: manifest hash, exact copied
 * file set, and every installed copy must agree for `current`. A disabled,
 * stale, partial or tampered bundle is `replace`; an unreadable registry is
 * `unknown` (the CLI list fallback then decides).
 */
function inspectBundleContent(agentDir: string, source: PluginSource): ContentState {
	const record = readPluginRecord(agentDir);
	if (record.status === "unreadable") return { state: "unknown", listedBefore: null, source: null };
	if (!record.registered) return { state: "missing", listedBefore: false, source: null };
	const replace = (): ContentState => ({ state: "replace", listedBefore: true, source: record.source });
	if (record.enabled !== true) return replace();
	if (record.manifestHash !== source.manifestHash) return replace();
	const copied = record.copiedFiles;
	if (!copied || copied.length !== source.files.length) return replace();
	const recorded = new Map(copied.map(file => [file.relativePath, file.sha256]));
	if (recorded.size !== copied.length) return replace();
	for (const file of source.files) {
		if (recorded.get(file.relativePath) !== file.sha256) return replace();
	}
	const root = record.pluginRoot;
	if (!root) return replace();
	let rootInfo;
	try {
		rootInfo = lstatSync(root);
	} catch {
		return replace();
	}
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return replace();
	for (const file of source.files) {
		const state = targetState(root, file.relativePath);
		if (state.state !== "file" || state.size > INSTALLED_FILE_MAX_BYTES) return replace();
		let actual: string;
		try {
			actual = sha256Hex(readFileSync(path.join(root, file.relativePath)));
		} catch {
			return replace();
		}
		if (actual !== file.sha256) return replace();
	}
	return { state: "current", listedBefore: true, source: record.source };
}

/**
 * Register this checkout's egm bundle through the installed GJC CLI. An
 * existing user-scope egm bundle is replaced only through the native
 * uninstall/install pair, never `--force`; an already-installed refusal (or a
 * registry that under-reports) gets exactly one uninstall + retry. `gjc` is
 * never asked to touch the separate `egm@egm` marketplace install.
 */
function ensurePluginHalf(gjc: GjcContext, pluginDir: string, partial: string, knownList?: boolean | null, content: PluginHalf["content"] = "unknown"): PluginHalf {
	if (content === "current") return { status: "unchanged", listedBefore: true, retried: false, content };
	const first = knownList === undefined ? listEgmBundle(gjc) : { listed: knownList, output: "" };
	if (first.listed === true) {
		uninstallEgmBundle(gjc, partial);
		const installed = installEgmBundle(gjc, pluginDir);
		if (installed.status === 0) return { status: "replaced", listedBefore: true, retried: false, content };
		if (!alreadyInstalled(outputOf(installed))) throw pluginInstallRefusal(installed, pluginDir, "after uninstall", partial);
		uninstallEgmBundle(gjc, partial);
		const retried = installEgmBundle(gjc, pluginDir);
		if (retried.status !== 0) throw pluginInstallRefusal(retried, pluginDir, "after uninstall and retry", partial);
		return { status: "replaced", listedBefore: true, retried: true, content };
	}
	const installed = installEgmBundle(gjc, pluginDir);
	if (installed.status === 0) return { status: "installed", listedBefore: first.listed, retried: false, content };
	const after = listEgmBundle(gjc);
	if (!alreadyInstalled(outputOf(installed)) && after.listed !== true) {
		throw pluginInstallRefusal(installed, pluginDir, "and the bundle was not listed afterwards", partial);
	}
	uninstallEgmBundle(gjc, partial);
	const retried = installEgmBundle(gjc, pluginDir);
	if (retried.status !== 0) throw pluginInstallRefusal(retried, pluginDir, "after uninstall and retry", partial);
	return { status: "installed", listedBefore: first.listed, retried: true, content };
}


function renderLooseSet(agentDir: string, pinned: Readonly<Record<string, string>>, upstream: Map<string, Buffer>): Map<string, Buffer> {
	const rendered = new Map<string, Buffer>();
	for (const file of looseFiles(pinned) as LooseFile[]) {
		const source = upstream.get(file.source);
		if (!source) throw new InstallRefusal("source_missing", `the pin lists ${file.source} but the verified source has no bytes for it`);
		try {
			rendered.set(file.relative, renderLoose(file, agentDir, source));
		} catch (error) {
			throw new InstallRefusal("compose_failed", `cannot compose ${file.relative}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return rendered;
}

function assertJournalTarget(agentDir: string): void {
	const relative = path.relative(agentDir, journalPath(agentDir));
	const state = targetState(agentDir, relative);
	if (state.state === "symlink") throw new InstallRefusal("target_symlink", `${path.join(agentDir, relative)} is a symlink; refusing to read or write the ownership journal through it`);
	if (state.state === "other") throw new InstallRefusal("target_not_file", `${path.join(agentDir, relative)} is not a regular file`);
}

function readOwnership(agentDir: string, pinned: Readonly<Record<string, string>>, expected: Map<string, Buffer>): Ownership | null {
	const read = readJournal(agentDir);
	if (read.status === "missing") return null;
	if (read.status === "unreadable") {
		throw new InstallRefusal("journal_unreadable", `${journalPath(agentDir)} is not an install journal this installer wrote`);
	}
	const journal = read.journal;
	if (journal.tag !== EGM_PINNED_TAG || journal.commit !== EGM_PINNED_COMMIT) {
		throw new InstallRefusal("journal_mismatch", `the journal pins ${journal.tag} ${journal.commit}, not ${EGM_PINNED_TAG} ${EGM_PINNED_COMMIT}`);
	}
	const pinnedKeys = Object.keys(pinned).sort();
	const journalBundle = Object.keys(journal.bundle).sort();
	if (pinnedKeys.length !== journalBundle.length || pinnedKeys.some((key, index) => key !== journalBundle[index])) {
		throw new InstallRefusal("journal_mismatch", "the journal's bundle list differs from the pinned file list");
	}
	for (const key of pinnedKeys) {
		if (journal.bundle[key] !== pinned[key]) throw new InstallRefusal("journal_mismatch", `the journal's digest for ${key} differs from the pin`);
	}
	const looseKeys = [...expected.keys()].sort();
	const journalLoose = Object.keys(journal.loose).sort();
	if (looseKeys.length !== journalLoose.length || looseKeys.some((key, index) => key !== journalLoose[index])) {
		throw new InstallRefusal("journal_mismatch", "the journal's loose list differs from the files this pin produces");
	}
	for (const key of looseKeys) {
		const bytes = expected.get(key);
		if (!bytes || journal.loose[key] !== sha256Hex(bytes)) throw new InstallRefusal("journal_mismatch", `the journal's digest for ${key} differs from the composed file`);
	}
	return { state: read.status, journal };
}

/**
 * Check every destination before the first write. A completed journal proves
 * ownership of exactly the pinned bundle paths and the composed loose paths; a
 * pending journal resumes any partially written file. Anything else that
 * exists at a destination is foreign and is never replaced.
 */
function preflightTargets(agentDir: string, pinned: Readonly<Record<string, string>>, expected: Map<string, Buffer>, ownership: Ownership | null): { upToDate: boolean } {
	const ownedBundle = new Set(Object.keys(ownership?.journal.bundle ?? {}));
	const ownedLoose = new Set(Object.keys(ownership?.journal.loose ?? {}));
	const resume = ownership?.state === "pending";
	let allPresent = ownership?.state === "complete";

	const inspect = (root: string, relative: string, target: string, owned: boolean, digest: string): void => {
		const state = targetState(root, relative);
		if (state.state === "missing") {
			allPresent = false;
			return;
		}
		if (state.state === "symlink") throw new InstallRefusal("target_symlink", `${target} is a symlink; refusing to replace it or write through it`);
		if (state.state !== "file") throw new InstallRefusal("target_not_file", `${target} is not a regular file`);
		if (state.links !== 1) throw new InstallRefusal("target_not_file", `${target} shares its inode with another path; refusing to rewrite user data`);
		if (state.size > INSTALLED_FILE_MAX_BYTES) throw new InstallRefusal("target_not_file", `${target} exceeds the ${INSTALLED_FILE_MAX_BYTES}-byte limit`);
		if (!owned) throw new InstallRefusal("foreign_file", `${target} exists and this installer did not write it; remove it or install into a different agent directory`);
		if (resume) return; // a pending journal resumes the files it already claimed
		let actual: string;
		try {
			actual = sha256Hex(readFileSync(target));
		} catch {
			throw new InstallRefusal("target_unreadable", `cannot read ${target}`);
		}
		if (actual !== digest) throw new InstallRefusal("owned_file_modified", `${target} changed after the completed install; delete it and re-run to restore the pinned file`);
	};

	for (const [relative, digest] of Object.entries(pinned)) {
		inspect(agentDir, `${path.relative(agentDir, bundleRoot(agentDir))}/${relative}`, path.join(bundleRoot(agentDir), relative), ownedBundle.has(relative), digest);
	}
	for (const [relative, bytes] of expected) {
		inspect(agentDir, relative, path.join(agentDir, relative), ownedLoose.has(relative), sha256Hex(bytes));
	}
	return { upToDate: allPresent };
}

function ensureAgentDir(dir: string): void {
	if (inspectAgentDir(dir) === "missing") {
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch {
			throw new InstallRefusal("write_failed", `cannot create the agent directory ${dir}`);
		}
	}
	const info = lstatSync(dir);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new InstallRefusal("agent_dir_symlink", `${dir} is not a real directory; refusing to install through it`);
}

function ensureDirectory(agentDir: string, relative: string): void {
	let current = agentDir;
	for (const part of relative.split("/").filter(Boolean)) {
		current = path.join(current, part);
		let info;
		try {
			info = lstatSync(current);
		} catch (error) {
			if (!isMissing(error)) throw new InstallRefusal("write_failed", `cannot inspect ${current}`);
			try {
				mkdirSync(current, { mode: 0o755 });
			} catch {
				throw new InstallRefusal("write_failed", `cannot create ${current}`);
			}
			continue;
		}
		if (info.isSymbolicLink()) throw new InstallRefusal("target_symlink", `${current} is a symlink; refusing to write through it`);
		if (!info.isDirectory()) throw new InstallRefusal("target_not_file", `${current} is not a directory`);
	}
}

function writeFileNoFollow(target: string, bytes: Uint8Array): void {
	let fd: number;
	try {
		fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o644);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new InstallRefusal("target_symlink", `${target} is a symlink; refusing to write through it`);
		throw new InstallRefusal("write_failed", `cannot write ${target}`);
	}
	try {
		let offset = 0;
		while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
	} finally {
		closeSync(fd);
	}
}

const journalTempPath = (agentDir: string): string => `${journalPath(agentDir)}.tmp`;

/**
 * Replace the ownership journal atomically: write `<journal>.tmp` with
 * O_EXCL|O_NOFOLLOW, then rename it over the journal. A failure before the
 * rename leaves the previous journal byte-identical (no in-place truncation).
 */
function writeJournal(agentDir: string, journal: Journal): void {
	const target = journalPath(agentDir);
	const temp = journalTempPath(agentDir);
	const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
	let fd: number | null = null;
	let created = false;
	try {
		try {
			fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new InstallRefusal("target_symlink", `${temp} is a symlink; refusing to write the journal through it`);
			throw new InstallRefusal("write_failed", `cannot create the temporary journal ${temp}`);
		}
		try {
			let offset = 0;
			while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
		} catch {
			throw new InstallRefusal("write_failed", `cannot write the temporary journal ${temp}`);
		}
		closeSync(fd);
		fd = null;
		try {
			renameSync(temp, target);
		} catch {
			throw new InstallRefusal("write_failed", `cannot replace the journal ${target}`);
		}
		created = false;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// already closed or unusable; the temp cleanup below is the durable part
			}
		}
		if (created) {
			try {
				unlinkSync(temp);
			} catch {
				// a missing or foreign temp path is not ours to delete
			}
		}
	}
}

function verifyWritten(root: string, relative: string, digest: string): void {
	const state = targetState(root, relative);
	const target = path.join(root, relative);
	if (state.state !== "file" || state.size > INSTALLED_FILE_MAX_BYTES || state.links !== 1) throw new InstallRefusal("verify_failed", `${target} is not the regular file that was written`);
	if (sha256Hex(readFileSync(target)) !== digest) throw new InstallRefusal("verify_failed", `${target} does not match the expected sha256 after writing`);
}

function countsOf(pinned: Readonly<Record<string, string>>): InstallCounts {
	const files = looseFiles(pinned);
	return {
		bundle: Object.keys(pinned).length,
		skills: files.filter(file => file.kind === "skill").length,
		references: files.filter(file => file.kind === "reference").length,
		agents: files.filter(file => file.kind === "agent").length,
	};
}

const looseDigests = (expected: Map<string, Buffer>): Record<string, string> =>
	Object.fromEntries([...expected].map(([relative, bytes]) => [relative, sha256Hex(bytes)]));

/**
 * Install (or resume, or verify) the pinned EGM runtime below the GJC agent
 * directory. Throws `InstallRefusal` before the first write when the source,
 * journal or any destination cannot be trusted; a partial write leaves the
 * journal `pending` for a resume.
 */
export function installEgm(options: InstallOptions = {}): InstallResult {
	const pinned = options.pinnedFiles ?? EGM_PINNED_FILES;
	const agentDir = resolveAgentDir({ env: options.env, home: options.home, host: options.host });
	inspectAgentDir(agentDir.dir);
	const gjc = probeGjc(options);
	const source = options.source ?? { kind: "release" };
	const verified = verifySource(source, pinned);
	const pluginDir = path.resolve(options.pluginDir ?? PLUGIN_DIR);
	try {
		const pluginSource = validatePluginSource(pluginDir, agentDir.dir);
		const content = inspectBundleContent(agentDir.dir, pluginSource);
		assertJournalTarget(agentDir.dir);
		const expected = renderLooseSet(agentDir.dir, pinned, verified.bytes);
		const ownership = readOwnership(agentDir.dir, pinned, expected);
		const preflight = preflightTargets(agentDir.dir, pinned, expected, ownership);
		const counts = countsOf(pinned);
		const result = (status: InstallResult["status"], runtime: InstallResult["runtime"], plugin: InstallResult["plugin"]): InstallResult => ({
			status,
			agentDir,
			bundleRoot: bundleRoot(agentDir.dir),
			journal: journalPath(agentDir.dir),
			pluginDir,
			source: source.kind,
			tag: EGM_PINNED_TAG,
			commit: EGM_PINNED_COMMIT,
			counts,
			runtime,
			plugin,
		});
		if (preflight.upToDate) {
			if (content.state === "current") {
				return result("unchanged", "unchanged", { status: "unchanged", listedBefore: true, retried: false, content: "current" });
			}
			if (content.state === "unknown") {
				const list = listEgmBundle(gjc);
				if (list.listed === true) return result("unchanged", "unchanged", { status: "unchanged", listedBefore: true, retried: false, content: "unknown" });
				const plugin = ensurePluginHalf(gjc, pluginDir, "The EGM runtime is complete; a re-run retries only the plugin half.", list.listed, "unknown");
				return result("installed", "unchanged", plugin);
			}
			const plugin = ensurePluginHalf(gjc, pluginDir, "The EGM runtime is complete; a re-run retries only the plugin half.", content.listedBefore, content.state);
			return result("installed", "unchanged", plugin);
		}

		ensureAgentDir(agentDir.dir);
		const bundleRelative = path.relative(agentDir.dir, bundleRoot(agentDir.dir));
		ensureDirectory(agentDir.dir, bundleRelative);
		const loose = looseDigests(expected);
		writeJournal(agentDir.dir, { schemaVersion: 1, state: "pending", tag: EGM_PINNED_TAG, commit: EGM_PINNED_COMMIT, bundle: { ...pinned }, loose });

		const plugin: PluginHalf =
			content.state === "current"
				? { status: "unchanged", listedBefore: true, retried: false, content: "current" }
				: ensurePluginHalf(
						gjc,
						pluginDir,
						"The EGM runtime was not written; the pending journal makes a re-run resume the plugin half.",
						content.state === "unknown" ? undefined : content.listedBefore,
						content.state,
					);

		for (const [relative, bytes] of verified.bytes) {
			ensureDirectory(agentDir.dir, path.posix.dirname(`${bundleRelative}/${relative}`));
			writeFileNoFollow(path.join(bundleRoot(agentDir.dir), relative), bytes);
		}
		for (const [relative, bytes] of expected) {
			ensureDirectory(agentDir.dir, path.posix.dirname(relative));
			writeFileNoFollow(path.join(agentDir.dir, relative), bytes);
		}

		for (const [relative, digest] of Object.entries(pinned)) verifyWritten(bundleRoot(agentDir.dir), relative, digest);
		for (const [relative, bytes] of expected) verifyWritten(agentDir.dir, relative, sha256Hex(bytes));

		writeJournal(agentDir.dir, { schemaVersion: 1, state: "complete", tag: EGM_PINNED_TAG, commit: EGM_PINNED_COMMIT, bundle: { ...pinned }, loose });
		if (readJournal(agentDir.dir).status !== "complete") throw new InstallRefusal("verify_failed", `the ownership journal at ${journalPath(agentDir.dir)} did not finalize`);
		return result("installed", "written", plugin);
	} finally {
		verified.cleanup();
	}
}

// ---- CLI ----

type CliOptions = { help: boolean; json: boolean; source: InstallSource };

function usageError(message: string): InstallRefusal {
	return new InstallRefusal("usage", message);
}

function parseArguments(argv: readonly string[]): CliOptions {
	const options: CliOptions = { help: false, json: false, source: { kind: "release" } };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--source") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) throw usageError("--source needs a directory");
			options.source = { kind: "local", dir: path.resolve(value) };
		} else if (arg.startsWith("--source=")) {
			const value = arg.slice("--source=".length);
			if (!value || value.startsWith("--")) throw usageError("--source needs a directory");
			options.source = { kind: "local", dir: path.resolve(value) };
		} else throw usageError(`unknown argument ${arg}`);
	}
	return options;
}

function describe(result: InstallResult): string[] {
	const lines = [
		`egm_install: ${result.status} ${result.tag} (${result.commit.slice(0, 12)})`,
		`agent dir: ${result.agentDir.dir} (${result.agentDir.source})`,
		`bundle: ${result.counts.bundle} pinned files at ${result.bundleRoot}`,
		`loose: ${result.counts.skills} skills, ${result.counts.references} references, ${result.counts.agents} reviewers`,
		`plugin: ${result.plugin.status} (${result.plugin.content}) at ${result.pluginDir}${result.plugin.retried ? " (retried after an already-installed refusal)" : ""}`,
		`runtime: ${result.runtime}`,
		`journal: ${result.journal} (complete)`,
	];
	if (result.status === "unchanged") lines.push("nothing was written: the runtime and the plugin bundle already match");
	return lines;
}

async function main(argv: readonly string[]): Promise<number> {
	let options: CliOptions;
	try {
		options = parseArguments(argv);
	} catch (error) {
		const refusal = refusalOf(error);
		process.stderr.write(`egm_install: ${refusal.code} — ${refusal.message}\n\n${EGM_INSTALL_USAGE}\n`);
		return 2;
	}
	if (options.help) {
		process.stdout.write(`${EGM_INSTALL_USAGE}\n`);
		return 0;
	}
	try {
		const result = installEgm({ source: options.source });
		if (options.json) process.stdout.write(`${JSON.stringify({ install: result })}\n`);
		else process.stdout.write(`${describe(result).join("\n")}\n${JSON.stringify({ install: result })}\n`);
		return 0;
	} catch (error) {
		const refusal = refusalOf(error);
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ install: { status: "refused", code: refusal.code, message: refusal.message, detail: refusal.detail } })}\n`);
		} else {
			process.stderr.write(`egm_install: ${refusal.code} — ${refusal.message}${refusal.detail ? `\n  ${refusal.detail}` : ""}\n`);
		}
		return refusal.code === "git_missing" || refusal.code === "gjc_missing" || refusal.code === "gjc_unusable" ? 2 : 1;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
