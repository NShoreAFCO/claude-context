# Co-existing Statusline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/claude-context:setup` wrap an existing (foreign) statusline so both run — the user's displayed line is unchanged, claude-context still captures its snapshot — and add a reversible `/claude-context:teardown`, so the plugin never takes away or breaks a user's existing tool.

**Architecture:** A new invisible-tap wrapper (`scripts/coexist.mjs`) reads the statusline stdin, spawns the user's original command via `sh -c`, forwards stdin/stdout/stderr, and writes the same snapshot the collector writes — the report engine is untouched. A new tested wiring module (`scripts/wiring.mjs`) does all `settings.json` + sidecar surgery behind a two-phase `detect`/`wrap`/`teardown` contract, backed by four new dependency-free `lib/*` helpers. The `setup.md`/`teardown.md` commands shrink to platform detection + a confirm + a call into the wiring module.

**Tech Stack:** Node ESM (`.mjs`), zero third-party dependencies, no build step. Tests use the built-in `node:test` runner (`npm test` → `node --test tests/*.test.mjs`). The shipped plugin lives under `plugins/claude-context/`; tests live at the repo root and import the nested scripts by path.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the design spec (`docs/superpowers/specs/2026-07-08-claude-context-coexist-statusline-design.md`).

- **Instrument, not advisor:** nothing in this feature emits recommendations, labels, thresholds, or policy. Co-existence produces a **normal `collector` snapshot**; the report engine and its no-advice denylist test are **unchanged**. Do not touch `report.mjs`.
- **Never take away or break a user's tool:** setup **never** replaces or seizes a slot it doesn't own. A foreign slot is wrapped only after a single explicit **proceed/cancel** confirm. Teardown restores the original **verbatim** and never clobbers a slot the plugin doesn't own.
- **Marker-only ownership (accepted risk):** "is this slot ours?" is decided **only** by a stable marker (`CLAUDE_CONTEXT_WRAPPER=collect` / `=coexist`) embedded in the command — never by exact-matching a resolved command string. No legacy path-shape fallback for pre-marker `collect` installs is added (risk accepted in the 4th pushback). The marker and `coexist.mjs` ship in the **same** release.
- **Platform scope (alpha):** co-existence and **all** wiring this release writes ship for **POSIX and Windows + Git Bash only** — both use the POSIX `spawn('sh', ['-c', original])`. **Native PowerShell/cmd is unsupported this alpha:** setup makes **no** `settings.json` change on native PowerShell and reports it (never a silent write/replace). The 0.2.0 empty-slot PowerShell launcher is **removed** (documented as a regression).
- **Snapshot is byte-identical to the collector's:** `coexist.mjs` reuses the existing `buildSnapshot` / `writeSnapshot` / `compactLine` and keys the file by `session_id` exactly as `collect.mjs` does. Snapshot path: `<config-dir>/claude-context/snapshot-<session-id>.json`.
- **Failure isolation & data survival:** the original tool must run whenever stdin is readable and its command is spawnable. The snapshot is written **after the spawn and without awaiting the child's exit**, so a slow/hung/broken/non-zero original never strands the snapshot. A **runtime-failed** original passes through transparently (even blank output) — the wrapper does **not** substitute its own line. Only a **missing/corrupt sidecar** (degraded half-state) falls back to printing our own compact line.
- **File modes:** every file this plugin writes is `0600` in a `0700` dir — snapshot, sidecar (`coexist.json`), and the **single** full-file backup (`settings.json.claude-context.bak`). The backup's `0600` mode is **test-asserted** (settings.json routinely holds API keys). Writes are atomic (temp + rename + chmod).
- **1-deep, fail-safe:** claude-context co-exists with exactly **one** prior statusline (not an N-way multiplexer). If a third tool overwrites the slot, teardown refuses to clobber it and reports the stored original instead.
- **`<config-dir>`** is `$CLAUDE_CONFIG_DIR` when set and non-empty, else `~/.claude`. Writer and reader resolve every path identically via `scripts/lib/config-dir.mjs`.
- **Runtime:** self-contained Node ESM; **zero third-party deps; no build step**. Requires Node 18+ or Bun. Borrowed patterns keep their claude-hud attribution header. Tests are local-only (no network/credentials).
- **Invocation names:** `/claude-context:setup` and the new `/claude-context:teardown`.

---

## File Structure

**New pure libs (no I/O, tested in isolation):**
- `scripts/lib/marker.mjs` — the ownership marker: `MARKER_VAR`, `markerAssignment(variant)`, `detectMarker(command)`.
- `scripts/lib/command.mjs` — `buildStatuslineCommand({ variant, runtime, platform })` builds the marked, version-resilient `bash -c '…'` invocation for `collect`/`coexist`.
- `scripts/lib/redact.mjs` — `redactSecrets(command)`, `previewCommand(command, max)` for the confirm preview.

**Modified pure lib:**
- `scripts/lib/config-dir.mjs` — add `sidecarPath`, `settingsPath`, `backupPath` (path resolution only).

**New I/O entry points:**
- `scripts/coexist.mjs` — the invisible-tap wrapper. Exports `runCoexist(opts)`.
- `scripts/wiring.mjs` — `settings.json` + sidecar surgery. Exports `detect`, `wrap`, `teardown`; CLI dispatches on `argv[2]`.

**Modified commands / docs:**
- `commands/setup.md` — rewritten to POSIX + Git Bash only, single-confirm, delegates to `wiring.mjs`.
- `commands/teardown.md` — new.
- `.claude-plugin/plugin.json` — add `./commands/teardown.md`, bump version.
- `README.md`, `CHANGELOG.md`, `CLAUDE.md` — co-exist story + regression note + convention update.

**Tests (repo root, import nested scripts):**
- New: `tests/marker.test.mjs`, `tests/command.test.mjs`, `tests/redact.test.mjs`, `tests/coexist.test.mjs`, `tests/wiring.test.mjs`.
- Modified: `tests/config-dir.test.mjs`, `tests/setup.test.mjs`, `tests/manifest.test.mjs`, `tests/docs.test.mjs`.
- Unchanged and still green: report core, snapshot, token-math, time, transcript, collect, skill.

The "only two I/O entry points" convention grows to **four** (`collect`, `report`, `coexist`, `wiring`); `lib/*` stays pure. Report engine untouched.

**Naming contract locked across tasks** (use these exact names/shapes everywhere):
- Marker variants: the strings `'collect'` and `'coexist'`.
- `detect(...)` returns `{ slot, preview, hasSidecar, sidecarMatchesSlot, storedOriginalPreview }` where `slot ∈ 'empty' | 'foreign' | 'ours-collect' | 'ours-coexist' | 'error'`.
- Sidecar file shape: `{ "original": <the entire statusLine object>, "wrapped_at": <ISO string> }`.
- `wrap(...)` returns `{ action, slot?, storedOriginalPreview?, reason? }`; `teardown(...)` returns `{ action, storedOriginalPreview?, reason? }`.

---

## Task 1: Config-dir paths for sidecar, settings, backup

**Files:**
- Modify: `plugins/claude-context/scripts/lib/config-dir.mjs` (append three functions)
- Test: `tests/config-dir.test.mjs` (append)

**Interfaces:**
- Consumes: existing `resolveConfigDir`, `snapshotDir` in the same file.
- Produces:
  - `sidecarPath(env = process.env): string` → `<config-dir>/claude-context/coexist.json`
  - `settingsPath(env = process.env): string` → `<config-dir>/settings.json`
  - `backupPath(env = process.env): string` → `<config-dir>/settings.json.claude-context.bak`

- [ ] **Step 1: Write the failing test** (append to `tests/config-dir.test.mjs`)

```js
// tests/config-dir.test.mjs (append)
import { sidecarPath, settingsPath, backupPath } from '../plugins/claude-context/scripts/lib/config-dir.mjs';

test('sidecarPath is coexist.json under claude-context', () => {
  assert.equal(
    sidecarPath({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }),
    path.join('/tmp/cfg', 'claude-context', 'coexist.json'),
  );
});

test('settingsPath and backupPath sit at the config-dir root', () => {
  assert.equal(settingsPath({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }), path.join('/tmp/cfg', 'settings.json'));
  assert.equal(
    backupPath({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }),
    path.join('/tmp/cfg', 'settings.json.claude-context.bak'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config-dir.test.mjs`
Expected: FAIL — `sidecarPath` / `settingsPath` / `backupPath` is not exported.

- [ ] **Step 3: Append the implementation** to `scripts/lib/config-dir.mjs`

