// dashboard 모듈 공개 계약 — 4봉투 열람. 모듈 밖은 이 경로만 import한다
// (모듈 간 내부 직접 import 금지·UI→adapters 직접 import 금지 — web 프로필 규칙).
export { readAll, readEnvelope } from "@/adapters/envelopes";
export type {
  EnvelopeRow,
  EnvelopeSnapshot,
  EnvelopeTable,
} from "@/ports/envelopes";
