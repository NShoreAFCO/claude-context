// readAutoCompactWindow — where Claude Code's auto-compact window comes from.
//
// Verified 2026-10-29 against code.claude.com docs (settings, settings-reference
// #autocompactwindow and #modelsettings, model-config#set-the-auto-compact-window,
// env-vars) and Claude Code 2.1.312:
//   - Key: top-level `autoCompactWindow` (tokens, 100000..1000000), any settings file.
//   - Per model: `modelSettings[<canonical model>].autoCompactWindow` (same range, or
//     "auto" = the window tuned for the model); `/autocompact` writes here, and it beats
//     the top-level key in the same file.
//   - File precedence: managed > --settings > local > project > user. The plugin reads
//     local, project and user only (managed and --settings are not observable here).
//   - Env: CLAUDE_CODE_AUTO_COMPACT_WINDOW beats the `--autocompact` flag and all
//     settings; values below 100k are treated as 100k, above 1M as 1M, suffixes k/M are
//     accepted, anything unusable is ignored.
//   - Claude Code caps the window at the model's context window (handled by the report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readAutoCompactWindow } from '../plugins/claude-context/scripts/lib/auto-compact.mjs';

const CFG = path.join('/cfg');
const env = { CLAUDE_CONFIG_DIR: CFG };
const userFile = path.join(CFG, 'settings.json');
const projFile = (dir) => path.join(dir, '.claude', 'settings.json');
const localFile = (dir) => path.join(dir, '.claude', 'settings.local.json');

// Map-backed fake: path → JSON-able value (stringified) or raw string; missing → ENOENT.
function fakeFs(files) {
  const reads = [];
  const readFile = (p) => {
    reads.push(p);
    if (!(p in files)) {
      const e = new Error(`ENOENT: ${p}`);
      e.code = 'ENOENT';
      throw e;
    }
    const v = files[p];
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  return { readFile, reads };
}

const stdinFor = (dir, modelId = 'claude-opus-5-5[1m]') => ({
  model: { id: modelId },
  workspace: { project_dir: dir },
  cwd: dir,
});

test('user settings only', () => {
  const { readFile } = fakeFs({ [userFile]: { autoCompactWindow: 400000 } });
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, readFile }), {
    tokens: 400000,
    source: 'user',
  });
});

test('local beats project beats user', () => {
  const files = {
    [localFile('/p')]: { autoCompactWindow: 300000 },
    [projFile('/p')]: { autoCompactWindow: 350000 },
    [userFile]: { autoCompactWindow: 400000 },
  };
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, ...fakeFs(files) }), {
    tokens: 300000,
    source: 'local',
  });
  delete files[localFile('/p')];
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, ...fakeFs(files) }), {
    tokens: 350000,
    source: 'project',
  });
});

test('project dir falls back to cwd', () => {
  const { readFile, reads } = fakeFs({ [projFile('/q')]: { autoCompactWindow: 200000 } });
  assert.deepEqual(readAutoCompactWindow({ stdin: { cwd: '/q' }, env, readFile }), {
    tokens: 200000,
    source: 'project',
  });
  assert.ok(reads.includes(projFile('/q')));

  const none = fakeFs({ [userFile]: { autoCompactWindow: 400000 } });
  assert.deepEqual(readAutoCompactWindow({ stdin: {}, env, readFile: none.readFile }), {
    tokens: 400000,
    source: 'user',
  });
  assert.deepEqual(none.reads, [userFile]);
});

test('ignores invalid values and falls through', () => {
  let r = fakeFs({
    [localFile('/p')]: { autoCompactWindow: '400000' },
    [projFile('/p')]: { autoCompactWindow: 0 },
    [userFile]: { autoCompactWindow: -5 },
  });
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, readFile: r.readFile }), {
    tokens: null,
    source: null,
  });
  r = fakeFs({
    [localFile('/p')]: { autoCompactWindow: 1.5 },
    [projFile('/p')]: { autoCompactWindow: 50000 },
    [userFile]: { autoCompactWindow: 400000 },
  });
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, readFile: r.readFile }), {
    tokens: 400000,
    source: 'user',
  });
  r = fakeFs({ [userFile]: { autoCompactWindow: NaN, modelSettings: null } });
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, readFile: r.readFile }), {
    tokens: null,
    source: null,
  });
});