```js
// scripts/lib/config-dir.mjs (append — the file already exports resolveConfigDir/snapshotDir)

// The co-existence sidecar: stores the entire original statusLine object so teardown
// restores it verbatim. Same 0700 dir as the snapshot; survives plugin upgrades.
export function sidecarPath(env = process.env) {
  return path.join(snapshotDir(env), 'coexist.json');
}

// Claude Code's user settings file and the single full-file backup the wiring module
// writes before its first mutating write (see the design spec §3.5, §3.8).
export function settingsPath(env = process.env) {
  return path.join(resolveConfigDir(env), 'settings.json');
}

export function backupPath(env = process.env) {
  return path.join(resolveConfigDir(env), 'settings.json.claude-context.bak');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config-dir.test.mjs`
Expected: PASS (all prior tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-context/scripts/lib/config-dir.mjs tests/config-dir.test.mjs
git commit -m "feat: add sidecar/settings/backup path resolution"
```

---

## Task 2: Ownership marker (`lib/marker.mjs`)

**Files:**
- Create: `plugins/claude-context/scripts/lib/marker.mjs`
- Test: `tests/marker.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MARKER_VAR: string` — the constant `'CLAUDE_CONTEXT_WRAPPER'`.
  - `markerAssignment(variant): string` — `'CLAUDE_CONTEXT_WRAPPER=collect'` / `'=coexist'`; throws on any other variant.
  - `detectMarker(command): 'collect' | 'coexist' | null` — scans the command string for the marker's presence + variant (substring, so it survives path changes across upgrades/`bun`-vs-`node`/`CLAUDE_CONFIG_DIR`). Non-string → `null`.

- [ ] **Step 1: Write the failing test**

```js
// tests/marker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER_VAR, markerAssignment, detectMarker } from '../plugins/claude-context/scripts/lib/marker.mjs';

test('markerAssignment emits a stable env-assignment sentinel', () => {
  assert.equal(MARKER_VAR, 'CLAUDE_CONTEXT_WRAPPER');
  assert.equal(markerAssignment('collect'), 'CLAUDE_CONTEXT_WRAPPER=collect');
  assert.equal(markerAssignment('coexist'), 'CLAUDE_CONTEXT_WRAPPER=coexist');
  assert.throws(() => markerAssignment('nope'));
});

test('detectMarker keys on presence + variant, not the resolved path', () => {
  // Different resolved paths, same variant → still detected.
  assert.equal(detectMarker("bash -c 'export CLAUDE_CONTEXT_WRAPPER=coexist; exec \"/a/node\" x'"), 'coexist');
  assert.equal(detectMarker("bash -c 'export CLAUDE_CONTEXT_WRAPPER=collect; exec \"/b/bun\" y'"), 'collect');
});

test('detectMarker returns null for foreign / empty / non-string', () => {
  assert.equal(detectMarker('bun run ~/.claude/claude-hud/statusline.js'), null);
  assert.equal(detectMarker(''), null);
  assert.equal(detectMarker(null), null);
  assert.equal(detectMarker(undefined), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/marker.test.mjs`
Expected: FAIL — cannot find module `../plugins/claude-context/scripts/lib/marker.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/marker.mjs
// The ownership marker embedded in every statusLine command claude-context writes, so
// setup/teardown can recognize its own slot without exact-matching a resolved command
// string (which legitimately changes across plugin upgrades, bun-vs-node, CLAUDE_CONFIG_DIR).
export const MARKER_VAR = 'CLAUDE_CONTEXT_WRAPPER';

const VARIANTS = new Set(['collect', 'coexist']);

export function markerAssignment(variant) {
  if (!VARIANTS.has(variant)) throw new Error(`bad marker variant: ${variant}`);
  return `${MARKER_VAR}=${variant}`;
}

export function detectMarker(command) {
  if (typeof command !== 'string') return null;
  if (command.includes(`${MARKER_VAR}=coexist`)) return 'coexist';
  if (command.includes(`${MARKER_VAR}=collect`)) return 'collect';
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/marker.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-context/scripts/lib/marker.mjs tests/marker.test.mjs
git commit -m "feat: add version-resilient ownership marker helper"
```

---

## Task 3: Secret redaction + preview (`lib/redact.mjs`)

**Files:**
- Create: `plugins/claude-context/scripts/lib/redact.mjs`
- Test: `tests/redact.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `redactSecrets(command): string` — masks Bearer tokens, `sk-…`, `gh[pousr]_…`, and `api_key`/`token`/`secret`/`password` assignments. Non-string → `''`.
  - `previewCommand(command, max = 160): string` — `redactSecrets` then truncate to `max` chars with a trailing `…`.

This moves the redaction that lived as prose in `setup.md` into a pure, tested helper so the wiring module can redact **inside** the module (raw commands never transit the agent transcript — design spec §3.8).

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/redact.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/redact.mjs
// Mask obvious secrets before a command is shown in the setup confirm. Best-effort — the
// goal is "don't echo a Bearer token / API key into the transcript", not perfect DLP.
export function redactSecrets(command) {
  if (typeof command !== 'string') return '';
  return command
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9._-]{6,}/g, 'sk-[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(
      /\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)("?)([^"\s]+)\3/gi,
      (_m, key, sep) => `${key}${sep}[REDACTED]`,
    );
}

export function previewCommand(command, max = 160) {
  const redacted = redactSecrets(command);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/redact.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-context/scripts/lib/redact.mjs tests/redact.test.mjs
git commit -m "feat: add secret redaction + preview helper"
```

---

## Task 4: Statusline command builder (`lib/command.mjs`)

**Files:**
- Create: `plugins/claude-context/scripts/lib/command.mjs`
- Test: `tests/command.test.mjs`

**Interfaces:**
- Consumes: `markerAssignment` (marker).
- Produces:
  - `buildStatuslineCommand({ variant, runtime, platform = 'posix' }): string` — the exact `bash -c '…'` command written into `settings.json`. `variant ∈ 'collect' | 'coexist'` selects both the marker and the target script (`scripts/<variant>.mjs`). `platform ∈ 'posix' | 'gitbash'` selects the version-resolution glob (POSIX uses the awk/sort form; Git Bash uses `sort -V`). Throws on a bad variant or empty runtime.

The command bodies are ported verbatim from the shipped `commands/setup.md` (the POSIX form at its "macOS/Linux (node)" block and the Git Bash form) so the known-good version-resolution logic is preserved — the only additions are `export CLAUDE_CONTEXT_WRAPPER=<variant>;` and `scripts/<variant>.mjs`. Building the string in JS (and escaping single quotes once) replaces the hand-escaped markdown template.

- [ ] **Step 1: Write the failing test**

```js
// tests/command.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildStatuslineCommand } from '../plugins/claude-context/scripts/lib/command.mjs';
import { detectMarker } from '../plugins/claude-context/scripts/lib/marker.mjs';

test('marker round-trips through the built command, for both variants and platforms', () => {
  for (const platform of ['posix', 'gitbash']) {
    assert.equal(detectMarker(buildStatuslineCommand({ variant: 'collect', runtime: '/usr/bin/node', platform })), 'collect');
    assert.equal(detectMarker(buildStatuslineCommand({ variant: 'coexist', runtime: '/usr/bin/node', platform })), 'coexist');
  }
});

test('the built command targets the right script and is a single bash -c string', () => {
  const cmd = buildStatuslineCommand({ variant: 'coexist', runtime: '/usr/bin/node', platform: 'posix' });
  assert.match(cmd, /^bash -c '/);
  assert.match(cmd, /scripts\/coexist\.mjs/);
});

test('bad inputs throw', () => {
  assert.throws(() => buildStatuslineCommand({ variant: 'nope', runtime: '/usr/bin/node' }));
  assert.throws(() => buildStatuslineCommand({ variant: 'collect', runtime: '' }));
});

// End-to-end: the built command must actually execute and exec the resolved script.
// This is the real guard against single-quote escaping bugs in the ported bash body.
test('the built command resolves the newest plugin dir and execs the target script', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cmd-'));
  // Fake an installed plugin: <cfg>/plugins/cache/mk/claude-context/0.3.0/scripts/coexist.mjs
  const scriptDir = path.join(cfg, 'plugins', 'cache', 'mk', 'claude-context', '0.3.0', 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'coexist.mjs'), 'console.log("EXEC-OK");');
  const cmd = buildStatuslineCommand({ variant: 'coexist', runtime: process.execPath, platform: 'posix' });
  const out = execFileSync('bash', ['-c', cmd], {
    input: '{}',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, HOME: cfg },
    encoding: 'utf8',
  });
  assert.match(out, /EXEC-OK/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/command.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/command.mjs
import { markerAssignment } from './marker.mjs';

// Version-resolution glob, evaluated at every statusline refresh (~300ms). Identical shape
// to the shipped collect launcher in commands/setup.md; only the sort differs by platform.
function globExpr(platform) {
  if (platform === 'gitbash') {
    // Git Bash: sort -V avoids nested quoting (per claude-hud's Git Bash branch).
    return 'plugin_dir=$(ls -1d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null | sort -V | tail -1)';
  }
  // POSIX (macOS/Linux). Numeric sort on the version segment; ported verbatim from setup.md.
  return [
    'plugin_dir=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null',
    "| awk -F/ '{ print $(NF-1) \"\\t\" $0 }'",
    "| grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+[[:space:]]'",
    '| sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-)',
  ].join(' ');
}

// Escape a body for embedding inside a single-quoted bash -c '<body>'.
function shSingleQuote(body) {
  return `'${body.replace(/'/g, `'"'"'`)}'`;
}

export function buildStatuslineCommand({ variant, runtime, platform = 'posix' }) {
  if (variant !== 'collect' && variant !== 'coexist') throw new Error(`bad variant: ${variant}`);
  if (typeof runtime !== 'string' || runtime.trim() === '') throw new Error('runtime required');
  const marker = markerAssignment(variant); // CLAUDE_CONTEXT_WRAPPER=<variant>
  const body = `export ${marker}; ${globExpr(platform)}; exec "${runtime}" "\${plugin_dir}scripts/${variant}.mjs"`;
  return `bash -c ${shSingleQuote(body)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/command.test.mjs`
Expected: PASS (4 tests). If the end-to-end test fails, inspect the built string with `node -e "import('./plugins/claude-context/scripts/lib/command.mjs').then(m=>console.log(m.buildStatuslineCommand({variant:'coexist',runtime:'node'})))"` and fix the escaping in `globExpr`/`shSingleQuote` — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-context/scripts/lib/command.mjs tests/command.test.mjs
git commit -m "feat: add marked, version-resilient statusline command builder"
```

---

## Task 5: The invisible-tap wrapper (`scripts/coexist.mjs`) — safety-critical

**Files:**
- Create: `plugins/claude-context/scripts/coexist.mjs`
- Test: `tests/coexist.test.mjs`

**Interfaces:**
- Consumes: `sidecarPath`, `snapshotPath` (config-dir); lazily `buildSnapshot`, `compactLine` (collect.mjs) + `writeSnapshot` (snapshot).
- Produces:
  - `runCoexist({ now, readInput, env, deps, spawn, write, loadSnapshotLib } = {}): Promise<number>` — resolves to the exit code to propagate. Reads stdin; if the sidecar is missing/corrupt → degraded (prints our own compact line, still writes a snapshot); otherwise spawns `sh -c <original>` with `stdio: ['pipe','inherit','inherit']`, forwards stdin, writes the snapshot **after the spawn and without awaiting exit**, then awaits `close` only to propagate the code. Never prints its own line when a valid sidecar's original runs (even if the original fails/prints nothing).
  - CLI (`isMain`): `process.exit(await runCoexist())`.

- [ ] **Step 1: Write the failing test**

```js
// tests/coexist.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCoexist } from '../plugins/claude-context/scripts/coexist.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const coexistPath = path.join(here, '..', 'plugins', 'claude-context', 'scripts', 'coexist.mjs');

// A temp config dir; optionally seed a sidecar whose stored original is `command`.
function mkCfg(command) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cox-'));
  if (command !== undefined) {
    fs.mkdirSync(path.join(cfg, 'claude-context'), { recursive: true });
    fs.writeFileSync(
      path.join(cfg, 'claude-context', 'coexist.json'),
      JSON.stringify({ original: { type: 'command', command }, wrapped_at: new Date(0).toISOString() }),
    );
  }
  return cfg;
}
const STDIN = JSON.stringify({
  session_id: 'sid-cox',
  context_window: { context_window_size: 200000, current_usage: { input_tokens: 100000 } },
});
function snapFile(cfg) {
  return path.join(cfg, 'claude-context', 'snapshot-sid-cox.json');
}
// Fake child for deterministic unit tests: records forwarded stdin; `close(code)` fires later.
function fakeChild() {
  const h = {};
  return {
    stdin: { data: '', write(c) { this.data += c; }, end() { this.ended = true; } },
    on(ev, cb) { h[ev] = cb; return this; },
    fireClose(code) { h.close && h.close(code); },
  };
}
async function tick() { await new Promise((r) => setImmediate(r)); }
async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return false;
}

// --- Unit tests (injected spawn / snapshot lib) ---

test('failure isolation: snapshot write throws, but the child still runs + exit propagates', async () => {
  const cfg = mkCfg('true');
  const child = fakeChild();
  let spawned = 0;
  const p = runCoexist({
    now: 0, readInput: async () => STDIN, env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => { spawned++; return child; },
    loadSnapshotLib: async () => ({
      buildSnapshot: () => ({ session_id: 'sid-cox' }),
      compactLine: () => 'x',
      writeSnapshot: () => { throw new Error('EROFS'); },
    }),
  });
  await tick();
  assert.equal(spawned, 1, 'child spawned before the (throwing) snapshot step');
  assert.equal(child.stdin.data, STDIN, 'stdin forwarded to the child');
  child.fireClose(0);
  assert.equal(await p, 0);
});

test('child is spawned even when snapshot BUILDING throws synchronously', async () => {
  const cfg = mkCfg('true');
  const child = fakeChild();
  let spawned = 0;
  const p = runCoexist({
    now: 0, readInput: async () => STDIN, env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => { spawned++; return child; },
    loadSnapshotLib: async () => ({
      buildSnapshot: () => { throw new Error('boom'); },
      compactLine: () => 'x',
      writeSnapshot: () => {},
    }),
  });
  await tick();
  assert.equal(spawned, 1);
  child.fireClose(0);
  assert.equal(await p, 0);
});

test('hung original: snapshot is written WITHOUT awaiting the child exit', async () => {
  const cfg = mkCfg('sleep 999'); // real default loadSnapshotLib; fake child that never closes
  const child = fakeChild();
  const p = runCoexist({
    now: 0, readInput: async () => STDIN, env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => child,
  });
  const appeared = await waitFor(() => fs.existsSync(snapFile(cfg)));
  assert.ok(appeared, 'snapshot appears while the child is still "running" (close not fired)');
  const snap = JSON.parse(fs.readFileSync(snapFile(cfg), 'utf8'));
  assert.equal(snap.context.used_percentage, 50);
  child.fireClose(0);
  assert.equal(await p, 0);
});

test('missing/corrupt sidecar → degrades to our own compact line', async () => {
  const cfg = mkCfg(); // no sidecar
  let out = '';
  const code = await runCoexist({
    now: 0, readInput: async () => STDIN, env: { CLAUDE_CONFIG_DIR: cfg },
    spawn: () => { throw new Error('must not spawn in degraded mode'); },
    write: (s) => { out += s; },
  });
  assert.equal(code, 0);
  assert.equal(out.trim(), 'Context 50%');
});

// --- Integration tests (real `node coexist.mjs` subprocess: true stdio inherit) ---

function runWrapper(cfg, stdinStr) {
  return spawnSync(process.execPath, [coexistPath], {
    input: stdinStr, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
  });
}

test('forwards stdin and passes the original stdout through unchanged', () => {
  const cfg = mkCfg('cat'); // sh -c cat echoes stdin to stdout
  const r = runWrapper(cfg, STDIN);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, STDIN, 'wrapper adds nothing; the original tool owns the line');
  assert.ok(fs.existsSync(snapFile(cfg)), 'snapshot still written');
});

test('forwards a realistic quote-laden original via sh -c', () => {
  // Representative of a claude-hud bash -c '…' with nested '"'"' quoting.
  const original = `bash -c 'printf %s '"'"'q1 "q2" '"'"'`;
  const cfg = mkCfg(original);
  const r = runWrapper(cfg, STDIN);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /q1 "q2"/);
});

