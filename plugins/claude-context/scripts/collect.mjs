import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  usedTokens,
  percentage,
  effectiveWindow,
  formatTokens,
  num,
  numOrNull,
} from './lib/token-math.mjs';
import { readAutoCompactWindow } from './lib/auto-compact.mjs';
import { epochToMs, formatDuration } from './lib/time.mjs';
import { writeSnapshot } from './lib/snapshot.mjs';
import { snapshotPath } from './lib/config-dir.mjs';
import { readStdin, parseStdinJson } from './lib/stdin.mjs';

function str(v) {
  return typeof v === 'string' ? v : '';
}
function roundPct(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}
// Native context percentage, treating 0/non-finite as "not yet populated" (see Global
// Constraints). roundPct already guards type+finite, so the only added rule is `> 0`.
// Rate-limit windows keep 0 as valid and use roundPct directly.
const nativePctOrNull = (v) => (v > 0 ? roundPct(v) : null);

function buildWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = roundPct(w.used_percentage);
  const ms = epochToMs(w.resets_at);
  if (pct === null && ms === null) return null;
  return { used_percentage: pct, resets_at: ms === null ? null : new Date(ms).toISOString() };
}

function buildRateLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const five = buildWindow(rl.five_hour);
  const seven = buildWindow(rl.seven_day);
  if (!five && !seven) return null;
  return { five_hour: five, seven_day: seven };
}

// `autoCompact` is readAutoCompactWindow()'s result; Claude Code does not put the
// auto-compact window on stdin, so the caller reads it from settings and passes it in.
export function buildSnapshot(stdin, now, autoCompact = { tokens: null, source: null }) {
  const cw = stdin?.context_window ?? {};
  const usage = cw.current_usage ?? {};
  const windowSize = num(cw.context_window_size);
  const used = usedTokens(usage);
  return {
    updated_at: new Date(now).toISOString(),
    model: { id: str(stdin?.model?.id), display_name: str(stdin?.model?.display_name) },
    context: {
      window_size: windowSize,
      used_tokens: used,
      used_percentage: nativePctOrNull(cw.used_percentage) ?? percentage(used, windowSize),
      input_tokens: num(usage.input_tokens),
      cache_read_tokens: num(usage.cache_read_input_tokens),
      cache_creation_tokens: num(usage.cache_creation_input_tokens),
      output_tokens: num(usage.output_tokens),
      auto_compact_window: numOrNull(autoCompact?.tokens),
      auto_compact_window_source: autoCompact?.source ?? null,
    },
    rate_limits: buildRateLimits(stdin?.rate_limits),
    cost: { total_cost_usd: numOrNull(stdin?.cost?.total_cost_usd) },
    transcript_path: str(stdin?.transcript_path) || null,
    session_id: str(stdin?.session_id) || null,
  };
}

// Countdown to a rate-limit reset, rounded to the minute like the report's resetsInSeconds
// and floored at 0. Null when resets_at is missing or unparseable.
function countdown(resetsAt, now) {
  const ms = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(ms)) return null;
  return formatDuration(Math.max(0, Math.round((ms - now) / 60_000) * 60));
}

function rateLimitPart(label, w, now) {
  if (w?.used_percentage == null) return null;
  const left = countdown(w.resets_at, now);
  return `${label} ${w.used_percentage}%${left ? ` ${left}` : ''}`;
}

export function compactLine(snapshot, now = Date.now()) {
  const { used_tokens: used, window_size: size, used_percentage: pct } = snapshot.context;
  const parts = [
    size > 0
      ? `Context ${formatTokens(used)}/${formatTokens(size)} ${pct == null ? '—' : pct}%`
      : `Context ${formatTokens(used)}`,
  ];
  const acw = snapshot.context.auto_compact_window;
  if (acw != null) {
    const eff = effectiveWindow(size, acw);
    parts.push(`${formatTokens(used)}/${formatTokens(eff)} ${percentage(used, eff)}%`);
  }
  const rl = snapshot.rate_limits;
  for (const p of [
    rateLimitPart('5h', rl?.five_hour, now),
    rateLimitPart('7d', rl?.seven_day, now),
  ]) {
    if (p) parts.push(p);
  }
  return parts.join(' · ');
}

export async function runCli({
  argv = process.argv,
  now = Date.now(),
  readInput = readStdin,
  env = process.env,
  deps = fs,
  write = (s) => process.stdout.write(s),
} = {}) {
  const silent = argv.includes('--silent');
  // readStdin is guarded (returns '' on a stream error) and parseStdinJson falls back to {}.
  const stdin = parseStdinJson(await readInput());
  const snapshot = buildSnapshot(stdin, now, readAutoCompactWindow({ stdin, env }));
  // Key by this session's id (from stdin) so concurrent same-account sessions each
  // write their own file instead of thrashing one shared snapshot.
  const snapPath = snapshotPath(snapshot.session_id, env);
  // Surface a genuine persistence FAILURE as a fact — not advice — so it has a discovery
  // path: if writes silently fail (read-only/full FS), the report reads "not set up" no
  // matter how healthy this line looks. writeSnapshot returns 'failed' only on a real
  // error, so the marker fires even when a stale prior snapshot still sits on disk (which a
  // plain existsSync check would misread as healthy) and stays quiet on a throttle
  // 'skipped', where the prior snapshot is intentionally left in place.
  const writeResult = writeSnapshot(snapPath, snapshot, { now, deps });
  const line =
    writeResult === 'failed'
      ? `${compactLine(snapshot, now)} · snapshot not saved`
      : compactLine(snapshot, now);
  if (!silent) write(`${line}\n`);
}

// Importing this module does not run the collector — only direct execution does.
// The Windows launcher (Task 11) imports the module and calls runCli() explicitly.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  // Fail safe, matching coexist.mjs: a synchronous throw (e.g. ERR_STREAM_DESTROYED writing
  // to an already-closed statusline pipe) must not surface as an unhandled rejection — one
  // blank tick, recovered next tick.
  try {
    await runCli();
  } catch {
    process.exit(0);
  }
}
