// scripts/report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSnapshot, findNewestSnapshot } from './lib/snapshot.mjs';
import { snapshotDir, snapshotFileName, resolveConfigDir, resolveSessionId } from './lib/config-dir.mjs';
import { lastAssistantUsage, countCompactions, findNewestTranscript, transcriptForSession } from './lib/transcript.mjs';
import { usedTokens, percentage, headroom } from './lib/token-math.mjs';
import { inferWindowSize } from './lib/model-window.mjs';
import { formatDuration, clockHM } from './lib/time.mjs';

function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function isProviderModel(id, env = process.env) {
  const s = String(id ?? '').toLowerCase();
  if (s.includes('anthropic.claude-')) return true; // Bedrock model ids
  if (s.includes('@')) return true;                 // Vertex uses '@' as version separator
  return env?.CLAUDE_CODE_USE_BEDROCK === '1' || env?.CLAUDE_CODE_USE_VERTEX === '1';
}

export function resolveReport({ now, sessionId = null, snapshotDir: dir, cwd, deps = fs, env = process.env }) {
  // 1. Prefer THIS session's own keyed snapshot — the only one guaranteed to describe
  //    our context/compactions. `identified` records that we matched it by session id.
  let read = null;
  let identified = false;
  if (sessionId && dir) {
    read = readSnapshot(path.join(dir, snapshotFileName(sessionId)), { now, deps });
    if (read) identified = true;
  }
  // 2. Couldn't identify our own snapshot (no session id, or its file is absent): fall
  //    back to the newest snapshot in the dir. Under concurrent sessions it may belong
  //    to a different one, so its provenance is flagged 'unverified-snapshot'.
  if (!read && dir) {
    const newest = findNewestSnapshot(dir, { deps });
    if (newest) read = readSnapshot(newest, { now, deps });
  }

  if (read && read.fresh) {
    const s = read.snapshot;
    const compactions = s.transcript_path ? countCompactions(s.transcript_path, deps) : 0;
    let rateLimitsStatus = 'available';
    if (!s.rate_limits) rateLimitsStatus = isProviderModel(s.model?.id, env) ? 'unavailable_provider' : 'unavailable_plan';
    return {
      source: 'collector',
      model: s.model ?? {},
      context: s.context ?? null,
      rateLimits: s.rate_limits ?? null,
      rateLimitsStatus,
      cost: numOrNull(s.cost?.total_cost_usd),
      compactions,
      sessionSelection: identified ? 'session_id' : 'unverified-snapshot',
      snapshotAgeSeconds: read.ageSeconds,
      windowInferred: false,
    };
  }

  // No fresh snapshot. A stale one still supplies the real window_size and its age,
  // and downgrades the "collector off" message to "collector idle" (unavailable_stale).
  const staleSnapshot = read ? read.snapshot : null;
  const staleAge = read ? read.ageSeconds : null;
  const knownWindow = numOrNull(staleSnapshot?.context?.window_size);
  const fallbackStatus = read ? 'unavailable_stale' : 'unavailable_collector';

  const configDir = resolveConfigDir(env);
  // Prefer our OWN transcript (deterministic from the session id) over the cwd heuristic,
  // which can't distinguish two sessions sharing a directory.
  let transcript = sessionId ? transcriptForSession(configDir, cwd, sessionId, deps) : null;
  let transcriptSelection = transcript ? 'session_id' : null;
  if (!transcript) {
    transcript = findNewestTranscript(configDir, cwd, deps);
    if (transcript) transcriptSelection = 'newest-in-cwd-heuristic';
  }
  const usage = transcript ? lastAssistantUsage(transcript, deps) : null;
  const compactions = transcript ? countCompactions(transcript, deps) : 0;

  if (usage) {
    // Reuse the snapshot's real window_size when we have one; only guess at true cold start.
    const windowInferred = !(knownWindow && knownWindow > 0);
    const windowSize = windowInferred ? inferWindowSize({ id: usage.model_id }) : knownWindow;
    const used = usedTokens(usage);
    return {
      source: 'transcript',
      model: { id: usage.model_id ?? '', display_name: '' },
      context: {
        window_size: windowSize,
        used_tokens: used,
        used_percentage: percentage(used, windowSize),
        input_tokens: usage.input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        output_tokens: usage.output_tokens,
      },
      rateLimits: null,
      rateLimitsStatus: fallbackStatus,
      cost: null,
      compactions,
      sessionSelection: transcriptSelection,
      snapshotAgeSeconds: staleAge,
      windowInferred,
    };
  }

  return {
    source: 'unavailable', model: staleSnapshot?.model ?? {}, context: null, rateLimits: null,
    rateLimitsStatus: fallbackStatus, cost: null, compactions,
    sessionSelection: transcriptSelection,
    snapshotAgeSeconds: staleAge, windowInferred: false,
  };
}

