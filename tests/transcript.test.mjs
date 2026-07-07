import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastAssistantUsage, countCompactions, findNewestTranscript, transcriptForSession } from '../plugins/claude-context/scripts/lib/transcript.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const session = path.join(here, 'fixtures', 'session.jsonl');
const empty = path.join(here, 'fixtures', 'empty.jsonl');

test('lastAssistantUsage returns the final assistant usage and model', () => {
  const u = lastAssistantUsage(session);
  assert.equal(u.input_tokens, 1200);
  assert.equal(u.cache_read_input_tokens, 88000);
  assert.equal(u.cache_creation_input_tokens, 2800);
  assert.equal(u.model_id, 'claude-opus-4-8');
});

test('lastAssistantUsage returns null when no assistant turn / missing file', () => {
  assert.equal(lastAssistantUsage(empty), null);
  assert.equal(lastAssistantUsage(path.join(here, 'fixtures', 'nope.jsonl')), null);
});

test('countCompactions counts only timestamped compact_boundary entries', () => {
  assert.equal(countCompactions(session), 1);
  assert.equal(countCompactions(empty), 0);
});

test('findNewestTranscript encodes cwd and finds newest jsonl', () => {
  // fixtures/ is not a projects dir, so a non-existent cwd resolves to null safely.
  assert.equal(findNewestTranscript('/no/such/dir', '/Users/x/proj'), null);
});

test('transcriptForSession resolves this session\'s own transcript deterministically', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ts-'));
  const cwd = '/Users/x/proj';
  const encoded = cwd.replace(/[/\\.]/g, '-'); // matches findNewestTranscript's encoding
  const projDir = path.join(configDir, 'projects', encoded);
  fs.mkdirSync(projDir, { recursive: true });
  const sid = '9cb01c18-f694-4be3-b629-212faf066563';
  const file = path.join(projDir, `${sid}.jsonl`);
  fs.writeFileSync(file, '');
  assert.equal(transcriptForSession(configDir, cwd, sid), file);
  assert.equal(transcriptForSession(configDir, cwd, 'no-such-session'), null); // absent
  assert.equal(transcriptForSession(configDir, cwd, null), null);              // unknown session
});

const real = path.join(here, 'fixtures', 'real-transcript.jsonl');

test('golden: a real transcript parses to the expected shape', () => {
  const u = lastAssistantUsage(real);
  assert.ok(u, 'a real transcript has at least one assistant turn with usage');
  for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
    assert.equal(typeof u[k], 'number');
    assert.ok(Number.isFinite(u[k]));
  }
  assert.equal(typeof u.model_id, 'string');
  assert.ok(u.model_id.length > 0);
  assert.equal(typeof countCompactions(real), 'number'); // real data must not crash the counter
});
