import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const setup = readFileSync(path.join(root, 'commands', 'setup.md'), 'utf8');

test('wires the collector, not the HUD', () => {
  assert.match(setup, /scripts\/collect\.mjs/);
  assert.match(setup, /plugins\/cache\/\*\/claude-context\//);
});

test('covers the platform matrix', () => {
  assert.match(setup, /Git Bash|MSYS/i);
  assert.match(setup, /PowerShell/i);
});

test('does replace-or-keep, never silent overwrite', () => {
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /Replace/i);
  assert.match(setup, /Keep/i);
  assert.match(setup, /back\s?up/i);
});

test('verifies a snapshot after wiring', () => {
  assert.match(setup, /snapshot\.json/);
});
