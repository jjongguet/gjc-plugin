// Linear transport for the filing step.
//
// The default CLI is bin/linear-transport.py: reads use one GraphQL request each
// (a complete inventory through per-process MCP sessions exceeded the shared
// 2,500/hour quota), and writes are delegated unchanged to the policy CLI
// (`linear-trace.py call <tool> --publish`), which owns write auditing and the
// 429 → Aside rule. This module only builds arguments and parses results; it
// never reads the key itself.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LINEAR_CLI = path.join(HERE, '..', 'bin', 'linear-transport.py');
const WRITE_TOOLS = new Set(['save_issue', 'save_comment']);

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
    // The transport refuses --publish on reads; only writes carry the gate.
    if (publish && WRITE_TOOLS.has(tool)) argv.push('--publish');
    return run(python, argv, exec);
  };

  return {
    projectFor(repo) {
      return projectMap[repo] ?? null;
    },
    async getIssue(id) {
      const out = await call('get_issue', { id, includeRelations: true, fields: ['id', 'uuid', 'title', 'description', 'priority', 'url', 'createdAt', 'updatedAt', 'archivedAt', 'triagedAt', 'status', 'statusType', 'labels', 'assignee', 'assigneeId', 'delegate', 'delegateId', 'project', 'projectId', 'parentId', 'relations'] });
      const issue = out.issue ?? out;
      return { ...issue, id: issue.uuid ?? issue.id, identifier: issue.identifier ?? issue.id };
    },
    async listIssues({ project, cursor, limit = 100 }) {
      return call('list_issues', { project, limit, includeArchived: true, ...(cursor ? { cursor } : {}) });
    },
    async listComments({ issueId, cursor, limit = 50 }) {
      return call('list_comments', { issueId, limit, ...(cursor ? { cursor } : {}) });
    },
    async listLabels() {
      return call('list_issue_labels', { team: 'Jjongguet', name: 'nightly', limit: 100 });
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
