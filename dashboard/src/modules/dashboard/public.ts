// dashboard module public contract — 4-envelope reads. Code outside the module imports this path
// only (no direct imports of internals across modules, no UI→adapters direct imports — web profile rule).
export { readAll, readEnvelope } from "@/adapters/envelopes";
export type {
  EnvelopeRow,
  EnvelopeSnapshot,
  EnvelopeTable,
} from "@/ports/envelopes";
