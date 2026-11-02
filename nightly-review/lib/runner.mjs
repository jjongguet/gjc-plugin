// Run one lens over one pull request in a separate process.
//
// Separate processes are what make the perspectives independent: no shared
// conversation, no shared scratch context, and no tool access, so a reviewer
// cannot wander into another reviewer's conclusion.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Verified enclosure (JJO-844/JJO-465 provenance in mini-dispatch.py): headless,
// no tools, no MCP, no LSP, no rules, no title, no session persistence.
export function enclosureArgs(mode = 'json') {
  return [
    '-p',
    '--no-tools',
    '--no-mcp',
    '--no-lsp',
    '--no-rules',
    '--no-title',
    '--no-session',
    '--mode',
    mode,
    '--model',
  ];
}

export function parseJsonFindings(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { findings: [], error: 'empty_response' };

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter(Boolean);

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < candidate.length; i += 1) {
      if (candidate[i] === '{') depth += 1;
      else if (candidate[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(candidate.slice(start, i + 1));
            if (Array.isArray(parsed?.findings)) return { findings: parsed.findings };
            return { findings: [], error: 'no_findings_array' };
          } catch {
            break;
          }
        }
      }
    }
  }
  return { findings: [], error: 'unparseable_response' };
}

export function lastAssistantText(stdout) {
  let text = '';
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type !== 'message_end') continue;
    const message = event.message;
    if (message?.role !== 'assistant') continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const joined = parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (joined) text = joined;
  }
  return text;
}

// `--mode json` is a snapshot stream: every token delta re-sends the accumulated
// message, which reached 176 MB for one 18 KB prompt in the first real run.
// Buffering it is not an option, so read the stream incrementally and keep only
// the two event types that carry an answer and a usage receipt.
const WANTED = new Set(['message_end', 'agent_end']);

export function createStreamFilter({ onEvent }) {
  let rest = '';
  let dropped = 0;
  const handle = (line) => {
    if (!line.startsWith('{')) return;
    if (!line.includes('"message_end"') && !line.includes('"agent_end"')) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!WANTED.has(event?.type)) return;
    onEvent(event);
  };
  return {
    push(chunk) {
      rest += chunk;
      let index = rest.indexOf('\n');
      while (index !== -1) {
        handle(rest.slice(0, index));
        rest = rest.slice(index + 1);
        index = rest.indexOf('\n');
      }
      // An oversized partial line is a skipped delta, never a lost answer.
      if (rest.length > 1_000_000) {
        rest = '';
        dropped += 1;
      }
    },
    get dropped() {
      return dropped;
    },
  };
}

export function streamCapture({
  bin = 'gjc',
  args,
  cwd,
  timeoutMs = 240_000,
  maxBytes = 512 * 1024 * 1024,
  softBytes = 96 * 1024 * 1024,
  mode = 'json',
}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let assistantText = '';
    let rawText = '';
    let telemetry = null;
    let stderr = '';
    let bytes = 0;
    let aborted = null;
    let trimmed = false;

    const finish = (code, signal) => {
      clearTimeout(timer);
      resolve({ assistantText, rawText, telemetry, stderr, bytes, code, signal, aborted, trimmed });
    };

    const filter = createStreamFilter({
      onEvent: (event) => {
        if (event.type === 'agent_end') {
          telemetry = event.telemetry ?? null;
          return;
        }
        const message = event.message;
        if (message?.role !== 'assistant') return;
        const joined = (Array.isArray(message.content) ? message.content : [])
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('');
        if (joined) assistantText = joined;
      },
    });

    const timer = setTimeout(() => {
      aborted = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes && aborted === null) {
        aborted = 'stream_too_large';
        child.kill('SIGKILL');
        return;
      }
      if (mode === 'text') {
        // Plain mode prints the answer only: nothing to filter, nothing quadratic.
        if (rawText.length < maxBytes) rawText += chunk;
        return;
      }
      filter.push(chunk);
      // Stop the flood as soon as the answer is in hand.
      if (telemetry) {
        child.stdout.destroy();
        child.kill('SIGTERM');
        return;
      }
      // A large diff can push the snapshot stream past any sane size before the
      // usage event arrives. Keep the answer, drop the accounting, and say so.
      if (assistantText && bytes > softBytes) {
        trimmed = true;
        child.stdout.destroy();
        child.kill('SIGTERM');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on('error', (error) => {
      aborted = aborted ?? `spawn_failed: ${String(error?.message ?? error).slice(0, 200)}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

export function readTelemetry(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type === 'agent_end' && event.telemetry) return event.telemetry;
  }
  return null;
}

// One call. Runs in a throwaway cwd so no project context is injected into the
// reviewer prompt — the diff and the repository rules are the only evidence.
//
// JSON mode is preferred because it carries the usage receipt, but its snapshot
// stream is quadratic in the answer length, so an oversized call is retried once
// in plain mode: the answer is worth more than the accounting.
export async function runLens({ prompt, lens, timeoutMs = 240_000, gjcBin = 'gjc', softBytes }) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'nightly-review-'));
  const started = Date.now();
  try {
    let captured = await streamCapture({
      bin: gjcBin,
      args: [...enclosureArgs('json'), lens.model, prompt],
      cwd: scratch,
      timeoutMs,
      softBytes,
      mode: 'json',
    });
    let retriedForSize = false;

    if (captured.aborted === 'stream_too_large') {
      retriedForSize = true;
      captured = await streamCapture({
        bin: gjcBin,
        args: [...enclosureArgs('text'), lens.model, prompt],
        cwd: scratch,
        timeoutMs,
        softBytes,
        mode: 'text',
      });
    }

    const latencyMs = Date.now() - started;
    if (captured.aborted) {
      return {
        ok: false,
        error: captured.aborted,
        findings: [],
        latencyMs,
        retriedForSize,
        usage: captured.telemetry?.usage ?? null,
        cost: captured.telemetry?.cost ?? null,
      };
    }
    const answer = captured.rawText || captured.assistantText;
    const { findings, error } = parseJsonFindings(answer);
    const stderrTail = captured.stderr.trim().slice(-300);
    return {
      ok: !error,
      error: error ? `${error}${stderrTail ? `: ${stderrTail}` : ''}` : undefined,
      findings: findings.map((finding) => ({ ...finding, lens: lens.id, model: lens.model })),
      latencyMs,
      streamBytes: captured.bytes,
      streamTrimmed: captured.trimmed,
      retriedForSize,
      usage: captured.telemetry?.usage ?? null,
      cost: captured.telemetry?.cost ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      error: `call_failed: ${String(error?.message ?? error).slice(0, 300)}`,
      findings: [],
      latencyMs: Date.now() - started,
      usage: null,
      cost: null,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Bounded fan-out. Concurrency is capped so the provider is not rate-limited
// into partial results, which would look like "the model found nothing".
//
// `shouldStop` stops *starting* work. A nightly run under a timer needs a hard
// ceiling on paid calls, and a started call is already paid for, so the check is
// made before each task instead of aborting one in flight.
export async function runAll({ tasks, concurrency = 4, onResult = () => {}, shouldStop = () => false }) {
  const results = [];
  let cursor = 0;
  let skipped = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (!task) return;
      if (shouldStop()) {
        skipped += 1;
        continue;
      }
      const result = await task.execute();
      results.push({ ...task.meta, ...result });
      onResult(results[results.length - 1]);
    }
  });
  await Promise.all(workers);
  return { results, skipped };
}
