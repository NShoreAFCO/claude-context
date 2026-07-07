// tests/snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSnapshot, readSnapshot, FRESHNESS_MS } from '../scripts/lib/snapshot.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  return path.join(dir, 'nested', 'snapshot.json');
}
const snap = (extra = {}) => ({ updated_at: new Date(1000).toISOString(), context: { used_percentage: 46 }, ...extra });

test('writeSnapshot writes atomically with 0600 and creates dirs', () => {
  const p = tmpFile();
  assert.equal(writeSnapshot(p, snap(), { now: 1000 }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).context, { used_percentage: 46 });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  }
});

test('readSnapshot returns snapshot + age + fresh flag when fresh', () => {
  const p = tmpFile();
  writeSnapshot(p, snap(), { now: 1000 });
  const r = readSnapshot(p, { now: 5000 });
  assert.equal(r.snapshot.context.used_percentage, 46);
  assert.equal(r.ageSeconds, 4);
  assert.equal(r.fresh, true);
});

test('readSnapshot marks stale snapshots not-fresh but still returns them', () => {
  const p = tmpFile();
  writeSnapshot(p, snap(), { now: 1000 });
  const stale = readSnapshot(p, { now: 1000 + FRESHNESS_MS + 1 });
  assert.equal(stale.fresh, false);
  assert.equal(stale.snapshot.context.used_percentage, 46); // still available for window reuse
});

test('readSnapshot returns null on missing/malformed', () => {
  assert.equal(readSnapshot('/no/such/file.json', {}), null);
});

test('readSnapshot returns null when updated_at is missing/invalid', () => {
  const p = tmpFile();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Present, parseable JSON with real content but no updated_at at all.
  fs.writeFileSync(p, JSON.stringify({ context: { used_percentage: 46 } }));
  assert.equal(readSnapshot(p, { now: 5000 }), null);
  // Present, parseable JSON with an explicitly invalid updated_at value.
  fs.writeFileSync(p, JSON.stringify({ updated_at: 'not-a-date', context: {} }));
  assert.equal(readSnapshot(p, { now: 5000 }), null);
});

test('readSnapshot returns null on corrupt JSON file', () => {
  const p = tmpFile();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{not json');
  assert.equal(readSnapshot(p, { now: 5000 }), null);
});

test('writeSnapshot skips unchanged content within throttle window', () => {
  const p = tmpFile();
  writeSnapshot(p, snap(), { now: 1000 });
  // same content (ignoring updated_at), 10s later, still within 30s throttle
  assert.equal(writeSnapshot(p, snap({ updated_at: new Date(11000).toISOString() }), { now: 11000 }), false);
});
