# HANDOFF — claude-context fork (resume point)

**Updated:** 2026-10-29, session 631cd151-a843-473a-8a10-ed27e201ea26 (previous: 5323ca0a)

## Latest: G2 prepared, waiting on N. Shore

0.3.3 live check (partly): in session 631cd151 `/claude-context:claude-context` loaded from
`skills/claude-context/` and printed the report (`auto_compact_window 400000`, source user,
session_id match). Statusline line not seen by the agent; N. Shore to confirm it shows tokens
and countdowns.

G2 prep: branch `upstream/compact-window-gitbash` built in worktree `Devel/cc-upstream`
(local only, NOT pushed) = upstream/main + b5100f4, 2b5e3a6, 142e8fd, 2b172b2, b6b6bd4
(CHANGELOG hunk dropped). Statusline feature 3dd38ea left out. 182/182 tests, eslint clean.
Drafts (3 issues + PR): `docs/superpowers/upstream-drafts.md`.
After G2 go: push branch to origin, open the three issues on Ovid/claude-context, then the PR
from NShoreAFCO:upstream/compact-window-gitbash with the issue numbers filled in.

## Latest: 0.3.3 on fork main (supersedes "State" below)

0.3.2 live check passed (report 21% vs `/context` 22% of 400k). Installed plugin now
comes from the fork (`~/.claude/settings.json` `extraKnownMarketplaces.claude-context`
→ NShoreAFCO). Plan `docs/superpowers/plans/2026-10-29-statusline-tokens-and-report-skill.md`
executed natively, no agents, no final reviewer (user asked: no agents):
PR #6 statusline tokens + reset countdowns, PR #7 skill moved to `skills/claude-context/`
+ first-use setup, PR #8 release 0.3.3. 189/189 tests, eslint clean.

Next: user live check (plan Task 3 Step 2): `/plugin` update `claude-context`, restart;
`/context` Skills lists `claude-context:claude-context`; `/claude-context` prints the
report; statusline reads `Context 170k/1M 17% · 170k/400k 42% · 5h 56% 1h 33m · …`.
Then G2: upstream drafts now three issues (add: root SKILL.md never loaded). Upstream
branch fix commits add b6b6bd4 (skill move) and the statusline commit from PR #6 if wanted.
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
