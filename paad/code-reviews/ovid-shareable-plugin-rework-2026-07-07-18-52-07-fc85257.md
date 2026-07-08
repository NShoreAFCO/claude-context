# Agentic Code Review: ovid/shareable-plugin-rework

**Date:** 2026-07-07 18:52:07
**Branch:** ovid/shareable-plugin-rework -> main
**Commit:** fc85257b454b69fc7599cea300d6528b097efac1
**Files changed:** 30 | **Lines changed:** +1127 / -146
**Diff size category:** Large (≈880 of the added lines are new design docs; the behavior-bearing code change is the ~110-line `report.mjs` rework plus the two manifests)

## Executive Summary

This branch does two things: (1) makes the collector **required** for all reporting — removing transcript-based window inference and the `model-window` module, and adding a third "not set up" state (`setup_required: true`) — and (2) relocates the shipped plugin under `plugins/claude-context/`, moving the marketplace `description`/`version` to the canonical top level and changing the plugin `source` from `./` to `./plugins/claude-context`. **Marketplace-install conformance was explicitly verified and PASSES**: `claude plugin validate .` and `claude plugin validate ./plugins/claude-context` both return "Validation passed" (exit 0, no warnings), and the layout matches the official spec on every checked point. All 66 tests pass.

The highest-severity finding is **[C1]**: in the new collector-idle (stale) branch, the report can size *this* session's transcript usage against *another* concurrent session's `window_size` and then stamp the result `session_selection: "session_id"` — a context percentage that can be ~5× wrong while its provenance claims certainty. This defeats the exact session-isolation guarantee the design is built around, and the test suite does not exercise the branch. One Important and two Suggestion-level findings follow, all around the report's degradation states.

## Critical Issues

### [C1] Stale branch sizes this session's transcript usage against a foreign snapshot's window, then labels it `session_selection: "session_id"`
- **File:** `plugins/claude-context/scripts/report.mjs:28-31, 74, 78-79, 91-113`
- **Bug:** When this session's own keyed snapshot is absent, `resolveReport` fills `read` from `findNewestSnapshot(dir)` — which, per its own doc (`lib/snapshot.mjs:47-49`), "may belong to another concurrent session" — and leaves `identified = false`. In the stale (collector-idle) branch, `knownWindow` is taken from that possibly-foreign snapshot (`:74`). Independently, `transcript = transcriptForSession(configDir, cwd, sessionId, deps)` (`:78`) resolves **this** session's own `<session-id>.jsonl` and unconditionally sets `transcriptSelection = 'session_id'`. The usage-bearing return then computes `used_percentage = percentage(used, knownWindow)` — this session's tokens ÷ the foreign window — and returns `sessionSelection: transcriptSelection` (= `'session_id'`) at `:109`. The `identified` flag, the one piece of state that records whether the window is actually this session's, is discarded on this path. (The FRESH branch at `:47` does it correctly: `identified ? 'session_id' : 'unverified-snapshot'`.)
- **Impact:** Reachable whenever a session has its own transcript but no own keyed snapshot yet (e.g. the collector was *just* enabled mid-session — now the required path — or collector-id vs report-id skew from a subagent/version mismatch) while a neighbor session's stale snapshot is the newest file in the dir. If the neighbor is a `[1m]` 1,000,000-token session and this session's real window is 200,000, this session's tokens are divided by 1,000,000 → a context percentage wrong by ~5×, emitted with `session_selection: "session_id"` and the human line `session: this session`. This makes the contract's core promise ("`session_id` means definitively yours; a rule never fires on a wrong-session value") lie about the precise number a documented consumer rule — "checkpoint before auto-compaction at N% context" — acts on. A too-low reading means that rule silently never fires.
- **Suggested fix:** Carry `identified` into the stale usage-branch's labeling instead of deriving it solely from transcript resolution. Concretely: only take the transcript-sizing path when `identified` is true (the window is known to be this session's); when `identified` is false, either fall through to the snapshot-context fallback (which already honestly reports `unverified-snapshot`) or emit `sessionSelection` as `unverified-snapshot`/`newest-in-cwd-heuristic`. The `used_percentage` must not be presented as certain when `knownWindow` came from `findNewestSnapshot`.
- **Confidence:** High (independently reproduced by two specialists; a third found the variant)
- **Found by:** Logic & Correctness (conf 90, reproduced live with a 5× error), Concurrency & State (conf 85, reproduced), Error Handling & Edge Cases (conf 63, no-usage-fallback variant)

