// tests/stdin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readStdin, parseStdinJson } from '../plugins/claude-context/scripts/lib/stdin.mjs';

test('readStdin concatenates all chunks as UTF-8', async () => {
  const s = Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]);
  assert.equal(await readStdin(s), '{"a":1}');
});

test('readStdin returns "" (never rejects) when the stream errors', async () => {
  const s = new Readable({
    read() {
      this.destroy(new Error('stdin blew up'));
    },
  });
  assert.equal(await readStdin(s), '');
});

test('parseStdinJson falls back to {} on empty / malformed input', () => {
  assert.deepEqual(parseStdinJson(''), {});
  assert.deepEqual(parseStdinJson('{ not json'), {});
  assert.deepEqual(parseStdinJson('{"x":1}'), { x: 1 });
});
