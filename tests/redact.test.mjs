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

test('redactSecrets masks non-HTTP connection-string passwords (I2)', () => {
  // A foreign statusline that shells out to a DB/cache embeds a connection string; its
  // password must not echo raw. The scheme anchor must cover any URI scheme, not just http(s).
  for (const url of [
    'postgres://admin:S3cr3tPass@db/mydb',
    'mysql://root:hunter2pw@127.0.0.1:3306/app',
    'redis://user:r3disPass@cache:6379',
    'mongodb://svc:m0ngoPass@mongo/db',
  ]) {
    const r = redactSecrets(`run ${url}`);
    assert.doesNotMatch(r, /S3cr3tPass|hunter2pw|r3disPass|m0ngoPass/, `password leaked: ${url}`);
    assert.match(r, /\[REDACTED\]/);
  }
  // Host/path stay usable in the preview.
  assert.match(redactSecrets('psql postgres://admin:S3cr3tPass@db/mydb'), /db\/mydb/);
});

test('redactSecrets masks github_pat_ PATs and xapp-/xoxe- Slack tokens (I3)', () => {
  assert.doesNotMatch(
    redactSecrets('gh auth github_pat_11ABCDEF0123456789_abcdefghijKLMNOPqrstuvwx'),
    /github_pat_11ABCDEF0123456789/,
  );
  assert.doesNotMatch(redactSecrets('slack xapp-1-ABC-123-xyzABCdefGHI'), /xyzABCdefGHI/);
  assert.doesNotMatch(redactSecrets('slack xoxe-1-abcdEFGHijklMNOP'), /abcdEFGHijklMNOP/);
});

test('redactSecrets masks a labeled quoted secret containing a space (I4)', () => {
  // A quoted value with a space must not slip through the label rule untouched.
  const a = redactSecrets('password="my secret phrase"');
  assert.doesNotMatch(a, /my secret phrase/);
  assert.match(a, /password=\[REDACTED\]/);
  const b = redactSecrets('api_token="abc def ghi"');
  assert.doesNotMatch(b, /abc def ghi/);
  assert.match(b, /api_token=\[REDACTED\]/);
  // Single-quoted values with spaces too.
  assert.doesNotMatch(redactSecrets("secret='one two three'"), /one two three/);
});

test('redactSecrets masks positional / abbreviated-name credentials (S2)', () => {
  // mysql-style attached password.
  const my = redactSecrets('mysql -u root -pMyS3cretPw');
  assert.doesNotMatch(my, /MyS3cretPw/);
  assert.match(my, /-p\[REDACTED\]/);
  // curl -u user:pass — keep the username, mask the password.
  const curl = redactSecrets('curl -u alice:s3cretpw https://x');
  assert.doesNotMatch(curl, /s3cretpw/);
  assert.match(curl, /-u alice:\[REDACTED\]/);
  // *_PWD / *_PASS env-style assignments.
  assert.doesNotMatch(redactSecrets('MYSQL_PWD=topsecret cmd'), /topsecret/);
  assert.doesNotMatch(redactSecrets('DB_PASS=letmein cmd'), /letmein/);
});

test('redactSecrets does not over-redact the MySQL port flag or a space-separated -p (S2 guard)', () => {
  // -P (uppercase) is the port, not the password — must survive.
  assert.match(redactSecrets('mysql -h db -P3306 -u root'), /-P3306/);
  // A space after -p means "prompt for password"; the next token is the db name, not a secret.
  assert.match(redactSecrets('mysql -p mydatabase'), /mydatabase/);
});

test('redactSecrets masks an Authorization: Basic header (I4)', () => {
  // base64(user:password) — must not echo into the transcript.
  const r = redactSecrets('curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="');
  assert.doesNotMatch(r, /dXNlcjpwYXNzd29yZA==/);
  assert.match(r, /Basic \[REDACTED\]/);
});

test('redactSecrets masks space-separated secret flags (I5)', () => {
  assert.doesNotMatch(redactSecrets('statusline --api-key 0123456789abcdef'), /0123456789abcdef/);
  assert.doesNotMatch(redactSecrets('fetch --password Hunter2Pass!'), /Hunter2Pass!/);
  assert.doesNotMatch(redactSecrets('x --token abcDEF123 y'), /abcDEF123/);
  // Quoted space-containing value after the flag, too.
  assert.doesNotMatch(redactSecrets('run --secret "my phrase here"'), /my phrase here/);
  // Guards: prompt-mode -p (next token is a db name) and --author are NOT redacted.
  assert.match(redactSecrets('mysql -p mydatabase'), /mydatabase/);
  assert.match(redactSecrets('git log --author Jane'), /Jane/);
});

test('redactSecrets masks a standard-base64 Bearer token with + and / (I6)', () => {
  // The char class must span +/= or the token is truncated at the first + or /, leaking the rest.
  const r = redactSecrets('Authorization: Bearer AbC0+xYz/98wQ==');
  assert.doesNotMatch(r, /xYz|98wQ/);
  assert.match(r, /Bearer \[REDACTED\]/);
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
