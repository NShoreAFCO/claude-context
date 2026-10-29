# HANDOFF — claude-context fork (resume point)

**Updated:** 2026-10-29, session 89c8bbe7-319c-491d-9176-5af301d13cc1 (previous: 46b6824f)
**Tracker project:** `claude-context-fork` (owner N. Shore)
**Repo:** `Devel/claude-context`. `origin` = NShoreAFCO/claude-context (fork), `upstream` = Ovid/claude-context
**Plan:** `docs/superpowers/plans/2026-10-29-auto-compact-window-and-gitbash-detection.md`

## State

Plan Tasks 1–4 are coded, reviewed and merged to fork `main` at **0.3.2** (PRs #1–#5,
180/180 tests, eslint clean). Branches are kept. Next is the **user live check** (Task 4
Step 4), then the **G2 gate** (Task 5).

| WP | Status |
|----|--------|
| `plan` | done (verified) |
| `auto-compact` | doing 90%: merged; done/verified needs N. Shore |
| `setup-gitbash` | doing 90%: merged; done/verified needs N. Shore |
| `release-verify` | doing 70%: waiting on the live check |
| `upstream` | todo, behind G2 |

## Next steps

1. **Live check (user):** switch the installed plugin to the fork
   (`/plugin marketplace add NShoreAFCO/claude-context`, reinstall `claude-context`), restart
   Claude Code, send one message, run `/claude-context`. Expected: `auto_compact_window: 400000`,
   `source: user`, and `auto_compact_used_percentage` near `/context`'s percentage. Then run
   `/claude-context:setup` once: it should take the gitbash branch and report `ours-collect`.
2. **G2:** review the upstream drafts (two issues + PR text). They are re-derivable from the
   CHANGELOG 0.3.2 entry and PR #1–#4 bodies. After a go, build `upstream/compact-window-gitbash`
   from `upstream/main` with only the fix commits b5100f4, 2b5e3a6, 142e8fd, 2b172b2 (no plan
   doc, no version bump) and post.

## What changed vs. the plan (rulings)

- The reader also handles `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (env, highest; k/M suffixes,
  clamped 100k–1M) and `modelSettings[<model>].autoCompactWindow`. The latter is where
  `/autocompact` saves, and it beats the top-level key in the same file. **The user's
  400000 lives there**, so the plan's top-level-only reader would have reported null.
  Per-model `"auto"` decides as "not configured".
- `--autocompact`, `--settings` and managed settings are not observable. SKILL.md says so.
- Settings values are valid only as integers in 100000..1000000 (the documented range).
  Anything else falls through.
- Setup probe: from PowerShell, `bash` is not on PATH (Git for Windows adds only `Git\cmd`).
  Setup now runs `bash -c 'echo $OSTYPE'` with the **Bash tool**, or calls `bin\bash.exe`
  next to `git` / `CLAUDE_CODE_GIT_BASH_PATH`. Both verified live here, giving `cygwin`.
  The final review found this, and PR #4 fixed it.
- The statusline line shows `N% of <effective window>k` (capped at the model window).
- This clone now has `core.autocrlf=input` (it was `true`, which checked files out CRLF and
  broke `skill.test`).

## Deferred minors (from the final review)

- Per-model matching normalises both sides, so an exact key is not preferred, and
  Bedrock/Vertex ids never match.
- Home-dir dedupe compares paths case-sensitively on Windows.
- `effectiveWindow(0, acw)` returns `acw` (uncapped) when the model window is unknown. The
  human line hides it, but the JSON shows it.
- Settings are read on every tick before the write throttle (3 small sync reads).