test('runtime-failed original: transparent pass-through, exit propagated, snapshot still written', () => {
  const cfg = mkCfg('exit 3'); // valid sidecar, original fails
  const r = runWrapper(cfg, STDIN);
  assert.equal(r.status, 3, "the original's exit code is propagated");
  assert.equal(r.stdout, '', 'we do NOT substitute our own line for a failing original');
  assert.ok(fs.existsSync(snapFile(cfg)), 'snapshot written regardless of child outcome');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/coexist.test.mjs`
Expected: FAIL — cannot find module `../plugins/claude-context/scripts/coexist.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/coexist.mjs
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sidecarPath, snapshotPath } from './lib/config-dir.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Returns the sidecar object only when it stores a usable original command; else null.
function readSidecar(env, deps) {
  try {
    const obj = JSON.parse(deps.readFileSync(sidecarPath(env), 'utf8'));
    const command = obj?.original?.command;
    return typeof command === 'string' && command.trim() !== '' ? obj : null;
  } catch {
    return null;
  }
}

// Lazy so token-math/time/etc. aren't parsed until AFTER the child is on its way
// (design spec §3.4 "lean hot path"). Importing collect.mjs does not run it (isMain-guarded).
async function defaultLoadSnapshotLib() {
  const collect = await import('./collect.mjs');
  const snap = await import('./lib/snapshot.mjs');
  return { buildSnapshot: collect.buildSnapshot, compactLine: collect.compactLine, writeSnapshot: snap.writeSnapshot };
}

function parse(input) {
  try { return JSON.parse(input); } catch { return {}; }
}

export async function runCoexist({
  now = Date.now(),
  readInput = readStdin,
  env = process.env,
  deps = fs,
  spawn = nodeSpawn,
  write = (s) => process.stdout.write(s),
  loadSnapshotLib = defaultLoadSnapshotLib,
} = {}) {
  const input = await readInput();
  const sidecar = readSidecar(env, deps);

  // Degraded half-state: wired to coexist but no usable sidecar. Show OUR line (not a
  // blank statusline) as a visible signal, and still capture the snapshot.
  if (!sidecar) {
    try {
      const { buildSnapshot, compactLine, writeSnapshot } = await loadSnapshotLib();
      const snapshot = buildSnapshot(parse(input), now);
      try { writeSnapshot(snapshotPath(snapshot.session_id, env), snapshot, { now, deps }); } catch { /* best effort */ }
      write(`${compactLine(snapshot)}\n`);
    } catch {
      write('\n');
    }
    return 0;
  }

  // Hot path: spawn the original FIRST, forward stdin, inherit stdout+stderr (the original
  // owns the display; inheriting also avoids a full-stderr-pipe deadlock in a chatty child).
  const child = spawn('sh', ['-c', sidecar.original.command], { stdio: ['pipe', 'inherit', 'inherit'], env });
  try { child.stdin.write(input); child.stdin.end(); } catch { /* child stdin may be closed */ }

  // Snapshot AFTER the spawn and WITHOUT awaiting the child's exit — a slow/hung/broken
  // original never strands our data.
  try {
    const { buildSnapshot, writeSnapshot } = await loadSnapshotLib();
    const snapshot = buildSnapshot(parse(input), now);
    writeSnapshot(snapshotPath(snapshot.session_id, env), snapshot, { now, deps });
  } catch { /* best-effort; never affects the child */ }

  // Await exit ONLY to propagate the code. The snapshot is already on disk.
  return await new Promise((resolve) => {
    child.on('close', (code) => resolve(typeof code === 'number' ? code : 0));
    child.on('error', () => resolve(0)); // spawn failure: stay transparent, don't crash
  });
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  process.exit(await runCoexist());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/coexist.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-context/scripts/coexist.mjs tests/coexist.test.mjs
git commit -m "feat: add the invisible-tap coexist wrapper"
```

---

## Task 6: Wiring — `detect` (no-write slot classification)

**Files:**
- Create: `plugins/claude-context/scripts/wiring.mjs` (add `detect` + shared helpers now; `wrap`/`teardown` land in Tasks 7-8)
- Test: `tests/wiring.test.mjs` (create, `detect` cases)

**Interfaces:**
- Consumes: `settingsPath`, `sidecarPath` (config-dir); `detectMarker` (marker); `previewCommand` (redact).
- Produces:
  - `detect({ env, deps } = {}): { slot, preview, hasSidecar, sidecarMatchesSlot, storedOriginalPreview }`. `slot`: `'empty'` (no/blank command), `'ours-collect'`/`'ours-coexist'` (marker), `'foreign'` (unmarked non-empty), `'error'` (settings.json present but unparseable — never overwrite what we can't read). `preview`/`storedOriginalPreview` are redacted+truncated (never raw). `sidecarMatchesSlot` is `true` when the stored original's command equals the current slot command (the interrupted-install / manual-revert case).

- [ ] **Step 1: Write the failing test**

```js
// tests/wiring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect } from '../plugins/claude-context/scripts/wiring.mjs';
import { detectMarker } from '../plugins/claude-context/scripts/lib/marker.mjs';

function mkCfg() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wire-')); }
function writeSettings(cfg, obj) { fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(obj, null, 2)); }
function writeSidecar(cfg, original) {
  fs.mkdirSync(path.join(cfg, 'claude-context'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'claude-context', 'coexist.json'),
    JSON.stringify({ original, wrapped_at: new Date(0).toISOString() }),
  );
}
const COLLECT = "bash -c 'export CLAUDE_CONTEXT_WRAPPER=collect; exec node x/scripts/collect.mjs'";
const COEXIST = "bash -c 'export CLAUDE_CONTEXT_WRAPPER=coexist; exec node x/scripts/coexist.mjs'";
const FOREIGN = 'bun run ~/.claude/claude-hud/statusline.js';

test('detect: empty slot (no settings file)', () => {
  const r = detect({ env: { CLAUDE_CONFIG_DIR: mkCfg() } });
  assert.equal(r.slot, 'empty');
  assert.equal(r.preview, null);
  assert.equal(r.hasSidecar, false);
});

test('detect: our markers classify as ours-collect / ours-coexist', () => {
  const c1 = mkCfg(); writeSettings(c1, { statusLine: { type: 'command', command: COLLECT } });
  assert.equal(detect({ env: { CLAUDE_CONFIG_DIR: c1 } }).slot, 'ours-collect');
  const c2 = mkCfg(); writeSettings(c2, { statusLine: { type: 'command', command: COEXIST } });
  assert.equal(detect({ env: { CLAUDE_CONFIG_DIR: c2 } }).slot, 'ours-coexist');
});

test('detect: foreign slot yields a REDACTED preview, never the raw secret', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: 'run --token ghp_ABCDEFGH12345678' } });
  const r = detect({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.slot, 'foreign');
  assert.doesNotMatch(r.preview, /ghp_ABCDEFGH12345678/);
});

