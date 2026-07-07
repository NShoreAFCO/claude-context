// tests/report.test.mjs
// NOTE: TZ is pinned to UTC before any Date work happens. The human block renders
// rate-limit reset times in the *local* wall clock (correct real-world behavior —
// a user wants their own local reset time, not UTC). That makes the "(at 14:30)"
// assertions below timezone-dependent: they were authored assuming resets_at's UTC
// clock digits equal the local clock digits. Pinning TZ here makes the test
// deterministic on any machine without changing scripts/report.mjs's real
// (correct) local-time rendering behavior.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReport } from '../scripts/report.mjs';

const NOW = Date.parse('2026-07-07T13:00:04.000Z');
const collectorRes = {
  source: 'collector',
  model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
  context: { window_size: 200000, used_tokens: 92000, used_percentage: 46, input_tokens: 1200, cache_read_tokens: 88000, cache_creation_tokens: 2800, output_tokens: 0 },
  rateLimits: {
    five_hour: { used_percentage: 25, resets_at: '2026-07-07T14:30:00.000Z' },
    seven_day: { used_percentage: 61, resets_at: '2026-07-10T17:00:00.000Z' },
  },
  rateLimitsStatus: 'available',
  cost: 0.42, compactions: 1, sessionSelection: 'transcript_path', snapshotAgeSeconds: 4,
};

test('collector JSON block is pure measurements + provenance', () => {
  const { json } = assembleReport(collectorRes, NOW);
  assert.equal(json.context.headroom_tokens, 108000);
  assert.equal(json.rate_limits.five_hour.resets_in_seconds, 5400);
  assert.equal(json.source, 'collector');
  assert.equal(json.rate_limits_status, 'available');
  assert.equal(json.session_selection, 'transcript_path');
  assert.equal('suggested_action' in json, false);
});

test('collector human block matches the contract', () => {
  const { human } = assembleReport(collectorRes, NOW);
  assert.match(human, /^Claude Context — Opus 4\.8$/m);
  assert.match(human, /^Context: 46% used · 92k \/ 200k tokens · 108k headroom$/m);
  assert.match(human, /^Session \(5h\): 25% used · resets in 1h 30m \(at 14:30\)$/m);
  assert.match(human, /^Weekly \(7d\): 61% used · resets in 3d 4h$/m); // >24h: no clock
  assert.match(human, /^Cost: \$0\.42 · Compactions: 1$/m);
  assert.match(human, /^Source: collector · snapshot 4s old$/m);
});

test('collector-on but no subscription usage → unavailable_plan (non-committal copy)', () => {
  const res = { ...collectorRes, rateLimits: null, rateLimitsStatus: 'unavailable_plan' };
  const { human, json } = assembleReport(res, NOW);
  assert.match(human, /^Session \(5h\): unavailable — no subscription usage reported \(API-key account, or before the first Pro\/Max response\)$/m);
  assert.match(human, /^Cost: \$0\.42 · Compactions: 1$/m);
  assert.equal(json.rate_limits.five_hour, null);
  assert.equal(json.rate_limits_status, 'unavailable_plan');
});

test('collector-on, Bedrock/Vertex → unavailable_provider', () => {
  const res = { ...collectorRes, rateLimits: null, rateLimitsStatus: 'unavailable_provider' };
  const { human, json } = assembleReport(res, NOW);
  assert.match(human, /^Session \(5h\): unavailable — subscription usage not reported on this provider \(Bedrock\/Vertex\)$/m);
  assert.equal(json.rate_limits_status, 'unavailable_provider');
});

test('stale snapshot → unavailable_stale keeps the age and never tells the user to run setup', () => {
  const res = { ...collectorRes, source: 'transcript', rateLimits: null, rateLimitsStatus: 'unavailable_stale', snapshotAgeSeconds: 420, sessionSelection: 'newest-in-cwd-heuristic', windowInferred: false };
  const { human, json } = assembleReport(res, NOW);
  assert.match(human, /^Session \(5h\): unavailable — last collector reading 420s ago \(idle; send a message to refresh\)$/m);
  assert.doesNotMatch(human, /\/claude-context:setup/);
  assert.match(human, /^Source: transcript fallback · context only · window from snapshot · snapshot 420s old \(stale\) · session: newest-in-cwd \(heuristic\)$/m);
  assert.equal(json.rate_limits_status, 'unavailable_stale');
  assert.equal(json.window_size_inferred, false);
});

test('transcript fallback (no snapshot ever): inferred window, hedged %, context only', () => {
  const res = {
    source: 'transcript', model: { id: 'claude-opus-4-8', display_name: '' },
    context: { window_size: 200000, used_tokens: 92000, used_percentage: 46, input_tokens: 1200, cache_read_tokens: 88000, cache_creation_tokens: 2800, output_tokens: 0 },
    rateLimits: null, rateLimitsStatus: 'unavailable_collector', cost: null, compactions: 1,
    sessionSelection: 'newest-in-cwd-heuristic', snapshotAgeSeconds: null, windowInferred: true,
  };
  const { human, json } = assembleReport(res, NOW);
  assert.match(human, /^Context: ~46% used · 92k tokens · window inferred \(200k assumed\)$/m);
  assert.match(human, /^Session \(5h\): unavailable — enable the collector with \/claude-context:setup$/m);
  assert.match(human, /^Source: transcript fallback · context only · window inferred · session: newest-in-cwd \(heuristic\)$/m);
  assert.equal(json.cost_usd, null);
  assert.equal(json.window_size_inferred, true);
  assert.equal(json.session_selection, 'newest-in-cwd-heuristic');
});

test('cold start: null context, no crash', () => {
  const res = {
    source: 'unavailable', model: {}, context: null, rateLimits: null,
    rateLimitsStatus: 'unavailable_collector', cost: null, compactions: 0,
    sessionSelection: null, snapshotAgeSeconds: null,
  };
  const { human, json } = assembleReport(res, NOW);
  assert.match(human, /^Context: unavailable — no measurement yet/m);
  assert.match(human, /^Source: unavailable$/m);
  assert.equal(json.context.used_percentage, null);
  assert.equal('session_selection' in json, false);
});

test('no-advice contract: rendered output carries no advice/level vocabulary in any state', () => {
  const forbidden = [/should compact/i, /recommend/i, /\byou should\b/i, /traffic.light/i, /\bpressure\b/i, /\b(70|85|90)%/];
  const staleRes = { ...collectorRes, source: 'transcript', rateLimits: null, rateLimitsStatus: 'unavailable_stale', snapshotAgeSeconds: 420, sessionSelection: 'newest-in-cwd-heuristic', windowInferred: false };
  const coldRes = { source: 'unavailable', model: {}, context: null, rateLimits: null, rateLimitsStatus: 'unavailable_collector', cost: null, compactions: 0, sessionSelection: null, snapshotAgeSeconds: null };
  for (const res of [collectorRes, staleRes, coldRes]) {
    const { human, json } = assembleReport(res, NOW);
    const blob = `${human}\n${JSON.stringify(json)}`;
    for (const re of forbidden) assert.doesNotMatch(blob, re);
    assert.equal('suggested_action' in json, false);
  }
});
