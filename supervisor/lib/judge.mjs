// Deterministic stall classification.
//
// One session fact record in, one state out. No I/O, no clock: the caller passes
// `now`, so the rules are pinned by tests. Only genuinely mixed signals carry an
// `ambiguous` block; everything else is decided here and never spends a
// decision-model call.
export const JUDGE_STATES = ["progressing", "thrashing", "stalled", "starting", "unknown"];

export const JUDGE_DEFAULTS = {
  stallMinutes: 30,
  progressMinutes: 10,
  /** Below the stall window a session has simply not had time to commit. */
  startingMinutes: 30,
};

const MINUTE = 60_000;

/** @param {string|null|undefined} iso */
export function minutesSince(iso, now) {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / MINUTE));
}

/**
 * @param {object} session collected session facts (see collect.mjs)
 * @param {{now: number, previous?: object|null, thresholds?: Partial<typeof JUDGE_DEFAULTS>}} context
 * @returns {{id: string, state: string, reasons: string[], ambiguous?: {labels: string[], defaultState: string, question: string}}}
 */
export function judgeSession(session, { now, previous = null, thresholds = {} } = {}) {
  const limits = { ...JUDGE_DEFAULTS, ...thresholds };
  const reasons = [];
  const verdict = state => ({ id: session.id, state, reasons });
  const ambiguous = (state, labels, question) => ({
    id: session.id,
    state,
    reasons,
    ambiguous: { labels, defaultState: state, question },
  });

  if (session.worktreePresent === false) {
    reasons.push("worktree_missing");
    return verdict("stalled");
  }
  if (session.tmuxAlive === false) {
    reasons.push("session_gone");
    return verdict("stalled");
  }

  const age = session.ageMinutes ?? null;
  const commitsSinceStart = session.commitsSinceStart ?? null;
  const commitsWindow = session.commitsLastWindow ?? 0;
  const dirty = session.dirty ?? 0;
  const dirtyDelta = session.dirtyDelta ?? null;
  const lastCommitAge = minutesSince(session.lastCommit?.at ?? null, now);
  const stall = limits.stallMinutes;

  if (commitsWindow > 0) {
    reasons.push(`commit_within_${limits.progressMinutes}m`);
    return verdict("progressing");
  }
  if (dirtyDelta !== null && dirtyDelta > 0) {
    reasons.push("dirty_growth_without_commit");
    return verdict("thrashing");
  }
  // A commit landed inside the stall window but not the 10 minute window: the
  // session is still landing work, just less recently.
  if (lastCommitAge !== null && lastCommitAge < stall) {
    reasons.push(`last_commit_${lastCommitAge}m`);
    return verdict("progressing");
  }
  if (age !== null && commitsSinceStart === 0 && age >= stall) {
    reasons.push(`no_commit_since_start_${age}m`);
    return verdict("stalled");
  }
  if (age !== null && lastCommitAge !== null && age >= stall && lastCommitAge >= stall) {
    reasons.push(`no_commit_within_${lastCommitAge}m`);
    if (dirty > 0) {
      // Work exists but nothing has landed for a whole stall window: either the
      // session is stuck in uncommitted edits (thrashing) or it stalled with a
      // dirty tree. The deterministic default is `stalled`; the ambiguity is
      // what a decision-model call is for.
      reasons.push("dirty_without_commit");
      return ambiguous("stalled", ["stalled", "thrashing"], "Is this workspace session stalled or thrashing?");
    }
    return verdict("stalled");
  }
  if (age !== null && age < stall) {
    reasons.push(`within_${stall}m_start_window`);
    return verdict("starting");
  }
  if (age === null && previous) {
    reasons.push("age_unknown");
    return verdict("unknown");
  }
  reasons.push("insufficient_signal");
  return verdict("unknown");
}