test('detect: sidecarMatchesSlot true when the sidecar stored THIS foreign command', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: FOREIGN } });
  writeSidecar(cfg, { type: 'command', command: FOREIGN });
  const r = detect({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.slot, 'foreign');
  assert.equal(r.hasSidecar, true);
  assert.equal(r.sidecarMatchesSlot, true);
});

test('detect: unparseable settings.json → error slot (never overwrite what we cannot read)', () => {
  const cfg = mkCfg();
  fs.writeFileSync(path.join(cfg, 'settings.json'), '{ this is not json ');
  assert.equal(detect({ env: { CLAUDE_CONFIG_DIR: cfg } }).slot, 'error');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/wiring.test.mjs`
Expected: FAIL — cannot find module `../plugins/claude-context/scripts/wiring.mjs`.

- [ ] **Step 3: Write minimal implementation** (create the file with `detect` + shared read helpers)

```js
// scripts/wiring.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { settingsPath, sidecarPath, backupPath } from './lib/config-dir.mjs';
import { detectMarker } from './lib/marker.mjs';
import { buildStatuslineCommand } from './lib/command.mjs';
import { previewCommand } from './lib/redact.mjs';

// Returns the parsed object, or undefined if the file is missing OR unparseable. Callers
// distinguish the two with existsSync so an unreadable settings.json is never overwritten.
function readJson(file, deps) {
  try { return JSON.parse(deps.readFileSync(file, 'utf8')); } catch { return undefined; }
}
function currentCommand(settings) {
  const c = settings?.statusLine?.command;
  return typeof c === 'string' && c.trim() !== '' ? c : null;
}
function classify(command) {
  if (command == null) return 'empty';
  const marker = detectMarker(command);
  if (marker === 'collect') return 'ours-collect';
  if (marker === 'coexist') return 'ours-coexist';
  return 'foreign';
}
function readSidecar(env, deps) {
  const s = readJson(sidecarPath(env), deps);
  return s && s.original && typeof s.original.command === 'string' ? s : null;
}

export function detect({ env = process.env, deps = fs } = {}) {
  const sp = settingsPath(env);
  const settings = readJson(sp, deps);
  if (settings === undefined && deps.existsSync(sp)) {
    return { slot: 'error', preview: null, hasSidecar: false, sidecarMatchesSlot: false, storedOriginalPreview: null };
  }
  const command = currentCommand(settings ?? {});
  const sidecar = readSidecar(env, deps);
  const storedCommand = sidecar ? sidecar.original.command : null;
  return {
    slot: classify(command),
    preview: command == null ? null : previewCommand(command),
    hasSidecar: !!sidecar,
    sidecarMatchesSlot: !!sidecar && command != null && storedCommand === command,
    storedOriginalPreview: storedCommand == null ? null : previewCommand(storedCommand),
  };
}

// wrap() and teardown() are added in Tasks 7-8. CLI dispatch is added in Task 8.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/wiring.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-context/scripts/wiring.mjs tests/wiring.test.mjs
git commit -m "feat: add wiring detect (no-write slot classification)"
```

---

## Task 7: Wiring — `wrap` (the mutation: backup, atomic write, sidecar)

**Files:**
- Modify: `plugins/claude-context/scripts/wiring.mjs` (add `wrap` + write helpers)
- Test: `tests/wiring.test.mjs` (append `wrap` cases)

**Interfaces:**
- Consumes: `backupPath` (config-dir); `buildStatuslineCommand` (command); the Task-6 helpers.
- Produces:
  - `wrap({ env, deps, now, runtime, platform = 'posix' } = {}): { action, slot, storedOriginalPreview?, reason? }`. Re-detects the slot (so the confirm can't be raced), then:
    - `empty` → backup, write `collect` command. `action: 'wired-collect'`.
    - `ours-collect`/`ours-coexist` → backup, rewrite the same variant to the freshly resolved path (idempotent refresh, never nests). `action: 'refreshed-collect'`/`'refreshed-coexist'`.
    - `foreign` + no sidecar → backup, **write sidecar first** (whole original `statusLine` object + `wrapped_at`), then write `coexist` command. `action: 'wired-coexist'`.
    - `foreign` + sidecar whose stored original **equals** the slot → resume (interrupted install/manual revert): backup, write `coexist`. `action: 'resumed-coexist'`.
    - `foreign` + sidecar whose stored original **differs** → **do not overwrite**; `action: 'conflict'`, `storedOriginalPreview`.
    - `error` (unparseable settings) → `action: 'error'`, `reason: 'unparseable-settings'`, no write.
  - Guarantees (test-enforced): **exactly one** `0600` full-file backup before the first mutating write; atomic settings write preserving other keys; sidecar written before settings (safe ordering); never nests.

- [ ] **Step 1: Write the failing test** (append)

```js
// tests/wiring.test.mjs (append)
import { wrap } from '../plugins/claude-context/scripts/wiring.mjs';

const RUNTIME = '/usr/bin/node';
function readSettingsFile(cfg) { return JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8')); }
function readSidecarFile(cfg) { return JSON.parse(fs.readFileSync(path.join(cfg, 'claude-context', 'coexist.json'), 'utf8')); }

test('wrap: empty slot → wires collect, marked, no sidecar', () => {
  const cfg = mkCfg();
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'wired-collect');
  assert.equal(detectMarker(readSettingsFile(cfg).statusLine.command), 'collect');
  assert.equal(fs.existsSync(path.join(cfg, 'claude-context', 'coexist.json')), false);
});

test('wrap: foreign → stores the WHOLE original statusLine object + wires coexist, preserving other keys', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { model: 'opus', statusLine: { type: 'command', command: FOREIGN, padding: 1 } });
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'wired-coexist');
  const settings = readSettingsFile(cfg);
  assert.equal(detectMarker(settings.statusLine.command), 'coexist');
  assert.equal(settings.model, 'opus', 'other settings keys preserved');
  assert.deepEqual(readSidecarFile(cfg).original, { type: 'command', command: FOREIGN, padding: 1 });
});

