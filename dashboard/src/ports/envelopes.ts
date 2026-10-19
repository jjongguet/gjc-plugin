// Envelope read port — the read interface for the four shared Supabase envelopes.
// The implementation is adapters/envelopes.ts (PostgREST fetch). The definitions originate in
// workspace-standard schemas/ (status, ledger, workflow-runs, workflow-steps).

export const ENVELOPE_TABLES = [
  "status",
  "ledger",
  "workflow_runs",
  "workflow_steps",
] as const;

export type EnvelopeTable = (typeof ENVELOPE_TABLES)[number];

/** An envelope row — read views assume no fixed column set (accepts schema evolution). */
export type EnvelopeRow = Record<string, unknown>;

/** One snapshot of the four envelopes — a single unit of dashboard server render. */
export type EnvelopeSnapshot = Record<EnvelopeTable, EnvelopeRow[]>;
