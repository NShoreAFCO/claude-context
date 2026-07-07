// Adapted from claude-hud (MIT, © Jarrod Watts): config directory resolution.
import os from 'node:os';
import path from 'node:path';

export function resolveConfigDir(env = process.env) {
  const override = env.CLAUDE_CONFIG_DIR;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return path.join(os.homedir(), '.claude');
}

export function snapshotPath(env = process.env) {
  return path.join(resolveConfigDir(env), 'claude-context', 'snapshot.json');
}
