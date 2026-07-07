// tests/docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(root, f), 'utf8');

test('LICENSE is MIT and acknowledges claude-hud', () => {
  const lic = read('LICENSE');
  assert.match(lic, /MIT License/);
  assert.match(lic, /claude-hud/i);
});

test('README documents install, the two invocation names, and the no-advice contract', () => {
  const r = read('README.md');
  assert.match(r, /\/plugin install claude-context/);
  assert.match(r, /\/claude-context:setup/);
  assert.match(r, /no (advice|recommendations)/i);
});

test('CHANGELOG has an entry', () => {
  assert.match(read('CHANGELOG.md'), /0\.1\.0/);
});
