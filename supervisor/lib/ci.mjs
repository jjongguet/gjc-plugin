// CI state per session HEAD, bounded and cached.
//
// `gh` is not installed on every workspace host, so this reads the public GitHub
// check-runs API directly. A missing remote, an offline host, a rate limit or a
// repository without checks all resolve to an explicit state — never to
// "success". Repeated HEADs reuse a short-lived on-disk cache so a 10 minute
// loop does not exhaust the unauthenticated quota.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 300;
const FAILING = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export function parseRepoSlug(remote) {
  if (!remote) return null;
  const match =
    /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote) ??
    /^https:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(remote) ??
    /^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (!match) return null;
  const host = match[1].toLowerCase();
  if (host !== "github.com") return null;
  const slug = match[2].replace(/\/+$/, "");
  return /^[^/]+\/[^/]+$/.test(slug) ? slug : null;
}

export function aggregateCheckRuns(payload) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  if (runs.length === 0) return { state: "unknown", detail: "no_checks", total: 0 };
  const failing = runs.filter(run => FAILING.has(run.conclusion));
  if (failing.length > 0) return { state: "failure", detail: failing.map(run => run.name).slice(0, 3).join(","), total: runs.length };
  const running = runs.filter(run => run.status !== "completed");
  if (running.length > 0) return { state: "pending", detail: `${running.length} running`, total: runs.length };
  const passing = runs.filter(run => run.conclusion === "success");
  if (passing.length === 0) return { state: "unknown", detail: "no_success", total: runs.length };
  return { state: "success", detail: `${passing.length}/${runs.length}`, total: runs.length };
}

/**
 * @param {object} options
 * @param {Function} [options.fetchImpl]
 * @param {string} options.cacheFile
 * @param {number} options.now
 * @param {number} [options.ttlMs]
 * @param {string} [options.token] GitHub token; omitted for public reads
 */
export async function createCiResolver({ fetchImpl = globalThis.fetch, cacheFile, now, ttlMs = DEFAULT_TTL_MS, token = process.env.GITHUB_TOKEN, maxLookups = 6 }) {
  let cache = {};
  try {
    cache = JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {
    cache = {};
  }
  let remaining = maxLookups;
  return {
    async resolve(session) {
      const slug = parseRepoSlug(session.remote);
      if (!slug) return { state: "unavailable", detail: "no_github_remote" };
      if (!session.sha) return { state: "unavailable", detail: "no_head" };
      const key = `${slug}@${session.sha}`;
      const cached = cache[key];
      if (cached && now - cached.at < ttlMs) return { ...cached.ci, cached: true };
      if (remaining <= 0) return { state: "deferred", detail: "lookup_cap" };
      remaining -= 1;
      const headers = { accept: "application/vnd.github+json", "user-agent": "gjc-supervisor" };
      if (token) headers.authorization = `Bearer ${token}`;
      const remember = ci => {
        cache[key] = { at: now, ci };
        return ci;
      };
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${slug}/commits/${session.sha}/check-runs`, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (response.status === 403 || response.status === 429) return remember({ state: "unavailable", detail: "rate_limited" });
        if (response.status === 404) return remember({ state: "unavailable", detail: "private_or_missing" });
        if (!response.ok) return remember({ state: "unavailable", detail: `http_${response.status}` });
        return remember({ ...aggregateCheckRuns(await response.json()), source: "github_check_runs" });
      } catch (error) {
        return { state: "unavailable", detail: `transport:${error.name}` };
      }
    },
    async flush() {
      const entries = Object.entries(cache)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, MAX_ENTRIES);
      await mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
      await writeFile(cacheFile, `${JSON.stringify(Object.fromEntries(entries))}\n`, { mode: 0o600 });
    },
  };
}
