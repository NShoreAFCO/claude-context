// tests/command.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildStatuslineCommand } from '../plugins/claude-context/scripts/lib/command.mjs';
import { detectMarker } from '../plugins/claude-context/scripts/lib/marker.mjs';

test('marker round-trips through the built command, for both variants and platforms', () => {
  for (const platform of ['posix', 'gitbash']) {
    assert.equal(detectMarker(buildStatuslineCommand({ variant: 'collect', runtime: '/usr/bin/node', platform })), 'collect');
    assert.equal(detectMarker(buildStatuslineCommand({ variant: 'coexist', runtime: '/usr/bin/node', platform })), 'coexist');
  }
});

test('the built command targets the right script and is a single bash -c string', () => {
  const cmd = buildStatuslineCommand({ variant: 'coexist', runtime: '/usr/bin/node', platform: 'posix' });
  assert.match(cmd, /^bash -c '/);
  assert.match(cmd, /scripts\/coexist\.mjs/);
});

test('bad inputs throw', () => {
  assert.throws(() => buildStatuslineCommand({ variant: 'nope', runtime: '/usr/bin/node' }));
  assert.throws(() => buildStatuslineCommand({ variant: 'collect', runtime: '' }));
});

// End-to-end: the built command must actually execute and exec the resolved script.
// This is the real guard against single-quote escaping bugs in the ported bash body.
test('the built command resolves the newest plugin dir and execs the target script', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cmd-'));
  // Fake an installed plugin: <cfg>/plugins/cache/mk/claude-context/0.3.0/scripts/coexist.mjs
  const scriptDir = path.join(cfg, 'plugins', 'cache', 'mk', 'claude-context', '0.3.0', 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'coexist.mjs'), 'console.log("EXEC-OK");');
  const cmd = buildStatuslineCommand({ variant: 'coexist', runtime: process.execPath, platform: 'posix' });
  const out = execFileSync('bash', ['-c', cmd], {
    input: '{}',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, HOME: cfg },
    encoding: 'utf8',
  });
  assert.match(out, /EXEC-OK/);
});
