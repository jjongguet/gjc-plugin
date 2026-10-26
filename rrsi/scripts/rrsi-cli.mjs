#!/usr/bin/env bun
// Local CLI entry for the rrsi tool surface (capture | import | dream | status).
//
// The plugin exposes `rrsi` as a GJC tool; this script calls the same built
// surface from a shell so a store can be inspected and fed outside a session.
// It is a thin wrapper: parsing, bounds, locking and storage stay in
// `tools/rrsi.ts` and `lib/rrsi.ts`. Keyless and offline like the tool itself.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolFile = join(pluginRoot, 'tools', 'rrsi.ts');
const ACTIONS = new Set(['capture', 'import', 'dream', 'status']);

const USAGE = [
	'usage: bun rrsi/scripts/rrsi-cli.mjs <action> [options]',
	'',
	'  status',
	'  dream    [--seed <n>] [--full]',
	'  import   [--ledger <path>] [--limit <n>]',
	'  capture  --goal <text> [--attempts <json> | --attempts-file <path>]',
	'',
	'Every action prints the tool\'s JSON payload to stdout. Exit codes:',
	'  0 handled · 1 tool error or invalid store · 2 usage or runtime error',
].join('\n');

function parseArgs(argv) {
	const [action, ...rest] = argv;
	if (!ACTIONS.has(action)) throw Object.assign(new Error(`unknown action: ${action ?? '(none)'}`), { usage: true });
	const options = {};
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		if (!flag.startsWith('--')) throw Object.assign(new Error(`unexpected argument: ${flag}`), { usage: true });
		if (flag === '--full') {
			options.full = true;
			continue;
		}
		const value = rest[index + 1];
		if (value === undefined || value.startsWith('--')) throw Object.assign(new Error(`missing value for ${flag}`), { usage: true });
		index++;
		if (flag === '--goal') options.goal = value;
		else if (flag === '--attempts') options.attempts = value;
		else if (flag === '--attempts-file') options.attempts = readFileSync(resolve(value), 'utf8');
		else if (flag === '--ledger') options.ledgerPath = value;
		else if (flag === '--limit') options.limit = value;
		else if (flag === '--seed') options.seed = value;
		else throw Object.assign(new Error(`unknown option: ${flag}`), { usage: true });
	}
	if (action === 'capture' && typeof options.goal !== 'string') throw Object.assign(new Error('capture requires --goal'), { usage: true });
	return { action, options };
}

async function loadTool() {
	const module = await import(pathToFileURL(toolFile).href);
	const fakePi = { typebox: { Type: { Object: (fields) => fields, String: (options) => options ?? {}, Optional: (schema) => schema } } };
	return module.default(fakePi);
}

/**
 * `dream --full` also returns the per-policy numbers behind the tool's ranking ids.
 * It replays the same store and seed, and refuses to print a table whose receipt
 * hash differs from the journaled tool call.
 */
async function fullDream(seed) {
	const lib = await import(pathToFileURL(join(pluginRoot, 'lib', 'rrsi.ts')).href);
	const loaded = lib.readStore();
	const { receipt } = lib.dreamOverStore({ store: loaded.store, seed: Number.parseInt(seed ?? '1', 10) || 1 });
	const ranked = receipt.rankings.map((id) => {
		const candidate = receipt.candidates.find((entry) => entry.id === id) ?? {};
		return { id, config: candidate.config ?? null, validation: candidate.validation ?? null, train: candidate.train ?? null };
	});
	return { full: { receiptHash: receipt.receiptHash, ranked, baselines: receipt.baselines, thresholds: receipt.thresholds } };
}

async function main(argv) {
	if (process.versions.bun === undefined) throw Object.assign(new Error('run this CLI with bun (the built surface is TypeScript)'), { usage: true });
	if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const { action, options } = parseArgs(argv);
	const { full, ...params } = options;
	const tool = await loadTool();
	const response = await tool.execute('rrsi-cli', { action, ...params });
	const payload = JSON.parse(response.content?.[0]?.text ?? '{}');
	if (full && action === 'dream' && !response.isError) {
		const extra = await fullDream(params.seed);
		if (payload.summary?.receiptHash && extra.full.receiptHash !== payload.summary.receiptHash) {
			throw new Error(`receipt_hash_mismatch: tool=${payload.summary.receiptHash} replay=${extra.full.receiptHash}`);
		}
		Object.assign(payload, extra);
	}
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
	return response.isError ? 1 : 0;
}

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		if (error?.usage) process.stderr.write(`${error.message}\n\n${USAGE}\n`);
		else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	});