test('unparseable file is treated as absent', () => {
  const { readFile } = fakeFs({
    [localFile('/p')]: '{not json',
    [userFile]: { autoCompactWindow: 400000 },
  });
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, readFile }), {
    tokens: 400000,
    source: 'user',
  });
});

test('nothing configured', () => {
  const { readFile } = fakeFs({ [userFile]: { theme: 'dark' } });
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, readFile }), {
    tokens: null,
    source: null,
  });
});

test('does not leak other keys', () => {
  const { readFile } = fakeFs({
    [userFile]: { autoCompactWindow: 400000, apiKeyHelper: 'secret', env: { TOKEN: 'x' } },
  });
  const r = readAutoCompactWindow({ stdin: stdinFor('/p'), env, readFile });
  assert.deepEqual(Object.keys(r).sort(), ['source', 'tokens']);
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('per-model modelSettings beats top-level in the same file', () => {
  const { readFile } = fakeFs({
    [userFile]: {
      autoCompactWindow: 600000,
      modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 400000 } },
    },
  });
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, readFile }), {
    tokens: 400000,
    source: 'user',
  });
});

test('per-model entry matches [1m] and date-suffixed ids, not other models', () => {
  const files = {
    [userFile]: { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 400000 } } },
  };
  for (const id of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5-5-20260601']) {
    assert.equal(
      readAutoCompactWindow({ stdin: stdinFor('/p', id), env, ...fakeFs(files) }).tokens,
      400000,
      id,
    );
  }
  assert.deepEqual(
    readAutoCompactWindow({ stdin: stdinFor('/p', 'claude-sonnet-5-5'), env, ...fakeFs(files) }),
    { tokens: null, source: null },
  );
});

test('a higher file with only a per-model value beats a lower top-level value', () => {
  const { readFile } = fakeFs({
    [localFile('/p')]: { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 300000 } } },
    [userFile]: { autoCompactWindow: 400000 },
  });
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, readFile }), {
    tokens: 300000,
    source: 'local',
  });
});

test('per-model "auto" decides: tuned window, nothing configured', () => {
  const { readFile } = fakeFs({
    [localFile('/p')]: { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 'auto' } } },
    [userFile]: { autoCompactWindow: 400000 },
  });
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env, readFile }), {
    tokens: null,
    source: null,
  });
});

test('env var beats every settings file', () => {
  const { readFile } = fakeFs({ [localFile('/p')]: { autoCompactWindow: 300000 } });
  const e = { ...env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' };
  assert.deepEqual(readAutoCompactWindow({ stdin: stdinFor('/p'), env: e, readFile }), {
    tokens: 250000,
    source: 'env',
  });
});

test('env var: suffixes, clamping, unusable values fall through', () => {
  const { readFile } = fakeFs({ [userFile]: { autoCompactWindow: 400000 } });
  const run = (v) =>
    readAutoCompactWindow({
      stdin: stdinFor('/p'),
      env: { ...env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: v },
      readFile,
    });
  assert.deepEqual(run('200k'), { tokens: 200000, source: 'env' });
  assert.deepEqual(run('1M'), { tokens: 1000000, source: 'env' });
  assert.deepEqual(run('200'), { tokens: 100000, source: 'env' });
  assert.deepEqual(run('5000000'), { tokens: 1000000, source: 'env' });
  for (const bad of ['', '  ', 'abc', '-5', '0', 'auto']) {
    assert.deepEqual(run(bad), { tokens: 400000, source: 'user' }, JSON.stringify(bad));
  }
});

test('project dir equal to the home dir reports the shared file as user', () => {
  const home = path.join('/home/u');
  const shared = path.join(home, '.claude', 'settings.json');
  const { readFile } = fakeFs({ [shared]: { autoCompactWindow: 400000 } });
  const r = readAutoCompactWindow({
    stdin: { workspace: { project_dir: home } },
    env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
    readFile,
  });
  assert.deepEqual(r, { tokens: 400000, source: 'user' });
});