test('wrap: writes exactly ONE full-file backup, mode 0600, before mutating', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: FOREIGN } });
  wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  const bak = path.join(cfg, 'settings.json.claude-context.bak');
  assert.ok(fs.existsSync(bak), 'backup exists');
  assert.match(JSON.parse(fs.readFileSync(bak, 'utf8')).statusLine.command, /statusline\.js|claude-hud|bun run/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(bak).mode & 0o777, 0o600);
});

test('wrap: idempotent for already-ours via marker, never nests', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: COEXIST } });
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'refreshed-coexist');
  const cmd = readSettingsFile(cfg).statusLine.command;
  assert.equal(detectMarker(cmd), 'coexist');
  assert.equal((cmd.match(/CLAUDE_CONTEXT_WRAPPER=coexist/g) || []).length, 1, 'no nested re-wrap');
});

test('wrap: orphaned sidecar — slot matches stored original → resume', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: FOREIGN } });
  writeSidecar(cfg, { type: 'command', command: FOREIGN });
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'resumed-coexist');
  assert.equal(detectMarker(readSettingsFile(cfg).statusLine.command), 'coexist');
});

test('wrap: orphaned sidecar — slot DIFFERS → conflict, no overwrite of the stored pointer', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: 'some-third-tool' } });
  writeSidecar(cfg, { type: 'command', command: FOREIGN });
  const r = wrap({ env: { CLAUDE_CONFIG_DIR: cfg }, now: 0, runtime: RUNTIME });
  assert.equal(r.action, 'conflict');
  assert.match(r.storedOriginalPreview, /claude-hud|statusline\.js|bun run/);
  // The slot and the sidecar are both untouched.
  assert.equal(readSettingsFile(cfg).statusLine.command, 'some-third-tool');
  assert.equal(readSidecarFile(cfg).original.command, FOREIGN);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/wiring.test.mjs`
Expected: FAIL — `wrap` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `scripts/wiring.mjs`, above the CLI-dispatch comment)

```js
// scripts/wiring.mjs (append)

function ensureDir(dir, deps) {
  deps.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Copy settings.json to the single stable 0600 backup — exactly once per run, and only
// if there is a file to protect. state.backedUp guards the "before the FIRST write" rule.
function backupOnce(env, deps, state) {
  if (state.backedUp) return;
  const sp = settingsPath(env);
  if (deps.existsSync(sp)) {
    const bp = backupPath(env);
    const tmp = `${bp}.${process.pid}.${state.now}.tmp`;
    deps.writeFileSync(tmp, deps.readFileSync(sp), { mode: 0o600 });
    deps.renameSync(tmp, bp);
    deps.chmodSync(bp, 0o600);
  }
  state.backedUp = true;
}

function writeSettingsAtomic(env, deps, obj) {
  const sp = settingsPath(env);
  const dir = path.dirname(sp);
  ensureDir(dir, deps);
  // Preserve the file's existing mode; default a new settings.json to 0600 (it may hold secrets).
  let mode = 0o600;
  try { mode = deps.statSync(sp).mode & 0o777; } catch { /* new file */ }
  const tmp = path.join(dir, `.settings.json.${process.pid}.${Date.now()}.tmp`);
  deps.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode });
  deps.renameSync(tmp, sp);
  deps.chmodSync(sp, mode);
}

function writeSidecarAtomic(env, deps, obj) {
  const scp = sidecarPath(env);
  const dir = path.dirname(scp);
  ensureDir(dir, deps);
  const tmp = path.join(dir, `.coexist.json.${process.pid}.${Date.now()}.tmp`);
  deps.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  deps.renameSync(tmp, scp);
  deps.chmodSync(scp, 0o600);
}

