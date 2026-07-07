import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epochToMs, formatDuration, clockHM } from '../scripts/lib/time.mjs';

test('epochToMs distinguishes seconds from milliseconds', () => {
  assert.equal(epochToMs(1751892600), 1751892600000);
  assert.equal(epochToMs(1751892600000), 1751892600000);
  assert.equal(epochToMs(0), null);
  assert.equal(epochToMs('x'), null);
});

test('formatDuration', () => {
  assert.equal(formatDuration(5400), '1h 30m');
  assert.equal(formatDuration(273600), '3d 4h');
  assert.equal(formatDuration(2700), '45m');
  assert.equal(formatDuration(30), '<1m');
  assert.equal(formatDuration(-1), null);
});

test('clockHM formats local hours:minutes', () => {
  assert.equal(clockHM(new Date(2026, 6, 7, 14, 30)), '14:30');
  assert.equal(clockHM(new Date(2026, 6, 7, 9, 5)), '09:05');
});
