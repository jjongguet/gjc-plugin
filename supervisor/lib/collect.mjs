// Session collection for the two workspace targets.
//
// Lane sessions are local tmux sessions started by lane-gjc (`lane-<name>`); the
// pane's working directory is the lane worktree, which is the authoritative
// worktree pointer. Mini sessions are non-integration-branch checkouts under
// ~/jjongguet and its lane worktrees on the mini host, read over one bounded ssh
// call. Lane worktrees matter: a mini session created by `mini-gjc run --lane`
// works inside ~/jjongguet/lanes/<repo>-<name>-<date>, so scanning only the top
// level reports the lane as missing and masks a stalled session (JJO-913).
//
// Every failure is returned as data: a missing worktree, unreachable host or
// failing git command must not abort the run.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { defaultRunner } from "./exec.mjs";

export const LANE_PREFIX = "lane-";
const MINUTE = 60_000;
const TMUX_FIELDS = ["#{session_name}", "#{session_created}", "#{pane_current_path}", "#{pane_current_command}"];
const TMUX_FORMAT = TMUX_FIELDS.join("\t");
const MAX_ACTIVITY_STAT = 200;

export function parseTmuxRow(line) {
  const [name, created, panePath, paneCommand] = line.split("\t");
  if (!name) return null;
  const createdSeconds = Number(created);
  return {
    name,
    createdMs: Number.isFinite(createdSeconds) && createdSeconds > 0 ? createdSeconds * 1000 : null,
    panePath: panePath && panePath !== "" ? panePath : null,
    paneCommand: paneCommand && paneCommand !== "" ? paneCommand : null,
  };
}

function gitArgs(worktree, args) {
  return ["-C", worktree, ...args];
}

function countPorcelainEntries(stdout) {
  if (!stdout) return 0;
  return stdout.split("\0").filter(entry => entry.length > 0).length;
}

function porcelainPaths(stdout) {
  return stdout
    .split("\0")
    .filter(entry => entry.length > 3)
    .map(entry => entry.slice(3));
}

function newestActivity(worktree, rawStatus, fallbackIso) {
  let newest = fallbackIso ? Date.parse(fallbackIso) : NaN;
  for (const relative of porcelainPaths(rawStatus).slice(0, MAX_ACTIVITY_STAT)) {
    try {
      const stat = statSync(path.join(worktree, relative));
      if (Number.isFinite(stat.mtimeMs) && (!Number.isFinite(newest) || stat.mtimeMs > newest)) newest = stat.mtimeMs;
    } catch {
      // Deleted or renamed-away paths are expected in a dirty tree.
    }
  }
  return Number.isFinite(newest) ? new Date(newest).toISOString() : null;
}

async function gitFact(runner, worktree, args, errors, label) {
  const result = await runner("git", gitArgs(worktree, args));
  if (!result.ok) {
    errors.push(`${label}:${result.error ?? `exit_${result.code}`}`);
    return null;
  }
  return result.stdout;
}

/**
 * @param {object} context
 * @param {Function} [context.runner]
 * @param {number} [context.now]
 * @param {boolean} [context.includeMini]
 * @param {string} [context.miniHost]
 * @returns {Promise<{sessions: object[], errors: object[]}>}
 */
export async function collectSessions({
  runner = defaultRunner,
  now = Date.now(),
  includeMini = true,
  miniHost = process.env.MINI_HOST ?? "macmini",
} = {}) {
  const errors = [];
  const sessions = [];
  sessions.push(...(await collectLaneSessions({ runner, now, errors })));
  if (includeMini) sessions.push(...(await collectMiniSessions({ runner, now, host: miniHost, errors })));
  return { sessions, errors };
}

async function collectLaneSessions({ runner, now, errors }) {
  const listing = await runner("tmux", ["ls", "-F", TMUX_FORMAT]);
  if (!listing.ok) {
    const detail = (listing.stderr ?? "").split("\n").filter(Boolean)[0] ?? "";
    const code = listing.code !== null ? `tmux_exit_${listing.code}` : (listing.error ?? "tmux_failed");
    errors.push({ target: "lane", error: detail ? `${code}: ${detail.slice(0, 80)}` : code });
    return [];
  }
  const rows = listing.stdout
    .split("\n")
    .filter(line => line.trim() !== "")
    .map(parseTmuxRow)
    .filter(row => row && row.name.startsWith(LANE_PREFIX));
  const sessions = [];
  for (const row of rows) sessions.push(await laneSessionFacts({ row, runner, now }));
  return sessions;
}

