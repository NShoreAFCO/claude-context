// scripts/lib/command.mjs
import { markerAssignment } from './marker.mjs';

// Version-resolution glob, evaluated at every statusline refresh (~300ms). Identical shape
// to the shipped collect launcher in commands/setup.md. One resolver for both POSIX and Git
// Bash: extract the version SEGMENT (awk -F/) and numeric-sort it. A whole-line `sort -V`
// (the old gitbash branch) instead orders by the cache-id dir that PRECEDES the version, so
// with claude-context cached under two cache-ids it can launch an older version (I1). Git Bash
// ships awk/grep/sort, and setup.md/teardown.md already run this exact form there.
// ponytail: single resolver for both platforms; split again only if a target shell lacks awk.
function globExpr() {
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

// `platform` is still accepted (setup.md passes it) but no longer selects a glob variant —
// the resolver is platform-agnostic now. Kept in the object shape for the wrap()/CLI contract.
export function buildStatuslineCommand({ variant, runtime }) {
  if (variant !== 'collect' && variant !== 'coexist') throw new Error(`bad variant: ${variant}`);
  if (typeof runtime !== 'string' || runtime.trim() === '') throw new Error('runtime required');
  const marker = markerAssignment(variant); // CLAUDE_CONTEXT_WRAPPER=<variant>
  // bun auto-loads the project's .env on every tick (cwd = project dir); a stray
  // CLAUDE_CONFIG_DIR or NODE_OPTIONS there would poison the collector. Neutralize it (I2).
  const isBun = runtime.replace(/\\/g, '/').split('/').pop() === 'bun';
  const runtimeArgs = isBun ? '--env-file /dev/null ' : '';
  // Single-quote the runtime at the INNER level too. The outer bash -c '<body>' escaping
  // does not protect it: it lands inside inner double quotes where $( ), backticks and ${}
  // still evaluate. shSingleQuote makes it an inert literal (and the outer shSingleQuote(body)
  // re-escapes those quotes uniformly), while still tolerating a legit path with spaces.
  const body = `export ${marker}; ${globExpr()}; exec ${shSingleQuote(runtime)} ${runtimeArgs}"\${plugin_dir}scripts/${variant}.mjs"`;
  return `bash -c ${shSingleQuote(body)}`;
}
