import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { usedTokens, percentage } from './lib/token-math.mjs';
import { epochToMs } from './lib/time.mjs';
import { writeSnapshot } from './lib/snapshot.mjs';
import { snapshotPath } from './lib/config-dir.mjs';

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function str(v) { return typeof v === 'string' ? v : ''; }
function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function roundPct(v) { return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null; }
// Native context percentage, treating 0/non-finite as "not yet populated" (see
// Global Constraints). Rate-limit windows keep 0 as valid and use roundPct instead.
function nativePctOrNull(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null; }

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

export function buildSnapshot(stdin, now) {
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
    },
    rate_limits: buildRateLimits(stdin?.rate_limits),
    cost: { total_cost_usd: numOrNull(stdin?.cost?.total_cost_usd) },
    transcript_path: str(stdin?.transcript_path) || null,
    session_id: str(stdin?.session_id) || null,
  };
}

export function compactLine(snapshot) {
  const pct = snapshot.context.used_percentage;
  const parts = [`Context ${pct == null ? '—' : pct}%`];
  const rl = snapshot.rate_limits;
  if (rl?.five_hour?.used_percentage != null) parts.push(`5h ${rl.five_hour.used_percentage}%`);
  if (rl?.seven_day?.used_percentage != null) parts.push(`7d ${rl.seven_day.used_percentage}%`);
  return parts.join(' · ');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runCli({ argv = process.argv, now = Date.now(), readInput = readStdin, env = process.env, deps = fs, write = (s) => process.stdout.write(s) } = {}) {
  const silent = argv.includes('--silent');
  let stdin = {};
  try { stdin = JSON.parse(await readInput()); } catch { stdin = {}; }
  const snapshot = buildSnapshot(stdin, now);
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
  const line = writeResult === 'failed' ? `${compactLine(snapshot)} · snapshot not saved` : compactLine(snapshot);
  if (!silent) write(`${line}\n`);
}

// Importing this module does not run the collector — only direct execution does.
// The Windows launcher (Task 11) imports the module and calls runCli() explicitly.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) { await runCli(); }
