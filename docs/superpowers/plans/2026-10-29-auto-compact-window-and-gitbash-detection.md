# Auto-compact window + Git Bash detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the report honour the user's configured `autoCompactWindow` (the real session limit), and stop `/claude-context:setup` refusing Windows machines where Git Bash is available just because the session's primary shell is PowerShell.

**Architecture:** A new pure helper reads `autoCompactWindow` from the Claude Code settings files (local → project → user). The collector and the co-exist tap pass its result into `buildSnapshot`, which stores it next to the model's `window_size`. The report prints the configured window plus usage and headroom measured against it. Setup decides the Windows branch by asking `bash` directly instead of reading `$OSTYPE` in whatever shell the session uses.

**Tech Stack:** Node ESM (`.mjs`), only `node:` built-ins, `node --test`.

**Spec:** this plan (no separate spec). The issues were found in session 46b6824f on 2026-10-29: snapshot `window_size: 1000000` while `/context` showed a 400k auto-compact window (`~/.claude/settings.json` → `"autoCompactWindow": 400000`); setup Step 1 returned native-powershell (PowerShell `$OSTYPE` empty) even though Git Bash `$OSTYPE` = `cygwin` and the plugin was already wired and collecting.

## Global Constraints

- The shipped plugin imports only `node:` built-ins and needs Node 18+.
- Instrument, not advisor: add raw facts and plain arithmetic only. No thresholds, no labels. Do not add an "estimated trigger point" (the autocompact buffer is not observable). The `report.mjs` denylist test must stay green.
- Settings files can contain secrets. Read only the `autoCompactWindow` key, never log, print or store any other content, and treat a parse error as "not configured".
- New fields are additive. Existing field names, values and the three report states stay unchanged when no `autoCompactWindow` is configured.
- Tests stay in `tests/*.test.mjs`. Golden fixtures in `tests/fixtures/` are not replaced.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Configured window larger than the model window** (for example 400k on a 200k model): usage and headroom must use `min(configured, window_size)`. The raw configured value is still reported as-is. → Task 2 test `auto-compact larger than model window uses the model window`.
2. **Malformed values** (`"400000"` string, `0`, negative, `NaN`, float) must be ignored and fall through to the next settings file. → Task 1 test `ignores invalid values and falls through`.
3. **Unparseable or missing settings file**: no throw, statusline still prints, fields `null`. → Task 1 test `unparseable file is treated as absent`.
4. **No `workspace.project_dir` in stdin** (older Claude Code): fall back to `stdin.cwd`, and to user settings only if both are absent. → Task 1 test `project dir falls back to cwd`.
5. **WSL `bash.exe` on PATH ahead of Git Bash** (prints `linux-gnu`): must resolve to native-powershell (stop), not gitbash. → Task 3 test `setup treats non-msys/cygwin bash as native`.

---

### Task 1: `readAutoCompactWindow` helper

**Files:**
- Create: `plugins/claude-context/scripts/lib/auto-compact.mjs`
- Test: `tests/auto-compact.test.mjs`

**Interfaces:**
- Consumes: `resolveConfigDir(env)` from `lib/config-dir.mjs`.
- Produces: `readAutoCompactWindow({ stdin, env = process.env, readFile = fs.readFileSync }) → { tokens: number|null, source: 'local'|'project'|'user'|null }`

- [ ] **Step 1: Confirm the setting's name and precedence.** Check the Claude Code settings docs (claude-code-guide agent or docs page) for: (a) the key is `autoCompactWindow` at the top level, (b) precedence local > project > user, (c) whether an env var overrides it. Record the answer in the test file header comment. If an env var exists, add it as `source: 'env'` with the highest precedence and add one test for it.
- [ ] **Step 2: Write the failing tests** in `tests/auto-compact.test.mjs`. Inject `readFile` as a map-backed fake (path → string, or throw ENOENT):
  - `user settings only` → `{ tokens: 400000, source: 'user' }` from `<CLAUDE_CONFIG_DIR>/settings.json`
  - `local beats project beats user`: local `300000`, project `350000`, user `400000` → `{ 300000, 'local' }`. Remove local → `{ 350000, 'project' }`.
  - Paths: project = `<project_dir>/.claude/settings.json`, local = `<project_dir>/.claude/settings.local.json`, `project_dir` = `stdin.workspace.project_dir`.
  - `project dir falls back to cwd`: no `workspace`, `stdin.cwd = '/p'` → reads `/p/.claude/settings.json`. With neither set, only the user file is read.
  - `ignores invalid values and falls through`: local `"400000"`, project `0`, user `-5` → `{ null, null }`. Local `1.5`, user `400000` → `{ 400000, 'user' }`.
  - `unparseable file is treated as absent`: local `'{not json'`, user `400000` → `{ 400000, 'user' }`, no throw.
  - `nothing configured` → `{ tokens: null, source: null }`.
  - `does not leak other keys`: the returned object has exactly the keys `tokens` and `source`.
