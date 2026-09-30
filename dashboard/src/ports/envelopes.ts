// 봉투 열람 포트 — 자기 Supabase 공통 봉투 4종(f5·f19)의 읽기 인터페이스.
// 구현은 adapters/envelopes.ts(PostgREST fetch)다. 정의 원본은
// workspace-standard schemas/(status·ledger·workflow-runs·workflow-steps).

export const ENVELOPE_TABLES = [
  "status",
  "ledger",
  "workflow_runs",
  "workflow_steps",
] as const;

export type EnvelopeTable = (typeof ENVELOPE_TABLES)[number];

/** 봉투 행 — 열람 뷰는 컬럼 집합을 가정하지 않는다(스키마 진화 수용). */
export type EnvelopeRow = Record<string, unknown>;

/** 봉투 4종 1회 스냅숏 — 대시보드 서버 렌더 1단위. */
export type EnvelopeSnapshot = Record<EnvelopeTable, EnvelopeRow[]>;
