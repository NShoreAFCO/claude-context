# Agentic Code Review: ovid/shareable-plugin-rework

**Date:** 2026-07-07 23:17:17
**Branch:** ovid/shareable-plugin-rework -> main
**Commit:** 2abbed01723dd493a7224089cdaef8386b70cb48
**Files changed:** 31 | **Lines changed:** +1411 / -178
**Diff size category:** Large (≈994 of the +1411 lines are new design/plan/review docs; the actual code surface is small)

## Executive Summary

The branch does two things: (1) relocates the shipped plugin under `plugins/claude-context/` (marketplace `source` → `./plugins/claude-context`, version 0.1.0 → 0.2.0), and (2) reworks `report.mjs` into a "collector-required" three-state engine — deleting the old window-size guesser (`model-window.mjs` / `window_size_inferred`), adding `setup_required`, and (via the C1 fix) pairing the stale-path window with the snapshot's *own* transcript so context % is never a cross-session mismatch. The work is well-implemented and green (72/72 tests pass). **No correctness, security, or concurrency bugs were found.** The single Important finding is a documentation/contract drift: SKILL.md still advertises a `session_selection` value (`newest-in-cwd-heuristic`) that this branch's C1 rework made unreachable, and instructs consumers to gate on it. Everything else is low-impact cleanup or doc-accuracy.

## Critical Issues

None found.

## Important Issues

### [I1] `session_selection: "newest-in-cwd-heuristic"` is documented and gated-on, but the code can no longer emit it
- **File:** `plugins/claude-context/SKILL.md:64-70` (and `CLAUDE.md:34`) vs `plugins/claude-context/scripts/report.mjs:59,76,89`
- **Bug:** SKILL.md documents three `session_selection` values and explicitly tells consumers *"Gate on this when it matters that the context figures are your session's and not a neighbor's,"* listing `newest-in-cwd-heuristic` as the lowest-trust value. But after the C1 rework, `resolveReport` only ever assigns `session_id` (`:59`), `unverified-snapshot` (`:89`, flowing to the stale returns), or `null` (`:76`, omitted from JSON). `newest-in-cwd-heuristic` is never assigned anywhere in production.
- **Impact:** An agent that follows SKILL.md and branches on `session_selection === "newest-in-cwd-heuristic"` writes dead policy — a condition that can never be true. The shipped, consumer-facing JSON enum no longer matches `buildJson`'s real output. This is a contract the plugin's whole "instrument, not advisor" premise depends on being accurate.
- **Suggested fix:** Remove `newest-in-cwd-heuristic` from the SKILL.md `session_selection` field reference and from the `CLAUDE.md` provenance enum. (If a genuinely-unverified transcript-derived reading is still intended as a distinct state, re-introduce the value in the resolver instead — but the C1 fix deliberately removed that path, so deleting the docs is the aligned choice.)
- **Confidence:** High (CONFIRMED)
- **Found by:** Contract & Integration (80), Plan Alignment (75), corroborated by Logic & Correctness

## Suggestions

- **[S1] S1 "· snapshot not saved" marker is masked by a stale file** — `plugins/claude-context/scripts/collect.mjs:79-87` + `lib/snapshot.mjs:26-44`. The marker fires only on `!existsSync(snapPath)`, so it catches only cold-start (first-ever) write failure. If a prior run wrote a snapshot and the FS then goes read-only, every `writeSnapshot` throws → returns `false`, but the stale file keeps `existsSync` true, so the statusline prints a healthy line indefinitely. `writeSnapshot`'s `false` also conflates "throttle-skipped" with "failed," so wiring its return value in wouldn't disambiguate without a tri-state signature. Backstopped programmatically by the report's `unavailable_stale` after the 5-min freshness window — only a human glancing at the statusline is misled. Fix: return `'written' | 'skipped' | 'failed'` from `writeSnapshot` and show the marker on `'failed'` regardless of `existsSync`. (Contract note: this is a partial gap in the very feature commit e7f71c5 added.) *Confidence: Medium.*
- **[S2] Dead code from the C1 rework** — `plugins/claude-context/scripts/lib/transcript.mjs:11,62,69` (`encodeProjectDir`, `findNewestTranscript`, `transcriptForSession`) have no production caller (only tests + historical plans reference them); and `report.mjs:265`'s `let sess = 'newest-in-cwd (heuristic)'` default in `sourceLine` is unreachable because the `source: 'transcript'` branch always overwrites it with `session_id`/`unverified-snapshot` at `:266-267`. Shares the C1 root cause with I1 but is a distinct (code vs. docs) artifact. Remove the dead exports/default (and their now-orphaned tests) or document them as intentionally-retained library surface. *Confidence: High.*
- **[S3] Version drift in `package.json`** — root `package.json:3` is still `0.1.0` (with the old description) while `plugin.json:3` and `marketplace.json:5` are `0.2.0`. `package.json` is `private: true` and is not consumed by the marketplace/installer, so install is unaffected — cosmetic, but nothing catches the drift. Bump it to `0.2.0` (and align the description), or add a test asserting the three agree. *Confidence: Medium.*
- **[S4] Duplicated numeric guards** — `numOrNull` is byte-identical in `report.mjs:11` and `collect.mjs:10`; `num` is duplicated in `collect.mjs:8` and `transcript.mjs:6`, while `lib/token-math.mjs` is the intended shared numeric module. The null-vs-0 semantics are load-bearing (report uses `numOrNull`, collect uses `num`→0), so divergent edits could silently split how a missing value is encoded across the snapshot seam. Hoist into a shared helper. (Previously noted and accepted in an earlier review.) *Confidence: Medium.*
- **[S5] Spec non-goal is now inaccurate** — `docs/superpowers/specs/2026-07-07-collector-required-reporting-and-nested-layout.md:226-229` (§8) states `collect.mjs` "is untouched," but this branch added the S1 marker to it (+15 lines, commit e7f71c5). Low severity: per CLAUDE.md, `docs/superpowers/` are historical records where "the code wins." Correct the non-goal or leave a note. *Confidence: Medium.*

