// scripts/lib/snapshot.mjs
// Adapted from claude-hud (MIT, © Jarrod Watts): src/external-usage.ts write/read robustness.
import fs from 'node:fs';
import path from 'node:path';

export const WRITE_THROTTLE_MS = 30_000;
export const FRESHNESS_MS = 5 * 60_000;

function withoutUpdatedAt(s) {
  if (!s || typeof s !== 'object') return s;
  const { updated_at, ...rest } = s;
  return rest;
}

function shouldWrite(snapshotPath, next, now, deps) {
  try {
    if (!deps.existsSync(snapshotPath)) return true;
    if (now - deps.statSync(snapshotPath).mtimeMs > WRITE_THROTTLE_MS) return true;
    const current = JSON.parse(deps.readFileSync(snapshotPath, 'utf8'));
    return JSON.stringify(withoutUpdatedAt(current)) !== JSON.stringify(withoutUpdatedAt(next));
  } catch {
    return true;
  }
}

// Persist the snapshot atomically, returning a tri-state so the caller can tell a real
// failure from a throttle no-op:
//   'written' — the snapshot was (re)written to disk
//   'skipped' — an up-to-date snapshot already exists (throttled / unchanged content)
//   'failed'  — a write error was swallowed; nothing durable was persisted this call
// The 'skipped' vs 'failed' split matters because a stale snapshot left on disk masks a
// persistent write failure from a plain existsSync check (a read-only FS still shows the
// old file), so the statusline marks 'failed' — but not 'skipped'.
export function writeSnapshot(snapshotPath, snapshot, { now = Date.now(), deps = fs } = {}) {
  let tmp = null;
  try {
    const dir = path.dirname(snapshotPath);
    deps.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to dirs it creates; tighten one an older version
    // (or a different umask) may have left world-traversable. Best-effort.
    try { deps.chmodSync(dir, 0o700); } catch { /* not ours to chmod; the 0600 file still protects content */ }
    if (!shouldWrite(snapshotPath, snapshot, now, deps)) return 'skipped';
    tmp = path.join(dir, `.${path.basename(snapshotPath)}.${process.pid}.${now}.tmp`);
    deps.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    deps.renameSync(tmp, snapshotPath);
    deps.chmodSync(snapshotPath, 0o600);
    return 'written';
  } catch {
    // Don't leak a temp file per tick when rename/chmod persistently fails.
    if (tmp) { try { deps.unlinkSync(tmp); } catch { /* already gone */ } }
    return 'failed';
  }
}

// All snapshot-*.json files in the dir, newest (highest mtime) first. The report
// tries them in order so a single corrupt / cross-version / zero-byte NEWEST file
// doesn't mask a valid older one and collapse an already-set-up user to the
// not-set-up state (it would falsely tell them to run setup).
export function listSnapshotsByMtime(dir, { deps = fs } = {}) {
  let files;
  try { files = deps.readdirSync(dir); } catch { return []; }
  const found = [];
  for (const f of files) {
    if (!f.startsWith('snapshot') || !f.endsWith('.json')) continue; // skips dot-prefixed .tmp files
    const full = path.join(dir, f);
    let mtime;
    try { mtime = deps.statSync(full).mtimeMs; } catch { continue; }
    found.push({ full, mtime });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.map((x) => x.full);
}

// Fallback for when the report can't identify its own session (older Claude Code,
// or a subagent): the newest snapshot-*.json in the dir. It may belong to another
// concurrent session, so callers must flag its provenance as unverified.
export function findNewestSnapshot(dir, { deps = fs } = {}) {
  return listSnapshotsByMtime(dir, { deps })[0] ?? null;
}

export function readSnapshot(snapshotPath, { now = Date.now(), freshnessMs = FRESHNESS_MS, deps = fs } = {}) {
  try {
    const snapshot = JSON.parse(deps.readFileSync(snapshotPath, 'utf8'));
    const updatedMs = Date.parse(snapshot?.updated_at);
    if (!Number.isFinite(updatedMs)) return null;
    const ageMs = now - updatedMs;
    // Present + parseable always returns; `fresh` distinguishes stale from absent
    // so the report can render `unavailable_stale` and reuse the real window_size.
    return { snapshot, ageSeconds: Math.max(0, Math.round(ageMs / 1000)), fresh: ageMs <= freshnessMs };
  } catch {
    return null;
  }
}
