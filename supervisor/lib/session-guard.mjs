// `session-guard <ticket> <repo>` — refuse to start a second session on a
// ticket that already has a live session in the same repository (JJO-895).
//
// Exit codes are the contract: 0 clear, 2 duplicate, 3 cannot verify (the tmux
// listing itself failed, so absence of a duplicate is not proven), 1 usage.
// The guard never starts or kills anything; it only reads collected state.
import process from "node:process";
import { collectSessions } from "./collect.mjs";
import {
  EXIT_CLEAR,
  EXIT_DUPLICATE,
  EXIT_UNVERIFIED,
  EXIT_USAGE,
  canonicalTicket,
  findDuplicateSessions,
  resolveRepoIdentity,
} from "./dedupe.mjs";
import { defaultRunner } from "./exec.mjs";

export const USAGE = `usage: session-guard <ticket> <repo> [--no-mini] [--json]

  <ticket>   Linear ticket id (JJO-895; jjo895 is accepted)
  <repo>     checkout path, owner/name, or repository name
  --no-mini  skip the mini host (MINI_HOST, default macmini)
  --json     machine-readable result on stdout

exit: 0 no live duplicate, 2 live duplicate, 3 verification unavailable, 1 usage`;

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = { ticketArg: null, repoArg: null, includeMini: true, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-mini") options.includeMini = false;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
    else if (options.ticketArg === null) options.ticketArg = arg;
    else if (options.repoArg === null) options.repoArg = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return options;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** Local wall clock with an explicit offset, e.g. `2026-10-27 04:35 +09:00`. */
export function localTimestamp(iso) {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "시작 시각 미상";
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )} ${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function ageText(minutes) {
  return Number.isFinite(minutes) ? `경과 ${minutes}분` : "경과 미상";
}

function describeSession(entry) {
  const branch = entry.branch ? `브랜치 ${entry.branch}` : "브랜치 미상";
  return `${entry.tmuxSession ?? entry.name ?? entry.id}  [${entry.target}]  시작 ${localTimestamp(entry.startedAt)}  ${ageText(
    entry.ageMinutes,
  )}  ${branch}  근거 ${entry.evidence.join(",")}`;
}

/**
 * @param {object} result
 * @returns {string}
 */
export function formatReport(result) {
  const target = `${result.ticket} / ${result.repo.key ?? result.repo.input}`;
  const lines = [];
  if (result.verdict === "duplicate") {
    lines.push(`session-guard: 차단 — ${target} 에 살아있는 세션이 ${result.live.length}개 있다`);
    for (const entry of result.live) lines.push(`  - ${describeSession(entry)}`);
    // lane-gjc addresses a session by its bare name (`lane-` prefix added back).
    const lane = result.live.find(entry => entry.target === "lane" && entry.name);
    const hint = lane ? ` (lane-gjc tail ${lane.name})` : "";
    lines.push(`  다음: 기존 세션을 끝낸 뒤 시작하거나 다른 티켓을 맡긴다${hint}`);
  } else if (result.verdict === "unverified") {
    lines.push(`session-guard: 확인 불가 — ${target} 의 tmux 목록을 읽지 못했다`);
    lines.push("  세션이 없다고 보장할 수 없으므로 시작하지 않는다. tmux 상태를 먼저 확인한다.");
  } else {
    const mini = result.includeMini ? `, 미니 ${result.miniHost} 포함` : ", 미니 제외";
    lines.push(`session-guard: 통과 — ${target} 에 살아있는 세션이 없다 (세션 ${result.checked}개 검사${mini})`);
  }
  for (const entry of result.dead) {
    lines.push(
      `  정리 후보(차단 아님): ${entry.tmuxSession ?? entry.name ?? entry.id} — ${
        entry.reason === "worktree_missing" ? "워크트리 없음" : "tmux 세션 없음"
      } · ${entry.worktree ?? "경로 미상"}`,
    );
  }
  for (const entry of result.unresolved) {
    lines.push(`  레포 미확인(차단 아님): ${entry.tmuxSession ?? entry.name ?? entry.id} — origin remote 없음`);
  }
  for (const error of result.errors) {
    const label = error.target === "mini" ? `미니 ${result.miniHost}` : "lane";
    lines.push(`  ${label} 수집 오류: ${error.error}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {string[]} argv
 * @param {{runner?: Function, now?: number, stdout?: (text: string) => void, stderr?: (text: string) => void, env?: Record<string, string|undefined>}} [options]
 * @returns {Promise<number>} exit code
 */
export async function main(
  argv,
  {
    runner = defaultRunner,
    now = Date.now(),
    stdout = text => process.stdout.write(text),
    stderr = text => process.stderr.write(text),
    env = process.env,
  } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`session-guard: ${error.message}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    stdout(`${USAGE}\n`);
    return EXIT_CLEAR;
  }
  if (options.ticketArg === null || options.repoArg === null) {
    stderr(`${USAGE}\n`);
    return EXIT_USAGE;
  }

  const ticket = canonicalTicket(options.ticketArg);
  if (!ticket) {
    stderr(`session-guard: 티켓 형식이 아니다: ${options.ticketArg} (예: JJO-895)\n`);
    return EXIT_USAGE;
  }
  const repo = await resolveRepoIdentity(options.repoArg, { runner });
  if (!repo || repo.error) {
    stderr(`session-guard: 레포를 해석할 수 없다: ${options.repoArg}${repo?.error ? ` (${repo.error})` : ""}\n`);
    return EXIT_USAGE;
  }

  const miniHost = env.MINI_HOST ?? "macmini";
  const { sessions, errors } = await collectSessions({ runner, now, includeMini: options.includeMini, miniHost });
  const { live, dead, unresolved } = findDuplicateSessions(sessions, { ticket, repoKey: repo.key });
  const laneError = errors.find(error => error.target === "lane");
  const verdict = live.length > 0 ? "duplicate" : laneError ? "unverified" : "clear";
  const result = {
    ticket,
    repo,
    verdict,
    checked: sessions.length,
    includeMini: options.includeMini,
    miniHost,
    live,
    dead,
    unresolved,
    errors,
  };

  if (options.json) stdout(`${JSON.stringify(result, null, 2)}\n`);
  else stdout(formatReport(result));

  if (verdict === "duplicate") return EXIT_DUPLICATE;
  if (verdict === "unverified") return EXIT_UNVERIFIED;
  return EXIT_CLEAR;
}