## Plan Alignment

Plan/spec docs found for this branch: `docs/superpowers/specs/2026-07-07-collector-required-reporting-and-nested-layout.md` and `docs/superpowers/plans/2026-07-07-collector-required-reporting-and-nested-layout.md`.

- **Implemented:** the 3-state collector-required model (`resolveReport`), `window_size_inferred` + `model-window.mjs` removal, `setup_required` field, cold-start human block, nested `plugins/claude-context/` layout, marketplace `source`/metadata-to-top-level move, version bump to 0.2.0, snapshot robustness (I1 corrupt-newest skip via `listSnapshotsByMtime`), and the synced README/CLAUDE.md/SKILL.md. All confirmed against code; suite green (72 pass).
- **Not yet implemented:** nothing material — plan Tasks 1–5 are all reflected in the diff. (Plan-file checkboxes remain unticked, but that is bookkeeping.)
- **Deviations:** (a) the docs still describe `newest-in-cwd-heuristic` — see **[I1]**; (b) the shipped code went beyond the plan's literal Step-6 listing by dropping the cwd transcript heuristic and the `resolveReport` `cwd` param (a correct, C1-driven refinement — "code wins"); (c) the spec's §8 non-goal that `collect.mjs` is untouched is now false — see **[S5]**.

## Review Metadata

- **Agents dispatched:** Logic & Correctness; Error Handling & Edge Cases; Contract & Integration; Concurrency & State; Security; Plan Alignment (+ one Error-Handling re-dispatch after the first instance returned no tool activity)
- **Scope:** changed code (`report.mjs`, `collect.mjs`, `lib/snapshot.mjs`) + unchanged callees traced one level deep (`lib/{config-dir,token-math,time,transcript}.mjs`), manifests (`marketplace.json`, `plugin.json`, `package.json`), `commands/setup.md`, and the shipped docs (`SKILL.md`, `README.md`, `CLAUDE.md`)
- **Raw findings:** 6 (after specialist dedup) — plus several explicitly-dismissed sub-threshold notes (Windows rename contention, `snapshot-unknown.json` collision, past-reset `rlLine` string, unvalidated `transcript_path` read)
- **Verified findings:** 6 (all CONFIRMED)
- **Filtered out:** 0 confirmed-false, but 5 of 6 downgraded to Suggestion during verification; no Critical survived
- **Steering files consulted:** `CLAUDE.md` (with staleness caveat — I1/S2/S5 are contradictions between it/SKILL.md/spec and the code)
- **Plan/design docs consulted:** `docs/superpowers/specs/2026-07-07-collector-required-reporting-and-nested-layout.md`, `docs/superpowers/plans/2026-07-07-collector-required-reporting-and-nested-layout.md` (+ the historical `2026-07-07-claude-context*` spec/plan)

## Model Attribution

- **Orchestrator:** claude-opus-4-8[1m] (source: system-prompt)
- **Specialists:**
  - Logic & Correctness: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Error Handling & Edge Cases: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Contract & Integration: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Concurrency & State: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Security: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Plan Alignment: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Verifier: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
- **Probe time:** 2026-07-07T21:00:56Z
