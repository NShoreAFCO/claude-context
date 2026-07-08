// tests/redact.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, previewCommand } from '../plugins/claude-context/scripts/lib/redact.mjs';

test('redactSecrets masks common secret shapes', () => {
  assert.match(
    redactSecrets('curl -H "Authorization: Bearer sk-live-abcdef123456"'),
    /Bearer \[REDACTED\]/,
  );
  assert.match(redactSecrets('x sk-ant-api03-ZZZZZZZZ y'), /sk-\[REDACTED\]/);
  assert.match(redactSecrets('token ghp_ABCDEFGH12345678'), /\[REDACTED\]/);
  assert.match(redactSecrets('foo api_key=SUPERSECRETVALUE bar'), /api_key=\[REDACTED\]/);
  assert.doesNotMatch(redactSecrets('foo api_key=SUPERSECRETVALUE bar'), /SUPERSECRETVALUE/);
});

test('redactSecrets masks the additional secret shapes a foreign command may embed', () => {
  // AWS access-key id and secret key. The `_`-joined label must still redact.
  assert.doesNotMatch(redactSecrets('run --id AKIAIOSFODNN7EXAMPLE'), /AKIAIOSFODNN7EXAMPLE/);
  const aws = redactSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  assert.doesNotMatch(aws, /wJalrXUtnFEMI/);
  // Google API key.
  assert.doesNotMatch(
    redactSecrets('key=AIzaSyD-1234567890abcdefghijklmnopqrstuvw'),
    /AIzaSyD-1234567890abcdefghijklmnopqrstuvw/,
  );
  // JWT / bearer-style triple-segment token.
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.doesNotMatch(redactSecrets(`auth ${jwt}`), /eyJzdWI/);
  // Basic-auth URL: mask the password segment, keep the rest usable as a preview.
  const url = redactSecrets('curl https://user:hunter2secret@example.com/x');
  assert.doesNotMatch(url, /hunter2secret/);
  assert.match(url, /example\.com/);
  // Slack token.
  assert.doesNotMatch(
    redactSecrets('xoxb-2222222222-3333333333-abcdEFGHijklMNOPqrstUVWX'),
    /abcdEFGHijklMNOPqrstUVWX/,
  );
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
