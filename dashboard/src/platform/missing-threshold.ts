// 결측 경고 임계 표시 정본(f31) — 루트 steps.json missing_threshold(3일 warn·7일 urgent)와 같은 값.
// 레포별 재정의는 steps.json이 담당하고, 대시보드 문구는 이 상수를 쓴다.
export const MISSING_THRESHOLD = { warnDays: 3, urgentDays: 7 } as const;
