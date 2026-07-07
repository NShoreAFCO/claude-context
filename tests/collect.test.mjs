import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, compactLine } from '../scripts/collect.mjs';

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
  transcript_path: '/Users/x/session.jsonl',
};

test('buildSnapshot maps stdin, prefers native %, converts epoch seconds', () => {
  const s = buildSnapshot(stdin, 1751895000000);
  assert.equal(s.context.window_size, 200000);
  assert.equal(s.context.used_tokens, 92000);
  assert.equal(s.context.used_percentage, 46);
  assert.equal(s.rate_limits.five_hour.used_percentage, 25);
  assert.equal(s.rate_limits.five_hour.resets_at, new Date(1751898600000).toISOString());
  assert.equal(s.cost.total_cost_usd, 0.42);
  assert.equal(s.transcript_path, '/Users/x/session.jsonl');
});

test('buildSnapshot computes % when native absent, and nulls rate_limits when absent', () => {
  const s = buildSnapshot({ context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } } }, 0);
  assert.equal(s.context.used_percentage, 50);
  assert.equal(s.rate_limits, null);
});

test('buildSnapshot treats native used_percentage=0 as unpopulated and computes from tokens', () => {
  const s = buildSnapshot({ context_window: { context_window_size: 200000, used_percentage: 0, current_usage: { input_tokens: 1200, cache_read_input_tokens: 88000, cache_creation_input_tokens: 2800 } } }, 0);
  assert.equal(s.context.used_percentage, 46); // 92000 / 200000, not the literal 0
});

test('compactLine shows context and any rate limits', () => {
  assert.equal(compactLine(buildSnapshot(stdin, 0)), 'Context 46% · 5h 25% · 7d 61%');
  assert.equal(compactLine(buildSnapshot({ context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } } }, 0)), 'Context 50%');
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

test('golden: real statusline stdin maps without losing fields', () => {
  const raw = JSON.parse(readFileSync(path.join(here, 'fixtures', 'real-stdin.json'), 'utf8'));
  const s = buildSnapshot(raw, 0);
  assert.equal(typeof s.context.window_size, 'number');
  assert.ok(s.context.used_percentage === null || typeof s.context.used_percentage === 'number');
  // If this capture carried rate_limits, they must survive mapping as ISO resets.
  if (raw.rate_limits?.five_hour) {
    assert.ok(s.rate_limits, 'rate_limits in stdin must map to a non-null snapshot block');
    assert.match(s.rate_limits.five_hour.resets_at ?? '', /^\d{4}-\d\d-\d\dT/);
  }
});