async function laneSessionFacts({ row, runner, now }) {
  const name = row.name.slice(LANE_PREFIX.length);
  const sessionErrors = [];
  const base = {
    id: `${"lane"}:${name}`,
    target: "lane",
    name,
    tmuxSession: row.name,
    tmuxAlive: true,
    paneCommand: row.paneCommand,
    worktree: row.panePath,
    worktreePresent: false,
    branch: null,
    sha: null,
    remote: null,
    ageMinutes: row.createdMs ? Math.max(0, Math.floor((now - row.createdMs) / MINUTE)) : null,
    startedAt: row.createdMs ? new Date(row.createdMs).toISOString() : null,
    commitsSinceStart: null,
    commitsLastWindow: null,
    dirty: null,
    lastCommit: null,
    lastActivityAt: null,
    paneDigest: null,
    ci: null,
    errors: sessionErrors,
  };

  const worktree = row.panePath;
  if (!worktree || !path.isAbsolute(worktree) || !existsSync(worktree) || !existsSync(path.join(worktree, ".git"))) {
    sessionErrors.push("worktree_missing");
    return base;
  }
  base.worktreePresent = true;

  const branch = await gitFact(runner, worktree, ["rev-parse", "--abbrev-ref", "HEAD"], sessionErrors, "branch");
  base.branch = branch ? branch.trim() : null;
  const sha = await gitFact(runner, worktree, ["rev-parse", "HEAD"], sessionErrors, "head");
  base.sha = sha ? sha.trim() : null;
  const remote = await gitFact(runner, worktree, ["config", "--get", "remote.origin.url"], sessionErrors, "remote");
  base.remote = remote ? remote.trim() : null;

  const rawStatus = await gitFact(runner, worktree, ["status", "--porcelain", "-z"], sessionErrors, "status");
  if (rawStatus !== null) base.dirty = countPorcelainEntries(rawStatus);

  const lastLog = await gitFact(runner, worktree, ["log", "-1", "--format=%cI%n%s"], sessionErrors, "last_commit");
  if (lastLog) {
    const [at, subject] = lastLog.replace(/\n$/, "").split("\n");
    if (at) base.lastCommit = { at, subject: subject ?? "" };
  }

  if (row.createdMs) {
    const since = ["--since", `@${Math.floor(row.createdMs / 1000)}`];
    const sinceStart = await gitFact(runner, worktree, ["log", ...since, "--format=%H"], sessionErrors, "commits_since_start");
    if (sinceStart !== null) base.commitsSinceStart = sinceStart.split("\n").filter(Boolean).length;
  }
  const windowSince = ["--since", `@${Math.floor((now - 10 * MINUTE) / 1000)}`];
  const windowCommits = await gitFact(runner, worktree, ["log", ...windowSince, "--format=%H"], sessionErrors, "commits_window");
  if (windowCommits !== null) base.commitsLastWindow = windowCommits.split("\n").filter(Boolean).length;

  base.lastActivityAt = newestActivity(worktree, rawStatus ?? "", base.lastCommit?.at ?? null);

  const pane = await runner("tmux", ["capture-pane", "-p", "-t", row.name]);
  if (pane.ok) base.paneDigest = createHash("sha256").update(pane.stdout).digest("hex").slice(0, 16);
  else sessionErrors.push(`pane_capture:${pane.error ?? `exit_${pane.code}`}`);

  return base;
}

