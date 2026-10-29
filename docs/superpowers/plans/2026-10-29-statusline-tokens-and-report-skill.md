# Statusline tokens + reachable report skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/claude-context` run the report (and set up on first use) instead of always landing on `/claude-context:setup`, and make the statusline show context tokens and rate-limit reset countdowns, not only percentages.

**Architecture:** The report skill moves from the plugin root to `skills/claude-context/SKILL.md`, where Claude Code actually discovers plugin skills. The skill gains a first-use branch keyed on the report's existing `setup_required` flag. The collector's `compactLine` gets a `now` argument, prints used/window tokens next to each percentage, and appends each window's reset countdown via the existing `formatDuration`.

**Tech Stack:** Node ESM (`.mjs`), only `node:` built-ins, `node --test`.

**Spec:** this plan (no separate spec). Found in session 5323ca0a on 2026-10-29:
- Bug: the session's loaded skills (`/context` → Skills) list `claude-context:setup` and `claude-context:teardown` but no report skill. `plugins/claude-context/SKILL.md` sits at the plugin root; Claude Code discovers plugin skills only under `skills/<name>/SKILL.md`. Typing `/claude-context` therefore completes to `/claude-context:setup`. `tests/manifest.test.mjs:16` encodes the wrong assumption ("no skills field so root SKILL.md auto-loads"). Upstream 0.3.1 has the same layout.
- Request (N. Shore): "The status bar entry with % isn't as useful as seeing the actual context tokens, because that's what I go by when choosing the clear point. Change the display so that the total tokens are displayed in addition. Also, time to reset could be printed, too."
- Request (N. Shore): "The first use should automatically call setup, the second use should print the plugin output."

