// tests/model-window.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferWindowSize } from '../scripts/lib/model-window.mjs';

test('defaults to 200k', () => {
  assert.equal(inferWindowSize({ id: 'claude-opus-4-8' }), 200000);
  assert.equal(inferWindowSize({ id: 'claude-sonnet-5' }), 200000);
  assert.equal(inferWindowSize(null), 200000);
});

test('detects 1M variants', () => {
  assert.equal(inferWindowSize({ id: 'claude-opus-4-8[1m]' }), 1000000);
  assert.equal(inferWindowSize({ id: 'claude-sonnet-5-1m' }), 1000000);
});
