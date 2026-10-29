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

test('win32 decides Git Bash by asking bash itself, from any session shell', () => {
  const norm = setup.replace(/[*`]/g, '').replace(/\s+/g, ' ');
  assert.ok(setup.includes("bash -c 'echo $OSTYPE'"), 'the literal bash check');
  assert.match(norm, /any shell \(PowerShell included\)/i);
  // The session shell column (PowerShell + empty $OSTYPE) is gone: the session shell is irrelevant.
  assert.doesNotMatch(setup, /\| Shell \|/);
  assert.doesNotMatch(setup, /run `echo \$OSTYPE` first/);
});

test('setup treats non-msys/cygwin bash as native', () => {
  const norm = setup.replace(/[*`]/g, '').replace(/\s+/g, ' ');
  assert.match(norm, /msys \/ cygwin \| gitbash/i);
  assert.match(norm, /linux-gnu/); // WSL bash.exe ahead of Git Bash on PATH
  assert.match(norm, /not found[^|]*\| native-powershell/i);
});

test('references teardown and keeps the session-keyed snapshot verification glob', () => {
  assert.match(setup, /\/claude-context:teardown/);
  assert.match(setup, /snapshot-\*\.json/);
});
