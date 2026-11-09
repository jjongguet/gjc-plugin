// Linear transport for the filing step.
//
// Writes go through the policy CLI (`linear-trace.py call <tool> --publish`) so the
// credential, the allowlist and the 429 → Aside rule stay in one place. This module
// only builds arguments and parses results; it never reads the key itself.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LINEAR_CLI = path.join(
  process.env.HOME ?? '.',
  '.gjc',
  'agent',
  'policy',
  'bin',
  'linear-trace.py',
);

export const DEFAULT_PROJECT_MAP_PATH = path.join(HERE, '..', 'config', 'projects.json');

// Repository → representative Linear project. A repository with no line here is
// skipped and reported: the tool does not invent a project for it.
export async function loadProjectMap(mapPath = DEFAULT_PROJECT_MAP_PATH) {
  const raw = JSON.parse(await readFile(mapPath, 'utf8'));
  return raw.repos ?? {};
}

function run(command, args, exec) {
  return new Promise((resolve, reject) => {
    exec(command, args, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const tail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ');
        const hint = /429|rate limit/i.test(`${stderr}${stdout}`)
          ? ' (Linear rate limit — switch to linear-aside.py, rule://linear-work)'
          : '';
        reject(new Error(`${command} ${args[1] ?? ''} failed: ${tail || error.message}${hint}`));
        return;
      }
      const text = String(stdout ?? '').trim();
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error(`unparseable ${args[1] ?? ''} output: ${text.slice(0, 200)}`));
      }
    });
  });
}

export function createLinearClient({
  cli = process.env.NIGHTLY_LINEAR_CLI ?? DEFAULT_LINEAR_CLI,
  python = process.env.NIGHTLY_LINEAR_PYTHON ?? 'python3',
  projectMap = {},
  publish = false,
  exec = execFile,
} = {}) {
  const call = async (tool, args) => {
    const argv = [cli, 'call', tool, '--arguments', JSON.stringify(args)];
    if (publish) argv.push('--publish');
    return run(python, argv, exec);
  };

  return {
    projectFor(repo) {
      return projectMap[repo] ?? null;
    },
    async getIssue(id) {
      const out = await call('get_issue', { id });
      return out.issue ?? out;
    },
    async listIssues({ project, cursor, limit = 100 }) {
      return call('list_issues', { project, limit, ...(cursor ? { cursor } : {}) });
    },
    async listComments({ issueId, cursor, limit = 50 }) {
      return call('list_comments', { issueId, limit, ...(cursor ? { cursor } : {}) });
    },
    async listLabels() {
      return call('list_issue_labels', { team: 'Jjongguet', limit: 100 });
    },
    async updateIssue({ id, ...changes }) {
      if (!publish) throw new Error('write client not enabled');
      return call('save_issue', { id, ...changes });
    },
    async createIssue({ title, description, project, priority, labels, parentId }) {
      if (!publish) throw new Error('write client not enabled');
      const out = await call('save_issue', {
        title,
        description,
        team: 'Jjongguet',
        project,
        priority,
        ...(labels ? { labels } : {}),
        ...(parentId ? { parentId } : {}),
      });
      const issue = out.issue ?? out;
      return { id: issue.id, url: issue.url ?? null };
    },
    async createComment({ issueId, body }) {
      if (!publish) throw new Error('write client not enabled');
      const out = await call('save_comment', { issueId, body });
      return out.comment ?? out;
    },
  };
}
