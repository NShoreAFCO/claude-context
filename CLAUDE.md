# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is (read first)

This repo **is** the installable `claude-context` Claude Code plugin, and it is **implemented and shipped**. Everything exists: `package.json`, the manifests (`.claude-plugin/`), `SKILL.md`, `scripts/` (collector + report engine + `lib/` helpers), `commands/setup.md`, `LICENSE`, `README.md`, and the `tests/*.test.mjs` suite. Run the suite with `npm test` (`node --test tests/*.test.mjs`).

The design and plan under `docs/superpowers/` are **historical design records**, not a to-do list. Where they and the code disagree, **the code wins** — it has evolved past the plan's literal listings (most notably the snapshot is now session-keyed; see Conventions).

- **Design spec** — `docs/superpowers/specs/2026-07-07-claude-context-plugin-design.md`. The *what* and *why* (numbered §1–§10).
- **Implementation plan** — `docs/superpowers/plans/2026-07-07-claude-context.md`. The original 12-task TDD build.

`README.md` describes the shipped plugin.

## The one non-negotiable contract: instrument, not advisor

The plugin's entire purpose is that **agents and subagents can query their own resource state** (context %, 5h/7d usage, cost, compactions) and act on the *user's* rules — e.g. checkpoint before Claude Code's silent auto-compaction drops CLAUDE.md guidance, or pause before a rate limit. For that to work, the plugin must **only report facts**:

- **No** recommendations, evaluative/level/traffic-light labels, policy ("should compact", 70/85/90 thresholds), or derived/predictive metrics. Raw measurements and provenance only.
- The plugin supplies facts; the **user's instructions** (CLAUDE.md, skills, subagent prompts) supply any policy. A tool with baked-in thresholds would fight the ones the user wrote.
- This is enforced by a denylist test over **`report.mjs`'s rendered output** (plan Task 9) — **not** by grepping `SKILL.md`, which legitimately uses words like "makes no recommendations" to *describe* the contract. Don't reintroduce a doc-vocabulary grep; it false-positives on the contract's own wording.

## Architecture

Two cooperating pieces plus the skill that ties them together:

- **Collector `scripts/collect.mjs`** — an *opt-in* statusline script. Claude Code pipes stdin JSON to it (~300ms cadence); it writes a private per-session snapshot (`snapshot-<session-id>.json`, atomic, `0600`, throttled) keyed off stdin's `session_id`, and prints one compact line. Exposes `buildSnapshot`, `compactLine`, and `runCli()`.
- **Report engine `scripts/report.mjs`** — what the skill runs. Graceful degradation: **fresh snapshot** (`source: collector`) → **transcript fallback** (`source: transcript`, context only) → **cold start** (`source: unavailable`). Emits a human block **and** a machine-readable JSON block.
- **Shared `scripts/lib/*`** — dependency-free single-responsibility helpers (`config-dir`, `token-math`, `model-window`, `time`, `transcript`, `snapshot`). `collect.mjs`/`report.mjs` hold the only I/O entry points.

**The core constraint that explains the whole design:** Claude Code pushes `context_window`, `rate_limits`, and `cost` **only to the statusline process via stdin**. A skill/command invoked by an agent gets **no stdin** — it can read only the transcript JSONL, which has per-message token `usage` but **no `rate_limits`**. Hence: the collector exists to capture stdin into a snapshot the report can later read, and the transcript fallback is context-only.

**Provenance is first-class.** Every reported number carries `source`, `rate_limits_status` (`available` / `unavailable_plan` / `unavailable_provider` / `unavailable_stale` / `unavailable_collector`), `window_size_inferred`, and `session_selection` (`session_id` / `unverified-snapshot` / `newest-in-cwd-heuristic`), so a consumer's rule never fires on a stale, estimated, or wrong-session value. A stale-but-present snapshot is a distinct state from "collector never installed."

