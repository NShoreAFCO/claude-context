// scripts/lib/command.mjs
import { markerAssignment } from './marker.mjs';

// Version-resolution glob, evaluated at every statusline refresh (~300ms). Identical shape
// to the shipped collect launcher in commands/setup.md; only the sort differs by platform.
function globExpr(platform) {
  if (platform === 'gitbash') {
    // Git Bash: sort -V avoids nested quoting (per claude-hud's Git Bash branch).
    return 'plugin_dir=$(ls -1d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null | sort -V | tail -1)';
  }
  // POSIX (macOS/Linux). Numeric sort on the version segment; ported verbatim from setup.md.
  return [
    'plugin_dir=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null',
    '| awk -F/ \'{ print $(NF-1) "\\t" $0 }\'',
    "| grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+[[:space:]]'",
    '| sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-)',
  ].join(' ');
}

// Escape a body for embedding inside a single-quoted bash -c '<body>'.
function shSingleQuote(body) {
  return `'${body.replace(/'/g, `'"'"'`)}'`;
}

export function buildStatuslineCommand({ variant, runtime, platform = 'posix' }) {
  if (variant !== 'collect' && variant !== 'coexist') throw new Error(`bad variant: ${variant}`);
  if (typeof runtime !== 'string' || runtime.trim() === '') throw new Error('runtime required');
  const marker = markerAssignment(variant); // CLAUDE_CONTEXT_WRAPPER=<variant>
  const body = `export ${marker}; ${globExpr(platform)}; exec "${runtime}" "\${plugin_dir}scripts/${variant}.mjs"`;
  return `bash -c ${shSingleQuote(body)}`;
}
