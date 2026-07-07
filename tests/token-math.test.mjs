import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usedTokens, percentage, headroom } from '../scripts/lib/token-math.mjs';

test('usedTokens sums input + cache read + cache creation', () => {
  assert.equal(usedTokens({ input_tokens: 1200, cache_read_input_tokens: 88000, cache_creation_input_tokens: 2800, output_tokens: 500 }), 92000);
});

test('usedTokens treats missing/invalid fields as 0', () => {
  assert.equal(usedTokens({}), 0);
  assert.equal(usedTokens(null), 0);
  assert.equal(usedTokens({ input_tokens: 'x', cache_read_input_tokens: 5 }), 5);
});

test('percentage and headroom', () => {
  assert.equal(percentage(92000, 200000), 46);
  assert.equal(headroom(92000, 200000), 108000);
});

test('percentage/headroom guard against zero window', () => {
  assert.equal(percentage(100, 0), null);
  assert.equal(headroom(100, 0), null);
});
