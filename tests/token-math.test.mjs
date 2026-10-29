import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  usedTokens,
  percentage,
  headroom,
  effectiveWindow,
  formatTokens,
} from '../plugins/claude-context/scripts/lib/token-math.mjs';

test('usedTokens sums input + cache read + cache creation', () => {
  assert.equal(
    usedTokens({
      input_tokens: 1200,
      cache_read_input_tokens: 88000,
      cache_creation_input_tokens: 2800,
      output_tokens: 500,
    }),
    92000,
  );
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

test('effectiveWindow is the smaller positive of model window and auto-compact window', () => {
  assert.equal(effectiveWindow(1000000, 400000), 400000);
  assert.equal(effectiveWindow(200000, 400000), 200000);
  assert.equal(effectiveWindow(1000000, null), 1000000);
  assert.equal(effectiveWindow(0, 400000), 400000);
  assert.equal(effectiveWindow(0, null), null);
});

test('formatTokens', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(83709), '84k');
  assert.equal(formatTokens(999600), '1M');
  assert.equal(formatTokens(1000000), '1M');
  assert.equal(formatTokens(1500000), '1.5M');
});
