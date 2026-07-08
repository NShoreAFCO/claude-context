import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const setup = readFileSync(
  path.join(root, 'plugins', 'claude-context', 'commands', 'setup.md'),
  'utf8',
);

// Positive facts only — do NOT grep for word-absence ("replace"/"keep"), the doc
// legitimately explains it never replaces, which would false-positive (base contract warning).

test('delegates the surgery to the wiring module via detect then wrap', () => {
  // the doc quotes the plugin path (`...wiring.mjs" detect`), so tolerate the closing quote — still asserts delegation to detect/wrap
  assert.match(setup, /wiring\.mjs"? detect/);
  assert.match(setup, /wiring\.mjs"? wrap/);
});

test('empty wires collect, foreign wires coexist (both via the wiring module)', () => {
  assert.match(setup, /collect/);
  assert.match(setup, /coexist/);
});

test('a foreign slot is a single proceed/cancel confirm', () => {
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /proceed/i);
  assert.match(setup, /cancel/i);
});

test('platform matrix is POSIX + Git Bash only; native PowerShell is reported unsupported, no settings change', () => {
  const norm = setup.replace(/[*`]/g, '').replace(/\s+/g, ' ');
  assert.match(setup, /Git Bash/i);
  assert.match(setup, /PowerShell/);
  assert.match(setup, /unsupported/i);
  assert.match(norm, /Make no settings\.json change/i); // native-PowerShell branch specifically must make NO settings.json change (prior regex coincidentally matched the unrelated foreign-Cancel bullet)
});

test('references teardown and keeps the session-keyed snapshot verification glob', () => {
  assert.match(setup, /\/claude-context:teardown/);
  assert.match(setup, /snapshot-\*\.json/);
});
