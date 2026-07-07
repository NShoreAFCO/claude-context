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

export function writeSnapshot(snapshotPath, snapshot, { now = Date.now(), deps = fs } = {}) {
  let tmp = null;
  try {
    const dir = path.dirname(snapshotPath);
    deps.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to dirs it creates; tighten one an older version
    // (or a different umask) may have left world-traversable. Best-effort.
    try { deps.chmodSync(dir, 0o700); } catch { /* not ours to chmod; the 0600 file still protects content */ }
    if (!shouldWrite(snapshotPath, snapshot, now, deps)) return false;
    tmp = path.join(dir, `.${path.basename(snapshotPath)}.${process.pid}.${now}.tmp`);
    deps.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    deps.renameSync(tmp, snapshotPath);
    deps.chmodSync(snapshotPath, 0o600);
    return true;
  } catch {
    // Don't leak a temp file per tick when rename/chmod persistently fails.
    if (tmp) { try { deps.unlinkSync(tmp); } catch { /* already gone */ } }
    return false;
  }
}

// Fallback for when the report can't identify its own session (older Claude Code,
// or a subagent): the newest snapshot-*.json in the dir. It may belong to another
// concurrent session, so callers must flag its provenance as unverified.
export function findNewestSnapshot(dir, { deps = fs } = {}) {
  let files;
  try { files = deps.readdirSync(dir); } catch { return null; }
  let newest = null;
  let newestMtime = -Infinity;
  for (const f of files) {
    if (!f.startsWith('snapshot') || !f.endsWith('.json')) continue; // skips dot-prefixed .tmp files
    const full = path.join(dir, f);
    let mtime;
    try { mtime = deps.statSync(full).mtimeMs; } catch { continue; }
    if (mtime > newestMtime) { newestMtime = mtime; newest = full; }
  }
  return newest;
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