Target statusline (this session's numbers, auto-compact window configured):

```
Context 84k/1M 8% · 84k/400k 21% · 5h 50% 1h 49m · 7d 18% 5d 18h
```

Without an auto-compact window: `Context 84k/1M 8% · 5h 50% 1h 49m · 7d 18% 5d 18h`.

## Global Constraints

- The shipped plugin imports only `node:` built-ins and needs Node 18+.
- Instrument, not advisor: tokens and countdowns are raw facts. No labels, thresholds or colours. The `report.mjs` denylist test must stay green.
- `report.mjs` output is unchanged by this plan (its `kt()` keeps printing `1000k`).
- Token format in the statusline: `< 1000` → the integer as-is; `< 1,000,000` → `Math.round(n/1000)` + `k`; otherwise `n/1e6` with at most one decimal, trailing `.0` dropped, + `M` (`1000000` → `1M`, `1500000` → `1.5M`). A value that rounds to `1000k` prints as `1M`.
- Countdown format: `formatDuration` from `lib/time.mjs`, computed from minutes rounded the same way as `report.mjs` `resetsInSeconds` (`Math.round((ms - now) / 60000) * 60`, floored at 0). Omitted when `resets_at` is null or unparseable.
- Tests stay in `tests/*.test.mjs`. Golden fixtures in `tests/fixtures/` are not replaced.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branch per task from fork `main`, PR to NShoreAFCO/claude-context `main`, self-merge, keep branches.

## Review Focus

1. **Reset time already passed** (`resets_at` before `now`, a stale snapshot shown by coexist): countdown prints `<1m`, never a negative. → Task 1 test `compactLine countdown never goes negative`.
2. **`used_tokens` 0 before the first API response**: line prints `Context 0/1M 0%` without throwing. → Task 1 test `compactLine on a fresh session`.
3. **Unknown model window (`window_size` 0)**: no `/0`, no `Infinity`; print `Context 84k` with no window part. → Task 1 test `compactLine without a window size`.
4. **Coexist fallback path** (`coexist.mjs:72` prints `compactLine` when the wrapped statusline fails): must pass `now`, so countdowns are not computed against `Date.now()` drift in tests. → Task 1 test in `coexist.test.mjs` `fallback line passes now to compactLine`.
5. **First use with a foreign statusline**: the skill must still go through setup's proceed/cancel confirm, never wire silently. → Task 2 test `skill first-use defers to setup's confirm`.

---

### Task 1: Statusline shows tokens and reset countdowns

**Files:**
- Modify: `plugins/claude-context/scripts/lib/token-math.mjs` (add `formatTokens`)
- Modify: `plugins/claude-context/scripts/collect.mjs:65-77` (`compactLine`), `:101-104` (pass `now`)
- Modify: `plugins/claude-context/scripts/coexist.mjs:72` (pass `now`)
- Test: `tests/token-math.test.mjs`, `tests/collect.test.mjs`, `tests/coexist.test.mjs`

**Interfaces:**
- Consumes: `effectiveWindow`, `percentage` (`lib/token-math.mjs`); `formatDuration` (`lib/time.mjs`).
- Produces: `formatTokens(n: number) → string`; `compactLine(snapshot, now = Date.now()) → string`.

- [ ] **Step 1: Write the failing tests**

`tests/token-math.test.mjs`:
```js
test('formatTokens', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(83709), '84k');
  assert.equal(formatTokens(999600), '1M');
  assert.equal(formatTokens(1000000), '1M');
  assert.equal(formatTokens(1500000), '1.5M');
});
```

`tests/collect.test.mjs` (replace the two existing `compactLine` tests; `stdin` fixture has a 200k window, 92k used, 5h 25%, 7d 61%; pick `now` so the fixture's `resets_at` values are 1h 49m and 5d 18h away, or build the rate limits inline):
```js
test('compactLine shows tokens, percentage and reset countdowns', () => {
  assert.equal(compactLine(snapWithResets, now), 'Context 92k/200k 46% · 5h 25% 1h 49m · 7d 61% 5d 18h');
});
test('compactLine adds tokens against the auto-compact window', () => {
  // 1M model window, 83709 used, acw 400000
  assert.equal(compactLine(s, now), 'Context 84k/1M 8% · 84k/400k 21% · 5h 50% 1h 49m · 7d 18% 5d 18h');
});
test('compactLine caps the auto-compact window at the model window', () => {
  // 200k model, acw 400000 → effective 200k
  assert.match(compactLine(s, now), /^Context 92k\/200k 46% · 92k\/200k 46%/);
});
test('compactLine countdown never goes negative', () => {
  // five_hour.resets_at 10 minutes before now
  assert.match(compactLine(s, now), / · 5h 25% <1m/);
});
test('compactLine on a fresh session', () => {
  assert.equal(compactLine(buildSnapshot({ context_window: { context_window_size: 1000000 } }, 0), 0), 'Context 0/1M 0%');
});
test('compactLine without a window size', () => {
  assert.equal(compactLine(buildSnapshot({ context_window: { current_usage: { input_tokens: 83709 } } }, 0), 0), 'Context 84k');
});
test('compactLine omits the countdown when resets_at is null', () => {
  // five_hour { used_percentage: 25, resets_at: null }
  assert.match(compactLine(s, now), / · 5h 25% · /);
});
```

`tests/coexist.test.mjs`: `fallback line passes now to compactLine` — inject `compactLine: (snap, n) => String(n)` and `now: 123`, assert the written line is `123\n`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/token-math.test.mjs tests/collect.test.mjs tests/coexist.test.mjs`
Expected: FAIL (`formatTokens` not exported; old line format).

- [ ] **Step 3: Implement**

`formatTokens` per Global Constraints. `compactLine(snapshot, now = Date.now())`: first part `Context <used>/<window> <pct>%`, or `Context <used>` when `window_size` is 0/null; when `auto_compact_window` is set, `<used>/<effective> <pct>%` with `effective = effectiveWindow(window_size, acw)`; each rate-limit window `<label> <pct>%` plus ` <countdown>` when `resets_at` parses. Keep the existing `—` when `used_percentage` is null. `runCli` and `coexist.mjs:72` pass their `now`.

- [ ] **Step 4: Run all tests and lint**

Run: `npm test && npx eslint .`
Expected: all pass, no lint errors.

- [ ] **Step 5: Docs + commit**

