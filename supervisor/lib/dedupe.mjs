// Same-ticket duplicate session guard.
//
// Two sessions on one ticket in one repository edit the same files and produce
// conflicting commits (2026-10-27: six sessions on one mini checkout).
// `lane-gjc run` refuses a duplicate *name* only, so this answers the different
// question from live tmux state: is a session that belongs to this ticket and
// this repository still running?
//
// Liveness comes from the tmux listing collected in collect.mjs; a handoff file
// or a branch alone never proves a session exists. A session is tied to a ticket
// only by strings the session itself carries (session name, branch, worktree
// path) and to a repository only by its git origin remote. Everything that
// cannot be resolved is returned as data instead of guessed.
import { existsSync } from "node:fs";
import path from "node:path";
import { defaultRunner } from "./exec.mjs";

export const EXIT_CLEAR = 0;
export const EXIT_USAGE = 1;
export const EXIT_DUPLICATE = 2;
export const EXIT_UNVERIFIED = 3;

// `JJO-895`, `jjo895`, `JJO_895`, and letter-suffixed ids like `JJO-870b`.
const TICKET_INPUT = /^([A-Za-z][A-Za-z0-9]*?)[-_ ]?(\d+[A-Za-z]?)$/;
const REPO_LABEL = /^[\w.-]+\/[\w.-]+$/;
const PATH_LIKE = /^(?:~|\/|\.{1,2}\/)/;
// Fields a session carries that can name its ticket.
export const TICKET_FIELDS = ["name", "tmuxSession", "branch", "worktree"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Canonical ticket form (`JJO-895`), or null when the input is not a ticket id.
 * @param {unknown} input
 * @returns {string|null}
 */
export function canonicalTicket(input) {
  if (typeof input !== "string") return null;
  const match = TICKET_INPUT.exec(input.trim());
  if (!match) return null;
  return `${match[1].toUpperCase()}-${match[2].toUpperCase()}`;
}

/**
 * Case-insensitive matcher for a ticket inside free text. Word boundaries keep
 * `JJO-895` from matching `JJO-8950`; the separator is optional so `jjo895`
 * (branch style) matches too.
 * @param {string} ticket
 * @returns {RegExp|null}
 */
export function ticketPattern(ticket) {
  const canonical = canonicalTicket(ticket);
  if (!canonical) return null;
  const [letters, tail] = canonical.split("-");
  const parts = /^(\d+)([A-Z]?)$/.exec(tail);
  if (!parts) return null;
  const suffix = parts[2] ? `(?:${parts[2]})?` : "";
  return new RegExp(`\\b${escapeRegExp(letters)}[-_ ]?${parts[1]}${suffix}\\b`, "i");
}

/**
 * @param {unknown} text
 * @param {string} ticket
 * @returns {boolean}
 */
export function mentionsTicket(text, ticket) {
  if (typeof text !== "string" || text === "") return false;
  const pattern = ticketPattern(ticket);
  return pattern ? pattern.test(text) : false;
}

/**
 * `owner/name` from an origin URL, lowercased. Handles https, ssh:// and
 * scp-style `git@host:owner/name`.
 * @param {unknown} remote
 * @returns {string|null}
 */
export function normalizeRemote(remote) {
  if (typeof remote !== "string") return null;
  let value = remote.trim();
  if (value === "") return null;
  value = value.replace(/\/+$/, "").replace(/\.git$/, "");
  value = value.replace(/^[a-z+]+:\/\//i, "");
  value = value.replace(/^[^@/]+@/, "");
  value = value.replace(":", "/");
  const segments = value.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.length === 1) return segments[0].toLowerCase();
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`.toLowerCase();
}

/**
 * Repository key of a collected session, or null when its origin remote is
 * unknown. The worktree basename is not used: a lane worktree is named
 * `<repo>-<ticket>-<date>`, so its basename is not a repository.
 * @param {{remote?: string|null}} session
 * @returns {string|null}
 */
export function repoKeyOf(session) {
  return normalizeRemote(session?.remote);
}

/**
 * @param {string|null} sessionKey
 * @param {string|null} targetKey
 * @returns {boolean}
 */
export function repoMatches(sessionKey, targetKey) {
  if (!sessionKey || !targetKey) return false;
  if (sessionKey === targetKey) return true;
  const hasOwner = key => key.includes("/");
  if (hasOwner(sessionKey) && hasOwner(targetKey)) return false;
  const name = key => key.slice(key.lastIndexOf("/") + 1);
  return name(sessionKey) === name(targetKey);
}

/**
 * Resolve the repository argument — an existing checkout path, `owner/name`, or
 * a bare repository name — into a repository key.
 * @param {string} input
 * @param {{runner?: Function}} [options]
 * @returns {Promise<{input: string, key: string|null, name: string|null, source: string, error?: string}|null>}
 */
export async function resolveRepoIdentity(input, { runner = defaultRunner } = {}) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw === "") return null;
  if (existsSync(raw)) {
    const result = await runner("git", ["-C", raw, "config", "--get", "remote.origin.url"]);
    const key = result.ok ? normalizeRemote(result.stdout) : null;
    const name = path.basename(path.resolve(raw));
    return { input: raw, key: key ?? name.toLowerCase(), name, source: key ? "remote" : "path" };
  }
  if (PATH_LIKE.test(raw)) return { input: raw, key: null, name: null, source: "path", error: "repo_path_missing" };
  const key = normalizeRemote(raw);
  if (!key) return null;
  return { input: raw, key, name: key.slice(key.lastIndexOf("/") + 1), source: REPO_LABEL.test(raw) ? "remote" : "label" };
}

/**
 * @param {object} session
 * @param {string} ticket
 * @returns {string[]} the session fields that name the ticket
 */
export function ticketEvidence(session, ticket) {
  return TICKET_FIELDS.filter(field => mentionsTicket(session[field], ticket));
}

function deadReason(session) {
  if (session.worktreePresent === false) return "worktree_missing";
  return "tmux_session_gone";
}

/**
 * Split the sessions that name this ticket into blocking live duplicates,
 * non-blocking leftovers, and sessions whose repository cannot be resolved.
 * @param {object[]} sessions
 * @param {{ticket: string, repoKey: string|null}} target
 */
export function findDuplicateSessions(sessions, { ticket, repoKey }) {
  const live = [];
  const dead = [];
  const unresolved = [];
  for (const session of sessions) {
    const evidence = ticketEvidence(session, ticket);
    if (evidence.length === 0) continue;
    const repo = repoKeyOf(session);
    const alive = session.tmuxAlive === true && session.worktreePresent !== false;
    const entry = {
      id: session.id,
      target: session.target,
      name: session.name ?? null,
      tmuxSession: session.tmuxSession ?? null,
      startedAt: session.startedAt ?? null,
      ageMinutes: session.ageMinutes ?? null,
      branch: session.branch ?? null,
      worktree: session.worktree ?? null,
      repo,
      evidence,
      state: alive ? "live" : "dead",
      reason: alive ? null : deadReason(session),
    };
    if (!repo) {
      unresolved.push(entry);
      continue;
    }
    if (!repoMatches(repo, repoKey)) continue;
    (alive ? live : dead).push(entry);
  }
  return { live, dead, unresolved };
}
