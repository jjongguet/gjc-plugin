// Snapshot and report rendering.
//
// The summary numbers are computed here from the snapshot; no model writes them.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export const SNAPSHOT_SCHEMA_VERSION = 1;

export function sessionLine(session, judgment) {
  const age = session.ageMinutes === null ? "?" : `${session.ageMinutes}m`;
  const commits = session.commitsSinceStart === null ? "?" : session.commitsSinceStart;
  const ci = ["success", "failure", "pending"].includes(session.ci?.state) ? ` ci=${session.ci.state}` : "";
  return `${session.target}:${session.name} ${age} 커밋${commits} dirty${session.dirty ?? "?"} → ${judgment.state}${ci}`;
}

export function buildSnapshot({ now, host, sessions, judgments, interventions, errors, discord = null, runId }) {
  const byState = {};
  for (const judgment of judgments) byState[judgment.state] = (byState[judgment.state] ?? 0) + 1;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    kind: "workspace-supervisor-snapshot",
    runId,
    generatedAt: new Date(now).toISOString(),
    host,
    counts: { sessions: sessions.length, ...byState },
    sessions,
    judgments,
    interventions,
    discord,
    errors,
  };
}

export function buildSummary(snapshot) {
  const counts = Object.entries(snapshot.counts)
    .filter(([key]) => key !== "sessions")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const lines = [
    `**supervisor** ${snapshot.generatedAt} · ${snapshot.host.hostname} · 세션 ${snapshot.counts.sessions}${counts ? ` (${counts})` : ""}`,
  ];
  for (const judgment of snapshot.judgments) {
    const session = snapshot.sessions.find(entry => entry.id === judgment.id);
    if (!session) continue;
    const note = judgment.source === "decision" ? " (decision)" : judgment.source === "deterministic_fallback" ? " (fallback)" : "";
    lines.push(`- ${sessionLine(session, judgment)}${note}`);
  }
  for (const intervention of snapshot.interventions) {
    const tail = intervention.verified ? "확인" : intervention.delivered ? "전달" : intervention.error ?? "미전달";
    lines.push(`- steer ${intervention.mode} → ${intervention.target}: ${tail}`);
  }
  if (snapshot.errors.length > 0) {
    lines.push(`- 수집 오류 ${snapshot.errors.length}: ${snapshot.errors.map(entry => `${entry.target}:${entry.error}`).join(", ")}`);
  }
  return lines.join("\n");
}

export function snapshotPaths(outDir, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
  return {
    dir: outDir,
    snapshot: path.join(outDir, `snapshot-${stamp}.json`),
    latest: path.join(outDir, "latest.json"),
    events: path.join(outDir, "events.jsonl"),
  };
}

export async function loadPreviousSnapshot(outDir) {
  try {
    return JSON.parse(await readFile(path.join(outDir, "latest.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function writeSnapshot({ outDir, snapshot, now }) {
  const paths = snapshotPaths(outDir, now);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(paths.snapshot, body, { mode: 0o600 });
  await writeFile(paths.latest, body, { mode: 0o600 });
  return paths;
}

export async function appendEvents(outDir, events) {
  if (events.length === 0) return;
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await appendFile(path.join(outDir, "events.jsonl"), events.map(event => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
}

export function eventsFor(snapshot) {
  const stamp = snapshot.generatedAt;
  const events = [{ ts: stamp, event: "snapshot", runId: snapshot.runId, counts: snapshot.counts }];
  for (const judgment of snapshot.judgments) {
    events.push({ ts: stamp, event: "judgment", runId: snapshot.runId, id: judgment.id, state: judgment.state, source: judgment.source, error: judgment.error ?? null });
  }
  for (const intervention of snapshot.interventions) {
    events.push({ ts: stamp, event: "steer", runId: snapshot.runId, ...intervention });
  }
  if (snapshot.discord) events.push({ ts: stamp, event: "discord", runId: snapshot.runId, ...snapshot.discord });
  for (const error of snapshot.errors) events.push({ ts: stamp, event: "error", runId: snapshot.runId, ...error });
  return events;
}
