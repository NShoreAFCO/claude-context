// scripts/report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSnapshot, findNewestSnapshot } from './lib/snapshot.mjs';
import { snapshotDir, snapshotFileName, resolveSessionId } from './lib/config-dir.mjs';
import { lastAssistantUsage, countCompactions } from './lib/transcript.mjs';
import { usedTokens, percentage, headroom } from './lib/token-math.mjs';
import { formatDuration, clockHM } from './lib/time.mjs';

function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function isProviderModel(id, env = process.env) {
  const s = String(id ?? '').toLowerCase();
  if (s.includes('anthropic.claude-')) return true; // Bedrock model ids
  if (s.includes('@')) return true;                 // Vertex uses '@' as version separator
  return env?.CLAUDE_CODE_USE_BEDROCK === '1' || env?.CLAUDE_CODE_USE_VERTEX === '1';
}

export function resolveReport({ now, sessionId = null, snapshotDir: dir, cwd, deps = fs, env = process.env }) {
  // 1. Prefer THIS session's own keyed snapshot; else the newest in the dir.
  let read = null;
  let identified = false;
  if (sessionId && dir) {
    read = readSnapshot(path.join(dir, snapshotFileName(sessionId)), { now, deps });
    if (read) identified = true;
  }
  if (!read && dir) {
    const newest = findNewestSnapshot(dir, { deps });
    if (newest) read = readSnapshot(newest, { now, deps });
  }

  // 2. Fresh snapshot → collector state.
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
      setupRequired: false,
    };
  }

  // 3. NO snapshot has EVER been written → not-set-up. Skip ALL transcript I/O: the
  //    compaction count is unknown (null, not 0), and no window is ever inferred.
  if (!read) {
    return {
      source: 'unavailable',
      model: {},
      context: null,
      rateLimits: null,
      rateLimitsStatus: 'unavailable_collector',
      cost: null,
      compactions: null,
      sessionSelection: null,
      snapshotAgeSeconds: null,
      setupRequired: true,
    };
  }

  // 4. A snapshot exists but is STALE (collector idle). It still carries the real
  //    window size and its age; we must never tell an already-set-up user to run setup.
  const staleSnapshot = read.snapshot;
  const staleAge = read.ageSeconds;
  const knownWindow = numOrNull(staleSnapshot?.context?.window_size);
  // Provenance follows whether the snapshot is THIS session's own keyed file (identified)
  // or the newest-in-dir fallback — exactly as the fresh branch (:47) labels it.
  const sessionSelection = identified ? 'session_id' : 'unverified-snapshot';

  // Size usage and count compactions from the snapshot's OWN transcript_path (as the
  // fresh branch does at :36) — NOT a separately-resolved transcript. This keeps the
  // window (from the snapshot) and the usage/compactions (from the transcript) describing
  // the SAME session. Pairing THIS session's transcript usage with a foreign newest
  // snapshot's window produced a used_percentage that could be several-fold wrong while
  // still stamped session_id (C1); reading the snapshot's own transcript removes the
  // cross-session read at its source, so the label honestly covers every number.
  const staleTranscript = staleSnapshot?.transcript_path ?? null;
  const compactions = staleTranscript ? countCompactions(staleTranscript, deps) : 0;

  // Read the transcript's latest usage ONLY when the snapshot supplied a real window
  // to size it against (§2.1). Without a real window we never infer — we fall back to
  // the snapshot's own context field below.
  const usage = knownWindow > 0 && staleTranscript ? lastAssistantUsage(staleTranscript, deps) : null;

  if (usage) {
    const used = usedTokens(usage);
    return {
      source: 'transcript',
      model: { id: usage.model_id ?? '', display_name: '' },
      context: {
        window_size: knownWindow,
        used_tokens: used,
        used_percentage: percentage(used, knownWindow),
        input_tokens: usage.input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        output_tokens: usage.output_tokens,
      },
      rateLimits: null,
      rateLimitsStatus: 'unavailable_stale',
      cost: null,
      compactions,
      sessionSelection,
      snapshotAgeSeconds: staleAge,
      setupRequired: false,
    };
  }

  // Transcript yielded no usage: fall back to the stale snapshot's OWN context field
  // (it already carries the real window). Provenance is `collector` — the numbers come
  // from the snapshot — distinguished from a live reading only by unavailable_stale +
  // the reported age.
  return {
    source: 'collector',
    model: staleSnapshot?.model ?? {},
    context: staleSnapshot?.context ?? null,
    rateLimits: null,
    rateLimitsStatus: 'unavailable_stale',
    cost: null,
    compactions,
    sessionSelection,
    snapshotAgeSeconds: staleAge,
    setupRequired: false,
  };
}

const COLD_START_HUMAN = `Claude Context — collector not configured

No resource facts are available for this session yet: the usage collector
has not recorded a snapshot, so there is nothing to measure.

To enable reporting — context %, 5-hour / 7-day usage, session cost, and
compaction count — run:

    /claude-context:setup

That wires a statusline helper which captures the figures Claude Code sends
only to the statusline. Once it has run, this report returns live numbers.`;

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
    setup_required: !!r.setupRequired,
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
  // Status is available but THIS window wasn't reported (null window, or a window with
  // no used_percentage). The collector is running, so don't tell the user to enable it.
  if (r.rateLimitsStatus === 'available') {
    return `${label}: unavailable — not reported for this window`;
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
  if (r.source === 'collector') {
    const stale = r.rateLimitsStatus === 'unavailable_stale' ? ' (stale)' : '';
    return `Source: collector · snapshot ${r.snapshotAgeSeconds}s old${stale}${sessionNote(r)}`;
  }
  if (r.source === 'transcript') {
    const age = r.snapshotAgeSeconds != null ? ` · snapshot ${r.snapshotAgeSeconds}s old (stale)` : '';
    let sess = 'newest-in-cwd (heuristic)';
    if (r.sessionSelection === 'session_id') sess = 'this session';
    else if (r.sessionSelection === 'unverified-snapshot') sess = 'unverified (newest snapshot)';
    return `Source: transcript fallback · context only · window from snapshot${age} · session: ${sess}`;
  }
  return 'Source: unavailable';
}

function buildHuman(r, now) {
  if (r.setupRequired) return COLD_START_HUMAN;
  const lines = [`Claude Context — ${modelName(r.model)}`];
  const c = r.context;
  if (c && c.used_percentage == null) {
    lines.push('Context: unavailable — window size not reported yet');
  } else if (c) {
    lines.push(`Context: ${c.used_percentage}% used · ${kt(c.used_tokens)} / ${kt(c.window_size)} tokens · ${kt(headroom(c.used_tokens, c.window_size))} headroom`);
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
