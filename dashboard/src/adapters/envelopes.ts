// 봉투 리더 어댑터(N14) — fetch/PostgREST 기반 서버 전용. postgres 라이브러리 의존 없음.
// SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY 둘 다 있을 때만 동작한다(fail-loud — 조용한 빈값 반환 금지).
import {
  type EnvelopeRow,
  type EnvelopeSnapshot,
  type EnvelopeTable,
} from "@/ports/envelopes";

/** 봉투별 정렬 컬럼 — 스캐폴드의 collected_at 단일 기준을 테이블 실제 컬럼에 적합화. */
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
    throw new Error("SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY 미설정 — 대시보드 서버 env를 확인하라(fail-loud)");
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