> **Related variant (same class, narrower):** In the *no-usage* fallback return (`report.mjs:120-131`), `sessionSelection` correctly uses `identified`, but `compactions` (`:84`) may have been counted from `findNewestTranscript` (a possibly foreign transcript, `newest-in-cwd-heuristic`) while the return is stamped `session_id` when `identified` is true. Same label/value divergence. Fixing C1 by threading `identified`/transcript-provenance through both stale returns resolves this too. Also note the stale branch re-derives the transcript via the cwd heuristic even though the stale snapshot already carries the session-exact `transcript_path` the fresh branch trusts (`:36`) — using it would remove the wrong-session read at the source.

## Important Issues

### [I1] A corrupt or cross-version *newest* snapshot collapses the report to "not set up," telling an already-configured user to run setup
- **File:** `plugins/claude-context/scripts/report.mjs:28-31, 55-68`; root cause in `plugins/claude-context/scripts/lib/snapshot.mjs:50-63` (`findNewestSnapshot`) and `:65-77` (`readSnapshot`)
- **Bug:** `readSnapshot` returns `null` for any present-but-unparseable file (JSON.parse throws → catch at `:74`) or one whose `updated_at` is unparseable (`:69`). `findNewestSnapshot` returns only the single newest `snapshot*.json` by mtime — there is **no next-newest fallback**. So if the newest file is corrupt/truncated/zero-byte/hand-edited or written by an older build with a different schema, `read` stays `null` and control reaches `if (!read)` (`:55`) → the not-set-up state (`source: unavailable`, `setup_required: true`, `rate_limits_status: unavailable_collector`, `compactions: null`) — even though the collector *has* run and a valid older snapshot may sit right beside the bad one.
- **Impact:** Directly violates the invariant the code asserts in its own comment at `report.mjs:71` ("we must never tell an already-set-up user to run setup") and makes `setup_required: true` ("collector never installed") lie to a configured user. A consumer keying on `setup_required` would act on a false negative. Trigger is narrow — the atomic temp+rename write prevents torn reads from the current writer — which is why this is Important, not Critical; the realistic triggers are cross-version format drift and external corruption.
- **Suggested fix:** Have `findNewestSnapshot` yield candidates in mtime order so the resolver can try successive files until one parses, or distinguish "snapshot files exist but none parse" from "no snapshot files exist" and degrade the former to an unavailable-stale-style state rather than `setup_required: true`.
- **Confidence:** Medium (reproduced by two specialists with a truncated snapshot)
- **Found by:** Logic & Correctness (conf 68, reproduced), Error Handling & Edge Cases (conf 68, reproduced), Concurrency & State (conf 60)

## Suggestions

- **[S1] Collector discards `writeSnapshot`'s return; a persistent write failure is indistinguishable from a throttled no-op** — `collect.mjs:77` drops the boolean, and `lib/snapshot.mjs:34` (throttled no-op) and `:40-44` (genuine failure caught) both return `false`. On an unwritable FS (read-only, disk full, unwritable config dir) no snapshot is ever persisted, so the report is stuck in not-set-up indefinitely while the statusline keeps printing a healthy `compactLine` — no discovery path. Consider distinguishing failure from no-op (enum/throw) and surfacing a one-time stderr diagnostic. *(Error Handling, conf 62; environment-gated, and the swallow is partly intentional so the statusline never crashes Claude Code.)*
- **[S2] `compactions` is counted at report time while `context`/`rate_limits`/`cost` are from the snapshot's capture moment** — `report.mjs:36` (fresh) and `:84` (stale) re-read the transcript now, whereas the other fields may be up to `FRESHNESS_MS = 5min` old. A compaction landing after capture but before the report bumps `compactions` while `context.used_percentage` still shows the pre-compaction value; only `context` carries `snapshot_age_seconds`. Count is monotonic (no corruption). Either capture the count into the snapshot at write time, or document that `compactions` is intentionally report-current. *(Concurrency, conf 60; arguably a feature.)*

