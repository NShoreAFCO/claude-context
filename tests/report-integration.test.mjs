// tests/report-integration.test.mjs
// Closes the collector→report seam: every other report test hand-builds a
// `resolution` object and calls assembleReport directly, so resolveReport —
// the function that actually READS a snapshot and performs the field
// rename/passthrough (e.g. cache_read_input_tokens -> cache_read_tokens) —
// is never exercised. A future field-name drift between collect.mjs's
// buildSnapshot and report.mjs's resolveReport would leave the suite green
// while the shipped plugin silently reports null/—. These tests build real
// snapshots via buildSnapshot, write them via writeSnapshot, read them back
// via resolveReport, and assert the round-tripped values — including that
// concurrent same-account sessions never read each other's numbers (C1).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot } from '../plugins/claude-context/scripts/collect.mjs';
import { writeSnapshot } from '../plugins/claude-context/scripts/lib/snapshot.mjs';
import { snapshotFileName } from '../plugins/claude-context/scripts/lib/config-dir.mjs';
import { resolveReport, assembleReport } from '../plugins/claude-context/scripts/report.mjs';

const NOW = Date.parse('2026-07-07T13:00:04.000Z');

const stdin = {
  session_id: 'sid-int',
  model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
  context_window: {
    context_window_size: 200000,
    used_percentage: 46,
    current_usage: { input_tokens: 1200, cache_read_input_tokens: 88000, cache_creation_input_tokens: 2800, output_tokens: 0 },
  },
  cost: { total_cost_usd: 0.42 },
  rate_limits: {
    five_hour: { used_percentage: 25, resets_at: 1751898600 },
    seven_day: { used_percentage: 61, resets_at: 1752166800 },
  },
  transcript_path: null,
};

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `cc-${tag}-`)); }
function writeSnap(dir, sid, snap, now) { return writeSnapshot(path.join(dir, snapshotFileName(sid)), snap, { now }); }

test('collector -> report seam: resolveReport reads a real buildSnapshot() output without dropping/renaming fields', () => {
  const dir = tmpDir('integration');
  assert.equal(writeSnap(dir, 'sid-int', buildSnapshot(stdin, NOW), NOW), true);

  const later = NOW + 1000;
  const resolution = resolveReport({ now: later, sessionId: 'sid-int', snapshotDir: dir, cwd: '/nonexistent', deps: fs, env: {} });
  const { human, json } = assembleReport(resolution, later);

  assert.equal(json.source, 'collector');
  assert.equal(json.rate_limits_status, 'available');
  assert.equal(json.session_selection, 'session_id');
  assert.equal(json.context.window_size, 200000);
  // Field-rename seam: stdin's cache_read_input_tokens/cache_creation_input_tokens
  // must survive buildSnapshot's rename to cache_read_tokens/cache_creation_tokens
  // and resolveReport's passthrough into the rendered JSON.
  assert.equal(json.context.cache_read_tokens, 88000);
  assert.equal(json.context.cache_creation_tokens, 2800);
  assert.equal(json.context.used_tokens, 1200 + 88000 + 2800);
  assert.equal(json.rate_limits.five_hour.used_percentage, 25);
  // Seams every other test skips (all cost assertions elsewhere use hand-built
  // resolutions): a rename in any of these would ship null/— with the suite green.
  assert.equal(json.cost_usd, 0.42);                              // snapshot.cost.total_cost_usd -> json.cost_usd
  assert.equal(json.rate_limits.seven_day.used_percentage, 61);  // the second window round-trips too
  assert.equal(json.context.used_percentage, 46);                // native used_percentage passthrough
  assert.equal(json.context.headroom_tokens, 200000 - (1200 + 88000 + 2800)); // derived from round-tripped fields
  assert.match(human, /^Source: collector/m);
});

test('C1: each session reads its OWN keyed snapshot, never a concurrent session\'s numbers', () => {
  const dir = tmpDir('concurrent');
  const stdinA = { session_id: 'sess-A', context_window: { context_window_size: 200000, used_percentage: 80, current_usage: { input_tokens: 160000 } }, transcript_path: null };
  const stdinB = { session_id: 'sess-B', context_window: { context_window_size: 200000, used_percentage: 12, current_usage: { input_tokens: 24000 } }, transcript_path: null };
  writeSnap(dir, 'sess-A', buildSnapshot(stdinA, NOW), NOW);
  writeSnap(dir, 'sess-B', buildSnapshot(stdinB, NOW), NOW);
  // Make A's file the most-recently-modified: A is the "most-recently-active" session,
  // the exact condition that leaked A's numbers into B's report under one shared file.
  const future = Math.floor((NOW + 60000) / 1000);
  fs.utimesSync(path.join(dir, snapshotFileName('sess-A')), future, future);

  const later = NOW + 1000;
  const res = resolveReport({ now: later, sessionId: 'sess-B', snapshotDir: dir, cwd: '/nonexistent', deps: fs, env: {} });
  const { json } = assembleReport(res, later);
  assert.equal(json.context.used_percentage, 12); // B's own fill, NOT A's 80%
  assert.equal(json.session_selection, 'session_id');
});

