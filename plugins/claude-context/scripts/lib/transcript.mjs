// Adapted from claude-hud (MIT, © Jarrod Watts): transcript JSONL parsing.
import fs from 'node:fs';
import { num } from './token-math.mjs';

function readJsonl(filePath, deps) {
  const raw = deps.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

export function lastAssistantUsage(filePath, deps = fs) {
  let entries;
  try {
    entries = readJsonl(filePath, deps);
  } catch {
    return null;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const usage = e?.message?.usage ?? e?.usage;
    if (e?.type === 'assistant' && usage && typeof usage === 'object') {
      return {
        input_tokens: num(usage.input_tokens),
        cache_read_input_tokens: num(usage.cache_read_input_tokens),
        cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
        output_tokens: num(usage.output_tokens),
        model_id:
          typeof e?.message?.model === 'string'
            ? e.message.model
            : typeof e?.model === 'string'
              ? e.model
              : null,
      };
    }
  }
  return null;
}

export function countCompactions(filePath, deps = fs) {
  let entries;
  try {
    entries = readJsonl(filePath, deps);
  } catch {
    // Unreadable transcript (e.g. a stale snapshot pointing at a since-rotated path): the
    // count is UNKNOWN, not zero. Return null so the report never reports a fabricated 0 —
    // the facts-only contract. (lastAssistantUsage already returns null on the same failure.)
    return null;
  }
  let count = 0;
  for (const e of entries) {
    const isBoundary = e?.type === 'compact_boundary' || e?.subtype === 'compact_boundary';
    if (!isBoundary) continue;
    const ts = e?.timestamp;
    if (typeof ts === 'string' && Number.isFinite(Date.parse(ts))) count++;
  }
  return count;
}
