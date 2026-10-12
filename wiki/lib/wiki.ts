// wiki plugin core — a thin, bounded wrapper around the guarded personal wiki
// CLI (python3 scripts/wiki.py). Exactly two operations exist: a read-only
// canonical-page query and a capture+propose submission. Approve, publish,
// refresh and configure are deliberately not implemented here: publication
// authority stays with the human on the configured writer.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir as wikiHomedir, tmpdir as wikiTmpdir } from "node:os";
import path from "node:path";

export type WikiCommandResult =
	| { status: "ok"; stdout: string }
	| { status: "failed"; reason: "timeout" | "runtime_error" | "missing_wiki" | "output_overflow"; stderr: string };

export const WIKI_QUERY_TIMEOUT_MS = 30000;
export const WIKI_PROPOSE_TIMEOUT_MS = 60000;
export const WIKI_TEXT_LIMIT = 65536;
export const WIKI_PAGE_PATH = /^(concepts|entities|references|synthesis|journal)\/[a-z0-9][a-z0-9-]*\.md$/;
export const WIKI_SOURCE_ID = /^[a-z0-9][a-z0-9-]*$/;

export function wikiRootDir(override?: string): string {
	const root = (override ?? process.env.WIKI_ROOT ?? "").trim();
	return root || path.join(wikiHomedir(), "jjongguet", "personal-wiki");
}

async function runWikiCommand(root: string, args: string[], timeoutMs: number): Promise<WikiCommandResult> {
	return new Promise(resolve => {
		let child;
		try {
			child = spawn("python3", [path.join(root, "scripts", "wiki.py"), "--root", root, ...args], {
				cwd: root,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({ status: "failed", reason: "runtime_error", stderr: `spawn_failed: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}
		let stdout = "";
		let stderr = "";
		let overflow = false;
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			try { child.kill("SIGKILL"); } catch {}
		}, timeoutMs);
		child.on("error", error => {
			clearTimeout(timer);
			resolve({ status: "failed", reason: "missing_wiki", stderr: error instanceof Error ? error.message : String(error) });
		});
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length <= 262144) stdout += chunk.toString("utf8");
			else overflow = true;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length <= 262144) stderr += chunk.toString("utf8");
		});
		child.on("close", code => {
			clearTimeout(timer);
			if (overflow) resolve({ status: "failed", reason: "output_overflow", stderr: stderr.trim().slice(-1024) || "output_limit" });
			else if (killed) resolve({ status: "failed", reason: "timeout", stderr: stderr.trim().slice(-1024) || "timeout" });
			else if (code === 0) resolve({ status: "ok", stdout: stdout.trim() });
			else resolve({ status: "failed", reason: "runtime_error", stderr: (stderr.trim() || `exit_${code}`).slice(-1024) });
		});
	});
}

export async function wikiQueryRun(query: string, timeoutMs: number = WIKI_QUERY_TIMEOUT_MS): Promise<WikiCommandResult> {
	return runWikiCommand(wikiRootDir(), ["query", query], Math.min(Math.max(timeoutMs, 1000), WIKI_QUERY_TIMEOUT_MS));
}

export type WikiProposeResult =
	| { status: "submitted"; digest: string; raw: string }
	| { status: "failed"; stage: "capture" | "propose"; reason: string; stderr: string };

export async function wikiProposeRun(input: {
	id: string;
	title: string;
	origin: "personal" | "public";
	sourceText: string;
	changes: Record<string, string>;
}, timeoutMs: number = WIKI_PROPOSE_TIMEOUT_MS): Promise<WikiProposeResult> {
	const root = wikiRootDir();
	const bounded = Math.min(Math.max(timeoutMs, 1000), WIKI_PROPOSE_TIMEOUT_MS);
	const dir = await mkdtemp(path.join(wikiTmpdir(), "gjc-wiki-"));
	try {
		const sourcePath = path.join(dir, "source.md");
		const changesPath = path.join(dir, "changes.json");
		await writeFile(sourcePath, input.sourceText, "utf8");
		await writeFile(changesPath, JSON.stringify(input.changes), "utf8");
		const capture = await runWikiCommand(root, ["capture", "--file", sourcePath, "--id", input.id, "--title", input.title, "--origin", input.origin], bounded);
		if (capture.status !== "ok") return { status: "failed", stage: "capture", reason: capture.reason, stderr: capture.stderr };
		const propose = await runWikiCommand(root, ["propose", "--source", input.id, "--changes", changesPath], bounded);
		if (propose.status !== "ok") return { status: "failed", stage: "propose", reason: propose.reason, stderr: propose.stderr };
		let digest = "";
		try {
			const parsed = JSON.parse(propose.stdout) as { digest?: string };
			if (typeof parsed.digest === "string") digest = parsed.digest;
		} catch {}
		if (!/^[a-f0-9]{64}$/.test(digest)) return { status: "failed", stage: "propose", reason: "missing_digest", stderr: propose.stdout.slice(-512) };
		return { status: "submitted", digest, raw: propose.stdout };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
