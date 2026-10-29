# HANDOFF — claude-context fork (resume point)

**Updated:** 2026-10-29, session 46b6824f-0278-48db-9b88-f64162ecebbe
**Tracker project:** `claude-context-fork` (owner N. Shore)
**Repo:** `Devel/claude-context`. `origin` = NShoreAFCO/claude-context (fork), `upstream` = Ovid/claude-context
**Plan (approved by N. Shore 2026-10-29):** `docs/superpowers/plans/2026-10-29-auto-compact-window-and-gitbash-detection.md`

## Brief for the next session

Start in `Devel/claude-context`. Call tracker `get_context_bundle` for `claude-context-fork`, then execute the plan **natively** (superpowers:executing-plans), Tasks 1 → 4. Stop at the Task 4 Step 4 live check and at the Task 5 gate.

- **Problem 1:** the report measures context against the model window (1M), while the real limit is `autoCompactWindow: 400000` in `~/.claude/settings.json`. Claude Code does not send that setting to the statusline, so the plugin must read it itself (one key only, because settings can hold secrets).
- **Problem 2:** setup Step 1 reads `$OSTYPE` in the session's primary shell (PowerShell → empty → "unsupported") even though Git Bash is present, and the plugin was already wired (`ours-collect`) and collecting.
- **Execution mode:** native, with no Copilot (about 150 lines of code plus 150 of tests, below the instruction v2 §4 threshold). Use one branch per task, a PR to fork `main`, and self-merge once `npm test` is green and the review passes. Keep the branches. Upsert the tracker WP at every merge.
- **Repo rules:** read `CLAUDE.md`. The key one is the "instrument, not advisor" contract: facts only, with a denylist test over the report output. Do not replace the golden fixtures. Docs commits go straight to `main`.
- **Setup:** run `npm install` once for ESLint and Prettier (`make all`).

## State

| WP | Status |
|----|--------|
| `plan` | finished. **Open:** N. Shore must mark it done/verified in the dashboard (agents may only verify as their own login) |
| `auto-compact` (Tasks 1–2) | todo, behind gate G1 |
| `setup-gitbash` (Task 3) | todo, behind gate G1 |
| `release-verify` (Task 4) | todo |
| `upstream` (Task 5) | todo, behind gate G2 |

**Before coding can start (dashboard, N. Shore):**
1. Set the project **decision maker** to N. Shore. Agents are refused (`DECISION_MAKER_LOCKED`).
2. Mark WP `plan` done/verified.
3. Record **G1 = go** (approval given in session 46b6824f). If the tracker still refuses an agent `record_gate_decision`, decide it in the dashboard.

## Open points / checkpoints

- **Task 1 Step 1:** confirm the exact name of `autoCompactWindow`, the settings precedence, and whether an env var overrides it, before writing tests.
- **Task 4 Step 4 (user):** switch the installed plugin to the fork, restart Claude Code, and compare the report with `/context`.
- **Task 5 (G2 gate):** show the issue and PR drafts to N. Shore before posting under NShoreAFCO. Build the upstream PR from a clean branch off `upstream/main` with only the fix commits (no plan doc, no fork version bump).
- `/context` at handoff: 122.5k of 400k.
