// Turn gated findings into actionable Linear issues.
//
// The gate decides what is evidence; this module decides what deserves a ticket.
// One issue per (repo, file, kind): a fix lands on a file, so a new finding in the
// same file is more evidence for the open ticket instead of a second ticket. The
// local state file is the dedupe source of truth — re-running a night, or re-running
// the file step twice, must not create a second issue for the same problem.

import { createHash } from 'node:crypto';

export const DEFAULT_MAX_ISSUES = 8;

// Confidence is the reviewer's own claim, so it orders the queue rather than
// deciding whether to file at all: the gate already decided that part.
export function priorityFor(confidence) {
  const value = Number(confidence ?? 0);
  if (value >= 0.85) return 2;
  if (value >= 0.7) return 3;
  return 4;
}

export function clusterKey(finding) {
  return `${finding.repo}::${finding.file}::${finding.kind}`;
}

export function evidenceHash(finding) {
  return createHash('sha256')
    .update(`${finding.file}\n${finding.line}\n${finding.quote}\n`)
    .digest('hex')
    .slice(0, 16);
}

export function clusterFindings(findings) {
  const clusters = new Map();
  for (const finding of findings ?? []) {
    if (!finding?.repo || !finding?.file) continue;
    const key = clusterKey(finding);
    const cluster = clusters.get(key) ?? {
      key,
      repo: finding.repo,
      file: finding.file,
      kind: finding.kind ?? 'unknown',
      findings: [],
      confidence: 0,
    };
    cluster.findings.push(finding);
    cluster.confidence = Math.max(cluster.confidence, Number(finding.confidence ?? 0) || 0);
    clusters.set(key, cluster);
  }
  const ordered = [...clusters.values()].sort(
    (a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key),
  );
  return ordered;
}

// Linear autolinks issue identifiers in stored markdown, including inside HTML
// comments, so the readable `nightly-review:<key>` marker is not stable for keys
// containing one (observed 2026-11-09). The hex marker is; legacy issues carry
// only the readable one, so matching accepts either.
export const clusterMarker = (key) => `<!-- nightly-review:${key} -->`;
export const clusterKeyMarker = (key) => `<!-- nightly-review-key:${createHash('sha256').update(key).digest('hex')} -->`;
export const hasClusterMarker = (text, key) => (text ?? '').includes(clusterMarker(key)) || (text ?? '').includes(clusterKeyMarker(key));

export function issueTitle(cluster) {
  return `[nightly] ${cluster.repo} ${cluster.file} — ${cluster.kind}`;
}

function findingBlock(finding) {
  const lines = [];
  lines.push(`\`${finding.file}:${finding.line}\``);
  lines.push('');
  lines.push('```');
  lines.push(String(finding.quote ?? ''));
  lines.push('```');
  lines.push('');
  if (finding.why_matters) {
    lines.push(finding.why_matters);
    lines.push('');
  }
  lines.push(
    `- PR: ${finding.prUrl ?? `jjongguet/${finding.repo}#${finding.pr}`} · lens ${finding.lens ?? '?'} · ` +
      `confidence ${finding.confidence ?? 0}`,
  );
  return lines.join('\n');
}

export function renderIssueBody({ cluster, runId }) {
  const lines = [];
  lines.push(`야간 코드리뷰 게이트를 통과한 finding ${cluster.findings.length}건이 이 파일에 있습니다.`);
  lines.push('');
  lines.push('## 무엇을 하나');
  lines.push('');
  lines.push(`- \`${cluster.file}\` 의 인용 코드가 실제 결함인지 확인한다.`);
  lines.push('- 맞으면 최소 수정과 회귀 테스트를 넣고, 아니면 반증 근거를 남기고 이 이슈를 닫는다.');
  lines.push('- 이미 고쳐진 상태면 Done으로 닫고 어떤 커밋/PR이 고쳤는지 적는다.');
  lines.push('');
  lines.push('## 근거');
  lines.push('');
  for (const finding of cluster.findings) {
    lines.push(findingBlock(finding));
    lines.push('');
  }
  lines.push('## 경계');
  lines.push('');
  lines.push('- 이 이슈는 인용이 머지 diff에 존재함을 게이트가 확인한 **증거**이며, 결함 판정이나 수정 승인이 아니다.');
  lines.push('- 이슈 생성은 실행 승인이 아니다(`rule://linear-work`). 착수는 별도 판단이다.');
  lines.push('');
  lines.push('## 추적');
  lines.push('');
  lines.push(`- nightly-review key: \`${cluster.key}\``);
  lines.push(`- run: \`${runId}\` (local-only; \`nightly-review recheck --run <dir>\`로 재게이트)`);
  lines.push(clusterMarker(cluster.key));
  lines.push(clusterKeyMarker(cluster.key));
  return lines.join('\n');
}

export function renderEvidenceComment({ cluster, findings, runId }) {
  const lines = [];
  lines.push(`## 추가 증거 (${runId})`);
  lines.push('');
  for (const finding of findings) {
    lines.push(findingBlock(finding));
    lines.push('');
  }
  lines.push(`<!-- nightly-review-evidence:${cluster.key}:${findings.map(evidenceHash).sort().join(',')} -->`);
  return lines.join('\n');
}

// Decide create / comment / skip per cluster without touching the network.
// `state` is the persisted map of previously filed clusters. The cap is a reading
// budget for the ticket queue, so clusters past it are reported, not silently cut.
export function planFiling({ clusters, state, maxIssues = DEFAULT_MAX_ISSUES }) {
  const actions = [];
  const known = state?.clusters ?? {};
  for (const [index, cluster] of clusters.entries()) {
    if (index >= maxIssues) {
      actions.push({ type: 'skip', cluster, reason: 'over_issue_cap' });
      continue;
    }
    const entry = known[cluster.key];
    if (!entry?.issue) {
      actions.push({ type: 'create', cluster, findings: cluster.findings });
      continue;
    }
    const seen = new Set(entry.evidence ?? []);
    const fresh = cluster.findings.filter((finding) => !seen.has(evidenceHash(finding)));
    if (fresh.length === 0) {
      actions.push({ type: 'skip', cluster, reason: 'up_to_date', issue: entry.issue });
      continue;
    }
    actions.push({ type: 'comment', cluster, findings: fresh, issue: entry.issue });
  }
  return actions;
}

export function summarizeFiling(result) {
  return (
    `filed ${result.created.length}, commented ${result.commented.length}, ` +
    `skipped ${result.skipped.length}, failed ${result.errors.length}`
  );
}
