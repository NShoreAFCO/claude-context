import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { buildSnapshot, compactLine, runCli } from '../plugins/claude-context/scripts/collect.mjs';

const stdin = {
  model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
  context_window: {
    context_window_size: 200000,
    used_percentage: 46,
    current_usage: {
      input_tokens: 1200,
      cache_read_input_tokens: 88000,
      cache_creation_input_tokens: 2800,
      output_tokens: 0,
    },
  },
  cost: { total_cost_usd: 0.42 },
  rate_limits: {
    five_hour: { used_percentage: 25, resets_at: 1751898600 },
    seven_day: { used_percentage: 61, resets_at: 1752166800 },
  },
  transcript_path: '/Users/x/session.jsonl',
};

test('buildSnapshot maps stdin, prefers native %, converts epoch seconds', () => {
  const s = buildSnapshot(stdin, 1751895000000);
  assert.equal(s.context.window_size, 200000);
  assert.equal(s.context.used_tokens, 92000);
  assert.equal(s.context.used_percentage, 46);
  assert.equal(s.rate_limits.five_hour.used_percentage, 25);
  assert.equal(s.rate_limits.five_hour.resets_at, new Date(1751898600000).toISOString());
  assert.equal(s.cost.total_cost_usd, 0.42);
  assert.equal(s.transcript_path, '/Users/x/session.jsonl');
});

test('buildSnapshot computes % when native absent, and nulls rate_limits when absent', () => {
  const s = buildSnapshot(
    { context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } } },
    0,
  );
  assert.equal(s.context.used_percentage, 50);
  assert.equal(s.rate_limits, null);
});

test('buildSnapshot treats native used_percentage=0 as unpopulated and computes from tokens', () => {
  const s = buildSnapshot(
    {
      context_window: {
        context_window_size: 200000,
        used_percentage: 0,
        current_usage: {
          input_tokens: 1200,
          cache_read_input_tokens: 88000,
          cache_creation_input_tokens: 2800,
        },
      },
    },
    0,
  );
  assert.equal(s.context.used_percentage, 46); // 92000 / 200000, not the literal 0
});

test('compactLine shows context and any rate limits', () => {
  assert.equal(compactLine(buildSnapshot(stdin, 0)), 'Context 46% · 5h 25% · 7d 61%');
  assert.equal(
    compactLine(
      buildSnapshot(
        {
          context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } },
        },
        0,
      ),
    ),
    'Context 50%',
  );
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

test('golden: real statusline stdin maps without losing fields', () => {
  const raw = JSON.parse(readFileSync(path.join(here, 'fixtures', 'real-stdin.json'), 'utf8'));
  const s = buildSnapshot(raw, 0);
  assert.equal(typeof s.context.window_size, 'number');
  assert.ok(s.context.used_percentage === null || typeof s.context.used_percentage === 'number');
  // If this capture carried rate_limits, they must survive mapping as ISO resets.
  if (raw.rate_limits?.five_hour) {
    assert.ok(s.rate_limits, 'rate_limits in stdin must map to a non-null snapshot block');
    assert.match(s.rate_limits.five_hour.resets_at ?? '', /^\d{4}-\d\d-\d\dT/);
  }
});

test('buildSnapshot records the stdin session id (for keying + provenance)', () => {
  assert.equal(buildSnapshot({ session_id: 'sid-1', context_window: {} }, 0).session_id, 'sid-1');
  assert.equal(buildSnapshot({ context_window: {} }, 0).session_id, null);
});

test('runCli writes a session-keyed snapshot so concurrent sessions never share a file', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-run-'));
  const raw = JSON.stringify({
    session_id: 'sid-xyz',
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } },
  });
  await runCli({
    argv: ['node', 'collect', '--silent'],
    now: 0,
    readInput: async () => raw,
    env: { CLAUDE_CONFIG_DIR: cfg },
  });
  const p = path.join(cfg, 'claude-context', 'snapshot-sid-xyz.json');
  assert.ok(fs.existsSync(p), 'snapshot written to the session-keyed path');
  const snap = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(snap.session_id, 'sid-xyz');
  assert.equal(snap.context.used_percentage, 50);
});

test('runCli statusline carries no marker when the snapshot persists', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ok-'));
  const raw = JSON.stringify({
    session_id: 'sid-ok',
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } },
  });
  let out = '';
  await runCli({
    argv: ['node', 'collect'],
    now: 0,
    readInput: async () => raw,
    env: { CLAUDE_CONFIG_DIR: cfg },
    write: (s) => {
      out += s;
    },
  });
  assert.equal(out.trim(), 'Context 50%');
  assert.doesNotMatch(out, /snapshot not saved/);
});

test('runCli flags a genuine write failure in the statusline (S1 discovery path)', async () => {
  // A read-only/full FS: every write throws and nothing durable is persisted. existsSync
  // returns true here (a stale snapshot from a prior run sits on disk) — the masking case
  // an existence check would misread as healthy — so the marker must be driven by the
  // write result, not the file's presence.
  const failingDeps = {
    existsSync: () => true,
    statSync: () => {
      throw new Error('nope');
    },
    readFileSync: () => {
      throw new Error('nope');
    },
    mkdirSync: () => {},
    chmodSync: () => {},
    writeFileSync: () => {
      throw new Error('EROFS: read-only file system');
    },
    renameSync: () => {},
    unlinkSync: () => {},
  };
  const raw = JSON.stringify({
    session_id: 'sid-fail',
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } },
  });
  let out = '';
  await runCli({
    argv: ['node', 'collect'],
    now: 0,
    readInput: async () => raw,
    env: { CLAUDE_CONFIG_DIR: os.tmpdir() },
    deps: failingDeps,
    write: (s) => {
      out += s;
    },
  });
  assert.match(out, /^Context 50% · snapshot not saved$/m);
});
