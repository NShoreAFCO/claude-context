# claude-context Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `claude-context` Claude Code plugin — a skill and opt-in statusline collector that report the current session's resource facts (context window, 5h/7d subscription usage, cost, compactions) to users and agents as pure measurements, with no advice.

**Architecture:** An opt-in statusline collector (`collect.mjs`) parses the stdin JSON Claude Code pushes to the statusline process, and writes a private `snapshot.json`. The skill runs a report engine (`report.mjs`) that reads that snapshot when fresh, falls back to the transcript JSONL for context-only data when it isn't, and degrades to an "unavailable" cold-start state otherwise. Both scripts share dependency-free `lib/` helpers. The report emits a human block and a machine-readable JSON block — measurements and provenance only.

**Tech Stack:** Node ESM (`.mjs`), zero dependencies, no build step. Tests use the built-in `node:test` runner. The plugin is distributed as a marketplace plugin.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the design spec (`docs/superpowers/specs/2026-07-07-claude-context-plugin-design.md`).

- **Runtime:** self-contained Node ESM; **zero dependencies; no build step**. All scripts are `.mjs` run directly. Requires Node 18+ or Bun.
- **Instrument, not advisor:** output carries **no** recommendations, evaluative/level/traffic-light labels, policy (no "should compact", no 70/85/90 rules), or derived/predictive metrics. Raw measurements and provenance only. The no-advice denylist is asserted against the **rendered `report.mjs` output across every state** (Task 9), **not by grepping `SKILL.md`** — whose own text legitimately names the advice vocabulary it refuses to emit (e.g. "makes no recommendations"). The tests guarantee the *report emits* no advice vocabulary and no `suggested_action`/level fields — they cannot govern what a consuming agent then says, so `SKILL.md` states the data-only contract and instructs the caller to relay the numbers without editorializing.
- **Snapshot path:** `<config-dir>/claude-context/snapshot.json`, mode `0600`, where `<config-dir>` is `process.env.CLAUDE_CONFIG_DIR` when set and non-empty, otherwise `os.homedir()/.claude`. Writer and reader resolve it identically.
- **Native fields:** prefer `context_window.used_percentage` over recomputing, **but treat a native `used_percentage` of `0` (or non-finite) as "not yet populated" and fall through to the token-based calculation** — mirroring claude-hud's `getNativePercent`. On a fresh session Claude Code emits `used_percentage=0` before the first API response while `current_usage` already holds the real initial-context tokens (system prompt, tools, memory), so trusting the literal `0` would report `Context 0%` when the window is already partly full. Treat `rate_limits.*.resets_at` from stdin as a **Unix epoch in seconds** and multiply by 1000 before converting to ISO. (Rate-limit `used_percentage` keeps `0` as a valid value; the `0 = unpopulated` guard applies only to context.)
- **Conditional rate limits:** `rate_limits` is present only for Pro/Max subscribers after the first API response, and is absent for API-key accounts, Bedrock/Vertex providers, and older Claude Code versions. Absence is therefore reported as one of several distinct `rate_limits_status` values, never collapsed to a single "this plan" verdict: `available`; `unavailable_plan` (fresh snapshot, non-provider account, no window reported — covers both genuine no-subscription and the transient pre-first-response window, so its copy must not assert permanence); `unavailable_provider` (Bedrock/Vertex, detected from the model id or `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`); `unavailable_stale` (a snapshot exists but is past the freshness window); `unavailable_collector` (no snapshot has ever been written).
- **Throttle / freshness:** snapshot write throttle ≈ 30s; reader freshness window 5 minutes. A snapshot that exists but is past the freshness window is a **distinct reported state** (`unavailable_stale`), never treated as "collector absent": the report keeps the snapshot's age and, per the window-reuse rule below, reuses its real `context.window_size` to size the transcript fallback. So `readSnapshot` must report *why* it declined a snapshot (missing/unparseable vs. present-but-stale) rather than collapsing both to `null`.
- **Window-size reuse (fallback):** the collector's snapshot stores the real `context_window_size` from stdin. In transcript fallback the report reuses that real `window_size` whenever a snapshot exists (even a stale one), and only falls back to `inferWindowSize` when **no snapshot has ever been written**. `inferWindowSize` cannot detect a 1M-context session from a transcript model id (Claude Code writes the base id, e.g. `claude-opus-4-8`, with no `1m` marker), so any purely-inferred window is flagged (`window_size_inferred: true`) and the human line hedges the percentage.
- **Existing statusline:** setup takes an empty `statusLine` slot automatically; if one exists it backs it up and asks replace-or-keep. The collector never chains/execs another statusline command.
- **Invocation name:** the skill is `/claude-context:claude-context` (short form `/claude-context` when unambiguous); the setup command is `/claude-context:setup`.
- **Borrowed code:** `lib/` helpers adapted from claude-hud (MIT, © Jarrod Watts) must carry an attribution header comment; claude-hud is acknowledged in the README.
- **Tests:** `node --test`. No network, no credential access, local-only.

---

## File Structure

- `.claude-plugin/plugin.json` — plugin manifest (name, version, metadata, `commands`).
- `.claude-plugin/marketplace.json` — marketplace entry enabling `/plugin marketplace add`.
- `package.json` — metadata, `engines`, `test` script. No dependencies.
- `SKILL.md` — the skill at the plugin root (single-skill layout). Interface + field reference + data-only statement; tells Claude to run `report.mjs`.
- `scripts/collect.mjs` — statusline collector. Exports `buildSnapshot`, `compactLine`; CLI writes the snapshot and prints a compact line.
- `scripts/report.mjs` — report engine. Exports `resolveReport`, `assembleReport`; CLI prints the human + JSON blocks.
- `scripts/lib/config-dir.mjs` — `resolveConfigDir`, `snapshotPath`.
- `scripts/lib/token-math.mjs` — `usedTokens`, `percentage`, `headroom`.
- `scripts/lib/model-window.mjs` — `inferWindowSize`.
- `scripts/lib/time.mjs` — `epochToMs`, `formatDuration`, `clockHM`.
- `scripts/lib/transcript.mjs` — `lastAssistantUsage`, `countCompactions`, `findNewestTranscript`.
- `scripts/lib/snapshot.mjs` — `writeSnapshot`, `readSnapshot`, constants.
- `commands/setup.md` — version-resilient statusLine wiring, replace-or-keep, cross-platform.
- `tests/*.test.mjs`, `tests/fixtures/` — unit tests and fixtures, including **golden fixtures captured from a real statusline stdin and a real transcript** (`real-stdin.json`, `real-transcript.jsonl`) that guard the external-format mapping against drift.
- `README.md`, `LICENSE`, `CHANGELOG.md` — docs.

Each `lib/` module has one responsibility and no cross-imports except where noted, so it can be reasoned about and tested in isolation. `collect.mjs` and `report.mjs` compose the libs and hold the only I/O entry points.

---

## Task 1: Plugin scaffold & manifests

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `package.json`
- Test: `tests/manifest.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a validated plugin skeleton. Plugin name `claude-context`, version `0.1.0`.

- [ ] **Step 1: Write the failing test**

```js
// tests/manifest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

test('plugin.json has required fields', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(m.name, 'claude-context');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.commands.includes('./commands/setup.md'));
  assert.equal(m.skills, undefined, 'no skills field so root SKILL.md auto-loads');
});

test('marketplace.json points at this plugin', () => {
  const m = readJson('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'claude-context');
  assert.equal(m.plugins[0].name, 'claude-context');
  assert.equal(m.plugins[0].source, './');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/manifest.test.mjs`
Expected: FAIL — `ENOENT` opening `.claude-plugin/plugin.json`.

- [ ] **Step 3: Create the manifests and package.json**

```json
// .claude-plugin/plugin.json
{
  "name": "claude-context",
  "version": "0.1.0",
  "description": "On-demand session resource facts (context window, 5h/7d usage, cost, compactions) for users and agents — pure measurements, no advice.",
  "author": { "name": "Ovid" },
  "license": "MIT",
  "homepage": "https://github.com/Ovid/claude-context",
  "repository": "https://github.com/Ovid/claude-context",
  "commands": ["./commands/setup.md"],
  "keywords": ["context", "usage", "rate-limits", "statusline", "claude-code", "telemetry"]
}
```

```json
// .claude-plugin/marketplace.json
{
  "name": "claude-context",
  "owner": { "name": "Ovid" },
  "metadata": {
    "description": "On-demand session resource facts for users and agents — pure measurements, no advice.",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "claude-context",
      "source": "./",
      "description": "Report the current session's context window, 5h/7d subscription usage, cost, and compactions on demand — for users and agents. Pure measurements, no recommendations.",
      "category": "monitoring",
      "tags": ["context", "usage", "rate-limits", "statusline", "telemetry"]
    }
  ]
}
```

```json
// package.json
{
  "name": "claude-context",
  "version": "0.1.0",
  "description": "On-demand session resource facts for Claude Code — pure measurements, no advice.",
  "license": "MIT",
  "type": "module",
  "private": true,
  "engines": { "node": ">=18" },
  "scripts": { "test": "node --test" }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/manifest.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json package.json tests/manifest.test.mjs
git commit -m "feat: scaffold claude-context plugin manifests"
```

---

## Task 2: Config-dir resolution (`lib/config-dir.mjs`)

**Files:**
- Create: `scripts/lib/config-dir.mjs`
- Test: `tests/config-dir.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveConfigDir(env = process.env): string`
  - `snapshotPath(env = process.env): string` → `<config-dir>/claude-context/snapshot.json`

- [ ] **Step 1: Write the failing test**

```js
// tests/config-dir.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveConfigDir, snapshotPath } from '../scripts/lib/config-dir.mjs';

test('honors CLAUDE_CONFIG_DIR when set', () => {
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }), '/tmp/cfg');
});

