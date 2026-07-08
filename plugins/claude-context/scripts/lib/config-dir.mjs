// Adapted from claude-hud (MIT, © Jarrod Watts): config directory resolution.
import os from 'node:os';
import path from 'node:path';

export function resolveConfigDir(env = process.env) {
  const override = env.CLAUDE_CONFIG_DIR;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return path.join(os.homedir(), '.claude');
}

export function snapshotDir(env = process.env) {
  return path.join(resolveConfigDir(env), 'claude-context');
}

// Reduce a session id to a single filesystem-safe path segment. Returns null for
// anything unusable (empty, an unsubstituted ${...} template, or a bare dot/dot-dot)
// so callers can decide the fallback. Real session ids are UUIDs and pass through
// unchanged; the substitution is a defensive guard against path traversal.
export function sanitizeSessionId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed || /[${}]/.test(trimmed)) return null;
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '-');
  if (safe === '' || safe === '.' || safe === '..') return null;
  return safe;
}

// The snapshot is keyed by session id so concurrent same-account sessions never
// share (and thrash) one file. 'unknown' is only reached if a session id is missing.
export function snapshotFileName(sessionId) {
  return `snapshot-${sanitizeSessionId(sessionId) ?? 'unknown'}.json`;
}

export function snapshotPath(sessionId, env = process.env) {
  return path.join(snapshotDir(env), snapshotFileName(sessionId));
}

// The report has no stdin, so it learns its own session id from the skill-passed
// `--session-id ${CLAUDE_SESSION_ID}` (substituted since Claude Code v2.1.9), or
// the CLAUDE_CODE_SESSION_ID env var, or neither (older versions) — in which case
// it falls back to the newest snapshot / cwd heuristic with honest provenance.
export function resolveSessionId({ argv = [], env = {} } = {}) {
  let val = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id') {
      val = argv[i + 1] ?? null;
      break;
    }
    if (typeof a === 'string' && a.startsWith('--session-id=')) {
      val = a.slice('--session-id='.length);
      break;
    }
  }
  if (val == null) val = env.CLAUDE_CODE_SESSION_ID ?? null;
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (!trimmed || /[${}]/.test(trimmed)) return null; // reject unsubstituted templates
  return trimmed;
}