README statusline example and CHANGELOG `## 0.3.3` entry ("Statusline: tokens and reset countdowns"). Remove the "`compactLine` shows 1M as `1000k`" line from HANDOFF.md's deferred minors.

```bash
git checkout -b feat/statusline-tokens
git add -A && git commit -m "feat(statusline): show context tokens and reset countdowns"
```

---

### Task 2: Report skill is discoverable and sets up on first use

**Files:**
- Move: `plugins/claude-context/SKILL.md` → `plugins/claude-context/skills/claude-context/SKILL.md` (`git mv`)
- Modify: the moved `SKILL.md` ("How to run it" section)
- Modify: `tests/manifest.test.mjs:16`, `tests/skill.test.mjs:9`
- Modify: `CLAUDE.md:7` and `:22` (path), README invocation section (`README.md:94-110`)

**Interfaces:**
- Consumes: report JSON field `setup_required` (unchanged); setup flow in `commands/setup.md` (unchanged).
- Produces: skill `claude-context:claude-context`.

- [ ] **Step 1: Write the failing tests**

`tests/manifest.test.mjs` — replace line 16:
```js
assert.equal(m.skills, undefined, 'skills/ is auto-discovered');
assert.ok(existsSync(path.join(root, 'plugins/claude-context/skills/claude-context/SKILL.md')));
assert.ok(!existsSync(path.join(root, 'plugins/claude-context/SKILL.md')), 'a root SKILL.md is not loaded by Claude Code');
```

`tests/skill.test.mjs` — read from the new path, and add:
```js
test('skill first-use runs setup when the report says setup_required', () => {
  assert.match(skill, /setup_required/);
  assert.match(skill, /commands\/setup\.md/);
});
test('skill first-use defers to setup\'s confirm', () => {
  assert.match(skill, /foreign/i);
  assert.match(skill, /AskUserQuestion|confirm/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/manifest.test.mjs tests/skill.test.mjs`
Expected: FAIL (file still at root, no first-use text).

- [ ] **Step 3: Move and edit the skill**

`git mv` the file. Frontmatter `name: claude-context` stays. `${CLAUDE_PLUGIN_ROOT}` still points at the plugin root, so the report command does not change. Add a "First use" subsection after the report command: if the JSON block has `"setup_required": true`, read `${CLAUDE_PLUGIN_ROOT}/commands/setup.md` and follow it exactly (including its foreign-slot proceed/cancel confirm and its native-PowerShell stop), then run the report once more and relay that output. If setup is cancelled or stops, relay the first report as-is. Keep the "facts only, no advice" wording.

- [ ] **Step 4: Run all tests and lint**

Run: `npm test && npx eslint .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git checkout main && git pull && git checkout -b fix/report-skill-discovery
git add -A && git commit -m "fix(skill): move the report skill to skills/ so Claude Code loads it; set up on first use"
```

---

### Task 3: Release 0.3.3 and live check

**Files:**
- Modify: `plugins/claude-context/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json` (version `0.3.3`)
- Modify: `CHANGELOG.md` (`## 0.3.3`: both changes), `HANDOFF.md`

- [ ] **Step 1: Bump versions, run `npm test && npx eslint .`, commit `chore(release): 0.3.3`, PR, merge.**

- [ ] **Step 2: Live check (user)**

`/plugin` → update `claude-context`, `/reload-plugins`, restart Claude Code. Expected:
1. `/context` → Skills lists `claude-context:claude-context`.
2. `/claude-context` (or `/claude-context:claude-context`) prints the report, not setup.
3. The statusline reads `Context <n>k/1M <p>% · <n>k/400k <p>% · 5h <p>% <countdown> · 7d <p>% <countdown>`, and the 400k tokens match `/context`.
4. First-use path: on a config dir with no snapshot (e.g. `CLAUDE_CONFIG_DIR` pointing to a scratch copy), `/claude-context` runs setup, then prints the report.

- [ ] **Step 3: Tracker** — upsert WPs, `log_progress`, `append_context` handover; add the skill-discovery bug to the G2 upstream drafts as a third issue.
