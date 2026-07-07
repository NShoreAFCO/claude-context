// tests/report-integration.test.mjs
// Closes the collector→report seam: every other report test hand-builds a
// `resolution` object and calls assembleReport directly, so resolveReport —
// the function that actually READS a snapshot and performs the field
// rename/passthrough (e.g. cache_read_input_tokens -> cache_read_tokens) —
// is never exercised. A future field-name drift between collect.mjs's
// buildSnapshot and report.mjs's resolveReport would leave the suite green
// while the shipped plugin silently reports null/—. This test builds a real
// snapshot via buildSnapshot, writes it to disk via writeSnapshot, reads it
// back via resolveReport, and asserts the round-tripped values.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot } from '../scripts/collect.mjs';
import { writeSnapshot } from '../scripts/lib/snapshot.mjs';
import { resolveReport, assembleReport } from '../scripts/report.mjs';

const stdin = {
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

test('collector -> report seam: resolveReport reads a real buildSnapshot() output without dropping/renaming fields', () => {
  const now = Date.parse('2026-07-07T13:00:04.000Z');
  const snap = buildSnapshot(stdin, now);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-context-integration-'));
  const snapshotPath = path.join(dir, 'snapshot.json');
  const wrote = writeSnapshot(snapshotPath, snap, { now });
  assert.equal(wrote, true);

  const later = now + 1000;
  const resolution = resolveReport({ now: later, snapshotPath, cwd: '/nonexistent', deps: fs, env: {} });
  const { human, json } = assembleReport(resolution, later);

  assert.equal(json.source, 'collector');
  assert.equal(json.rate_limits_status, 'available');
  assert.equal(json.context.window_size, 200000);
  // Field-rename seam: stdin's cache_read_input_tokens/cache_creation_input_tokens
  // must survive buildSnapshot's rename to cache_read_tokens/cache_creation_tokens
  // and resolveReport's passthrough into the rendered JSON.
  assert.equal(json.context.cache_read_tokens, 88000);
  assert.equal(json.context.cache_creation_tokens, 2800);
  assert.equal(json.context.used_tokens, 1200 + 88000 + 2800);
  assert.equal(json.rate_limits.five_hour.used_percentage, 25);
  assert.match(human, /^Source: collector/m);
});
