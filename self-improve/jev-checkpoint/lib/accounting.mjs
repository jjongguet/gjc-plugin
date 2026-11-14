/**
 * Request-level cost ledger with two separate limits (final plan C4/K2):
 *
 * (a) per-cell cap: a cell whose spent+reserved+next would exceed its USD cap
 *     (or whose turn count would exceed its turn cap) gets `cell_cap`; only that
 *     cell's further requests are refused, every other cell continues.
 * (b) global hard stop: when spent+reserved+next+cleanup ≥ hardStopUsd the
 *     ledger turns STOPPED atomically, writes `stop.json`, and refuses every
 *     later request with `budget_stop`. The runner propagates the stop.
 *
 * Reservation happens before dispatch and is durably journaled (sync append)
 * before the caller may touch transport. Settlement basis, in order:
 * `billed` (provider cost) > `observed_catalog` (tokens × observed price) >
 * `computed_tokens` (tokens × list price) > `computed_bound` (the reservation).
 * An unknown charge is never recorded as zero.
 */
import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";

export const HARD_STOP_USD = 4.0;
export const ABSOLUTE_CAP_USD = 5.0;
export const STOP_EPSILON_USD = 1e-9;

const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function createLedger({ hardStopUsd = HARD_STOP_USD, priorSpentUsd = 0, cleanupUsd = 0, journalPath = null, stopPath = null, label = null, now = () => new Date().toISOString() } = {}) {
	if (!(finite(hardStopUsd) && hardStopUsd > 0 && hardStopUsd <= ABSOLUTE_CAP_USD)) throw new Error("invalid_hard_stop");
	if (!finite(priorSpentUsd) || !finite(cleanupUsd)) throw new Error("unknown_prior_spend");
	let spent = priorSpentUsd;
	let stopped = null;
	const pending = new Map();
	const seen = new Set();
	const cells = new Map();
	const byBasis = { billed: 0, observed_catalog: 0, computed_tokens: 0, computed_bound: 0 };
	const journal = (row) => {
		if (journalPath) appendFileSync(journalPath, `${JSON.stringify({ at: now(), stage: label, ...row })}\n`, { mode: 0o600 });
	};
	const reservedTotal = () => [...pending.values()].reduce((sum, entry) => sum + entry.reserveUsd, 0);
	const snapshot = () => ({ spentUsd: spent, reservedUsd: reservedTotal(), priorSpentUsd, cleanupUsd, hardStopUsd, stopped: stopped !== null, byBasis: { ...byBasis } });
	const cell = (cellId) => {
		if (!cells.has(cellId)) cells.set(cellId, { usdCap: Infinity, turnCap: Infinity, spent: 0, reserved: 0, turns: 0, capped: null });
		return cells.get(cellId);
	};
	const stop = (reason, attempted) => {
		if (stopped) return;
		stopped = { reason, at: now(), attemptedUsd: attempted, ledger: snapshot() };
		stopped.ledger.stopped = true;
		journal({ kind: "stopped", ...stopped });
		if (stopPath) {
			const temp = `${stopPath}.tmp`;
			writeFileSync(temp, JSON.stringify(stopped, null, 2), { mode: 0o600 });
			renameSync(temp, stopPath);
		}
	};
	return {
		snapshot,
		get stopped() { return stopped; },
		configureCell(cellId, { usdCap = Infinity, turnCap = Infinity } = {}) {
			// NaN would disable the `>` cap checks below; only a positive number (or an explicit Infinity) is a cap.
			for (const [name, value] of [["usdCap", usdCap], ["turnCap", turnCap]]) {
				if (typeof value !== "number" || Number.isNaN(value) || value <= 0) throw new Error(`invalid_${name}`);
			}
			const entry = cell(cellId);
			entry.usdCap = usdCap;
			entry.turnCap = turnCap;
		},
		cellState(cellId) { return { ...cell(cellId) }; },
		/** Reserve before dispatch. Throws `budget_stop`, `cell_cap` or `duplicate_request`. */
		reserve({ id, cellId, kind, reserveUsd, turn = false }) {
			if (!finite(reserveUsd) || reserveUsd <= 0) throw new Error("invalid_reservation");
			if (stopped) throw new Error("budget_stop");
			if (seen.has(id)) throw new Error("duplicate_request");
			const entry = cell(cellId);
			if (entry.capped) throw new Error("cell_cap");
			if (turn && entry.turns + 1 > entry.turnCap) { entry.capped = "turn_cap"; journal({ kind: "cell_cap", cellId, cap: "turns" }); throw new Error("cell_cap"); }
			if (entry.spent + entry.reserved + reserveUsd > entry.usdCap) { entry.capped = "usd_cap"; journal({ kind: "cell_cap", cellId, cap: "usd" }); throw new Error("cell_cap"); }
			const projected = spent + reservedTotal() + reserveUsd + cleanupUsd;
			// A float-rounding margin stops at, never past, the boundary.
			if (projected >= hardStopUsd - STOP_EPSILON_USD) { stop("hard_stop", projected); throw new Error("budget_stop"); }
			seen.add(id);
			pending.set(id, { cellId, kind, reserveUsd });
			entry.reserved += reserveUsd;
			if (turn) entry.turns += 1;
			// Durable before transport: a failed write throws and the caller never dispatches.
			journal({ kind: "reserved", id, cellId, requestKind: kind, reserveUsd });
		},
		/** Settle one reservation. `charge` = {billedUsd?, observedUsd?, computedUsd?}. */
		settle(id, charge = {}) {
			const entry = pending.get(id);
			if (!entry) throw new Error("unknown_request");
			let usd;
			let basis;
			if (finite(charge.billedUsd)) { usd = charge.billedUsd; basis = "billed"; }
			else if (finite(charge.observedUsd)) { usd = charge.observedUsd; basis = "observed_catalog"; }
			else if (finite(charge.computedUsd)) { usd = charge.computedUsd; basis = "computed_tokens"; }
			else { usd = entry.reserveUsd; basis = "computed_bound"; }
			pending.delete(id);
			const state = cell(entry.cellId);
			state.reserved -= entry.reserveUsd;
			state.spent += usd;
			spent += usd;
			byBasis[basis] += usd;
			journal({ kind: "settled", id, cellId: entry.cellId, requestKind: entry.kind, usd, basis });
			return { usd, basis };
		},
		/** Transport/response unknown: charge the full reservation (never zero). */
		unresolved(id) {
			if (!pending.has(id)) return null;
			return this.settle(id, {});
		},
		stop,
	};
}

export function stopRequested(stopPath) {
	return existsSync(stopPath);
}
