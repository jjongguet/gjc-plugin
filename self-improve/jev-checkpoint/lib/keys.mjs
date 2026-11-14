/**
 * Parent-only credential loading. Values are returned to the caller and never
 * printed, logged, written, or placed in a child environment or argv. Only the
 * presence and byte length are reportable.
 */
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPENGATEWAY_KEY_FILE = path.join(os.homedir(), ".gjc", "agent", "policy", "secrets", "opengateway-key.txt");
export const AGENT_ENV_FILE = path.join(os.homedir(), ".gjc", "agent", ".env");

export function readOpenGatewayKey(file = OPENGATEWAY_KEY_FILE) {
	const mode = statSync(file).mode & 0o777;
	if (mode & 0o077) throw new Error("key_file_permissions");
	const value = readFileSync(file, "utf8").trim();
	if (!value || /\s/.test(value)) throw new Error("key_file_invalid");
	return value;
}

/** First of JEV_ADVISOR_API_KEY / OPENROUTER_API_KEY in the agent .env (J0 only). */
export function readOpenRouterKey(file = AGENT_ENV_FILE) {
	const values = {};
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const match = /^\s*(?:export\s+)?(JEV_ADVISOR_API_KEY|OPENROUTER_API_KEY)\s*=\s*(.*)\s*$/.exec(line);
		if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
	}
	const value = values.JEV_ADVISOR_API_KEY || values.OPENROUTER_API_KEY;
	if (!value) throw new Error("openrouter_key_missing");
	return value;
}

/** Report shape only (never the value). */
export function describeKey(value) {
	return { present: typeof value === "string" && value.length > 0, bytes: typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0 };
}

/** In-process scan: does any of the given buffers contain the key? Never returns the key. */
export function keyLeaked(value, buffers) {
	if (!value) return false;
	const needle = Buffer.from(value, "utf8");
	return buffers.some((buffer) => Buffer.isBuffer(buffer) && buffer.indexOf(needle) !== -1);
}