export function wrap({ env = process.env, deps = fs, now = Date.now(), runtime, platform = 'posix' } = {}) {
  const sp = settingsPath(env);
  const settings = readJson(sp, deps);
  if (settings === undefined && deps.existsSync(sp)) return { action: 'error', reason: 'unparseable-settings' };
  const base = settings ?? {};
  const command = currentCommand(base);
  const slot = classify(command);
  const state = { backedUp: false, now };

  const setVariant = (variant) => {
    backupOnce(env, deps, state);
    writeSettingsAtomic(env, deps, {
      ...base,
      statusLine: { type: 'command', command: buildStatuslineCommand({ variant, runtime, platform }) },
    });
  };

  if (slot === 'empty') { setVariant('collect'); return { action: 'wired-collect', slot }; }
  if (slot === 'ours-collect') { setVariant('collect'); return { action: 'refreshed-collect', slot }; }
  if (slot === 'ours-coexist') { setVariant('coexist'); return { action: 'refreshed-coexist', slot }; }

  // slot === 'foreign'
  const sidecar = readSidecar(env, deps);
  if (sidecar) {
    if (sidecar.original.command === command) { setVariant('coexist'); return { action: 'resumed-coexist', slot }; }
    return { action: 'conflict', slot, storedOriginalPreview: previewCommand(sidecar.original.command) };
  }
  // Fresh foreign wrap: back up, store the ORIGINAL first (safe ordering), then wire coexist.
  backupOnce(env, deps, state);
  writeSidecarAtomic(env, deps, { original: base.statusLine, wrapped_at: new Date(now).toISOString() });
  writeSettingsAtomic(env, deps, {
    ...base,
    statusLine: { type: 'command', command: buildStatuslineCommand({ variant: 'coexist', runtime, platform }) },
  });
  return { action: 'wired-coexist', slot };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/wiring.test.mjs`
Expected: PASS (5 detect + 6 wrap = 11 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-context/scripts/wiring.mjs tests/wiring.test.mjs
git commit -m "feat: add wiring wrap (backup + atomic settings/sidecar surgery)"
```

---

## Task 8: Wiring — `teardown` + CLI dispatch

**Files:**
- Modify: `plugins/claude-context/scripts/wiring.mjs` (add `teardown` + `isMain` CLI dispatch)
- Test: `tests/wiring.test.mjs` (append `teardown` cases)

**Interfaces:**
- Consumes: the Task-6/7 helpers.
- Produces:
  - `teardown({ env, deps } = {}): { action, storedOriginalPreview?, reason? }`:
    - slot carries `coexist` marker + sidecar present → restore `statusLine = sidecar.original` (atomic), delete sidecar, remove backup. `action: 'restored-original'`.
    - slot carries `coexist` marker, sidecar missing → can't restore; remove our `statusLine` (back to empty), delete backup. `action: 'coexist-no-sidecar-removed'`.
    - slot carries `collect` marker → remove our `statusLine` entry (back to empty), delete sidecar + backup. `action: 'removed-collect'`.
    - slot carries **neither** marker, non-empty → **never clobber**; report facts + stored original if any. `action: 'not-ours'`.
    - nothing of ours wired (empty / no settings) → `action: 'noop-nothing-wired'`.
    - unparseable settings → `action: 'error'`, `reason: 'unparseable-settings'`.
  - CLI: `node wiring.mjs <detect|wrap|teardown> [--runtime <path>] [--platform posix|gitbash]` prints the result as one JSON line.

- [ ] **Step 1: Write the failing test** (append)

```js
// tests/wiring.test.mjs (append)
import { teardown } from '../plugins/claude-context/scripts/wiring.mjs';

test('teardown: coexist + sidecar → restores the original verbatim, removes sidecar + backup', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { model: 'opus', statusLine: { type: 'command', command: COEXIST } });
  writeSidecar(cfg, { type: 'command', command: FOREIGN, padding: 2 });
  fs.writeFileSync(path.join(cfg, 'settings.json.claude-context.bak'), '{}');
  const r = teardown({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.action, 'restored-original');
  const settings = readSettingsFile(cfg);
  assert.deepEqual(settings.statusLine, { type: 'command', command: FOREIGN, padding: 2 });
  assert.equal(settings.model, 'opus', 'other keys preserved');
  assert.equal(fs.existsSync(path.join(cfg, 'claude-context', 'coexist.json')), false);
  assert.equal(fs.existsSync(path.join(cfg, 'settings.json.claude-context.bak')), false);
});

test('teardown: bare collect marker (empty-slot install) → removes our statusLine entry', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: COLLECT } });
  const r = teardown({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.action, 'removed-collect');
  assert.equal('statusLine' in readSettingsFile(cfg), false);
});

test('teardown: NEVER clobbers a slot we do not own', () => {
  const cfg = mkCfg();
  writeSettings(cfg, { statusLine: { type: 'command', command: 'third-party-tool' } });
  writeSidecar(cfg, { type: 'command', command: FOREIGN });
  const r = teardown({ env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.action, 'not-ours');
  assert.match(r.storedOriginalPreview, /claude-hud|statusline\.js|bun run/);
  assert.equal(readSettingsFile(cfg).statusLine.command, 'third-party-tool', 'slot untouched');
});

test('teardown: nothing of ours wired → idempotent no-op', () => {
  assert.equal(teardown({ env: { CLAUDE_CONFIG_DIR: mkCfg() } }).action, 'noop-nothing-wired');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/wiring.test.mjs`
Expected: FAIL — `teardown` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `scripts/wiring.mjs`; replace the trailing CLI-dispatch comment with the dispatch block)

```js
// scripts/wiring.mjs (append)

function removeIfPresent(file, deps) {
  try { deps.rmSync(file, { force: true }); } catch { /* already gone */ }
}

export function teardown({ env = process.env, deps = fs } = {}) {
  const sp = settingsPath(env);
  const settings = readJson(sp, deps);
  if (settings === undefined && deps.existsSync(sp)) return { action: 'error', reason: 'unparseable-settings' };
  const base = settings ?? {};
  const command = currentCommand(base);
  const marker = command == null ? null : detectMarker(command);
  const sidecar = readSidecar(env, deps);
  const state = { backedUp: false, now: Date.now() };

  if (marker === 'coexist') {
    if (sidecar) {
      backupOnce(env, deps, state);
      writeSettingsAtomic(env, deps, { ...base, statusLine: sidecar.original });
      removeIfPresent(sidecarPath(env), deps);
      removeIfPresent(backupPath(env), deps);
      return { action: 'restored-original' };
    }
    // Our wrapper is wired but the sidecar is gone — nothing to restore. Back to empty.
    backupOnce(env, deps, state);
    const next = { ...base }; delete next.statusLine;
    writeSettingsAtomic(env, deps, next);
    removeIfPresent(backupPath(env), deps);
    return { action: 'coexist-no-sidecar-removed' };
  }
  if (marker === 'collect') {
    backupOnce(env, deps, state);
    const next = { ...base }; delete next.statusLine;
    writeSettingsAtomic(env, deps, next);
    removeIfPresent(sidecarPath(env), deps);
    removeIfPresent(backupPath(env), deps);
    return { action: 'removed-collect' };
  }
  if (command == null) return { action: 'noop-nothing-wired' };
  // Non-empty but not our marker: never clobber. Report the stored original if we have one.
  return { action: 'not-ours', storedOriginalPreview: sidecar ? previewCommand(sidecar.original.command) : null };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const sub = process.argv[2];
  let result;
  if (sub === 'detect') result = detect();
  else if (sub === 'wrap') {
    result = wrap({
      runtime: argValue(process.argv, '--runtime'),
      platform: argValue(process.argv, '--platform') ?? 'posix',
    });
  } else if (sub === 'teardown') result = teardown();
  else result = { action: 'error', reason: `unknown subcommand: ${sub ?? '(none)'}` };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/wiring.test.mjs`
Expected: PASS (5 detect + 6 wrap + 4 teardown = 15 tests).

- [ ] **Step 5: Manually verify the CLI round-trips**

Run:
```bash
CFG=$(mktemp -d)
node plugins/claude-context/scripts/wiring.mjs detect 2>&1; echo
printf '{"statusLine":{"type":"command","command":"bun run hud.js"}}' > "$CFG/settings.json"
CLAUDE_CONFIG_DIR="$CFG" node plugins/claude-context/scripts/wiring.mjs detect; echo
CLAUDE_CONFIG_DIR="$CFG" node plugins/claude-context/scripts/wiring.mjs wrap --runtime "$(command -v node)" --platform posix; echo
CLAUDE_CONFIG_DIR="$CFG" node plugins/claude-context/scripts/wiring.mjs teardown; echo
cat "$CFG/settings.json"
```
Expected: `detect` prints `{"slot":"foreign",...}`; `wrap` prints `{"action":"wired-coexist",...}`; `teardown` prints `{"action":"restored-original"}`; the final `settings.json` holds the original `bun run hud.js` again.

- [ ] **Step 6: Commit**

```bash
git add plugins/claude-context/scripts/wiring.mjs tests/wiring.test.mjs
git commit -m "feat: add wiring teardown + CLI dispatch"
```

---

## Task 9: Rewrite `commands/setup.md` (POSIX + Git Bash, single-confirm, delegate to wiring)

**Files:**
- Modify: `plugins/claude-context/commands/setup.md` (full rewrite)
- Test: `tests/setup.test.mjs` (full rewrite)

**Interfaces:**
- Consumes: `wiring.mjs` (`detect` / `wrap`), `AskUserQuestion`.
- Produces: a command doc that detects platform/runtime, resolves nothing shell-side beyond the runtime path (the command builder handles the glob), calls `wiring.mjs detect`, renders a single proceed/cancel confirm for a foreign slot, calls `wiring.mjs wrap` on proceed, and reports native PowerShell as unsupported this alpha with **no** settings change.

- [ ] **Step 1: Write the failing test** (replace the whole file)

```js
// tests/setup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const setup = readFileSync(path.join(root, 'plugins', 'claude-context', 'commands', 'setup.md'), 'utf8');

// Positive facts only — do NOT grep for word-absence ("replace"/"keep"), the doc
// legitimately explains it never replaces, which would false-positive (base contract warning).

test('delegates the surgery to the wiring module via detect then wrap', () => {
  assert.match(setup, /wiring\.mjs detect/);
  assert.match(setup, /wiring\.mjs wrap/);
});

test('empty wires collect, foreign wires coexist (both via the wiring module)', () => {
  assert.match(setup, /collect/);
  assert.match(setup, /coexist/);
});

test('a foreign slot is a single proceed/cancel confirm', () => {
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /proceed/i);
  assert.match(setup, /cancel/i);
});

test('platform matrix is POSIX + Git Bash only; native PowerShell is reported unsupported, no settings change', () => {
  assert.match(setup, /Git Bash/i);
  assert.match(setup, /PowerShell/);
  assert.match(setup, /unsupported/i);
  assert.match(setup, /no (settings )?change|makes no change/i);
});

test('references teardown and keeps the session-keyed snapshot verification glob', () => {
  assert.match(setup, /\/claude-context:teardown/);
  assert.match(setup, /snapshot-\*\.json/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/setup.test.mjs`
