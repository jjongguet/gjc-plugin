#!/usr/bin/env node
// Re-measures the three `gjc plugin` CLI behaviours recorded in
// docs/gjc-0.20-plugin-cli-verification.md (JJO-1609) against the `gjc` on PATH, in a
// throwaway HOME, and fails when the observed contract drifts from that document.
//
//   node scripts/check-plugin-cli.mjs [--keep]
//
// Every case is observed through the CLI itself: no repository fixture is installed
// and the real ~/.gjc is never written. A hosted runner has no `gjc`, so the check
// reports itself skipped there instead of passing silently.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const KEEP = process.argv.includes("--keep");
const LABEL = "plugin-cli:check";
const BUNDLE_TOOLS = ["verification_run", "verification_status", "verification_loop"];
let cases = 0;

function record(name, detail) {
	cases += 1;
	console.log(`${LABEL}: ok ${name}${detail ? ` — ${detail}` : ""}`);
}

async function sh(command, args, { cwd, home, allowFailure = false } = {}) {
	const child = spawn(command, args, {
		cwd,
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			GJC_CODING_AGENT_DIR: path.join(home, ".gjc", "agent"),
			GJC_AGENT_DIR: path.join(home, ".gjc", "agent"),
			GJC_UI_LANGUAGE: "en",
			GJC_MODEL_PRESET_REGISTRY_DISABLED: "1",
			LOCALSTUB_KEY: "check-not-a-secret",
			...(process.env.JJO_PROBE_MARKER ? { JJO_PROBE_MARKER: process.env.JJO_PROBE_MARKER } : {}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	let spawnError = null;
	const code = await new Promise((resolve) => {
		child.on("close", resolve);
		// A missing binary resolves like an exit so callers can tell ENOENT from a failure.
		child.on("error", (error) => {
			stderr += `${error.message}\n`;
			spawnError = error;
			resolve(127);
		});
	});
	const result = { code, stdout, stderr, spawnError, out: `${stdout}${stderr}` };
	if (!allowFailure && code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}\n${result.out}`);
	return result;
}

// The CLI extracts its own native module into $HOME/.gjc/natives on first use. That
// file is the binary's, not plugin state, so it is excluded from the write snapshots.
function snapshot(root) {
	const rows = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(root, full);
			if (rel === path.join(".gjc", "natives")) continue;
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) rows.push(`${rel}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
		}
	};
	if (existsSync(root)) walk(root);
	return rows;
}

function jsonOf(text) {
	const object = text.indexOf("{");
	const array = text.indexOf("[");
	const candidates = [object, array].filter((index) => index !== -1);
	if (candidates.length === 0) throw new Error(`no JSON in output: ${text.slice(0, 200)}`);
	return JSON.parse(text.slice(Math.min(...candidates)));
}

function writeBundle(root, name, hooks) {
	const dir = path.join(root, name);
	mkdirSync(path.join(dir, "hooks"), { recursive: true });
	writeFileSync(
		path.join(dir, "gajae-plugin.json"),
		`${JSON.stringify({ kind: "gajae-code-plugin", name, version: "0.0.1", hooks }, null, 2)}\n`,
	);
	writeFileSync(
		path.join(dir, "hooks", "probe.ts"),
		'export default function register(api: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) {\n\tapi.on("session_shutdown", async () => undefined);\n}\n',
	);
	return dir;
}

// The surfaces a linked npm-style plugin advertises. The tool module records its own
// import, so "loaded" is observed rather than inferred from a manifest the CLI lists.
function writeLinkedProbe(root) {
	const dir = path.join(root, "linked-probe");
	mkdirSync(path.join(dir, "tools"), { recursive: true });
	writeFileSync(
		path.join(dir, "package.json"),
		`${JSON.stringify({ name: "jjo-linked-probe", version: "0.0.1", gjc: { tools: "tools" } }, null, 2)}\n`,
	);
	writeFileSync(
		path.join(dir, "tools", "index.ts"),
		[
			'import { appendFileSync } from "node:fs";',
			"",
			"const marker = process.env.JJO_PROBE_MARKER;",
			'if (marker) appendFileSync(marker, "linked-probe tool module imported\\n");',
			"",
			"export default function probeTool(pi: { typebox: { Type: { Object(schema: Record<string, never>): unknown } } }) {",
			"\treturn {",
			'\t\tname: "jjo_linked_probe",',
			'\t\tlabel: "Linked probe",',
			'\t\tdescription: "Tool declared by a linked npm-style plugin.",',
			"\t\tparameters: pi.typebox.Type.Object({}),",
			'\t\tasync execute() { return { content: [{ type: "text", text: "OK" }] }; },',
			"\t};",
			"}",
			"",
		].join("\n"),
	);
	return dir;
}

// A local OpenAI-compatible endpoint records the tool inventory each request carries:
// that inventory is the session's loaded plugin surface, observed at the wire.
async function startStub(logPath) {
	const requests = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
			const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name ?? tool?.name ?? "?") : [];
			requests.push({ url: req.url, tools });
			writeFileSync(logPath, `${requests.map((row) => JSON.stringify(row)).join("\n")}\n`);
			const model = body.model ?? "stub-model";
			if (req.url?.includes("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
				return;
			}
			const completed = {
				id: "resp_stub",
				object: "response",
				created_at: Math.floor(Date.now() / 1000),
				status: "completed",
				model,
				output: [
					{
						type: "message",
						id: "msg_stub",
						status: "completed",
						role: "assistant",
						content: [{ type: "output_text", text: "stub-ok", annotations: [] }],
					},
				],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			};
			if (body.stream) {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				const emit = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
				for (const type of ["response.created", "response.in_progress"]) {
					emit(type, { response: { ...completed, status: "in_progress", output: [] } });
				}
				emit("response.output_text.delta", { item_id: "msg_stub", output_index: 0, content_index: 0, delta: "stub-ok" });
				emit("response.output_text.done", { item_id: "msg_stub", output_index: 0, content_index: 0, text: "stub-ok" });
				emit("response.output_item.done", { output_index: 0, item: completed.output[0] });
				emit("response.completed", { response: completed });
				res.end("data: [DONE]\n\n");
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(completed));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: server.address().port, requests };
}

