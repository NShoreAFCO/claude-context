// tests/redact.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, previewCommand } from '../plugins/claude-context/scripts/lib/redact.mjs';

test('redactSecrets masks common secret shapes', () => {
  assert.match(redactSecrets('curl -H "Authorization: Bearer sk-live-abcdef123456"'), /Bearer \[REDACTED\]/);
  assert.match(redactSecrets('x sk-ant-api03-ZZZZZZZZ y'), /sk-\[REDACTED\]/);
  assert.match(redactSecrets('token ghp_ABCDEFGH12345678'), /\[REDACTED\]/);
  assert.match(redactSecrets('foo api_key=SUPERSECRETVALUE bar'), /api_key=\[REDACTED\]/);
  assert.doesNotMatch(redactSecrets('foo api_key=SUPERSECRETVALUE bar'), /SUPERSECRETVALUE/);
});

test('redactSecrets is total on non-strings', () => {
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(42), '');
});

test('previewCommand redacts then truncates with an ellipsis', () => {
  const long = 'bash -c ' + 'a'.repeat(300);
  const p = previewCommand(long, 160);
  assert.equal(p.length, 160);
  assert.ok(p.endsWith('…'));
  assert.equal(previewCommand('short', 160), 'short');
});
