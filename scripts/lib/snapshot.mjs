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
  try {
    const dir = path.dirname(snapshotPath);
    deps.mkdirSync(dir, { recursive: true });
    if (!shouldWrite(snapshotPath, snapshot, now, deps)) return false;
    const tmp = path.join(dir, `.${path.basename(snapshotPath)}.${process.pid}.${now}.tmp`);
    deps.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    deps.renameSync(tmp, snapshotPath);
    deps.chmodSync(snapshotPath, 0o600);
    return true;
  } catch {
    return false;
  }
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