## Plan Alignment

Design/plan docs found and consulted: `docs/superpowers/specs/2026-07-07-collector-required-reporting-and-nested-layout.md` and `docs/superpowers/plans/2026-07-07-collector-required-reporting-and-nested-layout.md` (the newer collector-required/nested-layout pair governs this diff; the older baseline design/plan are historical per CLAUDE.md).

- **Implemented:** Three-state `resolveReport` with exact `source`/`rate_limits_status`/`setup_required` values; "not set up" performs zero transcript I/O (`compactions: null`, not 0); stale snapshot never emits `/claude-context:setup`; window inference + `model-window.mjs` + `tests/model-window.test.mjs` removed; `window_size_inferred` field fully gone (only survives as absence-guards in tests); `setup_required` always-present boolean; `COLD_START_HUMAN` block; plugin relocation under `plugins/claude-context/` with `LICENSE` copied in; marketplace `source`/metadata move + `0.2.0` bump + CHANGELOG entry; all test imports repointed; docs (CLAUDE.md/README.md/SKILL.md/CHANGELOG.md) synced to the new behavior.
- **Not yet implemented:** None — all plan Tasks 1–5 are present and committed.
- **Deviations:** None at confidence ≥60. One cosmetic spec-example-vs-code gap (the spec §2.2 abbreviated JSON example omits `snapshot_age_seconds: null` in the not-set-up state, but implementation-plan line 325 deliberately keeps the always-present provenance key) — plan-authorized, no action. No doc claims a behavior the code lacks, and no code behavior is undocumented.

## Marketplace / Plugin-Install Conformance (requested check)

Verified against https://code.claude.com/docs/en/plugin-marketplaces and the plugins reference. **Result: conforms; installable.**

