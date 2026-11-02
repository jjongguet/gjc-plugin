import assert from 'node:assert/strict';
import test from 'node:test';

import { collectRules, nestedAgentsCandidates, RULES_BUDGET_BYTES } from '../lib/collect.mjs';
import { buildPrompt, renderRules } from '../lib/lenses.mjs';

const FILES = [
  'cluster/gpu/comfyui/queue/recipes.json',
  'scripts/check-arc-scope.py',
  'README.md',
];

test('nestedAgentsCandidates asks for the AGENTS.md nearest the changed files first', () => {
  const candidates = nestedAgentsCandidates(FILES);
  assert.deepEqual(candidates, [
    'cluster/gpu/comfyui/queue/AGENTS.md',
    'cluster/gpu/comfyui/AGENTS.md',
  ]);
});

test('nestedAgentsCandidates ignores top-level files and honours the limit', () => {
  assert.deepEqual(nestedAgentsCandidates(['README.md']), []);
  const many = nestedAgentsCandidates(FILES, { limit: 1 });
  assert.equal(many.length, 1);
});

test('collectRules puts the root AGENTS.md first and clips to the budget', async () => {
  const long = 'r'.repeat(9_000);
  const nested = 'n'.repeat(9_000);
  const seen = [];
  const docs = await collectRules({
    repo: 'infra',
    ref: 'abc123',
    files: FILES,
    budgetBytes: 10_000,
    fetcher: async ({ filePath }) => {
      seen.push(filePath);
      if (filePath === 'AGENTS.md') return long;
      if (filePath === 'cluster/gpu/comfyui/queue/AGENTS.md') return nested;
      return null;
    },
  });
  assert.equal(seen[0], 'AGENTS.md');
  assert.equal(docs[0].path, 'AGENTS.md');
  assert.equal(docs[0].text.length, 9_000);
  assert.equal(docs[1].path, 'cluster/gpu/comfyui/queue/AGENTS.md');
  assert.equal(docs[1].text.length, 1_000);
  assert.equal(docs[1].truncated, true);
  assert.equal(RULES_BUDGET_BYTES, 12_000);
});

test('collectRules returns nothing when the repository has no AGENTS.md', async () => {
  const docs = await collectRules({
    repo: 'infra',
    ref: 'abc123',
    files: FILES,
    fetcher: async () => null,
  });
  assert.deepEqual(docs, []);
});

test('collectRules stops asking once the budget is spent', async () => {
  const seen = [];
  await collectRules({
    repo: 'infra',
    ref: 'abc123',
    files: FILES,
    budgetBytes: 10,
    fetcher: async ({ filePath }) => {
      seen.push(filePath);
      return 'x'.repeat(50);
    },
  });
  assert.deepEqual(seen, ['AGENTS.md']);
});

test('renderRules states that unwritten rules do not exist', () => {
  const rendered = renderRules([{ path: 'AGENTS.md', text: 'do not force push', truncated: false }]);
  assert.match(rendered, /REPOSITORY RULES/);
  assert.match(rendered, /do not force push/);
  assert.match(rendered, /do not invent repository conventions/);
});

test('renderRules returns null without rules so the prompt stays clean', () => {
  assert.equal(renderRules([]), null);
  assert.equal(renderRules(undefined), null);
});

const PR = {
  number: 7,
  title: 'add a check',
  files: ['scripts/check.py'],
  diff: '@@ -1 +1,2 @@\n+x = 1\n+y = 2',
};

test('buildPrompt injects the repository rules above the diff', () => {
  const prompt = buildPrompt({
    repo: 'infra',
    pr: { ...PR, rules: [{ path: 'AGENTS.md', text: 'run bun run test before merging', truncated: false }] },
    lens: { id: 'contract', ask: 'Focus: contract breaks.' },
  });
  assert.match(prompt, /run bun run test before merging/);
  assert.ok(prompt.indexOf('run bun run test') < prompt.indexOf('DIFF'));
  assert.match(prompt, /A rule violation must name the rule it breaks/);
});

test('buildPrompt omits the rules section when a PR carries none', () => {
  const prompt = buildPrompt({
    repo: 'infra',
    pr: { ...PR, rules: [] },
    lens: { id: 'contract', ask: 'Focus: contract breaks.' },
  });
  assert.doesNotMatch(prompt, /REPOSITORY RULES/);
  assert.match(prompt, /Return JSON only/);
});
