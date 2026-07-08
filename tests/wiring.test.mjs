// tests/wiring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detect, wrap, teardown } from '../plugins/claude-context/scripts/wiring.mjs';
import { detectMarker } from '../plugins/claude-context/scripts/lib/marker.mjs';

const wiringPath = fileURLToPath(
  new URL('../plugins/claude-context/scripts/wiring.mjs', import.meta.url),
);

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

test('detect: a statusLine present but with no usable command classifies foreign, not empty', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command' } }); // no `command` string
  assert.equal(detect({ env: { CLAUDE_CONFIG_DIR: cfg } }).slot, 'foreign');
});

test('detect: a bare-string settings.json → error slot (not a spreadable object)', () => {
  const cfg = mkCfg();
  fs.writeFileSync(path.join(cfg, 'settings.json'), '"just a string"');
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

test('wrap: foreign slot + missing runtime → throws BEFORE writing any sidecar or backup', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: FOREIGN } });
  // buildStatuslineCommand throws on a blank runtime; it must fire before the first write,
  // so a bad-runtime foreign wrap leaves no stray sidecar/backup to wedge a later run.
  assert.throws(() => wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0 }));
  assert.equal(
    fs.existsSync(path.join(cfg, 'claude-context', 'coexist.json')),
    false,
    'no stray sidecar',
  );
  assert.equal(
    fs.existsSync(path.join(cfg, 'settings.json.claude-context.bak')),
    false,
    'no stray backup',
  );
  assert.equal(readSettingsFile(cfg).statusLine.command, FOREIGN, 'slot untouched');
});

test('wrap: a failing rename leaves no .tmp file behind (atomic writers clean up)', () => {
  const cfg = mkCfg();
  const deps = {
    ...fs,
    renameSync: () => {
      throw new Error('EXDEV');
    },
  };
  assert.throws(() => wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME, deps }));
  const leftovers = fs.readdirSync(cfg).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'temp file unlinked after the rename failed');
});

test('wrap: a chmod failure after a successful rename does not fail the write', () => {
  const cfg = mkCfg();
  const deps = {
    ...fs,
    chmodSync: () => {
      throw new Error('EPERM');
    },
  };
  // The mode is already applied at temp-write time, so the trailing chmod is best-effort.
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME, deps });
  assert.equal(r.action, 'wired-collect');
  assert.equal(detectMarker(readSettingsFile(cfg).statusLine.command), 'collect');
});

test('wrap: tightens an existing loose sidecar dir to 0700', () => {
  if (process.platform === 'win32') return;
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: FOREIGN } });
  const scDir = path.join(cfg, 'claude-context');
  fs.mkdirSync(scDir, { recursive: true });
  fs.chmodSync(scDir, 0o755); // simulate a loose dir left by an older version / umask
  wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(fs.statSync(scDir).mode & 0o777, 0o700, 'sidecar dir re-tightened to 0700');
});

test('wrap: a statusLine with no usable command is co-existed (foreign), never seized', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', padding: 3 } }); // present, no `command`
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'wired-coexist', 'foreign path — original preserved, slot not seized');
  // The whole original object is stored verbatim so teardown restores it.
  assert.deepEqual(readSidecarFile(cfg).original, { type: 'command', padding: 3 });
  assert.equal(detectMarker(readSettingsFile(cfg).statusLine.command), 'coexist');
});

test('wrap: a bare-string settings.json is unparseable, never spread into an object', () => {
  const cfg = mkCfg();
  fs.writeFileSync(path.join(cfg, 'settings.json'), '"just a string"');
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'error');
  assert.equal(r.reason, 'unparseable-settings');
  assert.equal(
    fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'),
    '"just a string"',
    'file left untouched — not corrupted into indexed-char keys',
  );
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

test('teardown: coexist marker but sidecar lost → removes our statusLine entry, preserves siblings, drops backup', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { model: 'opus', statusLine: { type: 'command', command: COEXIST } });
  fs.writeFileSync(path.join(cfg, 'settings.json.claude-context.bak'), '{}');
  const r = teardown({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.action, 'coexist-no-sidecar-removed');
  const settings = readSettingsFile(cfg);
  assert.equal('statusLine' in settings, false, 'our wrapper is removed, not written back');
  assert.equal(settings.model, 'opus', 'sibling keys survive');
  assert.equal(fs.existsSync(path.join(cfg, 'settings.json.claude-context.bak')), false);
});

test('teardown: unparseable settings.json → error, file left untouched', () => {
  const cfg = mkCfg();
  fs.writeFileSync(path.join(cfg, 'settings.json'), '{ not json ');
  const r = teardown({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.action, 'error');
  assert.equal(r.reason, 'unparseable-settings');
  assert.equal(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'), '{ not json ');
});

test('CLI: wrap with a missing --runtime prints a clean JSON error, not a stack trace', () => {
  const cfg = mkCfg();
  const r = spawnSync(process.execPath, [wiringPath, 'wrap'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'clean exit, not a crash');
  assert.equal(JSON.parse(r.stdout).action, 'error');
  assert.match(JSON.parse(r.stdout).reason, /runtime/i);
  assert.equal(r.stderr.trim(), '', 'no stderr output at all');
  assert.doesNotMatch(r.stderr, /\bat\s+.*wiring\.mjs/, 'no stack trace');
  assert.equal(fs.existsSync(path.join(cfg, 'settings.json')), false, 'nothing written');
});
