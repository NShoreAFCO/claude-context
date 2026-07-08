// tests/coexist.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCoexist } from '../plugins/claude-context/scripts/coexist.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const coexistPath = path.join(here, '..', 'plugins', 'claude-context', 'scripts', 'coexist.mjs');

// A temp config dir; optionally seed a sidecar whose stored original is `command`.
function mkCfg(command) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cox-'));
  if (command !== undefined) {
    fs.mkdirSync(path.join(cfg, 'claude-context'), { recursive: true });
    fs.writeFileSync(
      path.join(cfg, 'claude-context', 'coexist.json'),
      JSON.stringify({
        original: { type: 'command', command },
        wrapped_at: new Date(0).toISOString(),
      }),
    );
  }
  return cfg;
}
const STDIN = JSON.stringify({
  session_id: 'sid-cox',
  context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } },
});
function snapFile(cfg) {
  return path.join(cfg, 'claude-context', 'snapshot-sid-cox.json');
}
// Fake child for deterministic unit tests: records forwarded stdin; `close(code)` fires later.
function fakeChild() {
  const h = {};
  return {
    stdin: {
      data: '',
      write(c) {
        this.data += c;
      },
      end() {
        this.ended = true;
      },
      on() {
        return this;
      }, // real child.stdin is a stream; the wrapper attaches an 'error' handler
    },
    on(ev, cb) {
      h[ev] = cb;
      return this;
    },
    fireClose(code) {
      h.close && h.close(code);
    },
  };
}
async function tick() {
  await new Promise((r) => setImmediate(r));
}
async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

// --- Unit tests (injected spawn / snapshot lib) ---

test('failure isolation: snapshot write throws, but the child still runs + exit propagates', async () => {
  const cfg = mkCfg('true');
  const child = fakeChild();
  let spawned = 0;
  const p = runCoexist({
    now: 0,
    readInput: async () => STDIN,
    env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => {
      spawned++;
      return child;
    },
    loadSnapshotLib: async () => ({
      buildSnapshot: () => ({ session_id: 'sid-cox' }),
      compactLine: () => 'x',
      writeSnapshot: () => {
        throw new Error('EROFS');
      },
    }),
  });
  await tick();
  assert.equal(spawned, 1, 'child spawned before the (throwing) snapshot step');
  assert.equal(child.stdin.data, STDIN, 'stdin forwarded to the child');
  child.fireClose(0);
  assert.equal(await p, 0);
});

test('child is spawned even when snapshot BUILDING throws synchronously', async () => {
  const cfg = mkCfg('true');
  const child = fakeChild();
  let spawned = 0;
  const p = runCoexist({
    now: 0,
    readInput: async () => STDIN,
    env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => {
      spawned++;
      return child;
    },
    loadSnapshotLib: async () => ({
      buildSnapshot: () => {
        throw new Error('boom');
      },
      compactLine: () => 'x',
      writeSnapshot: () => {},
    }),
  });
  await tick();
  assert.equal(spawned, 1);
  child.fireClose(0);
  assert.equal(await p, 0);
});

test('hung original: snapshot is written WITHOUT awaiting the child exit', async () => {
  const cfg = mkCfg('sleep 999'); // real default loadSnapshotLib; fake child that never closes
  const child = fakeChild();
  const p = runCoexist({
    now: 0,
    readInput: async () => STDIN,
    env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => child,
  });
  const appeared = await waitFor(() => fs.existsSync(snapFile(cfg)));
  assert.ok(appeared, 'snapshot appears while the child is still "running" (close not fired)');
  const snap = JSON.parse(fs.readFileSync(snapFile(cfg), 'utf8'));
  assert.equal(snap.context.used_percentage, 50);
  child.fireClose(0);
  assert.equal(await p, 0);
});

test('missing/corrupt sidecar → degrades to our own compact line', async () => {
  const cfg = mkCfg(); // no sidecar
  let out = '';
  const code = await runCoexist({
    now: 0,
    readInput: async () => STDIN,
    env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => {
      throw new Error('must not spawn in degraded mode');
    },
    write: (s) => {
      out += s;
    },
  });
  assert.equal(code, 0);
  assert.equal(out.trim(), 'Context 50%');
});

