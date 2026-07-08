// The ownership marker embedded in every statusLine command claude-context writes, so
// setup/teardown can recognize its own slot without exact-matching a resolved command
// string (which legitimately changes across plugin upgrades, bun-vs-node, CLAUDE_CONFIG_DIR).
export const MARKER_VAR = 'CLAUDE_CONTEXT_WRAPPER';

const VARIANTS = new Set(['collect', 'coexist']);

export function markerAssignment(variant) {
  if (!VARIANTS.has(variant)) throw new Error(`bad marker variant: ${variant}`);
  return `${MARKER_VAR}=${variant}`;
}

export function detectMarker(command) {
  if (typeof command !== 'string') return null;
  if (command.includes(`${MARKER_VAR}=coexist`)) return 'coexist';
  if (command.includes(`${MARKER_VAR}=collect`)) return 'collect';
  return null;
}
