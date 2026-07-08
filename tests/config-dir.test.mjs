// tests/config-dir.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  resolveConfigDir,
  snapshotDir,
  snapshotFileName,
  snapshotPath,
  resolveSessionId,
  sidecarPath,
  settingsPath,
  backupPath,
} from '../plugins/claude-context/scripts/lib/config-dir.mjs';

test('honors CLAUDE_CONFIG_DIR when set', () => {
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }), '/tmp/cfg');
});

test('falls back to homedir/.claude', () => {
  assert.equal(resolveConfigDir({}), path.join(os.homedir(), '.claude'));
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '  ' }), path.join(os.homedir(), '.claude'));
});

test('snapshotDir appends claude-context', () => {
  assert.equal(
    snapshotDir({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }),
    path.join('/tmp/cfg', 'claude-context'),
  );
});

test('snapshotPath keys the file by session id', () => {
  assert.equal(
    snapshotPath('abc-123', { CLAUDE_CONFIG_DIR: '/tmp/cfg' }),
    path.join('/tmp/cfg', 'claude-context', 'snapshot-abc-123.json'),
  );
});

test('snapshotFileName sanitizes unsafe ids to a single traversal-free segment', () => {
  assert.doesNotMatch(snapshotFileName('a/b/../c'), /[\\/]/); // never a path separator
  assert.equal(snapshotFileName(''), 'snapshot-unknown.json');
  assert.equal(snapshotFileName(null), 'snapshot-unknown.json');
  assert.equal(snapshotFileName('9cb01c18-f694'), 'snapshot-9cb01c18-f694.json'); // real UUIDs pass through
});

test('resolveSessionId: --session-id arg wins, then env, else null; placeholders/empties are absent', () => {
  assert.equal(
    resolveSessionId({ argv: ['node', 'r', '--session-id', 'sid-1'], env: {} }),
    'sid-1',
  );
  assert.equal(resolveSessionId({ argv: ['node', 'r', '--session-id=sid-2'], env: {} }), 'sid-2');
  assert.equal(
    resolveSessionId({ argv: ['node', 'r'], env: { CLAUDE_CODE_SESSION_ID: 'sid-env' } }),
    'sid-env',
  );
  assert.equal(
    resolveSessionId({
      argv: ['node', 'r', '--session-id', 'sid-arg'],
      env: { CLAUDE_CODE_SESSION_ID: 'sid-env' },
    }),
    'sid-arg',
  );
  assert.equal(resolveSessionId({ argv: ['node', 'r'], env: {} }), null);
  // An older Claude Code that doesn't substitute ${CLAUDE_SESSION_ID} passes the literal template through: treat as absent.
  assert.equal(
    resolveSessionId({ argv: ['node', 'r', '--session-id', '${CLAUDE_SESSION_ID}'], env: {} }),
    null,
  );
  // I1: an UNUSABLE arg (unsubstituted template, or bash-expanded empty string) must not
  // short-circuit the chain — it falls THROUGH to the env var that older builds still export.
  assert.equal(
    resolveSessionId({
      argv: ['node', 'r', '--session-id', '${CLAUDE_SESSION_ID}'],
      env: { CLAUDE_CODE_SESSION_ID: 'sid-env' },
    }),
    'sid-env',
  );
  assert.equal(
    resolveSessionId({
      argv: ['node', 'r', '--session-id', ''],
      env: { CLAUDE_CODE_SESSION_ID: 'sid-env' },
    }),
    'sid-env',
  );
});

test('sidecarPath is coexist.json under claude-context', () => {
  assert.equal(
    sidecarPath({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }),
    path.join('/tmp/cfg', 'claude-context', 'coexist.json'),
  );
});

test('settingsPath and backupPath sit at the config-dir root', () => {
  assert.equal(
    settingsPath({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }),
    path.join('/tmp/cfg', 'settings.json'),
  );
  assert.equal(
    backupPath({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }),
    path.join('/tmp/cfg', 'settings.json.claude-context.bak'),
  );
});