test('a throwing stdin read does not reject: the original still spawns, exit propagates', async () => {
  const cfg = mkCfg('true');
  const child = fakeChild();
  let spawned = 0;
  const p = runCoexist({
    now: 0,
    readInput: async () => {
      throw new Error('stdin error');
    },
    env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => {
      spawned++;
      return child;
    },
    loadSnapshotLib: async () => ({
      buildSnapshot: () => ({ session_id: 'sid-cox' }),
      compactLine: () => 'x',
      writeSnapshot: () => {},
    }),
  });
  await tick();
  assert.equal(spawned, 1, 'child still spawned despite the stdin read throwing');
  assert.equal(child.stdin.data, '', 'empty input forwarded, not a crash');
  child.fireClose(0);
  assert.equal(await p, 0);
});

// --- Integration tests (real `node coexist.mjs` subprocess: true stdio inherit) ---

function runWrapper(cfg, stdinStr) {
  return spawnSync(process.execPath, [coexistPath], {
    input: stdinStr,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
  });
}

test('forwards stdin and passes the original stdout through unchanged', () => {
  const cfg = mkCfg('cat'); // sh -c cat echoes stdin to stdout
  const r = runWrapper(cfg, STDIN);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, STDIN, 'wrapper adds nothing; the original tool owns the line');
  assert.ok(fs.existsSync(snapFile(cfg)), 'snapshot still written');
});

test('forwards a realistic quote-laden original via sh -c', () => {
  // Representative of a claude-hud bash -c '…' with nested '"'"' quoting.
  // closing quote corrected — brief fixture was missing one `'` (would exit 2 as invalid shell)
  const original = `bash -c 'printf %s '"'"'q1 "q2" '"'"''`;
  const cfg = mkCfg(original);
  const r = runWrapper(cfg, STDIN);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /q1 "q2"/);
});

test('runtime-failed original: transparent pass-through, exit propagated, snapshot still written', () => {
  const cfg = mkCfg('exit 3'); // valid sidecar, original fails
  const r = runWrapper(cfg, STDIN);
  assert.equal(r.status, 3, "the original's exit code is propagated");
  assert.equal(r.stdout, '', 'we do NOT substitute our own line for a failing original');
  assert.ok(fs.existsSync(snapFile(cfg)), 'snapshot written regardless of child outcome');
});

test('broken-pipe original (large payload, child ignores stdin) never crashes the wrapper; exit code propagated + snapshot written', () => {
  // The original exits immediately without reading stdin. A ~4MB write cannot fit the OS
  // pipe buffer of an already-exited child, so Node emits an async 'error' (EPIPE) on
  // child.stdin. Without the child.stdin.on('error', ...) handler that async error would
  // crash the wrapper (exit 1/null), overriding the original's real code and possibly
  // firing before the snapshot is durable. The payload stays VALID JSON (session_id intact).
  const cfg = mkCfg('exit 3'); // fast-exiting original that does not read stdin
  const big = JSON.stringify({
    session_id: 'sid-cox',
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } },
    _pad: 'x'.repeat(4_000_000),
  });
  const r = runWrapper(cfg, big);
  assert.equal(r.status, 3, "the original's code is propagated — NOT a wrapper crash (1/null)");
  assert.ok(fs.existsSync(snapFile(cfg)), 'snapshot survived the broken pipe');
});

test('degraded branch also triggers for a MALFORMED-JSON sidecar (no spawn, code 0, our line)', async () => {
  const cfg = mkCfg('true'); // seed a valid sidecar dir/file, then corrupt it
  fs.writeFileSync(path.join(cfg, 'claude-context', 'coexist.json'), '{ not valid json');
  let out = '';
  const code = await runCoexist({
    now: 0,
    readInput: async () => STDIN,
    env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => {
      throw new Error('must not spawn in degraded mode');
    },
    write: (s) => {
      out += s;
    },
  });
  assert.equal(code, 0);
  assert.equal(out.trim(), 'Context 50%');
});

test('degraded branch also triggers for a BLANK original.command (no spawn, code 0, our line)', async () => {
  const cfg = mkCfg(''); // sidecar exists but original.command is ''
  let out = '';
  const code = await runCoexist({
    now: 0,
    readInput: async () => STDIN,
    env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => {
      throw new Error('must not spawn in degraded mode');
    },
    write: (s) => {
      out += s;
    },
  });
  assert.equal(code, 0);
  assert.equal(out.trim(), 'Context 50%');
});