// One ssh round trip. The remote script prints tab-separated records so a
// partially failed checkout still yields the other rows.
const MINI_SCRIPT = `
set -u
origin="$HOME/jjongguet"
printf 'origin\\t%s\\n' "$origin"
now=$(date +%s)
tmux_rows=$(tmux ls -F '#{session_name}|#{session_created}|#{pane_current_path}' 2>/dev/null)
printf '%s\\n' "$tmux_rows" | while IFS='|' read -r n c p; do
  [ -n "\${n:-}" ] || continue
  printf 'tmux\\t%s\\t%s\\t%s\\n' "$n" "$c" "$p"
done
for d in "$origin"/*/ "$origin"/lanes/*/; do
  # 워크트리의 .git 은 디렉터리가 아니라 파일이라 -d 로 검사하면 레인이 전부 빠진다.
  [ -e "$d/.git" ] || continue
  case "$d" in "$origin"/lanes/*)
    lane_remote=$(git -C "$d" config --get remote.origin.url 2>/dev/null)
    lane_repo=$(printf '%s' "$lane_remote" | sed -E 's#.*/([^/]+?)(\\.git)?$#\\1#')
    repo="\${lane_repo:-$(basename "$d")}"
    ;;
  *) repo=$(basename "$d") ;;
  esac
  branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null) || continue
  case "$branch" in main|master|dev) continue;; esac
  session_path="\${d%/}"
  created=$(printf '%s\\n' "$tmux_rows" | awk -F'|' -v p="$session_path" '$3==p {print $2; exit}')
  window=$(git -C "$d" log --since "@$((now - 600))" --format=%H 2>/dev/null | wc -l | tr -d ' ')
  if [ -n "\${created:-}" ]; then
    since_start=$(git -C "$d" log --since "@$created" --format=%H 2>/dev/null | wc -l | tr -d ' ')
  else
    since_start=""
  fi
  # 살아 있는 tmux 세션이 없는 최상위 체크아웃은 세션이 아니라 남은 브랜치다.
  # (미니 최상위 레포에 남은 feature 브랜치를 세션으로 세면 정체로 잘못 보고된다.)
  case "$d" in "$origin"/lanes/*) ;; *) [ -n "\${created:-}" ] || continue ;; esac
  dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  last_at=$(git -C "$d" log -1 --format=%cI 2>/dev/null)
  last_subject=$(git -C "$d" log -1 --format=%s 2>/dev/null)
  head=$(git -C "$d" rev-parse HEAD 2>/dev/null)
  remote=$(git -C "$d" config --get remote.origin.url 2>/dev/null)
  printf 'repo\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$repo" "$branch" "$window" "$dirty" "$last_at" "$last_subject" "$head" "$remote" "$since_start" "\${created:-}"
done
`;

export function parseMiniRecords(stdout) {
  const rows = { origin: null, repos: [], tmux: [] };
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    if (fields[0] === "origin" && fields[1]) rows.origin = fields[1];
    else if (fields[0] === "repo" && fields[1] && fields.length >= 6 && fields[2]) {
      rows.repos.push({
        repo: fields[1],
        branch: fields[2] || null,
        commitsLastWindow: Number(fields[3] ?? "") || 0,
        dirty: Number(fields[4] ?? "") || 0,
        lastCommitAt: fields[5] || null,
        lastCommitSubject: fields[6] || "",
        sha: fields[7] || null,
        remote: fields[8] || null,
        commitsSinceStart: (fields[9] ?? "") === "" ? null : Number(fields[9]),
        createdSeconds: Number(fields[10] ?? "") || null,
      });
    } else if (fields[0] === "tmux" && fields[1]) {
      const created = Number(fields[2]);
      rows.tmux.push({
        name: fields[1],
        createdMs: Number.isFinite(created) && created > 0 ? created * 1000 : null,
        panePath: fields[3] || null,
      });
    }
  }
  return rows;
}

async function collectMiniSessions({ runner, now, host, errors }) {
  const remote = await runner("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, MINI_SCRIPT], { timeoutMs: 30000 });
  if (!remote.ok) {
    errors.push({ target: "mini", error: remote.code !== null ? `ssh_exit_${remote.code}` : (remote.error ?? "ssh_failed") });
    return [];
  }
  const parsed = parseMiniRecords(remote.stdout);
  if (!parsed.origin) {
    errors.push({ target: "mini", error: "origin_unresolved" });
    return [];
  }
  return parsed.repos.map(entry => {
    const worktree = path.posix.join(parsed.origin, entry.repo);
    const tmux = parsed.tmux.find(row => row.panePath === worktree || row.panePath === `${worktree}/`);
    const createdMs = entry.createdSeconds ? entry.createdSeconds * 1000 : (tmux?.createdMs ?? null);
    const sessionErrors = [];
    return {
      id: `mini:${entry.repo}`,
      target: "mini",
      name: entry.repo,
      tmuxSession: tmux?.name ?? null,
      tmuxAlive: createdMs ? true : null,
      paneCommand: null,
      worktree,
      worktreePresent: true,
      branch: entry.branch,
      sha: entry.sha,
      remote: entry.remote,
      ageMinutes: createdMs ? Math.max(0, Math.floor((now - createdMs) / MINUTE)) : null,
      startedAt: createdMs ? new Date(createdMs).toISOString() : null,
      commitsSinceStart: entry.commitsSinceStart,
      commitsLastWindow: entry.commitsLastWindow,
      dirty: entry.dirty,
      lastCommit: entry.lastCommitAt ? { at: entry.lastCommitAt, subject: entry.lastCommitSubject } : null,
      lastActivityAt: entry.lastCommitAt,
      paneDigest: null,
      ci: null,
      errors: sessionErrors,
    };
  });
}
