// Collect merged pull requests and their diffs. This stage runs no model: it is
// the evidence bundle the reviewers are grounded on, and it is the only place
// that decides what "the last day of work" means.

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PR_FIELDS = [
  'number',
  'title',
  'url',
  'mergedAt',
  'additions',
  'deletions',
  'files',
  'headRefOid',
].join(',');

export const PR_FIELDS_QUERY = PR_FIELDS;

async function gh(args, { timeout = 120_000 } = {}) {
  const { stdout } = await run('gh', args, { timeout, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function listMergedPrs({ repo, since, limit = 100 }) {
  const raw = await gh([
    'pr',
    'list',
    '-R',
    `jjongguet/${repo}`,
    '--state',
    'merged',
    '--search',
    `merged:>=${since}`,
    '--limit',
    String(limit),
    '--json',
    PR_FIELDS,
  ]);
  return JSON.parse(raw || '[]');
}

// Repository rules travel with the review. Every repository in this workspace
// tells its reviewer what it must respect in its own AGENTS.md, so a review that
// ignores those files is judging the diff against someone else's conventions.
export const RULES_BUDGET_BYTES = 12_000;

export function nestedAgentsCandidates(files, { limit = 2 } = {}) {
  const dirs = new Set();
  for (const file of files) {
    let dir = path.posix.dirname(file);
    while (dir && dir !== '.' && dir !== '/') {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return [...dirs]
    .sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))
    .slice(0, limit)
    .map((dir) => `${dir}/AGENTS.md`);
}

export async function fetchFileAtRef({ repo, ref, filePath, timeout = 60_000 }) {
  try {
    const raw = await gh(
      ['api', '-H', 'Accept: application/vnd.github.raw', `/repos/jjongguet/${repo}/contents/${filePath}?ref=${ref}`],
      { timeout },
    );
    return raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

// Root AGENTS.md first (it owns the repository-wide contract), then the nearest
// AGENTS.md to the changed files, all inside one byte budget.
export async function collectRules({
  repo,
  ref,
  files,
  budgetBytes = RULES_BUDGET_BYTES,
  fetcher = fetchFileAtRef,
}) {
  const candidates = ['AGENTS.md', ...nestedAgentsCandidates(files)];
  const docs = [];
  let remaining = budgetBytes;
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    if (docs.some((doc) => doc.path === candidate)) continue;
    const text = await fetcher({ repo, ref, filePath: candidate });
    if (!text) continue;
    const clipped = text.slice(0, remaining);
    docs.push({ path: candidate, text: clipped, truncated: clipped.length < text.length });
    remaining -= clipped.length;
  }
  return docs;
}

export function truncateDiff(diff, maxBytes) {
  if (diff.length <= maxBytes) return { diff, truncated: false };
  const cut = diff.slice(0, maxBytes);
  // Keep the truncation marker on its own line so a reviewer cannot mistake a
  // half hunk for complete context.
  return {
    diff: `${cut}\n\n[diff truncated at ${maxBytes} bytes by nightly-review]\n`,
    truncated: true,
  };
}

export async function fetchDiff({ repo, number, maxDiffBytes }) {
  const raw = await gh(['pr', 'diff', String(number), '-R', `jjongguet/${repo}`]);
  return truncateDiff(raw, maxDiffBytes);
}

// Collect one repo into runDir/input/<repo>/.
export async function collectRepo({
  repo,
  since,
  runDir,
  maxDiffBytes,
  withRules = true,
  log = () => {},
}) {
  const prs = await listMergedPrs({ repo, since });
  const dir = path.join(runDir, 'input', repo);
  await mkdir(dir, { recursive: true });

  const collected = [];
  for (const pr of prs) {
    const { diff, truncated } = await fetchDiff({ repo, number: pr.number, maxDiffBytes });
    if (!diff.trim()) {
      log(`${repo}#${pr.number}: empty diff, skipped`);
      continue;
    }
    const files = (pr.files ?? []).map((file) => file.path);
    const rules = withRules
      ? await collectRules({ repo, ref: pr.headRefOid, files }).catch(() => [])
      : [];
    const entry = {
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      mergedAt: pr.mergedAt,
      additions: pr.additions,
      deletions: pr.deletions,
      headRefOid: pr.headRefOid,
      truncated,
      rules,
      files,
      diff,
    };
    await writeFile(
      path.join(dir, `pr-${pr.number}.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
      'utf8',
    );
    collected.push(entry);
    log(
      `${repo}#${pr.number}: ${files.length} files, ${diff.length} bytes${truncated ? ' (truncated)' : ''}, rules ${rules.map((doc) => `${doc.path}(${doc.text.length})`).join(',') || 'none'}`,
    );
  }

  return collected;
}
