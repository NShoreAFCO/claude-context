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
// Trim and reject anything unusable as a session id: a non-string, empty/whitespace, or
// an unsubstituted ${...} template. Returns the clean id, or null so a caller can fall through.
function usableSessionId(val) {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (!trimmed || /[${}]/.test(trimmed)) return null;
  return trimmed;
}

export function resolveSessionId({ argv = [], env = {} } = {}) {
  let argVal = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id') {
      argVal = argv[i + 1] ?? null;
      break;
    }
    if (typeof a === 'string' && a.startsWith('--session-id=')) {
      argVal = a.slice('--session-id='.length);
      break;
    }
  }
  // arg → env → null. An arg that is present but UNUSABLE (empty, or the literal
  // `${CLAUDE_SESSION_ID}` on a build that doesn't expand it) must fall THROUGH to the env
  // var, not short-circuit the chain to null — otherwise the arg→env→newest fallback that
  // preserves session identity breaks in the middle and degrades to a neighbor's snapshot (I1).
  return usableSessionId(argVal) ?? usableSessionId(env.CLAUDE_CODE_SESSION_ID) ?? null;
}

// The co-existence sidecar: stores the entire original statusLine object so teardown
// restores it verbatim. Same 0700 dir as the snapshot; survives plugin upgrades.
export function sidecarPath(env = process.env) {
  return path.join(snapshotDir(env), 'coexist.json');
}

// Claude Code's user settings file and the single full-file backup the wiring module
// writes before its first mutating write (see the design spec §3.5, §3.8).
export function settingsPath(env = process.env) {
  return path.join(resolveConfigDir(env), 'settings.json');
}

export function backupPath(env = process.env) {
  return path.join(resolveConfigDir(env), 'settings.json.claude-context.bak');
}