function modelName(model) {
  return model?.display_name || model?.id || 'unknown';
}
function kt(n) {
  if (n == null) return '—';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// Reset countdowns are rounded to the nearest MINUTE (not second): the human block
// only ever prints minute resolution (via formatDuration), and second-level jitter
// (e.g. "5396s" vs "5400s" depending on the exact instant the report runs) would
// make the JSON value tell a different, more precise story than the prose next to
// it. Rounding both from one shared value keeps them consistent.
function resetsInSeconds(resetsAt, now) {
  const ms = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.round((ms - now) / 60_000);
  return Math.max(0, minutes * 60);
}

function windowJson(w, now) {
  if (!w) return null;
  return {
    used_percentage: w.used_percentage ?? null,
    resets_at: w.resets_at ?? null,
    resets_in_seconds: resetsInSeconds(w.resets_at, now),
  };
}

function buildJson(r, now) {
  const c = r.context;
  const context = c ? {
    used_percentage: c.used_percentage,
    used_tokens: c.used_tokens,
    window_size: c.window_size,
    headroom_tokens: headroom(c.used_tokens, c.window_size),
    input_tokens: c.input_tokens,
    cache_read_tokens: c.cache_read_tokens,
    cache_creation_tokens: c.cache_creation_tokens,
    output_tokens: c.output_tokens,
  } : {
    used_percentage: null, used_tokens: null, window_size: null, headroom_tokens: null,
    input_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, output_tokens: null,
  };
  const json = {
    model: r.model ?? {},
    context,
    rate_limits: {
      five_hour: r.rateLimits ? windowJson(r.rateLimits.five_hour, now) : null,
      seven_day: r.rateLimits ? windowJson(r.rateLimits.seven_day, now) : null,
    },
    cost_usd: r.cost,
    compactions: r.compactions,
    source: r.source,
    rate_limits_status: r.rateLimitsStatus,
    window_size_inferred: !!r.windowInferred,
    snapshot_age_seconds: r.snapshotAgeSeconds,
    generated_at: new Date(now).toISOString(),
  };
  if (r.sessionSelection) json.session_selection = r.sessionSelection;
  return json;
}

function rlLine(label, r, w, now) {
  if (r.rateLimitsStatus === 'available' && w && w.used_percentage != null) {
    const secs = resetsInSeconds(w.resets_at, now);
    let when = '';
    if (secs != null) {
      const ms = Date.parse(w.resets_at);
      const dur = formatDuration(secs);
      const withinDay = ms - now < 24 * 3600 * 1000;
      when = ` · resets in ${dur}${withinDay ? ` (at ${clockHM(new Date(ms))})` : ''}`;
    }
    return `${label}: ${w.used_percentage}% used${when}`;
  }
  switch (r.rateLimitsStatus) {
    case 'unavailable_plan':
      return `${label}: unavailable — no subscription usage reported (API-key account, or before the first Pro/Max response)`;
    case 'unavailable_provider':
      return `${label}: unavailable — subscription usage not reported on this provider (Bedrock/Vertex)`;
    case 'unavailable_stale':
      return `${label}: unavailable — last collector reading ${r.snapshotAgeSeconds}s ago (idle; send a message to refresh)`;
    default:
      return `${label}: unavailable — enable the collector with /claude-context:setup`;
  }
}

function sessionNote(r) {
  if (r.sessionSelection === 'unverified-snapshot') return ' · session: unverified (newest snapshot)';
  return '';
}

function sourceLine(r) {
  if (r.source === 'collector') return `Source: collector · snapshot ${r.snapshotAgeSeconds}s old${sessionNote(r)}`;
  if (r.source === 'transcript') {
    const win = r.windowInferred ? 'window inferred' : 'window from snapshot';
    const age = r.snapshotAgeSeconds != null ? ` · snapshot ${r.snapshotAgeSeconds}s old (stale)` : '';
    const sess = r.sessionSelection === 'session_id' ? 'this session' : 'newest-in-cwd (heuristic)';
    return `Source: transcript fallback · context only · ${win}${age} · session: ${sess}`;
  }
  return 'Source: unavailable';
}

function buildHuman(r, now) {
  const lines = [`Claude Context — ${modelName(r.model)}`];
  if (r.context && r.windowInferred) {
    // Cold-start fallback: window size is a guess, so hedge the % and drop headroom.
    lines.push(`Context: ~${r.context.used_percentage}% used · ${kt(r.context.used_tokens)} tokens · window inferred (${kt(r.context.window_size)} assumed)`);
  } else if (r.context) {
    lines.push(`Context: ${r.context.used_percentage}% used · ${kt(r.context.used_tokens)} / ${kt(r.context.window_size)} tokens · ${kt(headroom(r.context.used_tokens, r.context.window_size))} headroom`);
  } else {
    lines.push('Context: unavailable — no measurement yet (no assistant turn recorded, collector off)');
  }
  lines.push(rlLine('Session (5h)', r, r.rateLimits?.five_hour, now));
  lines.push(rlLine('Weekly (7d)', r, r.rateLimits?.seven_day, now));
  lines.push(`Cost: ${r.cost != null ? `$${r.cost.toFixed(2)}` : 'unavailable'} · Compactions: ${r.compactions}`);
  lines.push(sourceLine(r));
  return lines.join('\n');
}

export function assembleReport(r, now) {
  return { human: buildHuman(r, now), json: buildJson(r, now) };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const now = Date.now();
  const sessionId = resolveSessionId({ argv: process.argv, env: process.env });
  const resolution = resolveReport({
    now, sessionId, snapshotDir: snapshotDir(process.env), cwd: process.cwd(), deps: fs, env: process.env,
  });
  const { human, json } = assembleReport(resolution, now);
  process.stdout.write(`${human}\n\n`);
  process.stdout.write('```json\n');
  process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  process.stdout.write('```\n');
}
