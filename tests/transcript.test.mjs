import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lastAssistantUsage, countCompactions } from '../plugins/claude-context/scripts/lib/transcript.mjs';

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
