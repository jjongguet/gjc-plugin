/**
 * Frozen stage plans (final plan 단계·셀 표). Cells are interleaved by repeat so
 * an early stop or the S1 re-projection checkpoint sees every arm. Split
 * membership is a frozen constant: dev stages never open a holdout task
 * directory (P2 leak guard); a unit test binds the constants to spec.json.
 */

export const DEV_TASKS = Object.freeze(["lane-start-base", "no-invented-cap", "retry-until-cap", "scope-stop", "size-read", "skipped-not-started"]);
export const HOLDOUT_TASKS = Object.freeze(["claim-evidence", "cost-arith", "destructive-gate", "lifecycle-records", "merge-conflict", "review-rounds"]);
export const S0_TASKS = Object.freeze(["no-invented-cap", "retry-until-cap"]);
export const REPEATS = Object.freeze([1, 2, 3]);
export const STAGE_CONDITIONS = Object.freeze({
	S0: Object.freeze(["a1-off", "bp-periodic", "de-error"]),
	S0b: Object.freeze(["a0-release", "a1-off"]),
	S1: Object.freeze(["a1-off", "bp-periodic", "de-error"]),
	S2: Object.freeze(["c3-ensemble"]),
	S3: Object.freeze(["a1-off", "fz-frozen"]),
});

export function stagePlan(stage) {
	const conditions = STAGE_CONDITIONS[stage];
	if (!conditions) throw new Error("unknown_stage");
	const split = stage === "S3" ? "holdout" : "dev";
	const tasks = stage === "S0" || stage === "S0b" ? S0_TASKS : split === "holdout" ? HOLDOUT_TASKS : DEV_TASKS;
	const plan = [];
	for (const repeat of REPEATS) for (const taskId of tasks) for (const condition of conditions) plan.push({ stage, split, taskId, condition, repeat });
	return plan;
}
