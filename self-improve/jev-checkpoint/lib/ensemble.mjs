/**
 * Two-voter ensemble over OpenGateway decisions: V1 = jev-omni (primary),
 * V2 = decider-4b (aux). Both voters receive the identical question and the
 * identical criteria order. Inputs are `classifyDecision` outcomes.
 *
 * Fixed evaluation order (final plan, 앙상블 계약):
 *  1. any voter `unnormalized_probabilities`      → abstain (whole ensemble)
 *  2. any voter other no-decision                 → abstain
 *  3. both decided, same label                    → agree, signal = min
 *  4. both decided, different labels              → rule-dependent
 *  5. one decided + one low_confidence            → rule-dependent
 *  6. both low_confidence                         → abstain
 *
 * Rules (C3 rule is frozen in the manifest before S2; the others are J0
 * sensitivity rows):
 *  - `primary_override`: 4 → primary label if primary signal ≥ 0.75, else
 *    abstain; 5 → the decided voter if its signal ≥ 0.75, else abstain.
 *  - `agreement_only`: 4 and 5 → abstain.
 *  - `single_primary`: the primary voter alone (decided → its label).
 */

export const OVERRIDE_THRESHOLD = 0.75;
export const ENSEMBLE_RULES = Object.freeze(["primary_override", "agreement_only", "single_primary"]);

const abstain = (reason) => ({ branch: "abstain", label: null, signal: null, reason });

export function combineVoters({ primary, aux, rule = "primary_override" }) {
	if (!ENSEMBLE_RULES.includes(rule)) throw new Error("unknown_ensemble_rule");
	if (!primary || !aux) throw new Error("missing_voter");
	if (rule === "single_primary") {
		if (primary.status === "decided") return { branch: "single", label: primary.choice, signal: primary.confidence, reason: null };
		return abstain(primary.status === "no_decision" ? primary.reason : "low_confidence");
	}
	if (primary.reason === "unnormalized_probabilities" || aux.reason === "unnormalized_probabilities") return abstain("unnormalized_probabilities");
	if (primary.status === "no_decision") return abstain(primary.reason);
	if (aux.status === "no_decision") return abstain(aux.reason);
	if (primary.status === "decided" && aux.status === "decided") {
		if (primary.choice === aux.choice) return { branch: "agree", label: primary.choice, signal: Math.min(primary.confidence, aux.confidence), reason: null };
		if (rule === "primary_override" && primary.confidence >= OVERRIDE_THRESHOLD) return { branch: "disagree", label: primary.choice, signal: primary.confidence, reason: null };
		return abstain("disagreement");
	}
	if (primary.status === "decided" || aux.status === "decided") {
		const decided = primary.status === "decided" ? primary : aux;
		if (rule === "primary_override" && decided.confidence >= OVERRIDE_THRESHOLD) return { branch: "single", label: decided.choice, signal: decided.confidence, reason: null };
		return abstain("low_confidence");
	}
	return abstain("low_confidence");
}

/**
 * Voter-level-abstain variant (reviewers' proposal), reported only as a J0
 * sensitivity row: an unnormalized voter is treated as low_confidence instead
 * of forcing the ensemble to abstain.
 */
export function combineVotersVoterLevel({ primary, aux, rule = "primary_override" }) {
	const demote = (voter) => (voter.reason === "unnormalized_probabilities" ? { ...voter, status: "low_confidence", reason: null, confidence: 0 } : voter);
	return combineVoters({ primary: demote(primary), aux: demote(aux), rule });
}
