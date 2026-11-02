// Deterministic gate for review findings.
//
// A model finding is kept only when the code it quotes actually exists in the
// merged diff. This is the whole point of the module: an unquotable finding is
// a guess, and a guess must never become a Linear ticket.

const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]+$/u;

export function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export function normalizePath(file) {
  return String(file ?? '')
    .trim()
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '');
}

// Index a unified diff: which files exist, and the added lines per file (with
// their new-file line numbers, so a finding's line can be range-checked).
export function indexDiff(diffText) {
  const files = new Map();
  let current = null;
  let newLine = 0;

  for (const raw of String(diffText ?? '').split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      if (target === '/dev/null') {
        current = null;
        continue;
      }
      const path = normalizePath(target);
      current = files.get(path) ?? { path, added: [] };
      files.set(path, current);
      continue;
    }
    if (raw.startsWith('@@')) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(raw);
      newLine = match ? Number(match[1]) : 0;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+')) {
      current.added.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-') || raw.startsWith('\\')) continue;
    newLine += 1;
  }

  for (const file of files.values()) {
    file.joinText = normalizeWhitespace(file.added.map((entry) => entry.text).join('\n'));
  }
  return files;
}

function quoteIsSpecific(normalized) {
  if (normalized.length < 12) return false;
  if (PUNCTUATION_ONLY.test(normalized)) return false;
  const meaningful = normalized.replace(/[^A-Za-z0-9_$]/g, '');
  return meaningful.length >= 6;
}

// Verify one finding against the diff index.
//
// The model's line number is a hint, not a fact: a real quote is worth keeping
// even when the citation is off by a line, but a wrong line in a ticket sends the
// reader to the wrong place. The quote decides, and the line is corrected to the
// added line that actually contains it.
export function verifyFinding(finding, files) {
  const file = normalizePath(finding?.file);
  if (!file) return { ok: false, reason: 'missing_file' };
  const index = files.get(file);
  if (!index) return { ok: false, reason: 'file_not_in_diff' };

  const quote = normalizeWhitespace(finding?.quote);
  if (!quote) return { ok: false, reason: 'missing_quote' };
  if (!quoteIsSpecific(quote)) return { ok: false, reason: 'quote_not_specific' };
  if (!index.joinText.includes(quote)) return { ok: false, reason: 'quote_not_in_diff' };

  const firstLine = quote.split('\n')[0];
  // Pick the added line with the longest overlap. A short added line can be a
  // prefix of the quote by accident (`optional: true`), and matching that one
  // would point the reader at the wrong place.
  let match = null;
  let bestScore = -1;
  for (const entry of index.added) {
    const normalized = normalizeWhitespace(entry.text);
    if (!normalized) continue;
    if (!normalized.includes(firstLine) && !firstLine.includes(normalized)) continue;
    const score = Math.min(normalized.length, firstLine.length);
    if (score > bestScore) {
      match = entry;
      bestScore = score;
    }
  }
  if (!match) return { ok: false, reason: 'line_not_located' };

  const cited = Number(finding?.line);
  return {
    ok: true,
    file,
    quote,
    line: match.line,
    corrected: !Number.isInteger(cited) || cited !== match.line,
  };
}

function isNearDuplicate(a, b) {
  if (a.file !== b.file) return false;
  if (a.kind !== b.kind) return false;
  const left = a.normQuote.slice(0, 60);
  const right = b.normQuote.slice(0, 60);
  if (left === right) return true;
  return a.normQuote.includes(b.normQuote) || b.normQuote.includes(a.normQuote);
}

// Apply verification, near-duplicate collapse and the per-run cap.
// Returns kept findings plus, per drop reason, the discarded findings so the
// receipt can show how much the models produced versus what survived.
export function gateFindings(findings, files, { maxFindings = 15 } = {}) {
  const kept = [];
  const dropped = [];

  for (const finding of findings) {
    const verdict = verifyFinding(finding, files);
    if (!verdict.ok) {
      dropped.push({ finding, reason: verdict.reason });
      continue;
    }
    const candidate = {
      ...finding,
      file: verdict.file,
      quote: verdict.quote,
      normQuote: verdict.quote,
      line: verdict.line,
      lineCorrected: verdict.corrected,
      confidence: Number(finding?.confidence ?? 0) || 0,
    };
    const duplicate = kept.find((entry) => isNearDuplicate(entry, candidate));
    if (duplicate) {
      dropped.push({ finding, reason: 'duplicate' });
      continue;
    }
    kept.push(candidate);
  }

  kept.sort((a, b) => b.confidence - a.confidence || a.file.localeCompare(b.file));
  const overflow = kept.slice(maxFindings);
  for (const finding of overflow) dropped.push({ finding, reason: 'over_cap' });

  const survivors = kept.slice(0, maxFindings);
  return {
    kept: survivors.map(({ normQuote, ...rest }) => rest),
    dropped: dropped.map(({ finding, reason }) => ({
      reason,
      file: normalizePath(finding?.file),
      lens: finding?.lens,
      quote: String(finding?.quote ?? '').slice(0, 160),
    })),
    stats: {
      submitted: findings.length,
      kept: survivors.length,
      dropped: dropped.length,
      byReason: countBy(dropped.map((entry) => entry.reason)),
    },
  };
}

export function countBy(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
