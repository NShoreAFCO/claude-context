# Upstream drafts (G2 review) — Ovid/claude-context

Branch: `upstream/compact-window-gitbash` (local worktree `Devel/cc-upstream`, not pushed),
5 commits on `upstream/main` 2026-10-29: fb7773c, 0e26a69, 2d1aa91, 66a8304, 67dbbc4.
182/182 tests, eslint clean. No version bump, no CHANGELOG entry, no plan docs.
Not included: statusline tokens + reset countdowns (3dd38ea) — a feature, offer separately if wanted.

---

## Issue 1 — Report measures usage against the model window, ignores `autoCompactWindow`

When `autoCompactWindow` is configured (e.g. `/autocompact 400k`, which saves it under
`modelSettings[<model>].autoCompactWindow`), Claude Code compacts at that window, but the
report and statusline measure usage only against the model window. On a 1M model with a
400k auto-compact window, the report says 8% while `/context` says 21% of 400k.

**Repro:** set `autoCompactWindow: 400000` (per model or top level) in user settings, use a
1M-context model, compare `/claude-context` with `/context`.

**Expected:** report usage and headroom against the effective auto-compact window too.

---

## Issue 2 — Setup on Windows refuses PowerShell sessions that have Git Bash

`/claude-context:setup` checks `$OSTYPE` in the session's own shell. In a PowerShell
session that variable is empty, so setup takes the native-PowerShell stop even though Claude
Code runs statusline commands through Git Bash. `bash` is also not on PowerShell's PATH
(Git for Windows adds only `Git\cmd`), so `bash -c` from PowerShell fails too.

**Repro:** Windows, Git for Windows installed, Claude Code with PowerShell as primary shell,
run `/claude-context:setup`.

**Expected:** ask the Git Bash Claude Code actually runs (its Bash tool, or `bin\bash.exe`
next to `git` / `CLAUDE_CODE_GIT_BASH_PATH`) for `$OSTYPE`; WSL's `bash.exe` (`linux-gnu`)
still takes the native stop.

---

## Issue 3 — The report skill is never loaded; `/claude-context` runs setup

The report skill lives at `plugins/claude-context/SKILL.md` (plugin root). Claude Code
registers plugin skills only from `skills/<name>/SKILL.md`, so `/context` lists only
`claude-context:setup` and `claude-context:teardown`, and typing `/claude-context`
completes to setup. The report is unreachable as a skill.

**Repro:** install the plugin, restart, run `/context` and look at Skills; type `/claude-context`.

**Expected:** `claude-context:claude-context` is listed and runs the report.

---

## PR — Measure against autoCompactWindow; fix Windows setup detection; load the report skill

Fixes #<1>, #<2>, #<3>.

**Auto-compact window (#1)**
- New `scripts/lib/auto-compact.mjs` reads the window from, highest first:
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (k/M suffixes, clamped 100k–1M), then local → project →
  user settings, where `modelSettings[<model>].autoCompactWindow` beats the top-level key
  in the same file (this is where `/autocompact` saves). Settings values count only as
  integers in 100000..1000000; per-model `"auto"` means not configured.
- Report adds `auto_compact_window`, `auto_compact_window_source`,
  `auto_compact_used_percentage`, `auto_compact_headroom_tokens` (capped at the model
  window). All `null` when nothing is configured; existing fields and states unchanged.
- The statusline line appends `N% of <window>k` when a window is configured.
- `--autocompact`, `--settings` and managed settings are not observable by a plugin; SKILL.md says so.

**Windows setup (#2)**
- setup.md asks Git Bash for `$OSTYPE` via the Bash tool, or `bin\bash.exe` next to `git` /
  `CLAUDE_CODE_GIT_BASH_PATH`, instead of the session shell. Verified live on Windows 11
  with a PowerShell session (`cygwin` → setup proceeds, `ours-collect`).

**Report skill (#3)**
- Move `SKILL.md` to `skills/claude-context/SKILL.md`. When the report says
  `setup_required: true`, the skill runs the setup flow (with its existing confirm before
  touching a foreign statusline), then reports.

**Tests:** 182/182 (`npm test`), eslint clean. New `tests/auto-compact.test.mjs`; additions to
report, collect, coexist, token-math, setup, skill and manifest tests.

Known limits, left for follow-up: per-model key matching normalises both sides (Bedrock/
Vertex ids don't match); home-dir dedupe is case-sensitive on Windows; settings are read
on every statusline tick (3 small sync reads).
