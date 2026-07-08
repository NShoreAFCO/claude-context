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
import { assembleReport } from '../plugins/claude-context/scripts/report.mjs';

const NOW = Date.parse('2026-07-07T13:00:04.000Z');
const collectorRes = {
  source: 'collector',
  model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
  context: {
    window_size: 200000,
    used_tokens: 92000,
    used_percentage: 46,
    input_tokens: 1200,
    cache_read_tokens: 88000,
    cache_creation_tokens: 2800,
    output_tokens: 0,
  },
  rateLimits: {
    five_hour: { used_percentage: 25, resets_at: '2026-07-07T14:30:00.000Z' },
    seven_day: { used_percentage: 61, resets_at: '2026-07-10T17:00:00.000Z' },
  },
  rateLimitsStatus: 'available',
  cost: 0.42,
  compactions: 1,
  sessionSelection: 'session_id',
  snapshotAgeSeconds: 4,
};

test('collector JSON block is pure measurements + provenance', () => {
  const { json } = assembleReport(collectorRes, NOW);
  assert.equal(json.context.headroom_tokens, 108000);
  assert.equal(json.rate_limits.five_hour.resets_in_seconds, 5400);
  assert.equal(json.source, 'collector');
  assert.equal(json.rate_limits_status, 'available');
  assert.equal(json.session_selection, 'session_id');
  assert.equal('suggested_action' in json, false);
  assert.equal(json.setup_required, false);
  assert.equal('window_size_inferred' in json, false);
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

test('compactions null (unreadable transcript) renders "unavailable", never a literal null', () => {
  const res = { ...collectorRes, compactions: null };
  const { human, json } = assembleReport(res, NOW);
  assert.match(human, /^Cost: \$0\.42 · Compactions: unavailable$/m);
  assert.doesNotMatch(human, /Compactions: null/);
  assert.equal(json.compactions, null); // JSON passes the unknown through as null
});

test('collector-on but no subscription usage → unavailable_plan (non-committal copy)', () => {
  const res = { ...collectorRes, rateLimits: null, rateLimitsStatus: 'unavailable_plan' };
  const { human, json } = assembleReport(res, NOW);
  assert.match(
    human,
    /^Session \(5h\): unavailable — no subscription usage reported \(API-key account, or before the first Pro\/Max response\)$/m,
  );
  assert.match(human, /^Cost: \$0\.42 · Compactions: 1$/m);
  assert.equal(json.rate_limits.five_hour, null);
  assert.equal(json.rate_limits_status, 'unavailable_plan');
});

test('collector-on, Bedrock/Vertex → unavailable_provider', () => {
  const res = { ...collectorRes, rateLimits: null, rateLimitsStatus: 'unavailable_provider' };
  const { human, json } = assembleReport(res, NOW);
  assert.match(
    human,
    /^Session \(5h\): unavailable — subscription usage not reported on this provider \(Bedrock\/Vertex\)$/m,
  );
  assert.equal(json.rate_limits_status, 'unavailable_provider');
});

test('collector available but a window is missing → factual copy, never "enable the collector"', () => {
  // buildRateLimits returns a non-null block if EITHER window is present, and a window
  // survives with used_percentage:null when only resets_at is valid. The render must
  // tolerate both without telling the user to enable an already-running collector.
  const res = {
    ...collectorRes,
    rateLimits: {
      five_hour: { used_percentage: null, resets_at: '2026-07-07T14:30:00.000Z' }, // present, no %
      seven_day: null, // absent entirely
    },
    rateLimitsStatus: 'available',
  };
  const { human, json } = assembleReport(res, NOW);
  assert.match(human, /^Session \(5h\): unavailable — not reported for this window$/m);
  assert.match(human, /^Weekly \(7d\): unavailable — not reported for this window$/m);
  assert.doesNotMatch(human, /\/claude-context:setup/); // collector is on; never say to enable it
  assert.equal(json.rate_limits_status, 'available');
});

test('stale snapshot → unavailable_stale keeps the age and never tells the user to run setup', () => {
  const res = {
    ...collectorRes,
    source: 'transcript',
    rateLimits: null,
    rateLimitsStatus: 'unavailable_stale',
    snapshotAgeSeconds: 420,
    sessionSelection: 'unverified-snapshot',
  };
  const { human, json } = assembleReport(res, NOW);
  assert.match(
    human,
    /^Session \(5h\): unavailable — last collector reading 420s ago \(idle; send a message to refresh\)$/m,
  );
  assert.doesNotMatch(human, /\/claude-context:setup/);
  assert.match(
    human,
    /^Source: transcript fallback · context only · window from snapshot · snapshot 420s old \(stale\) · session: unverified \(newest snapshot\)$/m,
  );
  assert.equal(json.rate_limits_status, 'unavailable_stale');
});

test('stale snapshot, no transcript usage: reports the snapshot context as source collector, flagged stale', () => {
  const res = {
    source: 'collector',
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context: {
      window_size: 1000000,
      used_tokens: 50000,
      used_percentage: 5,
      input_tokens: 1000,
      cache_read_tokens: 47000,
      cache_creation_tokens: 2000,
      output_tokens: 0,
    },
    rateLimits: null,
    rateLimitsStatus: 'unavailable_stale',
    cost: null,
    compactions: 2,
    sessionSelection: 'session_id',
    snapshotAgeSeconds: 600,
    setupRequired: false,
  };
  const { human, json } = assembleReport(res, NOW);
  assert.equal(json.source, 'collector');
  assert.equal(json.rate_limits_status, 'unavailable_stale');
  assert.equal(json.context.used_percentage, 5); // accurate against the real 1M window
  assert.equal(json.setup_required, false);
  assert.match(human, /^Source: collector · snapshot 600s old \(stale\)$/m); // stale-marked, not "fresh"
  assert.match(
    human,
    /^Session \(5h\): unavailable — last collector reading 600s ago \(idle; send a message to refresh\)$/m,
  );
  assert.doesNotMatch(human, /\/claude-context:setup/); // already set up — never tell them to run setup
});

test('collector snapshot with an unpopulated window (0) renders "unavailable", never a literal null%', () => {
  // First statusline ping of a brand-new session: window_size 0 → percentage() is null,
  // so the numeric branch would interpolate a literal null% if not guarded.
  const res = {
    source: 'collector',
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context: {
      window_size: 0,
      used_tokens: 0,
      used_percentage: null,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      output_tokens: 0,
    },
    rateLimits: null,
    rateLimitsStatus: 'unavailable_plan',
    cost: null,
    compactions: 0,
    sessionSelection: 'session_id',
    snapshotAgeSeconds: 0,
  };
  const { human, json } = assembleReport(res, NOW);
  assert.doesNotMatch(human, /null%/);
  assert.match(human, /^Context: unavailable — window size not reported yet$/m);
  assert.equal(json.context.used_percentage, null); // JSON still reports the raw measurement
});

test('not set up (no snapshot ever): cold-start block + all-null JSON + setup_required + compactions null', () => {
  const res = {
    source: 'unavailable',
    model: {},
    context: null,
    rateLimits: null,
    rateLimitsStatus: 'unavailable_collector',
    cost: null,
    compactions: null,
    sessionSelection: null,
    snapshotAgeSeconds: null,
    setupRequired: true,
  };
  const { human, json } = assembleReport(res, NOW);
  // Human: the configure-the-tool block, and NO Context:/Source: lines.
  assert.match(human, /^Claude Context — collector not configured$/m);
  assert.match(human, /\/claude-context:setup/);
  assert.match(human, /Once it has run, this report returns live numbers\.$/m);
  assert.doesNotMatch(human, /^Context:/m);
  assert.doesNotMatch(human, /^Source:/m);
  // JSON: all-null payload plus provenance.
  assert.equal(json.source, 'unavailable');
  assert.equal(json.rate_limits_status, 'unavailable_collector');
  assert.equal(json.setup_required, true);
  assert.equal(json.compactions, null);
  assert.equal(json.context.used_percentage, null);
  assert.equal(json.context.window_size, null);
  assert.equal(json.rate_limits.five_hour, null);
  assert.equal(json.cost_usd, null);
  assert.equal('session_selection' in json, false);
  assert.equal('window_size_inferred' in json, false); // field removed entirely (§3)
});

test('no-advice contract: rendered output carries no advice/level vocabulary in any state', () => {
  const forbidden = [
    /should compact/i,
    /recommend/i,
    /\byou should\b/i,
    /traffic.light/i,
    /\bpressure\b/i,
    /\b(70|85|90)%/,
  ];
  const staleTranscriptRes = {
    ...collectorRes,
    source: 'transcript',
    rateLimits: null,
    rateLimitsStatus: 'unavailable_stale',
    snapshotAgeSeconds: 420,
    sessionSelection: 'unverified-snapshot',
    setupRequired: false,
  };
  const staleSnapshotRes = {
    ...collectorRes,
    source: 'collector',
    rateLimits: null,
    rateLimitsStatus: 'unavailable_stale',
    snapshotAgeSeconds: 600,
    setupRequired: false,
  };
  const notSetUpRes = {
    source: 'unavailable',
    model: {},
    context: null,
    rateLimits: null,
    rateLimitsStatus: 'unavailable_collector',
    cost: null,
    compactions: null,
    sessionSelection: null,
    snapshotAgeSeconds: null,
    setupRequired: true,
  };
  const planRes = { ...collectorRes, rateLimits: null, rateLimitsStatus: 'unavailable_plan' };
  const providerRes = {
    ...collectorRes,
    rateLimits: null,
    rateLimitsStatus: 'unavailable_provider',
  };
  for (const res of [
    collectorRes,
    staleTranscriptRes,
    staleSnapshotRes,
    notSetUpRes,
    planRes,
    providerRes,
  ]) {
    const { human, json } = assembleReport(res, NOW);
    const blob = `${human}\n${JSON.stringify(json)}`;
    for (const re of forbidden) assert.doesNotMatch(blob, re);
    assert.equal('suggested_action' in json, false);
    assert.equal(typeof json.setup_required, 'boolean'); // always present, always boolean
  }
});
