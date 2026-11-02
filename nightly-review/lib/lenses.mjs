// One lens per independent perspective. A lens is not a temperature knob: it
// changes what the reviewer is asked to look for, so two lenses disagree for a
// reason. Model families are mixed on purpose — same-model reviewers share
// blind spots, which is exactly what an ensemble is supposed to break.

export const LENSES = [
  {
    id: 'contract',
    model: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast:high',
    service: 'deepseek',
    ask: [
      'Focus: contract breaks between this change and its consumers.',
      'Look for renamed or removed symbols still referenced elsewhere, changed function',
      'signatures whose callers were not updated, request/response or schema shapes that',
      'no longer match the OpenAPI document, migration columns that do not match the',
      'code that reads them, and config keys read under a different name than written.',
    ].join(' '),
  },
  {
    id: 'failure',
    model: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast:high',
    service: 'deepseek',
    ask: [
      'Focus: failure paths and boundaries.',
      'Look for unhandled exceptions or rejected promises, empty and null and zero and',
      'single-element cases, off-by-one bounds, partial writes left after an error,',
      'retries without a limit or without backoff, timeouts that leak a process, and',
      'error paths that report success.',
    ].join(' '),
  },
  {
    id: 'security',
    model: 'opengateway/z-ai/glm-5.3-flash-ultrafast:high',
    service: 'glm',
    ask: [
      'Focus: trust boundaries.',
      'Look for untrusted input reaching a shell, query, path or template, missing',
      'authorization or row-level-security checks on a new path, credentials or tokens',
      'written to logs or files, secrets committed, permissive defaults, and deletion or',
      'mutation endpoints that skip ownership checks.',
    ].join(' '),
  },
  {
    id: 'testgap',
    model: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast:high',
    service: 'deepseek',
    ask: [
      'Focus: is the change actually verified?',
      'Look for behavior changes with no test touching them, tests that assert nothing',
      'meaningful, mocks that replace the thing under test, skipped or conditionally',
      'skipped assertions, and tests whose name describes a different case than the body.',
    ].join(' '),
  },
  {
    id: 'regression',
    model: 'opengateway/z-ai/glm-5.3-flash-ultrafast:high',
    service: 'glm',
    ask: [
      'Focus: collateral damage in files that were not edited.',
      'Look for behavior that silently depends on what this diff changed, generated or',
      'vendored files now out of sync with their source, deleted helpers still imported',
      'by untouched modules, and docs or manifests that still describe the old shape.',
    ].join(' '),
  },
];

export const LENS_IDS = LENSES.map((lens) => lens.id);

export function selectLenses(ids) {
  if (!ids || ids.length === 0) return LENSES;
  const wanted = new Set(ids);
  const picked = LENSES.filter((lens) => wanted.has(lens.id));
  const missing = [...wanted].filter((id) => !LENS_IDS.includes(id));
  if (missing.length > 0) {
    throw new Error(`unknown lens: ${missing.join(', ')} (known: ${LENS_IDS.join(', ')})`);
  }
  return picked;
}

export function renderRules(rules) {
  if (!rules || rules.length === 0) return null;
  const blocks = rules.map(
    (doc) =>
      `--- ${doc.path}${doc.truncated ? ' (truncated)' : ''} ---\n${doc.text.trim()}`,
  );
  return [
    `REPOSITORY RULES — the reviewed repository's own instructions, taken from its AGENTS.md at the reviewed commit.`,
    `These are authoritative for this repository and they override your general habits.`,
    `A change that violates a rule written below is a finding.`,
    `A rule that is not written below does not exist: do not invent repository conventions.`,
    ``,
    blocks.join('\n\n'),
  ].join('\n');
}

export function buildPrompt({ repo, pr, lens }) {
  const rules = renderRules(pr.rules);
  return [
    `You are reviewing one merged pull request as an independent reviewer.`,
    `Report only defects that a maintainer would accept as needing a code change.`,
    ``,
    `REPOSITORY: jjongguet/${repo}`,
    `PR: #${pr.number} ${pr.title}`,
    `FILES CHANGED: ${pr.files.join(', ') || '(none reported)'}`,
    ``,
    lens.ask,
    ``,
    ...(rules ? [rules, ``] : []),
    `RULES`,
    `- Report only what the diff below shows. Do not speculate about code you cannot see.`,
    `- Every finding MUST include "quote": the exact added line(s), copied character for character from a line starting with "+".`,
    `- "line" MUST be the new-file line number of that quote, taken from the hunk header.`,
    `- If you cannot quote it, do not report it. A finding without a quote is discarded by a validator.`,
    `- At most 5 findings. Zero is a valid and preferred answer when nothing is clearly wrong.`,
    `- Do not report style, formatting, naming or "consider adding a comment".`,
    `- A rule violation must name the rule it breaks in "why_matters".`,
    ``,
    `DIFF (truncated if it ends with a truncation marker):`,
    pr.diff,
    ``,
    `Return JSON only, no prose and no code fence:`,
    `{"findings":[{"file":"path/to/file","line":123,"kind":"correctness","quote":"exact added line","why_matters":"one sentence","confidence":0.0}]}`,
  ].join('\n');
}