test("C1 (stale branch): a FOREIGN newest snapshot never sizes THIS session's usage against the foreign window under a session_id label", () => {
  // Regression for the collector-idle path. Trigger: this session (sess-B) has its own
  // transcript but NO own keyed snapshot yet (e.g. collector just enabled mid-session),
  // while a neighbor 1M-window session (sess-A) has gone idle and left the newest, but
  // STALE, snapshot in the dir. The old code sized sess-B's transcript tokens against
  // sess-A's 1,000,000 window and stamped the result session_id — a ~5x-low context %.
  const dir = tmpDir('c1-stale');

  // sess-A: idle 1M-window session. Its stale snapshot is the newest file, and it points
  // at its OWN transcript (800k tokens → 80% of 1M — internally consistent).
  const aTranscript = path.join(dir, 'A.jsonl');
  fs.writeFileSync(aTranscript, `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8[1m]', usage: { input_tokens: 800000 } } })}\n`);
  const past = NOW - 10 * 60 * 1000; // 10 min → stale
  const stdinA = { session_id: 'sess-A', model: { id: 'claude-opus-4-8[1m]' }, context_window: { context_window_size: 1000000, used_percentage: 80, current_usage: { input_tokens: 800000 } }, transcript_path: aTranscript };
  writeSnap(dir, 'sess-A', buildSnapshot(stdinA, past), past);

  // sess-B: THIS session. It has its own transcript (24k tokens) at the cwd-encoded path
  // the old code resolved via transcriptForSession — but no snapshot of its own. If the
  // fix regressed, 24000 / 1,000,000 → ~2%, stamped session_id.
  const cwd = '/proj';
  const bDir = path.join(dir, 'projects', '-proj'); // encodeProjectDir('/proj')
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(path.join(bDir, 'sess-B.jsonl'), `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 24000 } } })}\n`);

  const res = resolveReport({ now: NOW, sessionId: 'sess-B', snapshotDir: dir, cwd, deps: fs, env: { CLAUDE_CONFIG_DIR: dir } });
  const { json } = assembleReport(res, NOW);

  // The one guarantee the contract makes: an unverifiable window is never labeled certain.
  assert.equal(json.session_selection, 'unverified-snapshot');
  assert.notEqual(json.session_selection, 'session_id');
  // Window and usage now describe the SAME session (sess-A's snapshot + its own transcript),
  // so the percentage is internally consistent — not sess-B's tokens over sess-A's window.
  assert.equal(json.context.window_size, 1000000);
  assert.equal(json.context.used_tokens, 800000);
  assert.equal(json.context.used_percentage, 80);
});

test('no session id (older Claude Code / subagent): falls back to the newest snapshot, flagged unverified', () => {
  const dir = tmpDir('unverified');
  const s = { session_id: 'whoever', context_window: { context_window_size: 200000, used_percentage: 33, current_usage: { input_tokens: 66000 } }, transcript_path: null };
  writeSnap(dir, 'whoever', buildSnapshot(s, NOW), NOW);

  const later = NOW + 1000;
  const res = resolveReport({ now: later, sessionId: null, snapshotDir: dir, cwd: '/nonexistent', deps: fs, env: {} });
  const { human, json } = assembleReport(res, later);
  assert.equal(json.source, 'collector');
  assert.equal(json.context.used_percentage, 33);
  assert.equal(json.session_selection, 'unverified-snapshot');
  assert.match(human, /session: unverified/);
});

test('cold start (no snapshot ever): resolveReport returns not-set-up without inventing numbers', () => {
  const dir = tmpDir('coldstart'); // empty snapshot dir
  const res = resolveReport({ now: NOW, sessionId: 'nobody', snapshotDir: dir, cwd: '/nonexistent', deps: fs, env: {} });
  const { json } = assembleReport(res, NOW);
  assert.equal(json.source, 'unavailable');
  assert.equal(json.setup_required, true);
  assert.equal(json.rate_limits_status, 'unavailable_collector');
  assert.equal(json.compactions, null);       // transcript I/O skipped entirely
  assert.equal(json.context.window_size, null); // no window ever inferred
});

test('stale snapshot, no transcript: resolveReport falls back to the snapshot context as source collector', () => {
  const dir = tmpDir('stale');
  const past = NOW - 10 * 60 * 1000; // 10 min before "now" → past the 5-min freshness window
  writeSnap(dir, 'sid-stale', buildSnapshot(stdin, past), past);
  const res = resolveReport({ now: NOW, sessionId: 'sid-stale', snapshotDir: dir, cwd: '/nonexistent', deps: fs, env: {} });
  const { json } = assembleReport(res, NOW);
  assert.equal(json.source, 'collector');
  assert.equal(json.rate_limits_status, 'unavailable_stale');
  assert.equal(json.context.window_size, 200000); // real window from the snapshot, not inferred
  assert.equal(json.context.used_percentage, 46);  // accurate against the real window
  assert.equal(json.setup_required, false);
});
