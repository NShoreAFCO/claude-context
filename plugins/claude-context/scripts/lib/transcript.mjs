// Adapted from claude-hud (MIT, © Jarrod Watts): transcript JSONL parsing.
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeSessionId } from './config-dir.mjs';

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// How Claude Code encodes a cwd into a projects/ subdirectory name.
function encodeProjectDir(cwd) {
  return String(cwd).replace(/[/\\.]/g, '-');
}

function readJsonl(filePath, deps) {
  const raw = deps.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed lines */ }
  }
  return out;
}

export function lastAssistantUsage(filePath, deps = fs) {
  let entries;
  try { entries = readJsonl(filePath, deps); } catch { return null; }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const usage = e?.message?.usage ?? e?.usage;
    if (e?.type === 'assistant' && usage && typeof usage === 'object') {
      return {
        input_tokens: num(usage.input_tokens),
        cache_read_input_tokens: num(usage.cache_read_input_tokens),
        cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
        output_tokens: num(usage.output_tokens),
        model_id: typeof e?.message?.model === 'string' ? e.message.model
          : (typeof e?.model === 'string' ? e.model : null),
      };
    }
  }
  return null;
}

export function countCompactions(filePath, deps = fs) {
  let entries;
  try { entries = readJsonl(filePath, deps); } catch { return 0; }
  let count = 0;
  for (const e of entries) {
    const isBoundary = e?.type === 'compact_boundary' || e?.subtype === 'compact_boundary';
    if (!isBoundary) continue;
    const ts = e?.timestamp;
    if (typeof ts === 'string' && Number.isFinite(Date.parse(ts))) count++;
  }
  return count;
}

// This session's own transcript, resolved deterministically from its session id
// (the transcript is named <session-id>.jsonl). Preferred over the newest-in-cwd
// heuristic, which can't tell two same-cwd sessions apart.
export function transcriptForSession(configDir, cwd, sessionId, deps = fs) {
  const safe = sanitizeSessionId(sessionId);
  if (!safe) return null;
  const file = path.join(configDir, 'projects', encodeProjectDir(cwd), `${safe}.jsonl`);
  try { deps.statSync(file); return file; } catch { return null; }
}

export function findNewestTranscript(configDir, cwd, deps = fs) {
  const dir = path.join(configDir, 'projects', encodeProjectDir(cwd));
  let files;
  try { files = deps.readdirSync(dir); } catch { return null; }
  let newest = null;
  let newestMtime = -Infinity;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    let mtime;
    try { mtime = deps.statSync(full).mtimeMs; } catch { continue; }
    if (mtime > newestMtime) { newestMtime = mtime; newest = full; }
  }
  return newest;
}
