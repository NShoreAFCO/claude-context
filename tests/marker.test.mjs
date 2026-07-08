import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER_VAR, markerAssignment, detectMarker } from '../plugins/claude-context/scripts/lib/marker.mjs';

test('markerAssignment emits a stable env-assignment sentinel', () => {
  assert.equal(MARKER_VAR, 'CLAUDE_CONTEXT_WRAPPER');
  assert.equal(markerAssignment('collect'), 'CLAUDE_CONTEXT_WRAPPER=collect');
  assert.equal(markerAssignment('coexist'), 'CLAUDE_CONTEXT_WRAPPER=coexist');
  assert.throws(() => markerAssignment('nope'));
});

test('detectMarker keys on presence + variant, not the resolved path', () => {
  // Different resolved paths, same variant → still detected.
  assert.equal(detectMarker("bash -c 'export CLAUDE_CONTEXT_WRAPPER=coexist; exec \"/a/node\" x'"), 'coexist');
  assert.equal(detectMarker("bash -c 'export CLAUDE_CONTEXT_WRAPPER=collect; exec \"/b/bun\" y'"), 'collect');
});

test('detectMarker returns null for foreign / empty / non-string', () => {
  assert.equal(detectMarker('bun run ~/.claude/claude-hud/statusline.js'), null);
  assert.equal(detectMarker(''), null);
  assert.equal(detectMarker(null), null);
  assert.equal(detectMarker(undefined), null);
});
