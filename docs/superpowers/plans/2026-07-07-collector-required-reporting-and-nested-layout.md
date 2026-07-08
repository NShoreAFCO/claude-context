# Collector-Required Reporting & Nested Plugin Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `report.mjs` require a real collector snapshot before it reports any context numbers (never infer a window from the transcript again), and relocate the shipped plugin into `plugins/claude-context/` so `/plugin install` copies a lean tree.

**Architecture:** Two independent changes to the shipped plugin. (1) `resolveReport` collapses to three states keyed on *whether a snapshot has ever been written*: fresh → collector; stale → accurate transcript-or-snapshot context flagged `unavailable_stale`; none → a not-set-up state that performs **zero** transcript I/O and returns all-null values plus a new `setup_required: true` flag. The transcript-inference path and the `window_size_inferred` field are deleted. (2) The plugin's manifest, skill, commands, scripts, and a LICENSE copy move under `plugins/claude-context/`; tests, docs, and dev infra stay at the repo root; path references are rewritten.

**Tech Stack:** Node ESM (`.mjs`), zero dependencies, no build step. Tests use the built-in `node:test` runner (`npm test` → `node --test tests/*.test.mjs`).

**Spec:** `docs/superpowers/specs/2026-07-07-collector-required-reporting-and-nested-layout.md` (§ references below point into it).

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the spec.

- **Runtime:** self-contained Node ESM; **zero dependencies; no build step; no lint gate.** Requires Node 18+ or Bun.
- **Instrument, not advisor (§6):** rendered output carries **no** recommendations, evaluative/level/traffic-light labels, policy ("should compact", 70/85/90 thresholds), or derived/predictive metrics. The new cold-start text may instruct the user to *configure the tool* (`/claude-context:setup`) but must not acquire resource-policy vocabulary. This is enforced by the denylist test **over `report.mjs`'s rendered output** — never by grepping `SKILL.md`. The denylist fixtures must be extended to run the new cold-start human block through the forbidden-vocabulary loop.
- **Provenance is first-class (§6):** `source`, `rate_limits_status`, `session_selection` remain on every applicable report. `setup_required` joins them as an explicit boolean signal, **always present** on every report (`true` only in not-set-up; `false` otherwise).
- **Golden fixtures unchanged (§6):** `tests/fixtures/real-stdin.json` and `real-transcript.jsonl` are redacted live captures; do **not** replace them with synthesized data.
- **The move keeps the suite green (§7):** the nesting is one atomic change — files move, every path reference is rewritten, and `npm test` is green at the commit boundary. Following "update import paths" alone leaves `readFileSync` data paths and the `marketplace.json` `source` assertion stale.
- **Tests:** `node --test`, local-only, no network, no credential access. The runner glob stays `tests/*.test.mjs`; tests stay at the repo root so they never ship.

## File Structure

**Task 1–2 touch (still at flat paths):**
- `scripts/report.mjs` — rewrite `resolveReport` + the render helpers; delete the inference path and `window_size_inferred`; add the cold-start human block and `setup_required`.
- `scripts/lib/model-window.mjs` — **deleted** (its sole runtime caller is gone).
- `tests/report.test.mjs`, `tests/report-integration.test.mjs` — new/updated behavioral assertions.
- `tests/model-window.test.mjs` — **deleted**.

**Task 3 moves (into `plugins/claude-context/`):** `.claude-plugin/plugin.json`, `SKILL.md`, `commands/`, `scripts/` (with `lib/`), and a **copy** of `LICENSE`.

**Stays at repo root:** `.claude-plugin/marketplace.json`, `README.md`, `CLAUDE.md`, `LICENSE` (canonical — the plugin copy is *in addition to* this one), `docs/`, `paad/`, `package.json`, `CHANGELOG.md`, and `tests/` (with `fixtures/`).

