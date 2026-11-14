/**
 * Cumulative spend from the shared ledger journal (`ledger.jsonl`). Every paid
 * step (L0, J0, S1–S3) appends to one journal so the hard stop is cumulative
 * across processes. A reservation without a matching settlement (a crashed
 * process) is charged at its full reserved amount — never zero.
 */
import { existsSync, readFileSync } from "node:fs";

export function readJournal(journalPath) {
	if (!existsSync(journalPath)) return [];
	return readFileSync(journalPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function priorSpend(journalPath) {
	const rows = readJournal(journalPath);
	const reserved = new Map();
	let settled = 0;
	for (const row of rows) {
		if (row.kind === "reserved") reserved.set(row.id, row.reserveUsd);
		else if (row.kind === "settled") { settled += row.usd; reserved.delete(row.id); }
	}
	let dangling = 0;
	for (const value of reserved.values()) dangling += value;
	return settled + dangling;
}

/** Spend table by basis and request kind, for the result comment (C2329-07). */
export function spendTable(journalPath) {
	const table = {};
	for (const row of readJournal(journalPath)) {
		if (row.kind !== "settled") continue;
		const key = `${row.stage ?? "unknown"}|${row.requestKind}|${row.basis}`;
		table[key] = (table[key] ?? 0) + row.usd;
	}
	return table;
}
