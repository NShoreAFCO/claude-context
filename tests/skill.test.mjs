// tests/skill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skill = readFileSync(path.join(root, 'plugins', 'claude-context', 'SKILL.md'), 'utf8');

test('frontmatter declares name and description', () => {
  assert.match(skill, /^---\n[\s\S]*\nname:\s*claude-context\b/m);
  assert.match(skill, /^description:\s*.+/m);
});

test('tells Claude to run report.mjs', () => {
  assert.match(skill, /scripts\/report\.mjs/);
});

test('states the data-only contract and tells the caller not to editorialize', () => {
  assert.match(skill, /instrument, not an? advisor/i);
  assert.match(skill, /pass the measurements through as-is/i);
  // The enforceable no-advice guarantee lives in Task 9 (denylist over report.mjs
  // OUTPUT). This doc legitimately uses words like "recommendations" / "you should"
  // to describe what the caller must NOT add, so grepping the doc for that
  // vocabulary would false-positive on the contract's own statement.
});

test('documents whose numbers these are (session context vs account usage)', () => {
  assert.match(skill, /account-wide/i);
  assert.match(skill, /\bsession\b/i);
  assert.match(skill, /\bsubagent\b/i);
});