async function main() {
	const probe = await sh("gjc", ["--version"], { home: os.homedir(), allowFailure: true });
	// Only an absent executable is "not runnable here". A gjc that exists but cannot answer
	// --version is a broken install, and a skip would hide it.
	if (probe.spawnError?.code === "ENOENT") {
		console.log(`${LABEL}: skipped — no gjc on PATH (hosted runners); this check runs where GJC is installed`);
		return 0;
	}
	if (probe.code !== 0) {
		throw new Error(`gjc --version exited ${probe.code}, so the CLI contract is unmeasurable:\n${probe.out}`);
	}
	const observed = probe.out.trim().split("\n")[0];
	const root = mkdtempSync(path.join(os.tmpdir(), "gjc-plugin-cli-"));
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	mkdirSync(path.join(home, ".gjc", "agent"), { recursive: true });
	mkdirSync(project, { recursive: true });
	const manifestPath = path.resolve("verification-receipts");
	console.log(`${LABEL}: gjc ${observed} in a throwaway HOME`);

	try {
		// 1. `plugin link` is discoverable by every consumer that lists plugins.
		const linked = writeLinkedProbe(root);
		const link = await sh("gjc", ["plugin", "link", linked], { cwd: project, home });
		if (!/Linked jjo-linked-probe/.test(link.out)) throw new Error(`link printed no success line: ${link.out}`);
		const checks = jsonOf((await sh("gjc", ["plugin", "doctor", "--json"], { cwd: project, home })).stdout);
		const pluginCheck = checks.find((entry) => entry.name === "plugin:jjo-linked-probe");
		if (!pluginCheck || pluginCheck.status !== "ok") throw new Error("doctor does not accept the link");
		const list = jsonOf((await sh("gjc", ["plugin", "list", "--json"], { cwd: project, home })).stdout);
		if (!list.npm?.some((entry) => entry.name === "jjo-linked-probe")) throw new Error("link missing from plugin list --json");
		const lock = JSON.parse(readFileSync(path.join(home, ".gjc", "plugins", "gjc-plugins.lock.json"), "utf8"));
		if (lock.plugins?.["jjo-linked-probe"]?.linked !== true) throw new Error("link recorded no linked:true discovery record");
		record("link is discoverable (doctor ok, list row, linked lock record)", "no orphan");

		// 2. `install --dry-run` writes no plugin state; a real install does.
		await sh("gjc", ["plugin", "install", manifestPath, "--user", "--dry-run"], { cwd: project, home });
		const before = snapshot(home);
		const dryUser = await sh("gjc", ["plugin", "install", manifestPath, "--user", "--dry-run"], { cwd: project, home });
		if (!/\[dry-run\] Would install verification-receipts/.test(dryUser.out)) throw new Error(`dry-run said: ${dryUser.out}`);
		const dryProject = await sh("gjc", ["plugin", "install", manifestPath, "--project", "--dry-run"], { cwd: project, home });
		if (!/\[dry-run\] Would install verification-receipts/.test(dryProject.out)) throw new Error(`project dry-run said: ${dryProject.out}`);
		if (before.join("\n") !== snapshot(home).join("\n")) throw new Error("dry-run changed the user-scope tree");
		if (existsSync(path.join(home, ".gjc", "agent", "gjc-plugins"))) throw new Error("dry-run created the bundle registry");
		if (existsSync(path.join(project, ".gjc"))) throw new Error("project dry-run created .gjc in the project");
		await sh("gjc", ["plugin", "install", manifestPath, "--user"], { cwd: project, home });
		if (!existsSync(path.join(home, ".gjc", "agent", "gjc-plugins", "registry.json"))) {
			throw new Error("control install wrote no registry, so the snapshot observer is blind");
		}
		record("install --dry-run writes nothing (user+project); the control install writes the registry", "0 writes");

		// 3. A refused manifest names the field, the supported set and a bundle-relative path.
		const extra = writeBundle(root, "probe-extra-field", [
			{ name: "probe-hook", event: "session_shutdown", path: "hooks/probe.ts", timeout: 5 },
		]);
		const canonical = writeBundle(root, "probe-canonical", [{ name: "probe-hook", event: "session_shutdown", path: "hooks/probe.ts" }]);
		const refused = await sh("gjc", ["plugin", "install", extra, "--user"], { cwd: project, home, allowFailure: true });
		if (refused.code === 0) throw new Error("a bundle with an unsupported hook field installed");
		for (const fragment of ['"timeout"', "supported fields are", "<bundle>/gajae-plugin.json"]) {
			if (!refused.out.includes(fragment)) throw new Error(`diagnostic missing ${fragment}: ${refused.out}`);
		}
		const refusedJson = await sh("gjc", ["plugin", "install", extra, "--user", "--json"], { cwd: project, home, allowFailure: true });
		if (refusedJson.code === 0) throw new Error("the --json failure path installed the refused bundle");
		if (refusedJson.stdout.trim() !== "") {
			throw new Error(
				"the --json failure path now prints JSON; the known gap in docs/gjc-0.20-plugin-cli-verification.md is closed — update the document and this check",
			);
		}
		if ((await sh("gjc", ["plugin", "install", canonical, "--user"], { cwd: project, home, allowFailure: true })).code !== 0) {
			throw new Error("the canonical control bundle failed to install");
		}
		record("a refused manifest names the field, the supported set and the bundle-relative path", "--json failure path still open");

		// 4. Session surfaces: installed bundle tools load, a linked npm-style tool does not.
		const marker = path.join(root, "linked-probe-import.log");
		process.env.JJO_PROBE_MARKER = marker;
		const stub = await startStub(path.join(root, "stub-requests.jsonl"));
		try {
			await sh(
				"gjc",
				[
					"setup",
					"provider",
					"--compat",
					"openai",
					"--provider",
					"localstub",
					"--base-url",
					`http://127.0.0.1:${stub.port}/v1`,
					"--api-key-env",
					"LOCALSTUB_KEY",
					"--model",
					"stub-model",
				],
				{ cwd: project, home },
			);
			await sh("gjc", ["-p", "--no-session", "--no-mcp", "--model", "stub-model", "say ok"], { cwd: project, home, allowFailure: true });
			const request = [...stub.requests].reverse().find((entry) => entry.url?.endsWith("/responses"));
			if (!request) throw new Error("the session made no model request");
			const loaded = BUNDLE_TOOLS.filter((name) => request.tools.includes(name));
			if (loaded.length !== BUNDLE_TOOLS.length) throw new Error(`installed bundle tools missing from the request: ${request.tools.join(", ")}`);
			if (request.tools.includes("jjo_linked_probe") || existsSync(marker)) {
				throw new Error(
					"a linked npm-style plugin now contributes a session surface; the known gap in docs/gjc-0.20-plugin-cli-verification.md is closed — update the document and this check",
				);
			}
			record("bundle tools load in a session; a linked npm-style tool does not", "3 bundle tools, 0 linked");
		} finally {
			stub.server.close();
		}
		return 0;
	} finally {
		if (KEEP) console.log(`${LABEL}: kept ${root}`);
		else rmSync(root, { recursive: true, force: true });
	}
}

let failure = 0;
try {
	failure = await main();
	if (failure === 0) {
		if (cases > 0) console.log(`${LABEL}: ok (${cases} cases)`);
	}
} catch (error) {
	console.error(`${LABEL}: failed — ${error instanceof Error ? error.message : String(error)}`);
	failure = 1;
}
process.exit(failure);
