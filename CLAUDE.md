# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is (read first)

This repo **is** the installable `claude-context` Claude Code plugin — but it is currently **pre-implementation**. The only things that exist are the design, the plan, the README, and captured test fixtures. There is **no plugin code yet**: `package.json`, the manifests (`.claude-plugin/`), `SKILL.md`, `scripts/`, `commands/`, `LICENSE`, and the `tests/*.test.mjs` files are all still to be written.

Two documents are the source of truth, and you should read them before doing anything:

- **Design spec** — `docs/superpowers/specs/2026-07-07-claude-context-plugin-design.md`. The *what* and *why*, in numbered sections §1–§10 (referenced throughout the plan).
- **Implementation plan** — `docs/superpowers/plans/2026-07-07-claude-context.md`. The *how*: 12 task-by-task TDD steps, each with complete code and tests. **Build the plugin by executing this plan** (write failing test → implement → pass → commit), using the `superpowers:subagent-driven-development` or `superpowers:executing-plans` skill.

`README.md` describes the **finished** plugin (it is written as if shipped) — it is the product vision, not a description of current code.

## The one non-negotiable contract: instrument, not advisor

The plugin's entire purpose is that **agents and subagents can query their own resource state** (context %, 5h/7d usage, cost, compactions) and act on the *user's* rules — e.g. checkpoint before Claude Code's silent auto-compaction drops CLAUDE.md guidance, or pause before a rate limit. For that to work, the plugin must **only report facts**:

- **No** recommendations, evaluative/level/traffic-light labels, policy ("should compact", 70/85/90 thresholds), or derived/predictive metrics. Raw measurements and provenance only.
- The plugin supplies facts; the **user's instructions** (CLAUDE.md, skills, subagent prompts) supply any policy. A tool with baked-in thresholds would fight the ones the user wrote.
- This is enforced by a denylist test over **`report.mjs`'s rendered output** (plan Task 9) — **not** by grepping `SKILL.md`, which legitimately uses words like "makes no recommendations" to *describe* the contract. Don't reintroduce a doc-vocabulary grep; it false-positives on the contract's own wording.

## Architecture (once built)

Two cooperating pieces plus the skill that ties them together:

- **Collector `scripts/collect.mjs`** — an *opt-in* statusline script. Claude Code pipes stdin JSON to it (~300ms cadence); it writes a private `snapshot.json` (atomic, `0600`, throttled) and prints one compact line. Exposes `buildSnapshot`, `compactLine`, and `runCli()`.
- **Report engine `scripts/report.mjs`** — what the skill runs. Graceful degradation: **fresh snapshot** (`source: collector`) → **transcript fallback** (`source: transcript`, context only) → **cold start** (`source: unavailable`). Emits a human block **and** a machine-readable JSON block.
- **Shared `scripts/lib/*`** — dependency-free single-responsibility helpers (`config-dir`, `token-math`, `model-window`, `time`, `transcript`, `snapshot`). `collect.mjs`/`report.mjs` hold the only I/O entry points.

**The core constraint that explains the whole design:** Claude Code pushes `context_window`, `rate_limits`, and `cost` **only to the statusline process via stdin**. A skill/command invoked by an agent gets **no stdin** — it can read only the transcript JSONL, which has per-message token `usage` but **no `rate_limits`**. Hence: the collector exists to capture stdin into a snapshot the report can later read, and the transcript fallback is context-only.

**Provenance is first-class.** Every reported number carries `source`, `rate_limits_status` (`available` / `unavailable_plan` / `unavailable_provider` / `unavailable_stale` / `unavailable_collector`), and `window_size_inferred`, so a consumer's rule never fires on a stale or estimated value. A stale-but-present snapshot is a distinct state from "collector never installed."

## Data-source facts (verified against live capture — don't re-derive)

These were confirmed by capturing a real session; the fixtures in `tests/fixtures/` encode them and guard against drift. **Do not replace the golden fixtures with synthesized data** — a made-up fixture only re-tests an assumption.

- Statusline **stdin** carries the real `context_window.context_window_size` (e.g. `1000000`) and `model.id` **with** the `[1m]` marker; `rate_limits.*.resets_at` is a Unix epoch in **seconds** (multiply by 1000 for ms).
- The **transcript** stores the **base** model id (`claude-opus-4-8`, *no* `1m` marker), so window size cannot be inferred from it. That is why the fallback reuses the snapshot's real `window_size` when any snapshot exists, and only *guesses* (flagged `window_size_inferred`) at true cold start.
- Native `context_window.used_percentage == 0` means "not yet populated" (fresh session, before the first API response) → fall through to token-based calc. Rate-limit `used_percentage: 0` stays a valid value.
- `tests/fixtures/real-stdin.json` and `tests/fixtures/real-transcript.jsonl` are redacted captures used as golden mapping tests (plan Tasks 6 & 8).

## Commands and toolchain

- **Runtime:** Node ESM (`.mjs`), **zero dependencies, no build step**. Requires Node 18+ (or Bun). Scripts run directly; there is no bundler, transpiler, or lint config by design.
- **Tests:** Node's built-in runner — `node --test` (the planned `package.json` `test` script). Single file: `node --test tests/<name>.test.mjs`. (These commands work once the plan's tasks scaffold `package.json` and create the `tests/*.test.mjs` files — none exist yet.)
- No network, no credential access; all tests are local-only.

## Conventions

- **Snapshot path:** `<config-dir>/claude-context/snapshot.json`, mode `0600`, where `<config-dir>` is `$CLAUDE_CONFIG_DIR` when set and non-empty, otherwise `~/.claude`. Writer and reader must resolve it identically.
- **Setup wiring** (`commands/setup.md`) is version-resilient and cross-platform (macOS/Linux, Git Bash, PowerShell). It only takes an **empty** `statusLine` slot; if one exists it backs it up and asks **replace-or-keep** — it never seizes the slot or chains another statusline command.
- **Docs commits go directly to `main`** (the repo's established convention; there is no build/CI gate on docs).

## The `claude-hud/` reference (gitignored, not shipped)

`claude-hud/` is a vendored reference checkout of an existing statusline plugin (MIT, © Jarrod Watts) — it is **reference only**, gitignored, and never a shipped component. It is the source of the borrowed `lib/` patterns and the setup command strings. When implementing, cross-check the real shapes in `claude-hud/src/{stdin,types,transcript,external-usage}.ts` and `claude-hud/commands/setup.md`. Note the key difference: claude-hud gets stdin because it *is* the statusline, so it never faces the "no stdin" problem — do not copy its assumption that the real window size is always available. Borrowed `lib/` files must carry an attribution header; claude-hud is acknowledged in the README and LICENSE.
