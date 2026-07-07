// tests/config-dir.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveConfigDir, snapshotPath } from '../scripts/lib/config-dir.mjs';

test('honors CLAUDE_CONFIG_DIR when set', () => {
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }), '/tmp/cfg');
});

test('falls back to homedir/.claude', () => {
  assert.equal(resolveConfigDir({}), path.join(os.homedir(), '.claude'));
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '  ' }), path.join(os.homedir(), '.claude'));
});

test('snapshotPath appends claude-context/snapshot.json', () => {
  assert.equal(snapshotPath({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }), '/tmp/cfg/claude-context/snapshot.json');
});