Expected: FAIL — the current `setup.md` has no `wiring.mjs`, no `teardown`, still has the PowerShell wiring and Replace/Keep menu.

- [ ] **Step 3: Write the new `commands/setup.md`** (replace the whole file)

````markdown
---
description: Wire claude-context as your statusline — co-existing invisibly with any statusline you already run — so /claude-context can report live 5h/7d usage
allowed-tools: Bash, Read, AskUserQuestion
---

Wire claude-context into the user's `statusLine` so it can capture the `rate_limits`
and `cost` Claude Code sends only to the statusline process. If a **foreign** statusline
already owns the slot, claude-context **co-exists**: it wraps the existing command so both
run and the user's displayed line is unchanged (undo any time with
`/claude-context:teardown`). Setup **never** replaces or seizes a slot it doesn't own.

The dangerous `settings.json` surgery lives in the tested `scripts/wiring.mjs` module; this
command only detects the platform + runtime, asks the one confirm, and calls that module.

## Step 1: Detect platform, shell, and runtime

Use the environment context `Platform:` and `Shell:` values as the starting point.

**On `win32`, run `echo $OSTYPE` first** — a `powershell`/`pwsh`/`cmd` shell whose `$OSTYPE`
is `msys` or `cygwin` is actually driving a Git Bash environment. Resolve the branch:

| Platform | Shell | OSTYPE | Branch |
|----------|-------|--------|--------|
| `darwin` / `linux` | any | any | **posix** |
| `win32` | `bash` | any | **gitbash** |
| `win32` | `powershell`/`pwsh`/`cmd` | `msys` / `cygwin` | **gitbash** |
| `win32` | `powershell`/`pwsh`/`cmd` | other / empty | **native-powershell** |

**If the branch is `native-powershell`: stop here.** This alpha does **not** wire a
statusline on native PowerShell/cmd (a change from 0.2.0 — see the CHANGELOG). Make **no**
`settings.json` change. Tell the user: native PowerShell is **unsupported this alpha**; they
keep whatever statusline they have; live numbers are available by running Claude Code from
**Git Bash**, or in a later release. Do not proceed to Step 2.

Runtime: on macOS/Linux prefer `bun` then `node`
(`command -v bun 2>/dev/null || command -v node 2>/dev/null`); on Git Bash require `node`
(`command -v node`). If none is found, stop and tell the user to install Node.js LTS
(https://nodejs.org/), restart the shell, and re-run `/claude-context:setup`. Record the
resolved path as `{RUNTIME_PATH}` and the branch (`posix` / `gitbash`) as `{PLATFORM}`.

## Step 2: Detect the current slot

Run the wiring module's no-write detector (it reads `settings.json`, classifies the slot,
and redacts any secrets in the preview **inside the module** — the raw command never reaches
this transcript):

```bash
node "{PLUGIN_DIR}scripts/wiring.mjs" detect
```

Resolve `{PLUGIN_DIR}` the same way the statusline command does — the newest installed
version:

```bash
PLUGIN_DIR=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null | awk -F/ '{ print $(NF-1) "\t" $0 }' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+[[:space:]]' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-)
```

The detector prints one JSON line: `{ "slot", "preview", "hasSidecar", "sidecarMatchesSlot", "storedOriginalPreview" }`.

## Step 3: Decide and wire

- **`slot: "empty"` / `"ours-collect"` / `"ours-coexist"`** → no confirm needed. Go to Step 4.
- **`slot: "foreign"` with `sidecarMatchesSlot: true`** → a benign interrupted-install / manual-revert state; resume without a prompt. Go to Step 4.
- **`slot: "foreign"` (fresh, `hasSidecar: false`)** → use **AskUserQuestion** (a single
  proceed/cancel, **not** a replace/keep menu):
  - header: "Existing statusline detected"
  - question: show `preview` (already redacted) and explain: claude-context will run
    **alongside** it invisibly — the displayed line is unchanged — and `/claude-context:teardown`
    restores it verbatim.
  - options: "Proceed — co-exist (recommended)" · "Cancel — change nothing"
  - On **Cancel**: make no change. State honestly that claude-context will have **no** live
    numbers until setup runs and co-exists (with a foreign tool owning the slot and no
    snapshot ever written, there is nothing to report yet).
- **`slot: "foreign"` with `hasSidecar: true` and `sidecarMatchesSlot: false`** → a preserved
  statusline already exists but the slot now holds something we don't recognize. Do **not**
  overwrite. Report the facts and show `storedOriginalPreview` so the user can decide. Stop.
- **`slot: "error"`** → `settings.json` is unparseable; do not touch it. Tell the user to fix
  or remove it, then re-run. Stop.

## Step 4: Apply via the wiring module

```bash
node "{PLUGIN_DIR}scripts/wiring.mjs" wrap --runtime "{RUNTIME_PATH}" --platform {PLATFORM}
```

It writes exactly one `0600` full-file `settings.json.claude-context.bak` before its first
write, then performs an atomic settings write (and, for a foreign slot, stores the entire
original `statusLine` object in `coexist.json` first). It prints one JSON line with `action`
(`wired-collect` / `wired-coexist` / `resumed-coexist` / `refreshed-collect` /
`refreshed-coexist` / `conflict` / `error`). Report the outcome and tell the user to **fully
restart Claude Code**. If `action` is `conflict` or `error`, report it and do not retry.

## Step 5: Verify a snapshot appears

After the user restarts and sends one message, confirm a snapshot exists. The collector keys
the file by session id, so match the glob:

```bash
cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/claude-context/snapshot-*.json
```

