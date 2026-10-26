// Interventions: a tmux nudge into exactly one session, and the Discord summary.
//
// Boundaries that are structural, not advisory:
//  - a steer target must be a single concrete `lane-<name>` session; there is no
//    "all sessions" form and no kill path in this module;
//  - dry-run never runs tmux or the webhook;
//  - the webhook URL is read from DISCORD_REPORT_WEBHOOK_URL and must be a
//    Discord webhook URL, so a stray value cannot post anywhere else.
import { defaultRunner } from "./exec.mjs";

const TARGET_PATTERN = /^lane-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);
const DISCORD_CONTENT_LIMIT = 1900;

export function isSteerTarget(value) {
  return typeof value === "string" && TARGET_PATTERN.test(value);
}

export function formatSteerMessage({ session, judgment, marker }) {
  const facts = [
    `${session.name} 감지: ${judgment.state} (${judgment.reasons.join(", ")})`,
    `경과 ${session.ageMinutes ?? "?"}분 · 커밋 ${session.commitsSinceStart ?? "?"} · dirty ${session.dirty ?? "?"}`,
  ].join(" / ");
  return (
    `[supervisor ${marker}] ${facts}. ` +
    "정체 해소를 위해 지금 상태 3줄 보고와 함께 첫 커밋(wip 허용)을 남겨줘. " +
    "막는 것이 있으면 한 줄로 알려줘. 세션은 종료하지 않는다."
  );
}

/**
 * @returns {Promise<{mode: "dry-run"|"real", target: string, delivered: boolean, verified: boolean, marker: string, command: string[], error: string|null}>}
 */
export async function steerSession({ target, message, marker, dryRun = true, runner = defaultRunner, settleMs = 1500 }) {
  const command = ["tmux", "send-keys", "-t", target, "-l", message];
  const base = { mode: dryRun ? "dry-run" : "real", target, delivered: false, verified: false, marker, command, error: null };
  if (!isSteerTarget(target)) return { ...base, error: "invalid_target" };
  if (dryRun) return base;

  const literal = await runner("tmux", ["send-keys", "-t", target, "-l", message]);
  if (!literal.ok) return { ...base, error: `send_keys:${literal.error ?? `exit_${literal.code}`}` };
  const enter = await runner("tmux", ["send-keys", "-t", target, "Enter"]);
  if (!enter.ok) return { ...base, delivered: true, error: `enter:${enter.error ?? `exit_${enter.code}`}` };
  await new Promise(resolve => setTimeout(resolve, settleMs));
  const pane = await runner("tmux", ["capture-pane", "-p", "-t", target]);
  const verified = pane.ok && pane.stdout.includes(marker);
  return { ...base, delivered: true, verified, error: verified ? null : "marker_not_observed" };
}

export function validateWebhookUrl(value) {
  if (!value) return "missing";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "malformed";
  }
  if (url.protocol !== "https:") return "not_https";
  if (!WEBHOOK_HOSTS.has(url.hostname)) return "host_not_discord";
  if (!url.pathname.startsWith("/api/webhooks/")) return "path_not_webhook";
  return null;
}

/**
 * @returns {Promise<{ok: boolean, skipped: boolean, status: number|null, error: string|null, contentLength: number}>}
 */
export async function sendDiscord({ webhookUrl, content, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  const trimmed = content.length > DISCORD_CONTENT_LIMIT ? `${content.slice(0, DISCORD_CONTENT_LIMIT - 20)}\n…(truncated)` : content;
  const invalid = validateWebhookUrl(webhookUrl);
  if (invalid) {
    return { ok: false, skipped: true, status: null, error: `webhook_${invalid}`, contentLength: trimmed.length };
  }
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: trimmed, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      skipped: false,
      status: response.status,
      error: response.ok ? null : `http_${response.status}`,
      contentLength: trimmed.length,
    };
  } catch (error) {
    return { ok: false, skipped: false, status: null, error: `transport:${error.message}`, contentLength: trimmed.length };
  }
}
