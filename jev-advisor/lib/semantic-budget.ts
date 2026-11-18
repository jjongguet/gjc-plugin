/** Durable task-wide reservations; unknown billing never releases money. */
import { constants as budgetFs, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID as budgetUUID } from "node:crypto";
import path from "node:path";
import { askSemanticAdvice, semanticOutboundEnabled, semanticRequestBody, type SemanticAdvice, type SemanticInput } from "./semantic";

export const SEMANTIC_BUDGET_MICRO_USD = 5000000;
export const SEMANTIC_RESERVATION_MICRO_USD = 50000;
export const SEMANTIC_SESSION_CALL_CAP = 1;
type BudgetEntry = { id: string; session: string; at: number; reservedMicroUsd: number; costMicroUsd: number | null };
type SemanticBudget = { version: 1; priorMicroUsd: number; entries: BudgetEntry[] };
type BudgetReason = "budget_unconfigured" | "budget_unavailable" | "budget_exceeded" | "session_cap";
type BudgetResult = SemanticAdvice | { status: "no_decision"; reason: BudgetReason; outbound: false };
const budgetInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function budgetValidate(value: any): value is SemanticBudget {
	return value?.version === 1 && budgetInteger(value.priorMicroUsd) && Array.isArray(value.entries) && value.entries.length <= 10000 &&
		value.entries.every((entry: any) => /^[a-f0-9-]{36}$/.test(entry?.id) && /^[a-f0-9]{16}$/.test(entry.session) && budgetInteger(entry.at) &&
			entry.reservedMicroUsd === SEMANTIC_RESERVATION_MICRO_USD && (entry.costMicroUsd === null || budgetInteger(entry.costMicroUsd))) &&
		new Set(value.entries.map((entry: BudgetEntry) => entry.session)).size === value.entries.length;
}

/** Private regular files, exclusive no-retry lock and fsynced atomic updates. */
function budgetTransaction<T>(env: Record<string, string | undefined>, mutate: (ledger: SemanticBudget) => T): T | null {
	let lock: number | undefined;
	let lockFile = "";
	let temporary = "";
	try {
		if (!env.HOME || !path.isAbsolute(env.HOME)) return null;
		let directory = realpathSync(env.HOME);
		const identities: Array<{ directory: string; dev: number; ino: number }> = [];
		for (const segment of [".gjc-plugin", "jev-advisor", "semantic"]) {
			directory = path.join(directory, segment);
			try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			const stat = lstatSync(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) return null;
			identities.push({ directory, dev: stat.dev, ino: stat.ino });
		}
		const unchanged = () => identities.every(identity => {
			const stat = lstatSync(identity.directory);
			return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700;
		});
		const file = path.join(directory, "budget.json");
		lockFile = `${file}.lock`;
		lock = openSync(lockFile, "wx", 0o600); // contention/crash fails closed; no stale-lock removal
		if (!unchanged()) return null;
		let ledger: SemanticBudget;
		let fd: number | undefined;
		try {
			fd = openSync(file, budgetFs.O_RDONLY | budgetFs.O_NOFOLLOW | budgetFs.O_NONBLOCK);
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 1048576) return null;
			ledger = JSON.parse(readFileSync(fd, "utf8"));
			if (!budgetValidate(ledger)) return null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
			const prior = env.JEV_ALIGNMENT_BUDGET_PRIOR_MICRO_USD;
			if (!prior || !/^(0|[1-9][0-9]{0,9})$/.test(prior) || !budgetInteger(Number(prior))) return null;
			ledger = { version: 1, priorMicroUsd: Number(prior), entries: [] };
		} finally { if (fd !== undefined) closeSync(fd); }
		const result = mutate(ledger);
		if (!budgetValidate(ledger) || !unchanged()) return null;
		temporary = `${file}.${budgetUUID()}.tmp`;
		fd = openSync(temporary, "wx", 0o600);
		try { writeFileSync(fd, JSON.stringify(ledger)); fsyncSync(fd); } finally { closeSync(fd); }
		if (!unchanged()) return null;
		renameSync(temporary, file);
		temporary = "";
		fd = openSync(directory, budgetFs.O_RDONLY);
		try { fsyncSync(fd); } finally { closeSync(fd); }
		return result;
	} catch { return null; }
	finally {
		if (temporary) { try { unlinkSync(temporary); } catch {} }
		if (lock !== undefined) {
			try { const a = fstatSync(lock); const b = lstatSync(lockFile); if (a.dev === b.dev && a.ino === b.ino) unlinkSync(lockFile); } catch {}
			closeSync(lock);
		}
	}
}

/** One reservation per stable host session; no eviction, expiry or reset. */
export async function askBudgetedSemanticAdvice(input: SemanticInput, session: string, env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): Promise<BudgetResult> {
	if (!semanticOutboundEnabled(env)) return { status: "no_decision", reason: "outbound_suppressed", outbound: false };
	try {
		if (!env.OPENGATEWAY_API_KEY?.trim()) return { status: "no_decision", reason: "unconfigured", outbound: false };
	} catch { return { status: "no_decision", reason: "unconfigured", outbound: false }; }
	try {
		if (semanticRequestBody(input) === null) return { status: "no_decision", reason: "invalid_input", outbound: false };
	} catch { return { status: "no_decision", reason: "invalid_input", outbound: false }; }
	if (!/^[a-f0-9]{16}$/.test(session)) return { status: "no_decision", reason: "budget_unconfigured", outbound: false };
	const id = budgetUUID();
	const admitted = budgetTransaction(env, ledger => {
		if (ledger.entries.filter(entry => entry.session === session).length >= SEMANTIC_SESSION_CALL_CAP) return "session_cap" as const;
		const charged = ledger.priorMicroUsd + ledger.entries.reduce((sum, entry) => sum + (entry.costMicroUsd ?? entry.reservedMicroUsd), 0);
		if (charged + SEMANTIC_RESERVATION_MICRO_USD > SEMANTIC_BUDGET_MICRO_USD || ledger.entries.length >= 10000) return "budget_exceeded" as const;
		ledger.entries.push({ id, session, at: Date.now(), reservedMicroUsd: SEMANTIC_RESERVATION_MICRO_USD, costMicroUsd: null });
		return "admitted" as const;
	});
	if (admitted !== "admitted") return { status: "no_decision", reason: admitted ?? "budget_unavailable", outbound: false };
	// Reserve BEFORE transport. Failures, unknown usage and process death after
	// sending retain the entire upper bound, never an assumed zero charge.
	let costMicroUsd: number | null = null;
	const advice = await askSemanticAdvice(input, env, fetcher, value => {
		const cost = (value as any)?.usage?.cost;
		if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost <= 1000) costMicroUsd = Math.ceil(cost * 1000000);
	});
	if (costMicroUsd !== null) budgetTransaction(env, ledger => {
		const entry = ledger.entries.find(entry => entry.id === id);
		if (entry) entry.costMicroUsd = costMicroUsd;
		return true;
	}); // failed settlement leaves the durable reservation
	return advice;
}
