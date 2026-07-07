// tests/snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSnapshot, readSnapshot, findNewestSnapshot, FRESHNESS_MS } from '../plugins/claude-context/scripts/lib/snapshot.mjs';

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

test('writeSnapshot keeps the snapshot dir private (0700), tightening a pre-existing 0755 dir', () => {
  if (process.platform === 'win32') return; // POSIX modes only
  // Fresh dir: created private.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mode-'));
  const dir = path.join(base, 'claude-context');
  writeSnapshot(path.join(dir, 'snapshot.json'), snap(), { now: 1000 });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

  // Pre-existing world-traversable dir (as an older version left it): tightened on write.
  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mode2-'));
  const dir2 = path.join(base2, 'claude-context');
  fs.mkdirSync(dir2, { recursive: true });
  fs.chmodSync(dir2, 0o755);
  writeSnapshot(path.join(dir2, 'snapshot.json'), snap(), { now: 1000 });
  assert.equal(fs.statSync(dir2).mode & 0o777, 0o700);
});

test('findNewestSnapshot returns the newest snapshot-*.json, ignoring temp and non-snapshot files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-newest-'));
  fs.writeFileSync(path.join(dir, 'snapshot-a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'snapshot-b.json'), '{}');
  fs.writeFileSync(path.join(dir, '.snapshot-b.json.42.99.tmp'), '{}'); // in-flight temp: ignored
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'); // not a snapshot: ignored
  const future = Math.floor(Date.now() / 1000) + 100;
  fs.utimesSync(path.join(dir, 'snapshot-b.json'), future, future); // make b newest
  assert.equal(findNewestSnapshot(dir), path.join(dir, 'snapshot-b.json'));
});

test('findNewestSnapshot returns null for a missing or snapshot-free dir', () => {
  assert.equal(findNewestSnapshot('/no/such/dir'), null);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-empty-'));
  fs.writeFileSync(path.join(empty, 'notes.txt'), 'x');
  assert.equal(findNewestSnapshot(empty), null);
});

test('writeSnapshot cleans up its temp file when the atomic rename fails', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tmp-'));
  const dir = path.join(base, 'nested');
  const p = path.join(dir, 'snapshot.json');
  const unlinked = [];
  const deps = {
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    readFileSync: fs.readFileSync,
    mkdirSync: fs.mkdirSync,
    chmodSync: () => {},
    writeFileSync: fs.writeFileSync,
    renameSync: () => { throw new Error('rename boom'); },
    unlinkSync: (f) => { unlinked.push(f); fs.unlinkSync(f); },
  };
  assert.equal(writeSnapshot(p, snap(), { now: 1000, deps }), false);
  assert.equal(unlinked.length, 1); // the temp file was removed
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []); // none orphaned
});
