// tests/wiring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect } from '../plugins/claude-context/scripts/wiring.mjs';

function mkCfg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wire-'));
}
function writeSettings(cfg, obj) {
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(obj, null, 2));
}
function writeSidecar(cfg, original) {
  fs.mkdirSync(path.join(cfg, 'claude-context'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'claude-context', 'coexist.json'),
    JSON.stringify({ original, wrapped_at: new Date(0).toISOString() }),
  );
}
const COLLECT = "bash -c 'export CLAUDE_CONTEXT_WRAPPER=collect; exec node x/scripts/collect.mjs'";
const COEXIST = "bash -c 'export CLAUDE_CONTEXT_WRAPPER=coexist; exec node x/scripts/coexist.mjs'";
const FOREIGN = 'bun run ~/.claude/claude-hud/statusline.js';

test('detect: empty slot (no settings file)', () => {
  const r = detect({ env: { CLAUDE_CONFIG_DIR: mkCfg() } });
  assert.equal(r.slot, 'empty');
  assert.equal(r.preview, null);
  assert.equal(r.hasSidecar, false);
});

test('detect: our markers classify as ours-collect / ours-coexist', () => {
  const c1 = mkCfg();
  writeSettings(c1, { statusLine: { type: 'command', command: COLLECT } });
  assert.equal(detect({ env: { CLAUDE_CONFIG_DIR: c1 } }).slot, 'ours-collect');
  const c2 = mkCfg();
  writeSettings(c2, { statusLine: { type: 'command', command: COEXIST } });
  assert.equal(detect({ env: { CLAUDE_CONFIG_DIR: c2 } }).slot, 'ours-coexist');
});

test('detect: foreign slot yields a REDACTED preview, never the raw secret', () => {
  const cfg = mkCfg();
  writeSettings(cfg, {
    statusLine: { type: 'command', command: 'run --token ghp_ABCDEFGH12345678' },
  });
  const r = detect({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.slot, 'foreign');
  assert.doesNotMatch(r.preview, /ghp_ABCDEFGH12345678/);
});

test('detect: sidecarMatchesSlot true when the sidecar stored THIS foreign command', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: FOREIGN } });
  writeSidecar(cfg, { type: 'command', command: FOREIGN });
  const r = detect({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.slot, 'foreign');
  assert.equal(r.hasSidecar, true);
  assert.equal(r.sidecarMatchesSlot, true);
});

test('detect: unparseable settings.json → error slot (never overwrite what we cannot read)', () => {
  const cfg = mkCfg();
  fs.writeFileSync(path.join(cfg, 'settings.json'), '{ this is not json ');
  assert.equal(detect({ env: { CLAUDE_CONFIG_DIR: cfg } }).slot, 'error');
});
