// Envelope reader adapter — server-only, built on fetch/PostgREST. No postgres library dependency.
// Works only when both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (fail-loud — never return
// silent empty results).
import {
  type EnvelopeRow,
  type EnvelopeSnapshot,
  type EnvelopeTable,
} from "@/ports/envelopes";

/** Sort column per envelope — adapts the scaffold's single collected_at basis to each table's real columns. */
const ORDER_COLUMN: Record<EnvelopeTable, string> = {
  status: "collected_at",
  ledger: "ts",
  workflow_runs: "started_at",
  workflow_steps: "started_at",
};

function cfg() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set — check the dashboard server env (fail-loud)",
    );
  }
  return { url: url.replace(/\/$/, ""), key };
}

export async function readEnvelope(table: EnvelopeTable, limit = 50): Promise<EnvelopeRow[]> {
  const { url, key } = cfg();
  const res = await fetch(`${url}/rest/v1/${table}?select=*&order=${ORDER_COLUMN[table]}.desc.nullslast&limit=${limit}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`PostgREST ${table} ${res.status}`);
  return (await res.json()) as EnvelopeRow[];
}

export async function readAll(): Promise<EnvelopeSnapshot> {
  const out = {} as EnvelopeSnapshot;
  for (const t of ["status", "ledger", "workflow_runs", "workflow_steps"] as const) out[t] = await readEnvelope(t);
  return out;
}