- `claude plugin validate .` → **Validation passed** (exit 0); `claude plugin validate ./plugins/claude-context` → **Validation passed** (exit 0). No warnings.
- `.claude-plugin/marketplace.json`: required `name` (`claude-context`, kebab-case, not a reserved name), `owner.name` (`Ovid`), non-empty `plugins` array — all present. `description`/`version` are at the canonical top level (the spec's recommended form; `metadata.*` is only backward-compat).
- Plugin entry: required `name` + `source` present. `source: "./plugins/claude-context"` starts with `./`, contains no `..`, and resolves (relative to the marketplace root, not `.claude-plugin/`) to a directory that **does** contain `.claude-plugin/plugin.json` — so install will copy a valid plugin tree.
- **No double-version pitfall:** the plugin *entry* has no `version` key; only the top-level marketplace-manifest `version` (`0.2.0`) and `plugin.json` `version` (`0.2.0`) exist, and those are distinct fields.
- `plugin.json`: has the only required field (`name`). Root `SKILL.md` + no `skills/` subdir + no `skills` manifest field → auto-loads as the single skill, invoked `/claude-context:claude-context` (requires Claude Code v2.1.142+). `commands: ["./commands/setup.md"]` points into the default `commands/` folder → loads with no warning.
- **No `../` escapes:** every `import` in the shipped `scripts/**` is a `node:` builtin or a `./lib/...` sibling; `SKILL.md` uses `${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs` and `setup.md` resolves `collect.mjs` from the plugin cache dir — all inside the copied tree. Nothing the plugin references at runtime lives outside `plugins/claude-context/`, so the install-copies-only-the-source-dir rule is satisfied. `.claude-plugin/` contains only `plugin.json`.

*(Optional, non-blocking: the single-skill auto-load requires Claude Code ≥ 2.1.142; if you want to support older clients you could add `"skills": ["./"]` to `plugin.json`, but this is not required for conformance.)*

## Review Metadata

- **Agents dispatched:** Logic & Correctness; Error Handling & Edge Cases; Contract & Integration (+ marketplace-install conformance); Concurrency & State; Security; Plan Alignment; plus a single Verifier pass.
- **Scope:** `plugins/claude-context/scripts/report.mjs` (the behavior change) and its callees `scripts/lib/{snapshot,transcript,token-math,config-dir,time}.mjs` and `scripts/collect.mjs`; the manifests `.claude-plugin/marketplace.json` and `plugins/claude-context/.claude-plugin/plugin.json`; `plugins/claude-context/{SKILL.md,commands/setup.md}`; behavior-bearing tests (`report.test.mjs`, `report-integration.test.mjs`, `manifest.test.mjs`); removed `scripts/lib/model-window.mjs` + `tests/model-window.test.mjs`; docs (CLAUDE.md, README.md, CHANGELOG.md).
- **Raw findings:** 8 (across specialists, pre-dedup/verify)
- **Verified findings:** 4 (1 Critical, 1 Important, 2 Suggestion)
- **Filtered out / merged:** 4 (duplicate reports of the same two defects across three specialists were merged; 0 rejected as false positives)
- **Steering files consulted:** CLAUDE.md, `plugins/claude-context/SKILL.md`, README.md (no stale-contradiction findings — docs match the code)
- **Plan/design docs consulted:** `docs/superpowers/specs/2026-07-07-collector-required-reporting-and-nested-layout.md`, `docs/superpowers/plans/2026-07-07-collector-required-reporting-and-nested-layout.md`

## Model Attribution

- **Orchestrator:** claude-opus-4-8[1m] (source: system-prompt)
- **Specialists:**
  - Logic & Correctness: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Error Handling & Edge Cases: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Contract & Integration + conformance: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Concurrency & State: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Security: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Plan Alignment: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
  - Verifier: inherit<claude-opus-4-8[1m]> (source: dispatched+inherited)
- **Probe time:** 2026-07-07T16:38:20Z

## Resolution (2026-07-07)

Each finding was verified against the code before acting. All 70 tests pass (was 66).

- **[C1] FIXED** — Root-cause fix, not just the label: the stale branch now sizes usage
  and counts compactions from the snapshot's OWN `transcript_path` (as the fresh branch
  already does), so `window_size`, `used_tokens`, and `compactions` always describe the
  same session; `session_selection` follows `identified`. This removes the cross-session
  read at its source and resolves the related variant too. `sourceLine` now renders the
  `unverified-snapshot` provenance the branch can emit. Added an integration test that
  drives `resolveReport` through the branch (the previously-untested path). *Commit: fix
  stale-branch usage from the snapshot's own transcript.*
- **[I1] FIXED** — Added `listSnapshotsByMtime` (candidates newest-first); the resolver
  now tries each until one parses, so a corrupt/cross-version newest file is skipped in
  favor of a valid older one instead of collapsing a set-up user to "not set up".
  `findNewestSnapshot` delegates to it. Tests cover ordering and corrupt-newest recovery.
  *Commit: skip a corrupt newest snapshot instead of reporting not-set-up.*
- **[S2] DOCUMENTED** — `compactions` being report-current is intentional (a monotonic
  count the report can always obtain without a window). Documented in-code as the
  reviewer's own suggested resolution. *Commit: note compactions is report-current.*
- **[S1] FIXED (maintainer chose the statusline-marker option)** — After surfacing the
  design trade-off (the collector is a fresh process per ~300ms tick, any durable marker
  needs the writable FS that is failing, and stderr visibility is unspecified), the
  maintainer chose the visible statusline channel. `runCli` now checks whether a snapshot
  was actually persisted at the keyed path after the write; if not — the exact condition
  that leaves the report stuck at "not set up" — it appends a factual ` · snapshot not
  saved` marker to the compact line. A throttle no-op leaves the prior file in place, so
  `existsSync` stays true and the marker is silent. It states a fact, not advice, so the
  "instrument, not advisor" contract holds. Tests cover both the failure marker and the
  silent success path. *Commit: flag a genuine snapshot-write failure in the statusline.*