**Session identity.** The report has no stdin, so it learns its own session id from the skill-passed `--session-id ${CLAUDE_SESSION_ID}` (substituted by Claude Code) → the `CLAUDE_CODE_SESSION_ID` env var → neither. With an id it reads its own keyed snapshot / own transcript (deterministic); without one it degrades to the newest snapshot / cwd heuristic and flags `session_selection` accordingly. This is what keeps concurrent same-account sessions from reading each other's context/compaction numbers.

## Data-source facts (verified against live capture — don't re-derive)

These were confirmed by capturing a real session; the fixtures in `tests/fixtures/` encode them and guard against drift. **Do not replace the golden fixtures with synthesized data** — a made-up fixture only re-tests an assumption.

- Statusline **stdin** carries the real `context_window.context_window_size` (e.g. `1000000`) and `model.id` **with** the `[1m]` marker; `rate_limits.*.resets_at` is a Unix epoch in **seconds** (multiply by 1000 for ms).
- The **transcript** stores the **base** model id (`claude-opus-4-8`, *no* `1m` marker), so window size cannot be inferred from it. That is why the fallback reuses the snapshot's real `window_size` when any snapshot exists, and only *guesses* (flagged `window_size_inferred`) at true cold start.
- Native `context_window.used_percentage == 0` means "not yet populated" (fresh session, before the first API response) → fall through to token-based calc. Rate-limit `used_percentage: 0` stays a valid value.
- Statusline **stdin** carries `session_id` and `transcript_path`; the transcript file on disk is named `<session-id>.jsonl` under the cwd-encoded `projects/` dir. The report reaches its own session id via `CLAUDE_CODE_SESSION_ID` (env, present in current builds) or the skill-passed `${CLAUDE_SESSION_ID}` substitution — this is why the snapshot can be session-keyed and the own-transcript lookup is deterministic.
- `tests/fixtures/real-stdin.json` and `tests/fixtures/real-transcript.jsonl` are redacted captures used as golden mapping tests (plan Tasks 6 & 8).

## Commands and toolchain

- **Runtime:** Node ESM (`.mjs`), **zero dependencies, no build step**. Requires Node 18+ (or Bun). Scripts run directly; there is no bundler, transpiler, or lint config by design.
- **Tests:** Node's built-in runner — `npm test` runs `node --test tests/*.test.mjs`. Single file: `node --test tests/<name>.test.mjs`. The glob is scoped to `tests/` so the vendored `claude-hud/` suite is excluded.
- No network, no credential access; all tests are local-only.

## Conventions

- **Snapshot path:** `<config-dir>/claude-context/snapshot-<session-id>.json`, file mode `0600` in a `0700` dir, where `<config-dir>` is `$CLAUDE_CONFIG_DIR` when set and non-empty, otherwise `~/.claude`. The collector keys the filename by stdin's `session_id`; the report resolves the matching file from its own session id (or falls back to the newest `snapshot-*.json`). Writer and reader must resolve the path — and sanitize the session id — identically (`scripts/lib/config-dir.mjs`).
- **Setup wiring** (`commands/setup.md`) is version-resilient and cross-platform (macOS/Linux, Git Bash, PowerShell). It only takes an **empty** `statusLine` slot; if one exists it backs it up and asks **replace-or-keep** — it never seizes the slot or chains another statusline command.
- **Docs commits go directly to `main`** (the repo's established convention; there is no build/CI gate on docs).

## The `claude-hud/` reference (gitignored, not shipped)

`claude-hud/` is a vendored reference checkout of an existing statusline plugin (MIT, © Jarrod Watts) — it is **reference only**, gitignored, and never a shipped component. It is the source of the borrowed `lib/` patterns and the setup command strings. When implementing, cross-check the real shapes in `claude-hud/src/{stdin,types,transcript,external-usage}.ts` and `claude-hud/commands/setup.md`. Note the key difference: claude-hud gets stdin because it *is* the statusline, so it never faces the "no stdin" problem — do not copy its assumption that the real window size is always available. Borrowed `lib/` files must carry an attribution header; claude-hud is acknowledged in the README and LICENSE.