- [ ] **Step 3: Run** `node --test tests/auto-compact.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement** `readAutoCompactWindow` in `lib/auto-compact.mjs`. Valid = `Number.isInteger(v) && v > 0`. Wrap every read and parse in try/catch. Add a header comment that names the precedence and the secrets rule.
- [ ] **Step 5: Run** `node --test tests/auto-compact.test.mjs`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(lib): read autoCompactWindow from Claude Code settings`

### Task 2: Snapshot + report carry the auto-compact window

**Files:**
- Modify: `plugins/claude-context/scripts/collect.mjs` (`buildSnapshot`, `compactLine`, `runCli`)
- Modify: `plugins/claude-context/scripts/coexist.mjs:56,111` (pass the reader's result)
- Modify: `plugins/claude-context/scripts/report.mjs` (`buildJson` ~L203, human line ~L302, stale path ~L95-122)
- Modify: `plugins/claude-context/SKILL.md:41` (document the new fields)
- Test: `tests/collect.test.mjs`, `tests/report.test.mjs`, `tests/coexist.test.mjs`

**Interfaces:**
- Consumes: `readAutoCompactWindow` (Task 1).
- Produces:
  - `buildSnapshot(stdin, now, autoCompact = { tokens: null, source: null })`. `snapshot.context` gains `auto_compact_window: number|null` (raw configured value) and `auto_compact_window_source: 'local'|'project'|'user'|null`.
  - `lib/token-math.mjs`: `effectiveWindow(windowSize, autoCompactWindow) → number|null` = the smaller of the positive values, or `null` if neither is positive.
  - Report JSON `context` gains `auto_compact_window`, `auto_compact_window_source`, `auto_compact_used_percentage` = `percentage(used, effectiveWindow(...))`, `auto_compact_headroom_tokens` = `headroom(used, effectiveWindow(...))`. All `null` when not configured or in the not-set-up state.

- [ ] **Step 1: Write the failing tests**
  - collect: `buildSnapshot(realStdin, 0, { tokens: 400000, source: 'user' })` → `context.auto_compact_window === 400000`, `source === 'user'`. `window_size` and `used_percentage` are unchanged from the existing golden assertion. With no third argument, both new fields are `null`.
  - collect: `compactLine` with auto-compact set → `'Context 46% · 17% of 400k · 5h 25% · 7d 61%'`. Use the fixture's real used tokens: compute the expected `of 400k` percentage in the test from `percentage(used, 400000)` and do not hard-code 17. Without auto-compact, the line is unchanged (existing test).
  - token-math: `effectiveWindow(1000000, 400000) === 400000`, `effectiveWindow(200000, 400000) === 200000`, `effectiveWindow(1000000, null) === 1000000`, `effectiveWindow(0, null) === null`.
  - report: a fresh snapshot with `auto_compact_window: 400000` and `used_tokens: 66780` → JSON `auto_compact_used_percentage: 17`, `auto_compact_headroom_tokens: 333220`. The human block contains `auto-compact window 400k (user settings) · 17% used · 333k headroom`.
  - report: `auto-compact larger than model window uses the model window`: `window_size: 200000`, `auto_compact_window: 400000`, used `50000` → `auto_compact_headroom_tokens: 150000`, and `auto_compact_window` is still reported as `400000`.
  - report: stale snapshot → the auto-compact fields come from the stale snapshot, the same way `window_size` does. Not-set-up state → all four fields `null`.
  - The existing denylist test passes against the new human line.
  - coexist: a tap run writes a snapshot that contains `auto_compact_window` (inject the reader).
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL and all others PASS.
- [ ] **Step 3: Implement.** In `collect.mjs` `runCli`, and in both `coexist.mjs` call sites, call `readAutoCompactWindow({ stdin, env })` and pass the result to `buildSnapshot`. Inject the reader through the existing `deps` pattern so tests stay hermetic. Add `effectiveWindow` to `token-math.mjs`. In `report.mjs`, append the auto-compact segment to the human `Context:` line only when `auto_compact_window != null`. In `SKILL.md`, add one bullet for the four new fields, worded as facts.
- [ ] **Step 4: Run** `npm test` and `npx eslint .`. Expected: all PASS, no lint errors.
- [ ] **Step 5: Commit** `feat: report usage against the configured autoCompactWindow`

### Task 3: Setup detects Git Bash by asking `bash`

**Files:**
- Modify: `plugins/claude-context/commands/setup.md` (Step 1 table + text)
- Modify: `README.md:5,198-212` (platform wording)
- Test: `tests/setup.test.mjs:33-40`

**Interfaces:** none (prose command; tests assert on its text).

Rationale to put in setup.md: the wired statusline command itself runs `bash -c '…'`. So the requirement is exactly that `bash` on PATH is Git Bash. Which shell the Claude Code session uses is irrelevant.

- [ ] **Step 1: Update the tests** in `tests/setup.test.mjs`:
  - setup.md contains the literal check `bash -c 'echo $OSTYPE'`. It says to run it on win32 from any shell (PowerShell included).
  - `setup treats non-msys/cygwin bash as native`: the text maps `msys`/`cygwin` → gitbash, and bash missing or any other output (e.g. `linux-gnu` from WSL) → native-powershell stop.
  - Keep the existing assertion that the native branch makes no `settings.json` change.
  - The old "Shell column" rule (PowerShell + empty `$OSTYPE`) no longer appears.
- [ ] **Step 2: Run** `node --test tests/setup.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Rewrite setup.md Step 1.** On `darwin`/`linux` → posix. On `win32` → run `bash -c 'echo $OSTYPE'`. `msys`/`cygwin` → gitbash. Anything else or command not found → native-powershell (existing stop text unchanged). Update the README platform lines to match.
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `fix(setup): detect Git Bash via bash itself, not the session shell`

### Task 4: Release 0.3.2-fork and verify live

**Files:**
- Modify: `CHANGELOG.md` (new `## 0.3.2` section, two bullets in the existing style)
- Modify: `plugins/claude-context/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (version `0.3.2`)
- Test: `tests/manifest.test.mjs` (existing; the versions must match)

- [ ] **Step 1:** Bump both versions and write the CHANGELOG entry.
- [ ] **Step 2: Run** `make all` (lint, format, test). Expected: all green, `git diff` clean after format.
- [ ] **Step 3: Offline end-to-end check.** In the scratchpad, create a temp `CLAUDE_CONFIG_DIR` with `settings.json` = `{"autoCompactWindow":400000}`. Pipe `tests/fixtures/real-stdin.json` into `node plugins/claude-context/scripts/collect.mjs`. Then run `node plugins/claude-context/scripts/report.mjs --session-id <fixture id>` with the same env. Expected: the snapshot has `auto_compact_window: 400000`, `source: "user"`, and the report shows the auto-compact segment.
- [ ] **Step 4: Live check (user checkpoint).** Switch the installed plugin to the fork (add the `NShoreAFCO/claude-context` marketplace, reinstall), restart Claude Code, send one message, then run the report. Expected: `auto_compact_window: 400000` and `auto_compact_used_percentage` near `/context`'s percentage. On Windows, also run setup once more: the detector should report `ours-collect` with no refusal.
- [ ] **Step 5:** Commit `chore(release): 0.3.2`, open a PR to fork `main`, and self-merge once green.

### Task 5: Offer the changes upstream (user gate before anything is posted)

Nothing in this task is posted without the user's explicit go: it publishes under the `NShoreAFCO` GitHub account.

- [ ] **Step 1:** Draft two issues for `Ovid/claude-context`, one per bug, each with observed vs. expected and the evidence above. Show the drafts to the user.
- [ ] **Step 2 (after go):** `gh issue create --repo Ovid/claude-context` for each.
- [ ] **Step 3:** Create a clean branch `upstream/compact-window-gitbash` from `upstream/main`. Cherry-pick only the Task 1–3 commits: no fork version bump, no plan document. Leave the version and CHANGELOG to the maintainer, or add an "Unreleased" entry if their convention allows. Push it to the fork.
- [ ] **Step 4 (after go):** `gh pr create --repo Ovid/claude-context --base main --head NShoreAFCO:upstream/compact-window-gitbash`. The body references both issues and ends with the Claude Code attribution line.
- [ ] **Step 5:** Record the issue and PR URLs in the tracker. The maintainer's response is outside our control: the WP stays `waiting` until they reply.

## Execution notes

- **Size:** about 150 lines of code plus about 150 lines of tests across 3 code tasks. That is below the Copilot threshold (instruction v2 §4: Copilot only for large self-contained output), so **no Copilot jobs**. Routine coding goes to a plain Sonnet implementer, or is done natively. No security-relevant surface beyond "read only one key from settings", which is covered by tests and the final review.
- Branch per task from fork `main` (`fix/auto-compact-helper`, `fix/auto-compact-report`, `fix/setup-gitbash`, `chore/release-0.3.2`). Then PR, then self-merge after `npm test` is green and the review passes. Keep the branches.
- Update the tracker WP at every merge.
