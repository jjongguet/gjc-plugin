/**
 * Catalog receipt (final plan 라우트·가격 표): the OpenGateway public model
 * catalog is re-read at experiment start and at every stage boundary; prices
 * are recorded per token with their source. A receipt older than 24 hours, or a
 * missing entry, refuses every paid stage (never priced as zero).
 */
import { createHash } from "node:crypto";
import { CHAT_MODEL, OPENGATEWAY_MODELS, TRIAL_DECISION_ROUTES } from "./decision-routes.mjs";

export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CATALOG_MODELS = Object.freeze([CHAT_MODEL, ...Object.keys(TRIAL_DECISION_ROUTES)]);

const price = (value) => {
	const number = typeof value === "string" ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : null;
};

export function catalogReceipt(rawText, observedAt = new Date().toISOString()) {
	const data = JSON.parse(rawText);
	const rows = Array.isArray(data?.data) ? data.data : [];
	const entries = {};
	for (const model of CATALOG_MODELS) {
		const row = rows.find((entry) => entry?.id === model);
		if (!row?.pricing) throw new Error(`catalog_entry_missing:${model}`);
		const listInput = price(row.pricing.list?.prompt);
		const observedInput = price(row.pricing.prompt);
		if (listInput === null && observedInput === null) throw new Error(`catalog_price_missing:${model}`);
		entries[model] = {
			source: OPENGATEWAY_MODELS,
			model,
			provider: Array.isArray(row.providers) ? row.providers.map((provider) => provider.id).join(",") : null,
			unit: "per_token",
			listInputPricePerToken: listInput ?? observedInput,
			observedInputPricePerToken: observedInput,
			listOutputPricePerToken: price(row.pricing.list?.completion),
			observedOutputPricePerToken: price(row.pricing.completion),
			discountPercent: price(row.pricing.discount_percent),
			discountSource: observedInput !== null ? "catalog_field" : null,
			status: row.status ?? null,
			observedAt,
		};
	}
	return { schema: "jexp.catalog_receipt.v1", observedAt, rawDigest: createHash("sha256").update(rawText).digest("hex"), entries };
}

export async function fetchCatalog(fetchImpl = globalThis.fetch) {
	const response = await fetchImpl(OPENGATEWAY_MODELS, { redirect: "error", signal: AbortSignal.timeout(15000) });
	if (!response.ok) throw new Error(`catalog_http_${response.status}`);
	return catalogReceipt(await response.text());
}

export function assertFresh(receipt, now = Date.now()) {
	if (!receipt?.observedAt) throw new Error("catalog_missing");
	const age = now - Date.parse(receipt.observedAt);
	if (!(age >= 0 && age <= CATALOG_MAX_AGE_MS)) throw new Error("catalog_stale");
	for (const model of CATALOG_MODELS) if (!receipt.entries?.[model]) throw new Error(`catalog_entry_missing:${model}`);
	return receipt;
}
