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

test('README documents co-existence, teardown, and the native-PowerShell regression', () => {
  const r = read('README.md');
  assert.match(r, /co-?exist/i);
  assert.match(r, /\/claude-context:teardown/);
  assert.match(r, /Git Bash/i);
  // Preserve the substrings the earlier tests require: /plugin install, /claude-context:setup,
  // and the no-advice phrase are still asserted by the existing README test above.
});

test('CHANGELOG has a 0.3.0 entry noting co-exist + teardown + the PowerShell removal', () => {
  const c = read('CHANGELOG.md');
  assert.match(c, /0\.3\.0/);
  assert.match(c, /co-?exist|teardown/i);
  assert.match(c, /PowerShell/);
});