test('falls back to homedir/.claude', () => {
  assert.equal(resolveConfigDir({}), path.join(os.homedir(), '.claude'));
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '  ' }), path.join(os.homedir(), '.claude'));
});

test('snapshotPath appends claude-context/snapshot.json', () => {
  assert.equal(snapshotPath({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }), '/tmp/cfg/claude-context/snapshot.json');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config-dir.test.mjs`
Expected: FAIL — cannot find module `../scripts/lib/config-dir.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/config-dir.mjs
// Adapted from claude-hud (MIT, © Jarrod Watts): config directory resolution.
import os from 'node:os';
import path from 'node:path';

export function resolveConfigDir(env = process.env) {
  const override = env.CLAUDE_CONFIG_DIR;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return path.join(os.homedir(), '.claude');
}

export function snapshotPath(env = process.env) {
  return path.join(resolveConfigDir(env), 'claude-context', 'snapshot.json');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config-dir.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/config-dir.mjs tests/config-dir.test.mjs
git commit -m "feat: add config-dir resolution honoring CLAUDE_CONFIG_DIR"
```

---

## Task 3: Token math (`lib/token-math.mjs`)

**Files:**
- Create: `scripts/lib/token-math.mjs`
- Test: `tests/token-math.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `usedTokens(usage): number` — sums `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (missing/invalid → 0).
  - `percentage(used, windowSize): number|null` — `round(used/window*100)`, `null` when window ≤ 0.
  - `headroom(used, windowSize): number|null` — `max(0, window - used)`, `null` when window ≤ 0.

- [ ] **Step 1: Write the failing test**

```js
// tests/token-math.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usedTokens, percentage, headroom } from '../scripts/lib/token-math.mjs';

test('usedTokens sums input + cache read + cache creation', () => {
  assert.equal(usedTokens({ input_tokens: 1200, cache_read_input_tokens: 88000, cache_creation_input_tokens: 2800, output_tokens: 500 }), 92000);
});

test('usedTokens treats missing/invalid fields as 0', () => {
  assert.equal(usedTokens({}), 0);
  assert.equal(usedTokens(null), 0);
  assert.equal(usedTokens({ input_tokens: 'x', cache_read_input_tokens: 5 }), 5);
});

test('percentage and headroom', () => {
  assert.equal(percentage(92000, 200000), 46);
  assert.equal(headroom(92000, 200000), 108000);
});

test('percentage/headroom guard against zero window', () => {
  assert.equal(percentage(100, 0), null);
  assert.equal(headroom(100, 0), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/token-math.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/token-math.mjs
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function usedTokens(usage) {
  return num(usage?.input_tokens) + num(usage?.cache_read_input_tokens) + num(usage?.cache_creation_input_tokens);
}

export function percentage(used, windowSize) {
  if (!windowSize || windowSize <= 0) return null;
  return Math.round((used / windowSize) * 100);
}

export function headroom(used, windowSize) {
  if (!windowSize || windowSize <= 0) return null;
  return Math.max(0, windowSize - used);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/token-math.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/token-math.mjs tests/token-math.test.mjs
git commit -m "feat: add token math helpers"
```

---

## Task 4: Model → window-size inference (`lib/model-window.mjs`)

**Files:**
- Create: `scripts/lib/model-window.mjs`
- Test: `tests/model-window.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `inferWindowSize(model): number` — accepts `{ id }` (or null); returns `1000000` for 1M-context variants (id contains a `1m` marker), else `200000`. This is a **last-resort cold-start guess**, used only when the transcript fallback runs and **no snapshot has ever been written** (so the real `context_window_size` cannot be recovered). When any snapshot exists — even a stale one — the report reuses its real `window_size` instead (see Task 9). Note: this heuristic has **no basis in the borrowed claude-hud code** (claude-hud always reads the real size from live stdin, and recovers it from a per-session cache of the last good frame; it never derives the window from the model id). A genuine 1M session in pure cold-start cannot be detected here, so the inferred window is flagged and the reported `%` is hedged.

- [ ] **Step 1: Write the failing test**

```js
// tests/model-window.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferWindowSize } from '../scripts/lib/model-window.mjs';

test('defaults to 200k', () => {
  assert.equal(inferWindowSize({ id: 'claude-opus-4-8' }), 200000);
  assert.equal(inferWindowSize({ id: 'claude-sonnet-5' }), 200000);
  assert.equal(inferWindowSize(null), 200000);
});

test('detects 1M variants', () => {
  assert.equal(inferWindowSize({ id: 'claude-opus-4-8[1m]' }), 1000000);
  assert.equal(inferWindowSize({ id: 'claude-sonnet-5-1m' }), 1000000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/model-window.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/model-window.mjs
const DEFAULT_WINDOW = 200_000;
const MILLION = 1_000_000;

// Matches "[1m]" or a "1m" token bounded by non-alphanumerics (e.g. "-1m").
const ONE_MILLION = /\[1m\]|(^|[^0-9a-z])1m([^0-9a-z]|$)/;

export function inferWindowSize(model) {
  const id = String(model?.id ?? '').toLowerCase();
  return ONE_MILLION.test(id) ? MILLION : DEFAULT_WINDOW;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/model-window.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/model-window.mjs tests/model-window.test.mjs
git commit -m "feat: add model to window-size inference"
```

---

## Task 5: Time & date helpers (`lib/time.mjs`)

**Files:**
- Create: `scripts/lib/time.mjs`
- Test: `tests/time.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `epochToMs(value): number|null` — epoch seconds or ms → ms (`value > 1e12 ? value : value*1000`); `null` for non-positive/invalid.
  - `formatDuration(totalSeconds): string|null` — `"3d 4h"`, `"1h 30m"`, `"45m"`, `"<1m"`; `null` for negative/nullish.
  - `clockHM(date): string` — local `"HH:MM"`.

- [ ] **Step 1: Write the failing test**

```js
// tests/time.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epochToMs, formatDuration, clockHM } from '../scripts/lib/time.mjs';

test('epochToMs distinguishes seconds from milliseconds', () => {
  assert.equal(epochToMs(1751892600), 1751892600000);
  assert.equal(epochToMs(1751892600000), 1751892600000);
  assert.equal(epochToMs(0), null);
  assert.equal(epochToMs('x'), null);
});

test('formatDuration', () => {
  assert.equal(formatDuration(5400), '1h 30m');
  assert.equal(formatDuration(273600), '3d 4h');
  assert.equal(formatDuration(2700), '45m');
  assert.equal(formatDuration(30), '<1m');
  assert.equal(formatDuration(-1), null);
});

test('clockHM formats local hours:minutes', () => {
  assert.equal(clockHM(new Date(2026, 6, 7, 14, 30)), '14:30');
  assert.equal(clockHM(new Date(2026, 6, 7, 9, 5)), '09:05');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/time.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/time.mjs
// Adapted from claude-hud (MIT, © Jarrod Watts): epoch parsing + reset formatting.
export function epochToMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value : value * 1000;
}

export function formatDuration(totalSeconds) {
  if (totalSeconds == null || totalSeconds < 0) return null;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function clockHM(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/time.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/time.mjs tests/time.test.mjs
git commit -m "feat: add time and epoch helpers"
```

---

## Task 6: Transcript parsing (`lib/transcript.mjs`)

Note: the transcript JSONL entry shapes below (assistant `message.usage`, `compact_boundary`) mirror `claude-hud/src/transcript.ts`. Cross-check that file and one real transcript under `~/.claude/projects/<encoded-cwd>/` during implementation; the fixtures in this task define the shapes the code parses.

**Files:**
- Create: `scripts/lib/transcript.mjs`
- Test: `tests/transcript.test.mjs`
- Test fixtures: `tests/fixtures/session.jsonl`, `tests/fixtures/empty.jsonl`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `lastAssistantUsage(filePath, deps = fs): { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens, model_id } | null`
  - `countCompactions(filePath, deps = fs): number` — `compact_boundary` entries with a valid timestamp.
  - `findNewestTranscript(configDir, cwd, deps = fs): string | null` — newest `*.jsonl` under `<configDir>/projects/<encoded-cwd>/`.

- [ ] **Step 1: Create the fixtures**

```text
// tests/fixtures/session.jsonl
{"type":"user","message":{"role":"user","content":"hi"}}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":1000,"cache_read_input_tokens":40000,"cache_creation_input_tokens":1000,"output_tokens":200}}}
{"type":"system","subtype":"compact_boundary","timestamp":"2026-07-07T12:00:00.000Z"}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":1200,"cache_read_input_tokens":88000,"cache_creation_input_tokens":2800,"output_tokens":0}}}
{"broken json line
{"type":"system","subtype":"compact_boundary"}
```

```text
// tests/fixtures/empty.jsonl
```

(`empty.jsonl` is a zero-byte file. The last `compact_boundary` above has no timestamp and must not be counted.)

- [ ] **Step 2: Write the failing test**

```js
// tests/transcript.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lastAssistantUsage, countCompactions, findNewestTranscript } from '../scripts/lib/transcript.mjs';

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/transcript.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write minimal implementation**

```js
// scripts/lib/transcript.mjs
// Adapted from claude-hud (MIT, © Jarrod Watts): transcript JSONL parsing.
import fs from 'node:fs';
import path from 'node:path';

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readJsonl(filePath, deps) {
  const raw = deps.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed lines */ }
  }
  return out;
}

export function lastAssistantUsage(filePath, deps = fs) {
  let entries;
  try { entries = readJsonl(filePath, deps); } catch { return null; }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const usage = e?.message?.usage ?? e?.usage;
    if (e?.type === 'assistant' && usage && typeof usage === 'object') {
      return {
        input_tokens: num(usage.input_tokens),
        cache_read_input_tokens: num(usage.cache_read_input_tokens),
        cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
        output_tokens: num(usage.output_tokens),
        model_id: typeof e?.message?.model === 'string' ? e.message.model
          : (typeof e?.model === 'string' ? e.model : null),
      };
    }
  }
  return null;
}

export function countCompactions(filePath, deps = fs) {
  let entries;
  try { entries = readJsonl(filePath, deps); } catch { return 0; }
  let count = 0;
  for (const e of entries) {
    const isBoundary = e?.type === 'compact_boundary' || e?.subtype === 'compact_boundary';
    if (!isBoundary) continue;
    const ts = e?.timestamp;
    if (typeof ts === 'string' && Number.isFinite(Date.parse(ts))) count++;
  }
  return count;
}

export function findNewestTranscript(configDir, cwd, deps = fs) {
  const encoded = String(cwd).replace(/[/\\.]/g, '-');
  const dir = path.join(configDir, 'projects', encoded);
  let files;
  try { files = deps.readdirSync(dir); } catch { return null; }
  let newest = null;
  let newestMtime = -Infinity;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    let mtime;
    try { mtime = deps.statSync(full).mtimeMs; } catch { continue; }
    if (mtime > newestMtime) { newestMtime = mtime; newest = full; }
  }
  return newest;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/transcript.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5b: Add a golden fixture captured from a real transcript**

The fixtures above are hand-authored to the *assumed* JSONL shape, so the suite can pass while the code misreads the real format. Add one tripwire against the *real* shape: copy a few `assistant` turns from a real session transcript at `~/.claude/projects/<encoded-cwd>/*.jsonl`, redact every `content` field, and commit the slice as `tests/fixtures/real-transcript.jsonl`. **Keep the real `message.usage` objects intact** — Claude Code nests extra keys (`server_tool_use`, `cache_creation`, `iterations`, `service_tier`, …) alongside the four token fields, and the parser must ignore them. Append:

```js
// tests/transcript.test.mjs (append)
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
```

Two facts this locked in from a real capture: (1) `message.model` is the **base id** (`claude-opus-4-8`) with no `1m` marker even in a 1M-context session — the empirical basis for Issue-5's window-reuse rule; and (2) real transcripts frequently contain **zero** `compact_boundary` entries, so compaction-shape coverage stays with the hand-authored `session.jsonl` (whose `{type:"system", subtype:"compact_boundary", timestamp}` shape matches claude-hud's real parser). Capture from a live session — a synthesized fixture only re-tests the assumption. (Suite becomes 5 tests.)

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/transcript.mjs tests/transcript.test.mjs tests/fixtures/session.jsonl tests/fixtures/empty.jsonl tests/fixtures/real-transcript.jsonl
git commit -m "feat: add transcript usage, compaction, and session-guess parsing"
```

---

## Task 7: Snapshot read/write (`lib/snapshot.mjs`)

**Files:**
- Create: `scripts/lib/snapshot.mjs`
- Test: `tests/snapshot.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `WRITE_THROTTLE_MS = 30000`, `FRESHNESS_MS = 300000`
  - `writeSnapshot(snapshotPath, snapshot, { now = Date.now(), deps = fs } = {}): boolean` — atomic (temp + rename + chmod `0600`), creates the dir, throttled by mtime, skips write when content (minus `updated_at`) is unchanged. Returns whether it wrote.
  - `readSnapshot(snapshotPath, { now = Date.now(), freshnessMs = FRESHNESS_MS, deps = fs } = {}): { snapshot, ageSeconds, fresh } | null` — `null` **only** when the snapshot is missing, unparseable, or has no valid `updated_at`. A present, parseable snapshot always returns `{ snapshot, ageSeconds, fresh }`, where `fresh` is `false` once older than `freshnessMs`. Distinguishing present-but-stale from truly-absent lets the report render `unavailable_stale` (and reuse the real `window_size`) instead of telling an already-configured user to run setup.

- [ ] **Step 1: Write the failing test**

```js
// tests/snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSnapshot, readSnapshot, FRESHNESS_MS } from '../scripts/lib/snapshot.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  return path.join(dir, 'nested', 'snapshot.json');
}
const snap = (extra = {}) => ({ updated_at: new Date(1000).toISOString(), context: { used_percentage: 46 }, ...extra });

test('writeSnapshot writes atomically with 0600 and creates dirs', () => {
  const p = tmpFile();
  assert.equal(writeSnapshot(p, snap(), { now: 1000 }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).context, { used_percentage: 46 });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  }
});

test('readSnapshot returns snapshot + age + fresh flag when fresh', () => {
  const p = tmpFile();
  writeSnapshot(p, snap(), { now: 1000 });
  const r = readSnapshot(p, { now: 5000 });
  assert.equal(r.snapshot.context.used_percentage, 46);
  assert.equal(r.ageSeconds, 4);
  assert.equal(r.fresh, true);
});

test('readSnapshot marks stale snapshots not-fresh but still returns them', () => {
  const p = tmpFile();
  writeSnapshot(p, snap(), { now: 1000 });
  const stale = readSnapshot(p, { now: 1000 + FRESHNESS_MS + 1 });
  assert.equal(stale.fresh, false);
  assert.equal(stale.snapshot.context.used_percentage, 46); // still available for window reuse
});

test('readSnapshot returns null on missing/malformed', () => {
  assert.equal(readSnapshot('/no/such/file.json', {}), null);
});

test('writeSnapshot skips unchanged content within throttle window', () => {
  const p = tmpFile();
  writeSnapshot(p, snap(), { now: 1000 });
  // same content (ignoring updated_at), 10s later, still within 30s throttle
  assert.equal(writeSnapshot(p, snap({ updated_at: new Date(11000).toISOString() }), { now: 11000 }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/snapshot.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/snapshot.mjs
// Adapted from claude-hud (MIT, © Jarrod Watts): src/external-usage.ts write/read robustness.
import fs from 'node:fs';
import path from 'node:path';

export const WRITE_THROTTLE_MS = 30_000;
export const FRESHNESS_MS = 5 * 60_000;

function withoutUpdatedAt(s) {
  if (!s || typeof s !== 'object') return s;
  const { updated_at, ...rest } = s;
  return rest;
}

function shouldWrite(snapshotPath, next, now, deps) {
  try {
    if (!deps.existsSync(snapshotPath)) return true;
    if (now - deps.statSync(snapshotPath).mtimeMs > WRITE_THROTTLE_MS) return true;
    const current = JSON.parse(deps.readFileSync(snapshotPath, 'utf8'));
    return JSON.stringify(withoutUpdatedAt(current)) !== JSON.stringify(withoutUpdatedAt(next));
  } catch {
    return true;
  }
}

export function writeSnapshot(snapshotPath, snapshot, { now = Date.now(), deps = fs } = {}) {
  try {
    const dir = path.dirname(snapshotPath);
    deps.mkdirSync(dir, { recursive: true });
    if (!shouldWrite(snapshotPath, snapshot, now, deps)) return false;
    const tmp = path.join(dir, `.${path.basename(snapshotPath)}.${process.pid}.${now}.tmp`);
    deps.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    deps.renameSync(tmp, snapshotPath);
    deps.chmodSync(snapshotPath, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function readSnapshot(snapshotPath, { now = Date.now(), freshnessMs = FRESHNESS_MS, deps = fs } = {}) {
  try {
    const snapshot = JSON.parse(deps.readFileSync(snapshotPath, 'utf8'));
    const updatedMs = Date.parse(snapshot?.updated_at);
    if (!Number.isFinite(updatedMs)) return null;
    const ageMs = now - updatedMs;
    // Present + parseable always returns; `fresh` distinguishes stale from absent
    // so the report can render `unavailable_stale` and reuse the real window_size.
    return { snapshot, ageSeconds: Math.max(0, Math.round(ageMs / 1000)), fresh: ageMs <= freshnessMs };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/snapshot.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/snapshot.mjs tests/snapshot.test.mjs
git commit -m "feat: add atomic, throttled snapshot read/write"
```

---

## Task 8: Collector (`scripts/collect.mjs`)

**Files:**
- Create: `scripts/collect.mjs`
- Test: `tests/collect.test.mjs`

**Interfaces:**
- Consumes: `usedTokens`, `percentage` (token-math); `epochToMs` (time); `writeSnapshot` (snapshot); `snapshotPath` (config-dir).
- Produces:
  - `buildSnapshot(stdin, now): object` — the snapshot shape from spec §5.1. Prefers native `context_window.used_percentage` **but treats a native value ≤ 0 (or non-finite) as unpopulated and falls through to the token-based calc**; converts `rate_limits.*.resets_at` epoch-seconds to ISO; `rate_limits` is `null` when stdin carried none.
  - `compactLine(snapshot): string` — e.g. `Context 46% · 5h 25% · 7d 61%`.
  - `runCli({ argv, now } = {}): Promise<void>` — reads stdin, writes the snapshot, prints the compact line unless `--silent`. Exported so the Windows PowerShell launcher (Task 11) can `import` and invoke it — importing the module alone does **not** run the collector, because the CLI body is guarded by the `isMain` check.

- [ ] **Step 1: Write the failing test**

```js
// tests/collect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, compactLine } from '../scripts/collect.mjs';

const stdin = {
  model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
  context_window: {
    context_window_size: 200000,
    used_percentage: 46,
    current_usage: { input_tokens: 1200, cache_read_input_tokens: 88000, cache_creation_input_tokens: 2800, output_tokens: 0 },
  },
  cost: { total_cost_usd: 0.42 },
  rate_limits: {
    five_hour: { used_percentage: 25, resets_at: 1751898600 },
    seven_day: { used_percentage: 61, resets_at: 1752166800 },
  },
  transcript_path: '/Users/x/session.jsonl',
};

test('buildSnapshot maps stdin, prefers native %, converts epoch seconds', () => {
  const s = buildSnapshot(stdin, 1751895000000);
  assert.equal(s.context.window_size, 200000);
  assert.equal(s.context.used_tokens, 92000);
  assert.equal(s.context.used_percentage, 46);
  assert.equal(s.rate_limits.five_hour.used_percentage, 25);
  assert.equal(s.rate_limits.five_hour.resets_at, new Date(1751898600000).toISOString());
  assert.equal(s.cost.total_cost_usd, 0.42);
  assert.equal(s.transcript_path, '/Users/x/session.jsonl');
});

test('buildSnapshot computes % when native absent, and nulls rate_limits when absent', () => {
  const s = buildSnapshot({ context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } } }, 0);
  assert.equal(s.context.used_percentage, 50);
  assert.equal(s.rate_limits, null);
});

test('buildSnapshot treats native used_percentage=0 as unpopulated and computes from tokens', () => {
  const s = buildSnapshot({ context_window: { context_window_size: 200000, used_percentage: 0, current_usage: { input_tokens: 1200, cache_read_input_tokens: 88000, cache_creation_input_tokens: 2800 } } }, 0);
  assert.equal(s.context.used_percentage, 46); // 92000 / 200000, not the literal 0
});

test('compactLine shows context and any rate limits', () => {
  assert.equal(compactLine(buildSnapshot(stdin, 0)), 'Context 46% · 5h 25% · 7d 61%');
  assert.equal(compactLine(buildSnapshot({ context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } } }, 0)), 'Context 50%');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/collect.test.mjs`
Expected: FAIL — cannot find module `../scripts/collect.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/collect.mjs
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { usedTokens, percentage } from './lib/token-math.mjs';
import { epochToMs } from './lib/time.mjs';
import { writeSnapshot } from './lib/snapshot.mjs';
import { snapshotPath } from './lib/config-dir.mjs';

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function str(v) { return typeof v === 'string' ? v : ''; }
function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function roundPct(v) { return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null; }
// Native context percentage, treating 0/non-finite as "not yet populated" (see
// Global Constraints). Rate-limit windows keep 0 as valid and use roundPct instead.
function nativePctOrNull(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null; }

function buildWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = roundPct(w.used_percentage);
  const ms = epochToMs(w.resets_at);
  if (pct === null && ms === null) return null;
  return { used_percentage: pct, resets_at: ms === null ? null : new Date(ms).toISOString() };
}

function buildRateLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const five = buildWindow(rl.five_hour);
  const seven = buildWindow(rl.seven_day);
  if (!five && !seven) return null;
  return { five_hour: five, seven_day: seven };
}

export function buildSnapshot(stdin, now) {
  const cw = stdin?.context_window ?? {};
  const usage = cw.current_usage ?? {};
  const windowSize = num(cw.context_window_size);
  const used = usedTokens(usage);
  return {
    updated_at: new Date(now).toISOString(),
    model: { id: str(stdin?.model?.id), display_name: str(stdin?.model?.display_name) },
    context: {
      window_size: windowSize,
      used_tokens: used,
      used_percentage: nativePctOrNull(cw.used_percentage) ?? percentage(used, windowSize),
      input_tokens: num(usage.input_tokens),
      cache_read_tokens: num(usage.cache_read_input_tokens),
      cache_creation_tokens: num(usage.cache_creation_input_tokens),
      output_tokens: num(usage.output_tokens),
    },
    rate_limits: buildRateLimits(stdin?.rate_limits),
    cost: { total_cost_usd: numOrNull(stdin?.cost?.total_cost_usd) },
    transcript_path: str(stdin?.transcript_path) || null,
  };
}

export function compactLine(snapshot) {
  const pct = snapshot.context.used_percentage;
  const parts = [`Context ${pct == null ? '—' : pct}%`];
  const rl = snapshot.rate_limits;
  if (rl?.five_hour?.used_percentage != null) parts.push(`5h ${rl.five_hour.used_percentage}%`);
  if (rl?.seven_day?.used_percentage != null) parts.push(`7d ${rl.seven_day.used_percentage}%`);
  return parts.join(' · ');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runCli({ argv = process.argv, now = Date.now() } = {}) {
  const silent = argv.includes('--silent');
  let stdin = {};
  try { stdin = JSON.parse(await readStdin()); } catch { stdin = {}; }
  const snapshot = buildSnapshot(stdin, now);
  writeSnapshot(snapshotPath(), snapshot);
  if (!silent) process.stdout.write(`${compactLine(snapshot)}\n`);
}

// Importing this module does not run the collector — only direct execution does.
// The Windows launcher (Task 11) imports the module and calls runCli() explicitly.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) { await runCli(); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/collect.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Manually verify the CLI writes a snapshot**

Run:
```bash
echo '{"model":{"id":"claude-opus-4-8","display_name":"Opus 4.8"},"context_window":{"context_window_size":200000,"used_percentage":46,"current_usage":{"input_tokens":1200,"cache_read_input_tokens":88000,"cache_creation_input_tokens":2800}},"cost":{"total_cost_usd":0.42},"rate_limits":{"five_hour":{"used_percentage":25,"resets_at":1751898600},"seven_day":{"used_percentage":61,"resets_at":1752166800}},"transcript_path":"/tmp/x.jsonl"}' | CLAUDE_CONFIG_DIR=/tmp/cc-manual node scripts/collect.mjs
cat /tmp/cc-manual/claude-context/snapshot.json
```
Expected: stdout prints `Context 46% · 5h 25% · 7d 61%`, and the snapshot file exists with the mapped fields.

- [ ] **Step 5b: Add a golden fixture captured from a real statusline stdin**

The `stdin` object in the unit tests encodes the *assumed* statusline shape. Capture the *real* one: temporarily wire a throwaway statusline that tees its stdin (e.g. `statusLine.command` → `tee ~/cc-stdin.json | cat`), send one message, then redact and commit the captured JSON as `tests/fixtures/real-stdin.json`. Append:

```js
// tests/collect.test.mjs (append)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

test('golden: real statusline stdin maps without losing fields', () => {
  const raw = JSON.parse(readFileSync(path.join(here, 'fixtures', 'real-stdin.json'), 'utf8'));
  const s = buildSnapshot(raw, 0);
  assert.equal(typeof s.context.window_size, 'number');
  assert.ok(s.context.used_percentage === null || typeof s.context.used_percentage === 'number');
  // If this capture carried rate_limits, they must survive mapping as ISO resets.
  if (raw.rate_limits?.five_hour) {
    assert.ok(s.rate_limits, 'rate_limits in stdin must map to a non-null snapshot block');
    assert.match(s.rate_limits.five_hour.resets_at ?? '', /^\d{4}-\d\d-\d\dT/);
  }
});
```

This catches renamed/renested/re-unit'd fields (e.g. epoch in ms vs seconds) that every hand-written fixture would pass. Capture from a live session — a synthesized fixture only re-tests the assumption. (Suite becomes 5 tests.)

- [ ] **Step 6: Commit**

```bash
git add scripts/collect.mjs tests/collect.test.mjs tests/fixtures/real-stdin.json
git commit -m "feat: add statusline collector"
```

---

## Task 9: Report engine (`scripts/report.mjs`)

**Files:**
- Create: `scripts/report.mjs`
- Test: `tests/report.test.mjs`

**Interfaces:**
- Consumes: `readSnapshot` (snapshot); `snapshotPath`, `resolveConfigDir` (config-dir); `lastAssistantUsage`, `countCompactions`, `findNewestTranscript` (transcript); `usedTokens`, `percentage`, `headroom` (token-math); `inferWindowSize` (model-window); `formatDuration`, `clockHM` (time).
- Produces:
  - `resolveReport({ now, snapshotPath, cwd, deps, env }): resolution` — normalized `{ source, model, context|null, rateLimits|null, rateLimitsStatus, cost, compactions, sessionSelection, snapshotAgeSeconds, windowInferred }`. `source` ∈ `collector | transcript | unavailable`; `rateLimitsStatus` ∈ `available | unavailable_plan | unavailable_provider | unavailable_stale | unavailable_collector`. Uses a **fresh** snapshot for collector mode; a **stale** snapshot still supplies the real `window_size` (and its age) to the transcript fallback and yields `unavailable_stale` rather than `unavailable_collector`. Detects Bedrock/Vertex (from the model id or `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`) as `unavailable_provider`. `windowInferred` is `true` only when the fallback had no snapshot to borrow a real `window_size` from.
  - `assembleReport(resolution, now): { human: string, json: object }` — human block and JSON block matching spec §5.2. The JSON never contains `suggested_action`, level labels, or derived metrics, and carries `window_size_inferred`. A dedicated test asserts the rendered human+JSON output across **all** states matches none of the advice/level denylist — the no-advice contract's real teeth (see Global Constraints).

- [ ] **Step 1: Write the failing test**

```js
// tests/report.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/report.test.mjs`
Expected: FAIL — cannot find module `../scripts/report.mjs`. (After implementation: PASS, 8 tests.)

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/report.mjs
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readSnapshot } from './lib/snapshot.mjs';
import { snapshotPath, resolveConfigDir } from './lib/config-dir.mjs';
import { lastAssistantUsage, countCompactions, findNewestTranscript } from './lib/transcript.mjs';
import { usedTokens, percentage, headroom } from './lib/token-math.mjs';
import { inferWindowSize } from './lib/model-window.mjs';
import { formatDuration, clockHM } from './lib/time.mjs';

function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function isProviderModel(id, env = process.env) {
  const s = String(id ?? '').toLowerCase();
  if (s.includes('anthropic.claude-')) return true; // Bedrock model ids
  if (s.includes('@')) return true;                 // Vertex uses '@' as version separator
  return env?.CLAUDE_CODE_USE_BEDROCK === '1' || env?.CLAUDE_CODE_USE_VERTEX === '1';
}

export function resolveReport({ now, snapshotPath: sp, cwd, deps = fs, env = process.env }) {
  const read = readSnapshot(sp, { now, deps });

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
      sessionSelection: 'transcript_path',
      snapshotAgeSeconds: read.ageSeconds,
      windowInferred: false,
    };
  }

  // No fresh snapshot. A stale one still supplies the real window_size and its age,
  // and downgrades the "collector off" message to "collector idle" (unavailable_stale).
  const staleSnapshot = read ? read.snapshot : null;
  const staleAge = read ? read.ageSeconds : null;
  const knownWindow = numOrNull(staleSnapshot?.context?.window_size);
  const fallbackStatus = read ? 'unavailable_stale' : 'unavailable_collector';

  const configDir = resolveConfigDir(env);
  const transcript = findNewestTranscript(configDir, cwd, deps);
  const usage = transcript ? lastAssistantUsage(transcript, deps) : null;
  const compactions = transcript ? countCompactions(transcript, deps) : 0;

  if (usage) {
    // Reuse the snapshot's real window_size when we have one; only guess at true cold start.
    const windowInferred = !(knownWindow && knownWindow > 0);
    const windowSize = windowInferred ? inferWindowSize({ id: usage.model_id }) : knownWindow;
    const used = usedTokens(usage);
    return {
      source: 'transcript',
      model: { id: usage.model_id ?? '', display_name: '' },
      context: {
        window_size: windowSize,
        used_tokens: used,
        used_percentage: percentage(used, windowSize),
        input_tokens: usage.input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        output_tokens: usage.output_tokens,
      },
      rateLimits: null,
      rateLimitsStatus: fallbackStatus,
      cost: null,
      compactions,
      sessionSelection: 'newest-in-cwd-heuristic',
      snapshotAgeSeconds: staleAge,
      windowInferred,
    };
  }

  return {
    source: 'unavailable', model: staleSnapshot?.model ?? {}, context: null, rateLimits: null,
    rateLimitsStatus: fallbackStatus, cost: null, compactions,
    sessionSelection: transcript ? 'newest-in-cwd-heuristic' : null,
    snapshotAgeSeconds: staleAge, windowInferred: false,
  };
}

function modelName(model) {
  return model?.display_name || model?.id || 'unknown';
}
function kt(n) {
  if (n == null) return '—';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function windowJson(w, now) {
  if (!w) return null;
  const ms = w.resets_at ? Date.parse(w.resets_at) : NaN;
  return {
    used_percentage: w.used_percentage ?? null,
    resets_at: w.resets_at ?? null,
    resets_in_seconds: Number.isFinite(ms) ? Math.max(0, Math.round((ms - now) / 1000)) : null,
  };
}

function buildJson(r, now) {
  const c = r.context;
  const context = c ? {
    used_percentage: c.used_percentage,
    used_tokens: c.used_tokens,
    window_size: c.window_size,
    headroom_tokens: headroom(c.used_tokens, c.window_size),
    input_tokens: c.input_tokens,
    cache_read_tokens: c.cache_read_tokens,
    cache_creation_tokens: c.cache_creation_tokens,
    output_tokens: c.output_tokens,
  } : {
    used_percentage: null, used_tokens: null, window_size: null, headroom_tokens: null,
    input_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, output_tokens: null,
  };
  const json = {
    model: r.model ?? {},
    context,
    rate_limits: {
      five_hour: r.rateLimits ? windowJson(r.rateLimits.five_hour, now) : null,
      seven_day: r.rateLimits ? windowJson(r.rateLimits.seven_day, now) : null,
    },
    cost_usd: r.cost,
    compactions: r.compactions,
    source: r.source,
    rate_limits_status: r.rateLimitsStatus,
    window_size_inferred: !!r.windowInferred,
    snapshot_age_seconds: r.snapshotAgeSeconds,
    generated_at: new Date(now).toISOString(),
  };
  if (r.sessionSelection) json.session_selection = r.sessionSelection;
  return json;
}

function rlLine(label, r, w, now) {
  if (r.rateLimitsStatus === 'available' && w && w.used_percentage != null) {
    const ms = w.resets_at ? Date.parse(w.resets_at) : NaN;
    let when = '';
    if (Number.isFinite(ms)) {
      const dur = formatDuration(Math.max(0, Math.round((ms - now) / 1000)));
      const withinDay = ms - now < 24 * 3600 * 1000;
      when = ` · resets in ${dur}${withinDay ? ` (at ${clockHM(new Date(ms))})` : ''}`;
    }
    return `${label}: ${w.used_percentage}% used${when}`;
  }
  switch (r.rateLimitsStatus) {
    case 'unavailable_plan':
      return `${label}: unavailable — no subscription usage reported (API-key account, or before the first Pro/Max response)`;
    case 'unavailable_provider':
      return `${label}: unavailable — subscription usage not reported on this provider (Bedrock/Vertex)`;
    case 'unavailable_stale':
      return `${label}: unavailable — last collector reading ${r.snapshotAgeSeconds}s ago (idle; send a message to refresh)`;
    default:
      return `${label}: unavailable — enable the collector with /claude-context:setup`;
  }
}

function sourceLine(r) {
  if (r.source === 'collector') return `Source: collector · snapshot ${r.snapshotAgeSeconds}s old`;
  if (r.source === 'transcript') {
    const win = r.windowInferred ? 'window inferred' : 'window from snapshot';
    const age = r.snapshotAgeSeconds != null ? ` · snapshot ${r.snapshotAgeSeconds}s old (stale)` : '';
    return `Source: transcript fallback · context only · ${win}${age} · session: newest-in-cwd (heuristic)`;
  }
  return 'Source: unavailable';
}

function buildHuman(r, now) {
  const lines = [`Claude Context — ${modelName(r.model)}`];
  if (r.context && r.windowInferred) {
    // Cold-start fallback: window size is a guess, so hedge the % and drop headroom.
    lines.push(`Context: ~${r.context.used_percentage}% used · ${kt(r.context.used_tokens)} tokens · window inferred (${kt(r.context.window_size)} assumed)`);
  } else if (r.context) {
    lines.push(`Context: ${r.context.used_percentage}% used · ${kt(r.context.used_tokens)} / ${kt(r.context.window_size)} tokens · ${kt(headroom(r.context.used_tokens, r.context.window_size))} headroom`);
  } else {
    lines.push('Context: unavailable — no measurement yet (no assistant turn recorded, collector off)');
  }
  lines.push(rlLine('Session (5h)', r, r.rateLimits?.five_hour, now));
  lines.push(rlLine('Weekly (7d)', r, r.rateLimits?.seven_day, now));
  lines.push(`Cost: ${r.cost != null ? `$${r.cost.toFixed(2)}` : 'unavailable'} · Compactions: ${r.compactions}`);
  lines.push(sourceLine(r));
  return lines.join('\n');
}

export function assembleReport(r, now) {
  return { human: buildHuman(r, now), json: buildJson(r, now) };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const now = Date.now();
  const resolution = resolveReport({ now, snapshotPath: snapshotPath(), cwd: process.cwd(), deps: fs });
  const { human, json } = assembleReport(resolution, now);
  process.stdout.write(`${human}\n\n`);
  process.stdout.write('```json\n');
  process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  process.stdout.write('```\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/report.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the full suite and the CLI end-to-end**

Run:
```bash
node --test
node scripts/report.mjs   # in a fresh dir with no snapshot → cold-start or transcript block, never a crash
```
Expected: all tests PASS; `report.mjs` prints a human block followed by a fenced JSON block and exits 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/report.mjs tests/report.test.mjs
git commit -m "feat: add report engine with graceful degradation"
```

---

## Task 10: Skill (`SKILL.md`)

**Files:**
- Create: `SKILL.md`
- Test: `tests/skill.test.mjs`

**Interfaces:**
- Consumes: `report.mjs` (invoked at runtime).
- Produces: the `/claude-context:claude-context` skill. Frontmatter `name: claude-context`.

- [ ] **Step 1: Write the failing test**

```js
// tests/skill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skill = readFileSync(path.join(root, 'SKILL.md'), 'utf8');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/skill.test.mjs`
Expected: FAIL — `ENOENT` opening `SKILL.md`.

- [ ] **Step 3: Write `SKILL.md`**

````markdown
---
name: claude-context
description: Report the current session's resource facts — context-window occupancy, 5-hour and 7-day subscription usage, session cost, and compaction count — as pure measurements with provenance (human summary + machine-readable JSON block). Use when you or the user want to know how much context, quota, or cost the session has used — and, for agents and subagents, to gate your own behavior on those numbers: checkpoint or stop as context fills up (before Claude Code's auto-compaction silently drops CLAUDE.md guidance or recent instructions), or pause before exhausting the 5h/7d limit. Reports facts only; your instructions set the policy. Makes no recommendations.
---

# claude-context

This skill surfaces the current session's resource facts on demand, for both the
user and agents (including subagents). It is an **instrument, not an advisor**: it
reports measurements and where they came from, and nothing else. It makes no
recommendations, attaches no evaluative or level labels, and prescribes no
actions. What to do with the numbers is entirely the caller's decision.

**When relaying this report, pass the measurements through as-is.** Do not add
recommendations, urgency, thresholds, or "you should…" framing of your own — even
though the numbers may invite it. Report what the instrument measured and the
provenance fields (`source`, `rate_limits_status`, `window_size_inferred`,
`session_selection`); let the caller decide what it means.

## How to run it

Run the report engine with Bash and read its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs"
```

It prints a human-readable block and a fenced `json` block. It always succeeds,
even with no collector running.

## Field reference

- **context.used_percentage** — percent of the context window in use (0–100).
- **context.used_tokens / window_size / headroom_tokens** — tokens in use, the
  window size, and tokens remaining. `used_tokens` = input + cache-read +
  cache-creation.
- **context.input_tokens / cache_read_tokens / cache_creation_tokens / output_tokens**
  — the token breakdown for the last measured turn.
- **rate_limits.five_hour / seven_day** — subscription usage windows, each with
  `used_percentage`, `resets_at` (ISO), and `resets_in_seconds`. Present only for
  Pro/Max accounts after the first API response; otherwise `null`.
- **cost_usd** — session cost in USD, or `null` when unavailable.
- **compactions** — number of compaction boundaries in the transcript.
- **source** — `collector` (from the statusline snapshot), `transcript`
  (context-only fallback), or `unavailable` (no measurement yet).
- **rate_limits_status** — `available`; `unavailable_plan` (collector on, account
  reports no subscription usage — either an API-key account or before the first
  Pro/Max response); `unavailable_provider` (Bedrock/Vertex, which don't report
  subscription usage); `unavailable_stale` (a snapshot exists but is past the
  freshness window — collector on but idle); or `unavailable_collector` (no
  snapshot has ever been written).
- **session_selection** — `transcript_path` (pinned from the snapshot) or
  `newest-in-cwd-heuristic` (guessed; may resolve to a different parallel session).
- **snapshot_age_seconds** — how old the snapshot is (collector mode, or the age
  of a stale snapshot reused in fallback).
- **window_size_inferred** — `true` only when the report had no snapshot to read
  the real context-window size from and had to guess it from the model id (a 1M
  session can't be detected this way); the `%` on that line is approximate.

## Sources and reliability

Live 5h/7d usage and cost require the opt-in collector, wired with
`/claude-context:setup`. Without it — or when the collector is on but idle and its
snapshot has gone stale — `/claude-context:claude-context` still reports context
health from the transcript (`source: "transcript"`), and 5h/7d/cost are `null`. A
stale snapshot is reported distinctly (`rate_limits_status: "unavailable_stale"`)
and still supplies the real window size, so it is never mistaken for "collector not
installed." Use the `source`, `rate_limits_status`, `window_size_inferred`, and
`session_selection` fields to judge how much to trust each number.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/skill.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add SKILL.md tests/skill.test.mjs
git commit -m "feat: add the claude-context skill"
```

---

## Task 11: Setup command (`commands/setup.md`)

This task adapts claude-hud's **version-resolution** command strings (which are battle-tested) to point at `scripts/collect.mjs` (no `dist/`/`COLUMNS` machinery, since our collector is plain `.mjs` and prints a short line), and replaces claude-hud's optional-features flow with the **replace-or-keep** decision for an existing statusline. The concrete, self-contained per-platform command strings and the full Windows PowerShell launcher are inlined in Step 3 below — this task defers nothing to another repo. (`claude-hud/commands/setup.md` remains a useful cross-reference for the original derivation and its issue links, but reading it is not required to implement this task.)

**Files:**
- Create: `commands/setup.md`
- Test: `tests/setup.test.mjs`

**Interfaces:**
- Consumes: `scripts/collect.mjs` (the wired command target).
- Produces: the `/claude-context:setup` command.

The two substitutions already applied to the inlined strings in Step 3:
- Cache glob `claude-hud` → `claude-context`.
- `{SOURCE}` / `dist/index.js` / `src/index.ts` → `scripts/collect.mjs` (always; no bun/node source split, no `COLUMNS` export). On Windows this means the launcher imports `scripts/collect.mjs` and calls the exported `runCli()` (Task 8) rather than calling a `main()` on a bundled `dist/index.js`.

- [ ] **Step 1: Write the failing test**

```js
// tests/setup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const setup = readFileSync(path.join(root, 'commands', 'setup.md'), 'utf8');

test('wires the collector, not the HUD', () => {
  assert.match(setup, /scripts\/collect\.mjs/);
  assert.match(setup, /plugins\/cache\/\*\/claude-context\//);
});

test('covers the platform matrix', () => {
  assert.match(setup, /Git Bash|MSYS/i);
  assert.match(setup, /PowerShell/i);
});

test('does replace-or-keep, never silent overwrite', () => {
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /Replace/i);
  assert.match(setup, /Keep/i);
  assert.match(setup, /back\s?up/i);
});

test('verifies a snapshot after wiring', () => {
  assert.match(setup, /snapshot\.json/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/setup.test.mjs`
Expected: FAIL — `ENOENT` opening `commands/setup.md`.

- [ ] **Step 3: Write `commands/setup.md`**

```markdown
---
description: Wire the claude-context collector as your statusline so /claude-context can report live 5h/7d usage
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

Wire `scripts/collect.mjs` into the user's `statusLine` so it can capture the
`rate_limits` and `cost` that Claude Code sends only to the statusline process.
The collector writes a private snapshot the report engine reads; it prints one
compact line and never runs or appends to any other statusline command.

## Step 1: Detect platform, shell, and runtime

Use the environment context `Platform:` and `Shell:` values as the starting point.
The cache glob is always `claude-context` and the wired source is always
`scripts/collect.mjs` (no `dist/`/`src` split, no `COLUMNS` export).

**On `win32`, run `echo $OSTYPE` first** — a `powershell`/`pwsh`/`cmd` shell whose
`$OSTYPE` is `msys` or `cygwin` is actually driving a Git Bash command environment,
where bash expands `$env:VAR`/`$(...)` before PowerShell runs, so the PowerShell
form is unsafe. Resolve the branch from this matrix:

| Platform | Shell | OSTYPE | Use |
|----------|-------|--------|-----|
| `darwin` / `linux` | any | any | macOS/Linux (bash) |
| `win32` | `bash` | any | Windows + Git Bash |
| `win32` | `powershell`/`pwsh`/`cmd` | `msys` / `cygwin` | Windows + Git Bash |
| `win32` | `powershell`/`pwsh`/`cmd` | other / empty | Windows + PowerShell |

Runtime: on macOS/Linux prefer `bun` then `node` (`command -v bun 2>/dev/null ||
command -v node 2>/dev/null`); on Windows require `node` (`command -v node`), never
bun. If none is found, stop and tell the user to install Node.js LTS
(https://nodejs.org/) — on Windows, note that Git Bash finding no `node` is distinct
from Claude Code being installed — then restart the shell and re-run
`/claude-context:setup`. Verify the resolved path with `ls -la {RUNTIME_PATH}`.

**macOS/Linux (node)** — generated command:
```
bash -c 'plugin_dir=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null | awk -F/ '"'"'{ print $(NF-1) "\t" $(0) }'"'"' | grep -E '"'"'^[0-9]+\.[0-9]+\.[0-9]+[[:space:]]'"'"' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-); exec "{RUNTIME_PATH}" "${plugin_dir}scripts/collect.mjs"'
```
(Use `--env-file /dev/null` after `{RUNTIME_PATH}` when the runtime is `bun`.)

**Windows + Git Bash** — use `sort -V` (avoids nested quotes), per claude-hud's
Git Bash branch, with the same `claude-context` glob and `scripts/collect.mjs`
source:
```
plugin_dir=$(ls -1d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null | sort -V | tail -1); exec "{RUNTIME_PATH}" "${plugin_dir}scripts/collect.mjs"
```

**Windows + PowerShell** (Platform `win32`, Shell `powershell`/`pwsh`/`cmd`, OSTYPE
other/empty). PowerShell startup plus a `Sort-Object [version]` scan can exceed
Claude Code's ~300ms render cadence on every refresh, so write a small Node launcher
once at setup and invoke it through `cmd.exe` each refresh.

1. Plugin path (the trailing `\*` is required, or the glob resolves the
   `claude-context` dir itself and the version match fails):
   ```powershell
   $claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }
   (Get-ChildItem (Join-Path $claudeDir "plugins\cache\*\claude-context\*") -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+(\.\d+)+$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).FullName
   ```

2. Runtime (require node): `(Get-Command node -ErrorAction SilentlyContinue).Source`.

3. Write the launcher to `$claudeDir\plugins\claude-context\statusline.mjs`. It finds
   the newest installed `claude-context` version and **imports `scripts/collect.mjs`
   and calls `runCli()`** — importing alone does not run the collector (its CLI body
   is `isMain`-guarded), so the explicit call is required. There is no `COLUMNS`
   handling.
   ```js
   import fs from 'node:fs';
   import os from 'node:os';
   import path from 'node:path';
   import { pathToFileURL } from 'node:url';

   const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
   const cacheDir = path.join(claudeDir, 'plugins', 'cache');

   function versionParts(value) {
     const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
     return match ? match.slice(1, 4).map(Number) : null;
   }
   function compareVersions(a, b) {
     for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
     return 0;
   }

   const candidates = [];
   try {
     for (const marketplace of fs.readdirSync(cacheDir, { withFileTypes: true })) {
       if (!marketplace.isDirectory()) continue;
       const pluginRoot = path.join(cacheDir, marketplace.name, 'claude-context');
       let versions = [];
       try { versions = fs.readdirSync(pluginRoot, { withFileTypes: true }); } catch { continue; }
       for (const version of versions) {
         if (!version.isDirectory()) continue;
         const parts = versionParts(version.name);
         if (!parts) continue;
         const dir = path.join(pluginRoot, version.name);
         if (fs.existsSync(path.join(dir, 'scripts', 'collect.mjs'))) candidates.push({ dir, parts });
       }
     }
   } catch { process.exit(0); }

   candidates.sort((a, b) => compareVersions(a.parts, b.parts));
   const latest = candidates.at(-1);
   if (!latest) process.exit(0);

   const mod = await import(pathToFileURL(path.join(latest.dir, 'scripts', 'collect.mjs')).href);
   if (typeof mod.runCli === 'function') await mod.runCli();
   ```
   Assign that launcher source to `$wrapperBody` via a single-quoted here-string
   (`@'` … `'@`), then write it UTF-8 **without a BOM** (PS 5.1's `Set-Content
   -Encoding UTF8` emits a BOM):
   ```powershell
   $wrapperDir = Join-Path $claudeDir "plugins\claude-context"
   New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
   $wrapperPath = Join-Path $wrapperDir "statusline.mjs"
   [System.IO.File]::WriteAllText($wrapperPath, $wrapperBody, (New-Object System.Text.UTF8Encoding $false))
   ```

4. Generated command (`{RUNTIME_PATH}` = the node path from step 2; `{CMD_PATH}` =
   `$env:SystemRoot\System32\cmd.exe`, falling back to `cmd.exe`; `{WRAPPER_PATH}` =
   `$wrapperPath`):
   ```
   {CMD_PATH} /d /s /c ""{RUNTIME_PATH}" "{WRAPPER_PATH}""
   ```

## Step 2: Test the command

Run the generated command with a sample stdin payload and confirm it prints one
line without error:
```bash
echo '{"model":{"display_name":"Test"},"context_window":{"context_window_size":200000,"current_usage":{"input_tokens":1000}}}' | {GENERATED_COMMAND}
```

## Step 3: Detect an existing statusline, back it up, and decide

Read `statusLine.command` from the settings file
(`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`, or the PowerShell
equivalent). **Always create a timestamped backup before any write** — on
macOS/Linux `cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d-%H%M%S)"`, on PowerShell
`Copy-Item $settingsPath "$settingsPath.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"`.
When showing the existing command in the prompt, redact obvious secrets (Bearer
tokens, `sk-…`, `gh[pousr]_…`, and `api_key`/`token`/`secret` assignments) and
truncate to ~160 chars — never print the raw command.

- **Empty / missing** → take the slot: write the generated command (Step 4).
- **Already claude-context** → idempotent update: overwrite with the new command.
- **Anything else** → use AskUserQuestion:
  - header: "Existing statusline detected"
  - question: show the redacted command preview and ask what to do.
  - options:
    - "Replace it with claude-context (your current statusline is backed up)"
    - "Keep my statusline (claude-context reports context-only, no live 5h/7d)"
    - "Cancel setup"
  - On **Keep** or **Cancel**: make no `statusLine` change; tell the user
    `/claude-context:claude-context` still works in transcript-only mode.

## Step 4: Apply configuration

Merge `{ "statusLine": { "type": "command", "command": "{GENERATED_COMMAND}" } }`
into `settings.json` with a real JSON serializer (never string concatenation);
preserve all other settings. On Windows PowerShell, write UTF-8 without a BOM via
`[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding $false)`.
Tell the user to fully restart Claude Code.

## Step 5: Verify a snapshot appears

After the user restarts and sends one message, confirm the snapshot exists:
```bash
cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-context/snapshot.json"
```
If it exists and has an `updated_at` within the last few minutes, setup worked.
If not, check, in order: the runtime path resolves (`ls -la {RUNTIME_PATH}`); the
plugin cache glob matches an installed version (`ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/`);
on Windows, that the `Platform:`/`Shell:` branch matches the actual command
environment (re-check `echo $OSTYPE`); and on PowerShell, that
`'{}' | & cmd.exe /c '{GENERATED_COMMAND}'` prints a compact line. The most common
cause is not having fully restarted Claude Code after the write.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/setup.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add commands/setup.md tests/setup.test.mjs
git commit -m "feat: add version-resilient setup with replace-or-keep"
```

---

## Task 12: Docs (`README.md`, `LICENSE`, `CHANGELOG.md`)

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `CHANGELOG.md`
- Test: `tests/docs.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: user-facing docs; MIT license with the claude-hud attribution the borrowed code requires.

- [ ] **Step 1: Write the failing test**

```js
// tests/docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(root, f), 'utf8');

test('LICENSE is MIT and acknowledges claude-hud', () => {
  const lic = read('LICENSE');
  assert.match(lic, /MIT License/);
  assert.match(lic, /claude-hud/i);
});

test('README documents install, the two invocation names, and the no-advice contract', () => {
  const r = read('README.md');
  assert.match(r, /\/plugin install claude-context/);
  assert.match(r, /\/claude-context:setup/);
  assert.match(r, /no (advice|recommendations)/i);
});

test('CHANGELOG has an entry', () => {
  assert.match(read('CHANGELOG.md'), /0\.1\.0/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/docs.test.mjs`
Expected: FAIL — `ENOENT` opening `LICENSE`.

- [ ] **Step 3: Write the docs**

`LICENSE` — standard MIT text, `Copyright (c) 2026 Ovid`, followed by:

```text
This project adapts portions of claude-hud (https://github.com/jarrodwatts/claude-hud),
Copyright (c) Jarrod Watts, licensed under the MIT License. Its permission notice
is retained in the adapted source files under scripts/lib/.
```

`README.md` — cover (**lead with the agent-facing value**):
- What it is: a live, machine-readable read of the session's own context window,
  5h/7d usage, and cost that **agents and subagents** can query and act on — gating
  their behavior on the user's rules (checkpoint/stop as context fills, *before*
  Claude Code's silent auto-compaction drops CLAUDE.md guidance or recent
  instructions; pause before exhausting the weekly budget). Humans can read the same
  summary on demand.
- Instrument, not advisor — **by design, as the enabler**: it reports facts with
  **no advice, no recommendations**; the user's instructions (CLAUDE.md, skills,
  subagent prompts) set the policy. Motivate with the real auto-compaction reports
  (claude-code#22376 "auto-compact loses last-request instructions"; #24460 & #6354
  "CLAUDE.md lost after compaction").
- Install: `/plugin marketplace add Ovid/claude-context` → `/plugin install claude-context`.
- Use: `/claude-context:claude-context` (short `/claude-context`) works immediately
  in transcript-only mode, returning a human summary **and** a JSON block agents
  parse. Run `/claude-context:setup` to enable live 5h/7d usage and cost via the
  opt-in collector.
- The collector needs the single `statusLine` slot; setup does replace-or-keep if
  one exists. Note 5h/7d requires a Pro/Max subscription.
- Provenance/trust: every number carries `source` / `rate_limits_status` /
  `window_size_inferred` so an agent's rule never fires on a stale or estimated value.
- Acknowledgement: adapted from claude-hud (MIT).

`CHANGELOG.md`:

```markdown
# Changelog

## 0.1.0

- Initial release: `/claude-context:claude-context` skill, opt-in `collect.mjs`
  statusline collector, `report.mjs` engine with snapshot → transcript → cold-start
  degradation, and `/claude-context:setup`. Pure measurements and provenance; no
  recommendations, labels, policy, or derived metrics.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/docs.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the entire suite**

Run: `node --test`
Expected: every test file PASSES.

- [ ] **Step 6: Commit**

```bash
git add README.md LICENSE CHANGELOG.md tests/docs.test.mjs
git commit -m "docs: add README, LICENSE (with claude-hud attribution), CHANGELOG"
```

---

## Self-Review

**1. Spec coverage**

- §1 Purpose / instrument-not-advisor → enforced by Task 9's **runtime-output denylist across all states** (plus `suggested_action`/label assertions), and Task 10's **data-only-contract assertion + no-editorializing relay instruction** (the doc *states* the contract; Task 9 *enforces* it against output — a substring grep over the doc would false-positive on the contract's own wording), and §9 non-goals. Global Constraints scope the "verified by tests" claim to what the tests actually check (the *report's* output), not a consuming agent's phrasing.
- §2 native fields (incl. the **`used_percentage=0`→token-fallback guard**), epoch-seconds, and the **fuller rate-limit state set** (`available`/`unavailable_plan`/`unavailable_provider`/`unavailable_stale`/`unavailable_collector`, with Bedrock/Vertex detection) → Tasks 4, 5, 8, 9.
- §3 approaches (differentiation from `/context`,`/usage`) → README (Task 12); not code.
- §4.1 collector (parse, snapshot, compact line, `--silent`) → Task 8.
- §4.1 replace-or-keep setup → Task 11.
- §4.2 report degradation (collector / **stale-snapshot** / transcript / cold-start / subscriber-null / provider), with **real-window reuse from a stale snapshot** and inferred-window hedging → Tasks 7 & 9.
- §4.2 compactions always from transcript → Tasks 6 & 9.
- §4.2 transcript pinned vs newest-in-cwd heuristic → Tasks 6 & 9.
- §4.3 skill body → Task 10.
- §5.1 snapshot shape + config-dir + 0600 + throttle → Tasks 2, 7, 8.
- §5.2 human & JSON blocks (all states) → Task 9.
- §6 layout (root SKILL.md, scripts/lib, commands) → Tasks 1, 8–11.
- §7 version-resilient setup, **fully inlined for macOS/Linux, Git Bash, and PowerShell (launcher + no-BOM write); nothing deferred to another repo** → Task 11.
- §8 testing coverage → each task's tests map to the spec's bullet list, **plus golden fixtures captured from a real statusline stdin and a real transcript** (Tasks 6 & 8) that guard the external-format mapping.
- §9 non-goals (no derived metrics) → Task 9 JSON assertions.
- §10 defaults (silent, path, throttle/freshness, replace-or-keep) → Tasks 7, 8, 11.

No gaps found.

**2. Placeholder scan**

No `TBD`/`TODO`/"handle edge cases"/"similar to Task N". Every code step shows complete code; every command step shows the exact command and expected output. `setup.md` is now **fully self-contained**: Task 11 inlines the concrete macOS/Linux, Git Bash, and Windows PowerShell command strings and the complete Node launcher (with the two claude-hud substitutions already applied, and the launcher calling the exported `runCli()`), so no detail is deferred to another repo. The golden-fixture captures in Tasks 6 & 8 are the one intentional "capture from a live session" step — flagged as such, not a placeholder.

**3. Type consistency**

- `usedTokens`/`percentage`/`headroom` signatures identical across Tasks 3, 8, 9.
- `writeSnapshot`/`readSnapshot` option bag `{ now, deps }` consistent across Tasks 7, 8, 9; `readSnapshot` returns `{ snapshot, ageSeconds, fresh }` (Task 7) and `resolveReport` branches on `read.fresh` (Task 9).
- `collect.mjs` exports `runCli()` (Task 8), imported and invoked by the Windows PowerShell launcher (Task 11); its CLI body stays `isMain`-guarded so importing the module is side-effect-free.
- `lastAssistantUsage` returns `model_id` (Task 6) and is consumed as `usage.model_id` (Task 9).
- Snapshot shape written by `buildSnapshot` (Task 8) matches fields read in `resolveReport` (Task 9): `context.*`, `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`, `cost.total_cost_usd`, `transcript_path`.
- `resolution` object keys produced by `resolveReport` (incl. `windowInferred`) match those consumed by `assembleReport`/`buildJson`/`buildHuman` (Task 9).
- `rateLimitsStatus` values (`available`/`unavailable_plan`/`unavailable_provider`/`unavailable_stale`/`unavailable_collector`) consistent between resolver, formatters, and the SKILL.md field reference (Tasks 9 & 10).

No inconsistencies found.
