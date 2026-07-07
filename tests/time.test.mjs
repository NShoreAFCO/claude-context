import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epochToMs, formatDuration, clockHM } from '../scripts/lib/time.mjs';

test('epochToMs distinguishes seconds from milliseconds', () => {
  assert.equal(epochToMs(1751892600), 1751892600000);
  assert.equal(epochToMs(1751892600000), 1751892600000);
  assert.equal(epochToMs(0), null);
  assert.equal(epochToMs('x'), null);
});

test('epochToMs rejects values beyond the max representable Date (no RangeError downstream)', () => {
  // new Date(ms).toISOString() throws RangeError for |ms| > 8.64e15. A garbage
  // resets_at at that magnitude must be dropped, not passed through.
  assert.equal(epochToMs(8.64e15), 8.64e15); // exactly at the boundary is still valid
  assert.equal(epochToMs(8.64e15 + 1), null);
  assert.doesNotThrow(() => new Date(epochToMs(8.64e15)).toISOString());
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
