// tests/wiring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, wrap, teardown } from '../plugins/claude-context/scripts/wiring.mjs';
import { detectMarker } from '../plugins/claude-context/scripts/lib/marker.mjs';

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

const RUNTIME = '/usr/bin/node';
function readSettingsFile(cfg) {
  return JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
}
function readSidecarFile(cfg) {
  return JSON.parse(fs.readFileSync(path.join(cfg, 'claude-context', 'coexist.json'), 'utf8'));
}

test('wrap: empty slot → wires collect, marked, no sidecar', () => {
  const cfg = mkCfg();
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'wired-collect');
  assert.equal(detectMarker(readSettingsFile(cfg).statusLine.command), 'collect');
  assert.equal(fs.existsSync(path.join(cfg, 'claude-context', 'coexist.json')), false);
});

test('wrap: foreign → stores the WHOLE original statusLine object + wires coexist, preserving other keys', () => {
  const cfg = mkCfg();
  writeSettings(cfg, {
    model: 'opus',
    statusLine: { type: 'command', command: FOREIGN, padding: 1 },
  });
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'wired-coexist');
  const settings = readSettingsFile(cfg);
  assert.equal(detectMarker(settings.statusLine.command), 'coexist');
  assert.equal(settings.model, 'opus', 'other settings keys preserved');
  assert.deepEqual(readSidecarFile(cfg).original, {
    type: 'command',
    command: FOREIGN,
    padding: 1,
  });
});

test('wrap: writes exactly ONE full-file backup, mode 0600, before mutating', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: FOREIGN } });
  wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  const bak = path.join(cfg, 'settings.json.claude-context.bak');
  assert.ok(fs.existsSync(bak), 'backup exists');
  assert.match(
    JSON.parse(fs.readFileSync(bak, 'utf8')).statusLine.command,
    /statusline\.js|claude-hud|bun run/,
  );
  if (process.platform !== 'win32') assert.equal(fs.statSync(bak).mode & 0o777, 0o600);
});

test('wrap: idempotent for already-ours via marker, never nests', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: COEXIST } });
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'refreshed-coexist');
  const cmd = readSettingsFile(cfg).statusLine.command;
  assert.equal(detectMarker(cmd), 'coexist');
  assert.equal((cmd.match(/CLAUDE_CONTEXT_WRAPPER=coexist/g) || []).length, 1, 'no nested re-wrap');
});

test('wrap: orphaned sidecar — slot matches stored original → resume', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: FOREIGN } });
  writeSidecar(cfg, { type: 'command', command: FOREIGN });
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'resumed-coexist');
  assert.equal(detectMarker(readSettingsFile(cfg).statusLine.command), 'coexist');
});

test('wrap: orphaned sidecar — slot DIFFERS → conflict, no overwrite of the stored pointer', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: 'some-third-tool' } });
  writeSidecar(cfg, { type: 'command', command: FOREIGN });
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'conflict');
  assert.match(r.storedOriginalPreview, /claude-hud|statusline\.js|bun run/);
  // The slot and the sidecar are both untouched.
  assert.equal(readSettingsFile(cfg).statusLine.command, 'some-third-tool');
  assert.equal(readSidecarFile(cfg).original.command, FOREIGN);
});

test('teardown: coexist + sidecar → restores the original verbatim, removes sidecar + backup', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { model: 'opus', statusLine: { type: 'command', command: COEXIST } });
  writeSidecar(cfg, { type: 'command', command: FOREIGN, padding: 2 });
  fs.writeFileSync(path.join(cfg, 'settings.json.claude-context.bak'), '{}');
  const r = teardown({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.action, 'restored-original');
  const settings = readSettingsFile(cfg);
  assert.deepEqual(settings.statusLine, { type: 'command', command: FOREIGN, padding: 2 });
  assert.equal(settings.model, 'opus', 'other keys preserved');
  assert.equal(fs.existsSync(path.join(cfg, 'claude-context', 'coexist.json')), false);
  assert.equal(fs.existsSync(path.join(cfg, 'settings.json.claude-context.bak')), false);
});

test('teardown: bare collect marker (empty-slot install) → removes our statusLine entry', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: COLLECT } });
  const r = teardown({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.action, 'removed-collect');
  assert.equal('statusLine' in readSettingsFile(cfg), false);
});

test('teardown: NEVER clobbers a slot we do not own', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: 'third-party-tool' } });
  writeSidecar(cfg, { type: 'command', command: FOREIGN });
  const r = teardown({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.action, 'not-ours');
  assert.match(r.storedOriginalPreview, /claude-hud|statusline\.js|bun run/);
  assert.equal(readSettingsFile(cfg).statusLine.command, 'third-party-tool', 'slot untouched');
});

test('teardown: nothing of ours wired → idempotent no-op', () => {
  assert.equal(teardown({ env: { CLAUDE_CONFIG_DIR: mkCfg() } }).action, 'noop-nothing-wired');
});