**Task 4–5 touch (prose + version, at final paths):** `plugins/claude-context/SKILL.md`, `README.md`, `CLAUDE.md`, `plugins/claude-context/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `CHANGELOG.md`.

---

## Task 1: Collector-required reporting (the logic + render change)

Rewrite `resolveReport` to the three states in spec §2/§2.1, add `setup_required`, delete the `window_size_inferred` field and its render branches, and stop calling `inferWindowSize`. TDD: write the failing behavioral assertions first, then the implementation.

**Files:**
- Modify: `scripts/report.mjs`
- Test: `tests/report.test.mjs`, `tests/report-integration.test.mjs`

**Interfaces:**
- Consumes: `readSnapshot`, `findNewestSnapshot` (`./lib/snapshot.mjs`); `snapshotFileName`, `resolveConfigDir` (`./lib/config-dir.mjs`); `lastAssistantUsage`, `countCompactions`, `findNewestTranscript`, `transcriptForSession` (`./lib/transcript.mjs`); `usedTokens`, `percentage`, `headroom` (`./lib/token-math.mjs`). No new imports; **remove** `inferWindowSize`.
- Produces: `resolveReport(...)` returns a resolution object with a new `setupRequired: boolean` field and **no** `windowInferred` field. `assembleReport(r, now)` → `{ human, json }` where `json` has `setup_required` and **no** `window_size_inferred`.

- [ ] **Step 1: Rewrite the cold-start test to expect the not-set-up block (was: inferred-window `~%`)**

Replace the existing `'cold start: null context, no crash'` test in `tests/report.test.mjs` with:

```js
test('not set up (no snapshot ever): cold-start block + all-null JSON + setup_required + compactions null', () => {
  const res = {
    source: 'unavailable', model: {}, context: null, rateLimits: null,
    rateLimitsStatus: 'unavailable_collector', cost: null, compactions: null,
    sessionSelection: null, snapshotAgeSeconds: null, setupRequired: true,
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
```

- [ ] **Step 2: Replace the "inferred window" test with the stale snapshot-context fallback test**

The `'transcript fallback (no snapshot ever): inferred window …'` scenario no longer exists (no snapshot ⇒ not-set-up). Replace that whole test with the §2.1 fallback sub-case — a stale snapshot whose transcript yields no usage, reported from the snapshot's own context field as `source: collector`:

```js
test('stale snapshot, no transcript usage: reports the snapshot context as source collector, flagged stale', () => {
  const res = {
    source: 'collector',
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context: { window_size: 1000000, used_tokens: 50000, used_percentage: 5, input_tokens: 1000, cache_read_tokens: 47000, cache_creation_tokens: 2000, output_tokens: 0 },
    rateLimits: null, rateLimitsStatus: 'unavailable_stale', cost: null, compactions: 2,
    sessionSelection: 'session_id', snapshotAgeSeconds: 600, setupRequired: false,
  };
  const { human, json } = assembleReport(res, NOW);
  assert.equal(json.source, 'collector');
  assert.equal(json.rate_limits_status, 'unavailable_stale');
  assert.equal(json.context.used_percentage, 5);   // accurate against the real 1M window
  assert.equal(json.setup_required, false);
  assert.match(human, /^Source: collector · snapshot 600s old \(stale\)$/m); // stale-marked, not "fresh"
  assert.match(human, /^Session \(5h\): unavailable — last collector reading 600s ago \(idle; send a message to refresh\)$/m);
  assert.doesNotMatch(human, /\/claude-context:setup/); // already set up — never tell them to run setup
});
```

- [ ] **Step 3: Update the collector JSON test and the no-advice test for the new field set**

In `'collector JSON block is pure measurements + provenance'`, add:

```js
  assert.equal(json.setup_required, false);
  assert.equal('window_size_inferred' in json, false);
```

In `'stale snapshot → unavailable_stale keeps the age …'`, remove the now-defunct assertion line `assert.equal(json.window_size_inferred, false);` and drop `windowInferred: false` from that test's `res` literal.

In `'collector snapshot with an unpopulated window (0) …'`, drop the now-vestigial `windowInferred: false` from that test's `res` literal — the field is deleted, so leaving it in keeps a dead reference to a flag §3 claims to have fully removed (the test still passes either way, since the rewritten `buildJson` no longer reads it).

Rewrite the no-advice test's fixture list so the cold-start block is exercised and the deleted inferred-window fixture is gone:

```js
test('no-advice contract: rendered output carries no advice/level vocabulary in any state', () => {
  const forbidden = [/should compact/i, /recommend/i, /\byou should\b/i, /traffic.light/i, /\bpressure\b/i, /\b(70|85|90)%/];
  const staleTranscriptRes = { ...collectorRes, source: 'transcript', rateLimits: null, rateLimitsStatus: 'unavailable_stale', snapshotAgeSeconds: 420, sessionSelection: 'newest-in-cwd-heuristic', setupRequired: false };
  const staleSnapshotRes = { ...collectorRes, source: 'collector', rateLimits: null, rateLimitsStatus: 'unavailable_stale', snapshotAgeSeconds: 600, setupRequired: false };
  const notSetUpRes = { source: 'unavailable', model: {}, context: null, rateLimits: null, rateLimitsStatus: 'unavailable_collector', cost: null, compactions: null, sessionSelection: null, snapshotAgeSeconds: null, setupRequired: true };
  const planRes = { ...collectorRes, rateLimits: null, rateLimitsStatus: 'unavailable_plan' };
  const providerRes = { ...collectorRes, rateLimits: null, rateLimitsStatus: 'unavailable_provider' };
  for (const res of [collectorRes, staleTranscriptRes, staleSnapshotRes, notSetUpRes, planRes, providerRes]) {
    const { human, json } = assembleReport(res, NOW);
    const blob = `${human}\n${JSON.stringify(json)}`;
    for (const re of forbidden) assert.doesNotMatch(blob, re);
    assert.equal('suggested_action' in json, false);
    assert.equal(typeof json.setup_required, 'boolean'); // always present, always boolean
  }
});
```

- [ ] **Step 4: Add real-seam integration tests (cold start + stale) through `resolveReport`**

Append to `tests/report-integration.test.mjs` (reuses its existing `stdin`, `tmpDir`, `writeSnap`, `NOW`):

```js
test('cold start (no snapshot ever): resolveReport returns not-set-up without inventing numbers', () => {
  const dir = tmpDir('coldstart'); // empty snapshot dir
  const res = resolveReport({ now: NOW, sessionId: 'nobody', snapshotDir: dir, cwd: '/nonexistent', deps: fs, env: {} });
  const { json } = assembleReport(res, NOW);
  assert.equal(json.source, 'unavailable');
  assert.equal(json.setup_required, true);
  assert.equal(json.rate_limits_status, 'unavailable_collector');
  assert.equal(json.compactions, null);       // transcript I/O skipped entirely
  assert.equal(json.context.window_size, null); // no window ever inferred
});

test('stale snapshot, no transcript: resolveReport falls back to the snapshot context as source collector', () => {
  const dir = tmpDir('stale');
  const past = NOW - 10 * 60 * 1000; // 10 min before "now" → past the 5-min freshness window
  writeSnap(dir, 'sid-stale', buildSnapshot(stdin, past), past);
  const res = resolveReport({ now: NOW, sessionId: 'sid-stale', snapshotDir: dir, cwd: '/nonexistent', deps: fs, env: {} });
  const { json } = assembleReport(res, NOW);
  assert.equal(json.source, 'collector');
  assert.equal(json.rate_limits_status, 'unavailable_stale');
  assert.equal(json.context.window_size, 200000); // real window from the snapshot, not inferred
  assert.equal(json.context.used_percentage, 46);  // accurate against the real window
  assert.equal(json.setup_required, false);
});
```

- [ ] **Step 5: Run the report tests to verify they fail**

Run: `node --test tests/report.test.mjs tests/report-integration.test.mjs`
Expected: FAIL — e.g. `setup_required` is `undefined` (not yet emitted), the cold-start human still renders the old "no measurement yet" line, and the stale-fallback returns `source: unavailable`.

- [ ] **Step 6: Rewrite `resolveReport` in `scripts/report.mjs`**

Remove the import on line 9 (`import { inferWindowSize } from './lib/model-window.mjs';`). Replace the entire `resolveReport` function (currently lines 21–109) with:

```js
export function resolveReport({ now, sessionId = null, snapshotDir: dir, cwd, deps = fs, env = process.env }) {
  // 1. Prefer THIS session's own keyed snapshot; else the newest in the dir.
  let read = null;
  let identified = false;
  if (sessionId && dir) {
    read = readSnapshot(path.join(dir, snapshotFileName(sessionId)), { now, deps });
    if (read) identified = true;
  }
  if (!read && dir) {
    const newest = findNewestSnapshot(dir, { deps });
    if (newest) read = readSnapshot(newest, { now, deps });
  }

  // 2. Fresh snapshot → collector state.
  if (read && read.fresh) {
    const s = read.snapshot;
    const compactions = s.transcript_path ? countCompactions(s.transcript_path, deps) : 0;
    let rateLimitsStatus = 'available';
    if (!s.rate_limits) rateLimitsStatus = isProviderModel(s.model?.id, env) ? 'unavailable_provider' : 'unavailable_plan';
    return {
      source: 'collector',
      model: s.model ?? {},
      context: s.context ?? null,
      rateLimits: s.rate_limits ?? null,
      rateLimitsStatus,
      cost: numOrNull(s.cost?.total_cost_usd),
      compactions,
      sessionSelection: identified ? 'session_id' : 'unverified-snapshot',
      snapshotAgeSeconds: read.ageSeconds,
      setupRequired: false,
    };
  }

  // 3. NO snapshot has EVER been written → not-set-up. Skip ALL transcript I/O: the
  //    compaction count is unknown (null, not 0), and no window is ever inferred.
  if (!read) {
    return {
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
  }

  // 4. A snapshot exists but is STALE (collector idle). It still carries the real
  //    window size and its age; we must never tell an already-set-up user to run setup.
  const staleSnapshot = read.snapshot;
  const staleAge = read.ageSeconds;
  const knownWindow = numOrNull(staleSnapshot?.context?.window_size);

  const configDir = resolveConfigDir(env);
  // Prefer our OWN transcript (deterministic from the session id) over the cwd heuristic.
  let transcript = sessionId ? transcriptForSession(configDir, cwd, sessionId, deps) : null;
  let transcriptSelection = transcript ? 'session_id' : null;
  if (!transcript) {
    transcript = findNewestTranscript(configDir, cwd, deps);
    if (transcript) transcriptSelection = 'newest-in-cwd-heuristic';
  }
  const compactions = transcript ? countCompactions(transcript, deps) : 0;

  // Read the transcript's latest usage ONLY when the snapshot supplied a real window
  // to size it against (§2.1). Without a real window we never infer — we fall back to
  // the snapshot's own context field below.
  const usage = knownWindow > 0 && transcript ? lastAssistantUsage(transcript, deps) : null;

  if (usage) {
    const used = usedTokens(usage);
    return {
      source: 'transcript',
      model: { id: usage.model_id ?? '', display_name: '' },
      context: {
        window_size: knownWindow,
        used_tokens: used,
        used_percentage: percentage(used, knownWindow),
        input_tokens: usage.input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        output_tokens: usage.output_tokens,
      },
      rateLimits: null,
      rateLimitsStatus: 'unavailable_stale',
      cost: null,
      compactions,
      sessionSelection: transcriptSelection,
      snapshotAgeSeconds: staleAge,
      setupRequired: false,
    };
  }

  // Transcript yielded no usage: fall back to the stale snapshot's OWN context field
  // (it already carries the real window). Provenance is `collector` — the numbers come
  // from the snapshot — distinguished from a live reading only by unavailable_stale +
  // the reported age. Attribute the session to the snapshot's own identification, since
  // the context is snapshot-derived (matches the fresh-collector state's semantics).
  return {
    source: 'collector',
    model: staleSnapshot?.model ?? {},
    context: staleSnapshot?.context ?? null,
    rateLimits: null,
    rateLimitsStatus: 'unavailable_stale',
    cost: null,
    compactions,
    sessionSelection: identified ? 'session_id' : 'unverified-snapshot',
    snapshotAgeSeconds: staleAge,
    setupRequired: false,
  };
}
```

- [ ] **Step 7: Add the cold-start human block constant and update the render helpers**

Add this constant just above `buildHuman` in `scripts/report.mjs` (exact text from §2.2):

```js
const COLD_START_HUMAN = `Claude Context — collector not configured

No resource facts are available for this session yet: the usage collector
has not recorded a snapshot, so there is nothing to measure.

To enable reporting — context %, 5-hour / 7-day usage, session cost, and
compaction count — run:

    /claude-context:setup

That wires a statusline helper which captures the figures Claude Code sends
only to the statusline. Once it has run, this report returns live numbers.`;
```

In `buildJson`, remove the `window_size_inferred: !!r.windowInferred,` line and add `setup_required` right after `rate_limits_status`:

```js
    source: r.source,
    rate_limits_status: r.rateLimitsStatus,
    setup_required: !!r.setupRequired,
    snapshot_age_seconds: r.snapshotAgeSeconds,
    generated_at: new Date(now).toISOString(),
```

(Note: the cold-start JSON keeps `snapshot_age_seconds: null` for field-shape consistency — the spec's abbreviated §2.2 example omits it, but "all-null payload plus provenance" is served by keeping the always-present provenance key rather than dropping it in one state.)

In `buildHuman`, short-circuit the not-set-up state at the top and delete the `else if (c && r.windowInferred)` branch:

```js
function buildHuman(r, now) {
  if (r.setupRequired) return COLD_START_HUMAN;
  const lines = [`Claude Context — ${modelName(r.model)}`];
  const c = r.context;
  if (c && c.used_percentage == null) {
    lines.push('Context: unavailable — window size not reported yet');
  } else if (c) {
    lines.push(`Context: ${c.used_percentage}% used · ${kt(c.used_tokens)} / ${kt(c.window_size)} tokens · ${kt(headroom(c.used_tokens, c.window_size))} headroom`);
  } else {
    lines.push('Context: unavailable — no measurement yet (no assistant turn recorded, collector off)');
  }
  lines.push(rlLine('Session (5h)', r, r.rateLimits?.five_hour, now));
  lines.push(rlLine('Weekly (7d)', r, r.rateLimits?.seven_day, now));
  lines.push(`Cost: ${r.cost != null ? `$${r.cost.toFixed(2)}` : 'unavailable'} · Compactions: ${r.compactions}`);
  lines.push(sourceLine(r));
  return lines.join('\n');
}
```

Replace `sourceLine` so the `transcript` line no longer branches on inference (window is always from the snapshot now) and the stale collector-fallback is marked `(stale)`:

```js
function sourceLine(r) {
  if (r.source === 'collector') {
    const stale = r.rateLimitsStatus === 'unavailable_stale' ? ' (stale)' : '';
    return `Source: collector · snapshot ${r.snapshotAgeSeconds}s old${stale}${sessionNote(r)}`;
  }
  if (r.source === 'transcript') {
    const age = r.snapshotAgeSeconds != null ? ` · snapshot ${r.snapshotAgeSeconds}s old (stale)` : '';
    const sess = r.sessionSelection === 'session_id' ? 'this session' : 'newest-in-cwd (heuristic)';
    return `Source: transcript fallback · context only · window from snapshot${age} · session: ${sess}`;
  }
  return 'Source: unavailable';
}
```

- [ ] **Step 8: Run the report tests to verify they pass**

Run: `node --test tests/report.test.mjs tests/report-integration.test.mjs`
Expected: PASS (all cases in both files).

- [ ] **Step 9: Run the full suite to confirm nothing else regressed**

Run: `npm test`
Expected: PASS except `tests/model-window.test.mjs`, which still passes on its own (its module is deleted in Task 2). If any *other* file fails, stop and fix before committing.

- [ ] **Step 10: Commit**

```bash
git add scripts/report.mjs tests/report.test.mjs tests/report-integration.test.mjs
git commit -m "feat: require a collector snapshot for reported numbers; drop window inference"
```

---

## Task 2: Delete the now-dead `model-window` module

Its only runtime caller (the transcript-inference path) was removed in Task 1, leaving `inferWindowSize` referenced only by its own test.

**Files:**
- Delete: `scripts/lib/model-window.mjs`, `tests/model-window.test.mjs`

- [ ] **Step 1: Verify nothing still imports the module**

Run: `grep -rn "model-window\|inferWindowSize" scripts tests`
Expected: only `tests/model-window.test.mjs` (and possibly nothing in `scripts/` — the Task 1 import removal is confirmed here). If `scripts/report.mjs` still matches, the Task 1 import removal was missed — fix it first.

- [ ] **Step 2: Delete both files**

```bash
git rm scripts/lib/model-window.mjs tests/model-window.test.mjs
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, with no reference to the deleted files.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: remove dead model-window inference module"
```

---

## Task 3: Nest the shipped plugin under `plugins/claude-context/`

One atomic mechanical change: move the shipped files, copy LICENSE, and rewrite every path reference so `npm test` stays green (§4, §7).

**Files:**
- Move: `.claude-plugin/plugin.json`, `SKILL.md`, `commands/`, `scripts/` → under `plugins/claude-context/`
- Copy: `LICENSE` → `plugins/claude-context/LICENSE`
- Modify: `.claude-plugin/marketplace.json`; `tests/manifest.test.mjs`, `tests/setup.test.mjs`, `tests/skill.test.mjs`; the 8 test files importing from `../scripts/`

- [ ] **Step 1: Move the shipped files and copy LICENSE**

```bash
mkdir -p plugins/claude-context/.claude-plugin
git mv .claude-plugin/plugin.json plugins/claude-context/.claude-plugin/plugin.json
git mv SKILL.md plugins/claude-context/SKILL.md
git mv commands plugins/claude-context/commands
git mv scripts plugins/claude-context/scripts
cp LICENSE plugins/claude-context/LICENSE
git add plugins/claude-context/LICENSE
```

`.claude-plugin/marketplace.json` stays at the repo root. The root `LICENSE` stays (canonical); the plugin now carries its own copy.

- [ ] **Step 2: Point the marketplace entry at the nested plugin**

In `.claude-plugin/marketplace.json`, change the plugin `source`:

```json
      "source": "./plugins/claude-context",
```

- [ ] **Step 3: Rewrite test import specifiers to the nested scripts path**

In every test that imports from `../scripts/`, replace the prefix `from '../scripts/` with `from '../plugins/claude-context/scripts/`. The eight affected files: `tests/report.test.mjs`, `tests/report-integration.test.mjs`, `tests/collect.test.mjs`, `tests/config-dir.test.mjs`, `tests/snapshot.test.mjs`, `tests/transcript.test.mjs`, `tests/token-math.test.mjs`, `tests/time.test.mjs`. Fixture paths (`fixtures/…`) are unchanged.

Verify none remain:

Run: `grep -rn "from '\.\./scripts" tests`
Expected: no output.

- [ ] **Step 4: Rewrite the `readFileSync` data paths for moved files**

In `tests/manifest.test.mjs`, read `plugin.json` from the nested location (line 12) and update the `source` assertion (line 23); keep `marketplace.json` at the root (line 20):

```js
  const m = readJson('plugins/claude-context/.claude-plugin/plugin.json'); // line 12: plugin.json moved
  ...
  assert.equal(m.plugins[0].source, './plugins/claude-context');           // line 23: was './'
```

In `tests/setup.test.mjs` line 8:

```js
const setup = readFileSync(path.join(root, 'plugins', 'claude-context', 'commands', 'setup.md'), 'utf8');
```

In `tests/skill.test.mjs` line 9:

```js
const skill = readFileSync(path.join(root, 'plugins', 'claude-context', 'SKILL.md'), 'utf8');
```

`tests/docs.test.mjs` needs **no change**: `LICENSE`, `README.md`, and `CHANGELOG.md` all stay at the repo root.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. If a test can't find a file, its data/import path wasn't rewritten — fix per Steps 3–4. `setup.test.mjs`'s `plugins/cache/*/claude-context/` glob assertion still passes: that string describes the *install cache* path (unchanged by repo nesting, verified against the installed `paad` plugin), not the repo path.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: nest the shipped plugin under plugins/claude-context; rewrite paths"
```

---

## Task 4: Sync the narrative docs to the new behavior and layout

Prose-only updates so the docs describe collector-required reporting and the nested paths (§5). No test asserts the changed content, so verification is "the doc tests still pass."

**Files:**
- Modify: `plugins/claude-context/SKILL.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Update `plugins/claude-context/SKILL.md`**

- In the "pass the measurements through as-is" paragraph, drop `window_size_inferred` from the provenance list and add `setup_required`: change `(\`source\`, \`rate_limits_status\`, \`window_size_inferred\`, \`session_selection\`)` to `(\`source\`, \`rate_limits_status\`, \`setup_required\`, \`session_selection\`)`.
- In the field reference, **delete** the `window_size_inferred` bullet and **add** a `setup_required` bullet:

```markdown
- **setup_required** — `true` only when no collector snapshot has ever been
  written (the not-set-up state): 5h/7d, cost, context, and compactions are all
  `null` and the human block explains how to run `/claude-context:setup`. `false`
  in every other state. Gate on this one field instead of inferring setup status
  from `source`/`rate_limits_status`.
```

- Update the `source` bullet so `transcript` is described as the stale/idle context fallback (not a works-without-setup path), and note that the not-set-up state (`source: unavailable`) carries `compactions: null`.
- Rewrite the "Sources and reliability" section to the three states: **collector** (fresh snapshot), **collector idle** (stale snapshot — accurate context from the transcript or the snapshot's own field, 5h/7d/cost `null`, `unavailable_stale`), and **not set up** (no snapshot ever — everything `null`, `setup_required: true`, the report explains how to enable it). Remove the claim that context health is reported "without" the collector. Drop the remaining `window_size_inferred` mention.

- [ ] **Step 2: Update `README.md`**

- Remove the "works out of the box / reads context health straight from the transcript" framing (the "Install" section's "It works immediately, reading context health straight from the session transcript." sentence, and the "Turn on live usage and cost" section's "Context health works out of the box." opener). Replace with: reporting requires the one-time `/claude-context:setup`; before that the report explains how to enable it.
- In "Every number says how much to trust it," remove `window_size_inferred` as the estimation example (there is no inference anymore); describe provenance as `source`, `rate_limits_status`, `setup_required`, and `session_selection`.
- Set the canonical install form to `/plugin install claude-context@claude-context`.

Verify the doc test still holds (its regexes match the new copy):

Run: `node --test tests/docs.test.mjs`
Expected: PASS.

- [ ] **Step 3: Update `CLAUDE.md`**

- Rewrite the architecture/degradation description from "snapshot → transcript → cold-start" to the three states in §2 (collector; collector idle / stale; not set up — no transcript I/O, `setup_required`, `compactions: null`).
- Remove `window_size_inferred` from the provenance sentence; note `setup_required` as an always-present field.
- Update every path reference to the nested locations: `scripts/…` → `plugins/claude-context/scripts/…`, `SKILL.md` → `plugins/claude-context/SKILL.md`, `commands/…` → `plugins/claude-context/commands/…`, and `.claude-plugin/plugin.json` → `plugins/claude-context/.claude-plugin/plugin.json` (marketplace.json stays at the root). Note that tests stay at the repo root.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS (`skill.test.mjs` and `docs.test.mjs` assert structure/contract vocabulary, not the changed prose).

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-context/SKILL.md README.md CLAUDE.md
git commit -m "docs: describe collector-required reporting and the nested layout"
```

---

## Task 5: Version bump, marketplace metadata cleanup, and changelog

Bump to `0.2.0` (removed a documented field, changed behavior) and tidy `marketplace.json` (§5).

**Files:**
- Modify: `plugins/claude-context/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `CHANGELOG.md`, `tests/manifest.test.mjs`

- [ ] **Step 1: Bump `plugin.json`**

In `plugins/claude-context/.claude-plugin/plugin.json`, change `"version": "0.1.0"` → `"version": "0.2.0"`.

- [ ] **Step 2: Move `marketplace.json` metadata to the top level and bump the version**

Rewrite `.claude-plugin/marketplace.json` so `description` and `version` sit at the top level (current-spec location) rather than under `metadata`, and the version is `0.2.0`:

```json
{
  "name": "claude-context",
  "owner": { "name": "Ovid" },
  "description": "On-demand session resource facts for users and agents — pure measurements, no advice.",
  "version": "0.2.0",
  "plugins": [
    {
      "name": "claude-context",
      "source": "./plugins/claude-context",
      "description": "Report the current session's context window, 5h/7d subscription usage, cost, and compactions on demand — for users and agents. Pure measurements, no recommendations.",
      "category": "monitoring",
      "tags": ["context", "usage", "rate-limits", "statusline", "telemetry"]
    }
  ]
}
```

Top-level `description`/`version` is the **canonical** location per the marketplace
schema (`https://code.claude.com/docs/en/plugin-marketplaces` → "Marketplace schema":
top-level `description` and `version` are optional fields; the docs note "`description`
and `version` are also accepted under `metadata` for backward compatibility"). So this
is a legacy→canonical move, not a risky rewrite — the current `metadata`-nested form is
not broken, both locations are read. This move is not required by the two feature goals;
it's incidental modernization, kept because it's low-risk and the file is already being
edited for the version bump.

**Guard the canonical location.** `tests/manifest.test.mjs` currently asserts nothing
about the marketplace's `version`/`description` in *either* spot, so a regression (a typo,
or a silent revert to `metadata`-only) would ship with the suite green. Extend the
`'marketplace.json points at this plugin'` test with two assertions on the now-top-level
fields:

```js
  assert.match(m.version, /^\d+\.\d+\.\d+$/);   // top-level (canonical) — NOT metadata.version
  assert.equal(typeof m.description, 'string'); // top-level (canonical) — NOT metadata.description
```

- [ ] **Step 3: Add a `CHANGELOG.md` entry**

Insert above the `## 0.1.0` entry:

```markdown
## 0.2.0

- Reporting now requires the collector: with no snapshot ever written, the report
  returns a not-set-up state (all-null values, new `setup_required: true`, and a
  human block explaining `/claude-context:setup`) instead of inferring the context
  window from the transcript. Removed the `window_size_inferred` field and the
  `model-window` inference module. A stale snapshot still reports accurate context
  (from the transcript, or the snapshot's own field) flagged `unavailable_stale`.
- Repository relocated the shipped plugin into `plugins/claude-context/` so
  `/plugin install` copies a lean tree (docs, tests, and dev infra stay at the root).
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS (`manifest.test.mjs` accepts `0.2.0` as a semver, reads the nested `plugin.json`, and its new assertions find the top-level `version`/`description` on the rewritten `marketplace.json`; `docs.test.mjs`'s `CHANGELOG` check matches `0.1.0`, still present).

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-context/.claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md tests/manifest.test.mjs
git commit -m "chore: release 0.2.0; move marketplace metadata to canonical top level"
```

---

## Self-Review

**1. Spec coverage.**
- §2 three states + §2.1 the only logic change → Task 1 (`resolveReport` rewrite; cold-start-no-IO; `knownWindow > 0` gate; snapshot-context fallback as `source: collector`).
- §2.2 cold-start human block + all-null JSON + `setup_required` + `compactions: null` → Task 1 (constant, `buildHuman` short-circuit, `buildJson` field).
- §3 dead code (`model-window.mjs`, test, import, `window_size_inferred` field + render branches) → Task 1 (field/render/import) + Task 2 (module + test files).
- §4 nested layout + path rewrites (marketplace `source`, test imports, CLAUDE.md) → Task 3 (+ CLAUDE.md in Task 4, done once with the content edit).
- §5 docs & versioning (README framing, SKILL three-state + field reference, CLAUDE.md, marketplace metadata move, version bump, CHANGELOG) → Tasks 4 and 5.
- §6 contract (denylist over output covers cold start; provenance + `setup_required`; golden fixtures untouched) → Task 1 Step 3 (denylist fixtures) and the Global Constraints.
- §7 testing impact (delete model-window test; update report/report-integration; import specifiers on 8 files; manifest/setup/skill data paths + manifest `source` assertion; docs.test unchanged) → Tasks 1, 2, 3.
- §8 non-goals (no collector change; no fresh/stale shape change beyond dropping `window_size_inferred`; no second plugin) → honored: `collect.mjs` and `commands/setup.md` content are untouched.

**2. Placeholder scan.** No TBD/TODO/"handle edge cases"; every code step shows complete code; the one mechanical bulk edit (Step 3 of Task 3) is an exact find/replace rule with a `grep` verification, not a placeholder.

**3. Type consistency.** The resolution object gains `setupRequired` (camelCase, internal) and loses `windowInferred`; `buildJson` emits `setup_required` (snake_case, external) via `!!r.setupRequired` and no longer emits `window_size_inferred`. Every `resolveReport` return sets `setupRequired` explicitly. `resolveReport`, `assembleReport`, `buildSnapshot`, `writeSnapshot`, `snapshotFileName` signatures are unchanged, so Task 3's import moves are pure path rewrites.
