// Canonical display thresholds for missing-data warnings — same values as the root steps.json
// missing_threshold (3-day warn, 7-day urgent). Per-repo overrides live in steps.json; the dashboard
// copy uses this constant.
export const MISSING_THRESHOLD = { warnDays: 3, urgentDays: 7 } as const;