If one exists with a recent `updated_at`, setup worked. If not, re-check: the runtime path
(`ls -la {RUNTIME_PATH}`); the plugin cache glob
(`ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/`); on Windows,
that the branch matches the real environment (`echo $OSTYPE`). The most common cause is not
having fully restarted Claude Code.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/setup.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-context/commands/setup.md tests/setup.test.mjs
git commit -m "feat: rewrite setup for co-existence (POSIX + Git Bash, delegates to wiring)"
```

---

## Task 10: New `commands/teardown.md` + manifest wiring

**Files:**
- Create: `plugins/claude-context/commands/teardown.md`
- Modify: `plugins/claude-context/.claude-plugin/plugin.json` (add the teardown command)
- Test: `tests/manifest.test.mjs` (assert both commands), `tests/setup.test.mjs` already references teardown (Task 9)

**Interfaces:**
- Consumes: `wiring.mjs teardown`.
- Produces: a command doc that resolves the plugin dir, calls `wiring.mjs teardown`, and reports the outcome (restore / removed / not-ours / no-op).

- [ ] **Step 1: Write the failing test** (append to `tests/manifest.test.mjs`)

```js
// tests/manifest.test.mjs (append inside the existing 'plugin.json has required fields' test,
// OR add this new test)
test('plugin.json registers both setup and teardown commands', () => {
  const m = readJson('plugins/claude-context/.claude-plugin/plugin.json');
  assert.ok(m.commands.includes('./commands/setup.md'));
  assert.ok(m.commands.includes('./commands/teardown.md'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/manifest.test.mjs`
Expected: FAIL — `commands` does not include `./commands/teardown.md`.

- [ ] **Step 3: Create `commands/teardown.md`**

````markdown
---
description: Undo /claude-context:setup — restore your original statusline verbatim (or remove ours), reversing co-existence
allowed-tools: Bash, Read
---

Reverse whatever `/claude-context:setup` wired, using the tested `scripts/wiring.mjs`
module. Ownership is decided by the marker the current `statusLine` command carries — never
by string-matching a resolved command — so an upgraded plugin path still tears down cleanly.

## Step 1: Resolve the plugin dir

```bash
PLUGIN_DIR=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null | awk -F/ '{ print $(NF-1) "\t" $0 }' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+[[:space:]]' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-)
```

## Step 2: Run teardown

```bash
node "{PLUGIN_DIR}scripts/wiring.mjs" teardown
```

It prints one JSON line with `action`. Report accordingly, then tell the user to **fully
restart Claude Code** if anything changed:

- `restored-original` — your original statusline is back; the sidecar and backup were removed.
- `removed-collect` — claude-context's own collector was removed; the slot is empty again.
- `coexist-no-sidecar-removed` — our wrapper was wired but the stored original was missing, so
  we removed our entry (slot empty). Nothing else to restore.
- `not-ours` — the slot no longer carries our marker (another tool or you changed it); we did
  **not** touch it. If `storedOriginalPreview` is shown, that is the statusline we had
  preserved — restore it by hand if you want it back.
- `noop-nothing-wired` — nothing of ours was wired; no change.
- `error` — `settings.json` is unparseable; fix or remove it, then re-run.
````

- [ ] **Step 4: Add the command to the manifest** — edit `plugins/claude-context/.claude-plugin/plugin.json`

```json
  "commands": ["./commands/setup.md", "./commands/teardown.md"],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/manifest.test.mjs`
Expected: PASS (the manifest tests, including the new both-commands assertion).

- [ ] **Step 6: Commit**

```bash
git add plugins/claude-context/commands/teardown.md plugins/claude-context/.claude-plugin/plugin.json tests/manifest.test.mjs
git commit -m "feat: add teardown command and register it in the manifest"
```

---

## Task 11: Docs + version bump (README, CHANGELOG, CLAUDE.md)

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`
- Modify: `package.json`, `plugins/claude-context/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (bump to `0.3.0` — the three must agree, per `tests/manifest.test.mjs`)
- Test: `tests/docs.test.mjs` (append a co-exist assertion), `tests/manifest.test.mjs` (version-agreement test already exists)

**Interfaces:**
- Consumes: nothing.
- Produces: docs describing co-existence, the native-PowerShell regression, and teardown; a `0.3.0` CHANGELOG entry.

- [ ] **Step 1: Write the failing test** (append to `tests/docs.test.mjs`)

```js
// tests/docs.test.mjs (append)
test('README documents co-existence, teardown, and the native-PowerShell regression', () => {
  const r = read('README.md');
  assert.match(r, /co-?exist/i);
  assert.match(r, /\/claude-context:teardown/);
  assert.match(r, /Git Bash/i);
  // Preserve the substrings the earlier tests require: /plugin install, /claude-context:setup,
  // and the no-advice phrase are still asserted by the existing README test above.
});

test('CHANGELOG has a 0.3.0 entry noting co-exist + teardown + the PowerShell removal', () => {
  const c = read('CHANGELOG.md');
  assert.match(c, /0\.3\.0/);
  assert.match(c, /co-?exist|teardown/i);
  assert.match(c, /PowerShell/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/docs.test.mjs`
Expected: FAIL — README has no co-exist/teardown copy; CHANGELOG has no 0.3.0 entry.

- [ ] **Step 3: Bump the three version fields to `0.3.0`**

Edit each file's `"version"` to `"0.3.0"`:
- `package.json`
- `plugins/claude-context/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json` (the **top-level** `version`, per `tests/manifest.test.mjs`)

- [ ] **Step 4: Rewrite the README "Already have a statusline?" section**

Replace the existing "Already have a statusline?" copy with the co-exist story. Keep the three
docs-test substrings intact elsewhere in the README (`/plugin install claude-context`,
`/claude-context:setup`, and a "no advice"/"no recommendations" phrase). Add:

```markdown
### Already have a statusline?

claude-context **co-exists** with it. `/claude-context:setup` wraps your existing statusline
so both run — your displayed line is **unchanged** — while claude-context quietly captures
its snapshot underneath. Undo any time with `/claude-context:teardown`, which restores your
original statusline verbatim. Setup **never** replaces or takes over a slot it doesn't own.

Co-existence is available on **macOS, Linux, and Windows + Git Bash** in this alpha. On
**native PowerShell/cmd** claude-context does not wire a statusline this release (a change
from 0.2.0, which shipped an empty-slot PowerShell collector) — run Claude Code from **Git
Bash** for live numbers, or wait for a later release.

**What if another statusline plugin later takes over the slot?** claude-context fails safe:
your original command is still stored, `/claude-context:teardown` refuses to clobber the new
tool and instead shows you the preserved original. claude-context stays one level deep — it
co-exists with exactly one prior statusline, not several.
```

- [ ] **Step 5: Add the CHANGELOG entry** (above the existing entries; keep `0.1.0` present for the existing docs test)

```markdown
## 0.3.0

- **Co-existing statusline.** `/claude-context:setup` now wraps an existing (foreign)
  statusline instead of offering replace-or-keep: both run, your displayed line is unchanged,
  and the new `/claude-context:teardown` restores the original verbatim. Setup never replaces
  or seizes a slot it doesn't own.
- **New `/claude-context:teardown` command.**
- **BREAKING (native PowerShell/cmd):** this release removes the empty-slot PowerShell
  collector shipped in 0.2.0. Native PowerShell/cmd is unsupported this alpha; setup makes no
  settings change there. Use Git Bash for live numbers. POSIX and Windows + Git Bash are
  wired as before (now via the tested `wiring.mjs` module).
```

- [ ] **Step 6: Update the CLAUDE.md "Setup wiring" convention bullet**

In `CLAUDE.md`, replace the "Setup wiring" convention bullet under **Conventions** with:

```markdown
- **Setup/teardown wiring** (`plugins/claude-context/commands/setup.md`,
  `commands/teardown.md`) **co-exists** rather than replaces: on a foreign slot it wraps the
  existing statusline via `scripts/coexist.mjs` (invisible tap — original's line unchanged),
  storing the whole original `statusLine` object in a `0600` `coexist.json` sidecar so
  teardown restores it verbatim. It **never** replaces/seizes a slot it doesn't own, stays
  **1-deep**, and fails safe. The risky `settings.json`/sidecar surgery is a tested module
  (`scripts/wiring.mjs`, marker-based ownership + a single `0600` full-file backup + atomic
  writes), not prose. **POSIX + Git Bash only** this alpha — native PowerShell is unsupported
  (no settings change). The report engine is **unchanged** (co-existence yields a normal
  `collector` snapshot).
```

Also update the entry-point count in the **Architecture** section: the "only two I/O entry
points" becomes **four** (`collect`, `report`, `coexist`, `wiring`); `lib/*` stays pure.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all new suites (marker, command, redact, coexist, wiring) plus the updated
config-dir/setup/manifest/docs, and the unchanged report/snapshot/token-math/time/transcript/
collect/skill suites. If lint/format is wired, also run `make all`.

- [ ] **Step 8: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md package.json plugins/claude-context/.claude-plugin/plugin.json .claude-plugin/marketplace.json tests/docs.test.mjs
git commit -m "docs: co-exist + teardown story, PowerShell regression note, bump 0.3.0"
```

---

## Self-Review (author checklist — done at plan-write time)

**1. Spec coverage** (spec §→task):
- §3.1 invisible tap → Task 5 (`coexist.mjs`).
- §3.2 two wiring modes (empty→collect, foreign→coexist, ours→refresh) → Task 7 (`wrap`) + Task 9 (setup decision).
- §3.3 Node wrapper + data sidecar; ownership marker; marker-only (no legacy fallback); Windows scope → Tasks 2 (marker), 4 (command), 5 (wrapper), 7 (sidecar write), 9 (native-PowerShell reported unsupported).
- §3.4 runtime flow (spawn-first, stderr+stdout inherit, snapshot after spawn without awaiting exit, lean/lazy hot path, degraded state, runtime-failed original) → Task 5 (impl + all seven tests).
- §3.5 setup UX (empty auto, foreign single-confirm, native-PS unsupported, already-ours refresh); one 0600 full-file backup → Task 9 (UX) + Task 7 (backup, mode-asserted).
- §3.6 teardown (restore / remove-collect / never-clobber / idempotent) → Task 8.
- §3.7 third-tool fail-safe; orphaned-sidecar detection (match→resume, differ→report) → Task 7 (`wrap` conflict/resume) + Task 8 (`teardown` not-ours).
- §3.8 tested wiring module; two-phase detect/wrap contract (detect no-write + in-module redaction, wrap gated) → Tasks 6 (detect) + 7 (wrap) + 9 (setup calls detect then wrap).
- §4 new components (coexist, wiring, teardown.md, setup.md; report unchanged; runtime files) → Tasks 5, 6-8, 10, 9; report untouched (Global Constraints).
- §5 testing (coexist.test, wiring.test, setup.test rewrite, others green) → Tasks 5, 6-8, 9; suites unchanged otherwise.
- §6 docs (README, CHANGELOG, CLAUDE.md, entry-point count, regression note) → Task 11.
- §7 non-goals — respected: no multiplexer (1-deep), report unchanged, no advice, no latency measurement, native PowerShell out of scope.

**2. Placeholder scan:** none — every code/test step carries full content; markdown command files are given in full.

**3. Type consistency:** `slot` values, `detect`/`wrap`/`teardown` return shapes, sidecar shape `{ original, wrapped_at }`, marker variants `'collect'`/`'coexist'`, and `buildStatuslineCommand({ variant, runtime, platform })` are used identically across Tasks 4–9. `coexist.mjs` reads `sidecar.original.command`; `wrap` writes `{ original: base.statusLine, wrapped_at }`; `teardown` restores `sidecar.original` — consistent.
