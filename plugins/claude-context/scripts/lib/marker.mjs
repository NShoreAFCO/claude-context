// The ownership marker embedded in every statusLine command claude-context writes, so
// setup/teardown can recognize its own slot without exact-matching a resolved command
// string (which legitimately changes across plugin upgrades, bun-vs-node, CLAUDE_CONFIG_DIR).
export const MARKER_VAR = 'CLAUDE_CONTEXT_WRAPPER';

const VARIANTS = new Set(['collect', 'coexist']);

export function markerAssignment(variant) {
  if (!VARIANTS.has(variant)) throw new Error(`bad marker variant: ${variant}`);
  return `${MARKER_VAR}=${variant}`;
}

// Anchored so a longer name (=coexistence, =collector) is NOT read as our slot: the
// variant must be followed by a non-identifier char (separator or end-of-string).
const MARKER_RE = new RegExp(`${MARKER_VAR}=(coexist|collect)(?![A-Za-z0-9_])`);

export function detectMarker(command) {
  if (typeof command !== 'string') return null;
  const m = command.match(MARKER_RE);
  return m ? m[1] : null;
}
