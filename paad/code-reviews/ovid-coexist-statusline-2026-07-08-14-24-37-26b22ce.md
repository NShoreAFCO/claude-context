# Agentic Code Review: ovid/coexist-statusline

**Date:** 2026-07-08 14:24:37
**Branch:** ovid/coexist-statusline -> main
**Commit:** 26b22ce97280c3e75cbd169798014f888ec1019e
**Files changed:** 25 | **Lines changed:** +3359 / -177
**Diff size category:** Large (but ~2085 lines are design/plan docs; the code surface is ~440 lines across 6 source files)

## Executive Summary

The co-existing-statusline feature is well-designed and unusually well-tested — 116/116 tests pass, the design spec's ten guarantees are all implemented, and the report engine is genuinely untouched (co-existence yields a normal collector snapshot). **No Critical issues** were found. The confirmed findings cluster in two areas: **secret exposure** (the preview redactor misses several common secret shapes, and the runtime path is command-injectable into the persisted statusline command) and **failure-mode hygiene in the wiring module** (a bad-runtime wrap leaves stray files, an orphaned sidecar can wedge setup/teardown with no documented recovery, and the wrapper's stdin read is unguarded). The highest-profile specialist finding — an exit-code race in `coexist.mjs` — was **empirically rejected as a live bug on Node** (750/750 real trials propagated the correct exit code) but is retained as a hardening suggestion for the unverified Bun path.

## Critical Issues

None found.

## Important Issues

### [I1] Preview redactor leaks common secret shapes into the agent transcript
- **File:** `plugins/claude-context/scripts/lib/redact.mjs:3-13`
- **Bug:** `redactSecrets` masks `Bearer …`, `sk-…`, `gh[pousr]_…`, and label-abutted `key/token/secret/password=value`, but passes through AWS access-key ids (`AKIA…`), `AWS_SECRET_ACCESS_KEY=…` (the `_` before `SECRET` defeats the `\bsecret\b` word boundary), basic-auth URLs (`https://user:pass@host`), JWTs (`eyJ…`), and generic unlabeled tokens. Verified by running the function against 10 sample shapes.
- **Impact:** `detect().preview` / `storedOriginalPreview` (`wiring.mjs:52,55,155,222`) are printed and shown to the user in `setup.md` Steps 2–3, so they reach the transcript. `setup.md` and the design spec explicitly promise the raw command is redacted "inside the module" so it "never reaches this transcript." A user whose *foreign* statusline command embeds such a secret inline has it disclosed in full at setup time.
- **Suggested fix:** Add patterns for `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z_-]{35}`, JWT (`eyJ[…].[…].[…]`), `://user:pass@` (mask the password segment), Slack `xox[baprs]-…`, and a generic high-entropy fallback; loosen the label rule to tolerate `_`-joined names like `AWS_SECRET_ACCESS_KEY`. (Redaction is best-effort by design, so over-redaction is acceptable.)
- **Confidence:** High
- **Found by:** Security (verified empirically)

### [I2] Runtime path is command-injectable into the persisted statusline command
- **File:** `plugins/claude-context/scripts/lib/command.mjs:29` (build) + `:21-23` (`shSingleQuote`)
- **Bug:** `shSingleQuote` escapes the *outer* `bash -c '<body>'` layer, but `runtime` is embedded as `exec "${runtime}"` inside **inner** bash double-quotes, where `$( )`, backticks, and `${}` are still evaluated. `buildStatuslineCommand` only checks `runtime` is a non-empty string. Verified: building a command with `runtime = '$(touch …/PWNED)'` and executing it via `bash -c` **created the marker file** — the substitution fires, and would re-fire at every ~300ms refresh since the command is persisted in `settings.json`.
- **Impact:** A confirmed injection primitive. **Threat-model caveat:** `runtime` is resolved by `command -v bun/node` from the user's own PATH, so in a normal install it is a trusted binary path with no metacharacters — this is hardening / defense-in-depth, real only if the resolved path is attacker-influenced or contains shell metacharacters. Hence Important, not Critical.
- **Suggested fix:** Reject `runtime` containing any of `` $ ` " \ ' `` (or single-quote it at the inner level too, e.g. `exec '<sq-escaped-runtime>'`).
- **Confidence:** High (mechanism) / caveated exploitability
- **Found by:** Security (verified empirically)

### [I3] Unguarded stdin read can blank the user's original statusline
- **File:** `plugins/claude-context/scripts/coexist.mjs:53, 105-108`
- **Bug:** `const input = await readInput();` (line 53) is not wrapped, and the entry point `process.exit(await runCoexist())` (105-108) has no guard. If `process.stdin` emits an `'error'` event, the top-level await rejects → unhandled rejection → the process exits non-zero **before the child is spawned**, so the wrapped original statusline produces no output for that refresh. `collect.mjs:91-95` guards the identical read; `wiring.mjs:235-246` wraps its whole CLI body — `coexist.mjs`, the one piece whose pre-spawn failure breaks the user's display, does neither.
- **Impact:** Directly violates the design's stated fail-safe goal ("the only way to break the user's tool is a crash in the wrapper before step 2"). Impact is transient (the next ~300ms tick recovers) and stdin `'error'` is rare, so Important rather than Critical.
- **Suggested fix:** `let input=''; try { input = await readInput(); } catch {}` and/or wrap the isMain call: `try { process.exit(await runCoexist()); } catch { process.exit(0); }`.
- **Confidence:** Medium-High
- **Found by:** Error Handling (verified by reading; contrasted against the guarded siblings)

### [I4] Bad-runtime foreign wrap leaves a stray sidecar + backup; atomic writers leak temp files on failure
- **File:** `plugins/claude-context/scripts/wiring.mjs:158-171` (ordering); `:65-76, 78-93, 95-103` (temp cleanup)
- **Bug:** On a **foreign** slot, `wrap` runs `backupOnce` → `writeSidecarAtomic` → then `buildStatuslineCommand({variant, runtime, platform})` inside the settings write — and `buildStatuslineCommand` throws on a missing/blank `runtime` (`command.mjs:27`) *after* the backup and sidecar are already on disk. Verified by running `wrap` on a foreign slot with `--runtime` omitted: it returned `{"action":"error","reason":"runtime required"}` yet left behind both `coexist.json` and `settings.json.claude-context.bak`. The existing "missing --runtime" test only exercises the **empty**-slot path (no settings.json → no backup/sidecar), so it never catches this. Separately, `writeSettingsAtomic`/`writeSidecarAtomic`/`backupOnce` never `unlink` their `.tmp` on a rename/chmod failure, unlike `snapshot.mjs:56-63`.
- **Impact:** The stray sidecar directly feeds [I5]'s wedge if the user later changes their statusline. Orphaned temp files can accumulate in the config dir on a flaky FS.
- **Suggested fix:** Build/validate the command string up front (before any write); unlink the temp in a `catch` on each atomic writer.
- **Confidence:** Medium-High (both parts verified — part 1 by running, part 2 by reading)
- **Found by:** Error Handling

### [I5] An orphaned sidecar that differs from the slot wedges setup and teardown with no in-tool recovery
- **File:** `plugins/claude-context/scripts/wiring.mjs:146-157` (wrap), `:218-223` (teardown)
- **Bug:** If a stale `coexist.json` exists and the current slot holds a *different* foreign command: `wrap` returns `conflict` (no write, stops) and `teardown` returns `not-ours` and does **not** remove the sidecar (only the three ours-marker teardown paths delete it). No command clears an orphan sidecar, and neither `setup.md`'s `conflict` bullet nor `teardown.md`'s `not-ours` bullet tells the user where the file is or to delete it.
- **Impact:** The *refusal* is correct and safe per spec §3.7 (no data loss), but it is a genuine dead-end: co-existence setup is permanently blocked until the user manually finds and `rm`s an undocumented file. Combined with [I4], a single interrupted/bad-runtime wrap can create exactly this stale sidecar.
- **Suggested fix:** Have the `conflict`/`not-ours` paths surface the sidecar path and offer (or document) a recovery action to clear an orphan that no longer matches the live slot.
- **Confidence:** Medium
- **Found by:** Error Handling

## Suggestions

- **[S1] `coexist.mjs:99-102` — attach `close`/`error` listeners synchronously right after `spawn`, before `await loadSnapshotLib()`.** Not a live bug on Node (750/750 real trials propagated exit 3, zero hangs — the disputed race is rejected), but the safety depends on ESM-loader internals and is **UNVERIFIED on Bun**, the runtime `setup.md` prefers on macOS/Linux. The fix is trivial and makes it structurally race-free. *(Found by Logic + Concurrency; adjudicated by empirical verification.)*
- **[S2] `command.mjs:6-18` vs `setup.md:55` vs `teardown.md:13` — single-source the plugin-dir resolution glob.** It is triplicated; the POSIX forms are byte-identical, but `command.mjs`'s Git Bash branch (`sort -V`, unfiltered) omits the `^[0-9]+\.[0-9]+\.[0-9]+` semver filter the docs use, so on Git Bash a non-semver cache dir could make the wired statusline and the setup/teardown commands resolve different plugin versions. *(Contract)*
- **[S3] `wiring.mjs:73, 92` and `snapshot.mjs:53` — wrap the post-rename `chmodSync` in try/catch.** It runs after the atomic `renameSync` commit; a chmod failure currently propagates and reports `{action:"error"}` on an already-successful write (and `setup.md` says not to retry). The mode is already applied at temp-write time, so the trailing chmod is a best-effort umask-defeat. *(Error Handling)*
- **[S4] `wiring.mjs:19-24, 132-134` — classify a `statusLine` that lacks a string `.command` as foreign, not empty.** Today `currentCommand`→null→`classify`→`'empty'`→`setVariant('collect')` overwrites the whole `statusLine` with no sidecar (seizing a slot). Also `readJson` doesn't verify a plain object, so a bare-string `settings.json` would corrupt via `{...base}`. Low reachability (Claude Code always emits a string `.command`) and the full-file `.bak` is a net, but it violates "never seize a slot it doesn't own." *(Error Handling)*
- **[S5] `marker.mjs:15-16` — anchor `detectMarker`'s substring match.** `command.includes('…=coexist')` also matches `…=coexistence`, and `…=collect` matches `…=collector`, which would be claimed as ours. Near-zero real trigger (the var is namespaced), but the match is genuinely unanchored: use e.g. `/CLAUDE_CONTEXT_WRAPPER=(coexist|collect)(?![A-Za-z0-9_])/`. *(Error Handling)*
- **[S6] `coexist.mjs:7-11, 36-42` duplicate `readStdin`/`parse` from `collect.mjs:75-79, 91-95`.** Both are stdin-driven by Claude Code and must behave identically; extract into a dependency-free `lib/stdin.mjs`. *(Contract)*
- **[S7] `wiring.mjs:59-61` (`ensureDir`) — defensively re-chmod an existing sidecar dir to `0700`, as `snapshot.mjs:41-45` does.** `mkdirSync({mode:0o700})` only applies to dirs it creates; an existing loose-mode dir stays that way. Content is still protected by the `0600` file. *(Security note)*
- **[S8] `wiring.mjs:65-76` — `backupOnce` re-reads `settings.json` from disk rather than reusing the already-read `base`.** Two concurrent `/setup` runs on one config dir can interleave so the `.bak` ends up holding the wrapper instead of the user's original. Bounded: teardown restores from the *sidecar*, not the `.bak`, and the trigger is two racing manual setups (not the hot path). *(Concurrency; verified by reasoning, not deterministically reproduced.)*

## Plan Alignment

Design spec `docs/superpowers/specs/2026-07-08-claude-context-coexist-statusline-design.md` and plan `docs/superpowers/plans/2026-07-08-claude-context-coexist.md` were consulted.

- **Implemented:** All ten spec guarantees are reflected in code and backed by passing tests — marker-only ownership (§3.3), snapshot written after spawn without awaiting exit (§3.4), runtime-failed original passes through transparently (§3.4), exactly one `0600` full-file backup before the first write and removed on clean teardown (§3.5/§3.8), fresh-foreign sidecar-before-settings ordering (§3.5/§3.7), orphaned-sidecar detection (§3.7), never-clobber-unowned teardown (§3.6), native-PowerShell makes no settings change (§3.3/§3.5), report engine unchanged — `report.mjs` is not in the diff (§4/§7), and the locked `detect`/`wrap`/`teardown` return shapes match `wiring.mjs` exactly.
- **Deviations:** None found at confidence ≥ 60.
- **Not yet implemented (deferred by design — expected, not defects):** native PowerShell/cmd support of any kind (incl. the `.cmd` materialization); removal of the 0.2.0 empty-slot native-PowerShell collector (done and documented as an explicit regression); Part B model-window fallback (dropped in review §8).

## Review Metadata

- **Agents dispatched:** Logic & Correctness; Error Handling & Edge Cases; Contract & Integration; Concurrency & State; Security; Plan Alignment; plus a single Verifier.
- **Scope:** Changed code — `coexist.mjs`, `wiring.mjs`, `lib/{command,marker,redact,config-dir}.mjs`; changed commands/docs — `setup.md`, `teardown.md`, `plugin.json`, `marketplace.json`, `package.json`, README/CHANGELOG/CLAUDE.md; adjacent callees read for contract — `collect.mjs`, `lib/snapshot.mjs`; new/modified tests — `tests/{coexist,wiring,command,marker,redact,config-dir,setup,manifest,docs}.test.mjs`.
- **Raw findings:** 13 (across five bug-hunting lenses; Plan Alignment found 0 deviations)
- **Verified findings:** 13 surfaced (5 Important + 8 Suggestions)
- **Filtered out:** the `coexist.mjs` exit-code race as a *live Node bug* (rejected on 750/750 empirical trials; retained only as hardening suggestion [S1] for the unverified Bun path), and a `writeSettingsAtomic` mode-widening concern (rejected — it preserves and never widens an existing mode).
- **Steering files consulted:** `CLAUDE.md` (no contradictions with the code; the "0600 in a 0700 dir" claim is accurate for files but only defensively enforced for the snapshot dir, not the sidecar dir — see [S7]).
- **Plan/design docs consulted:** the co-exist design spec and implementation plan under `docs/superpowers/`.

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
- **Probe time:** 2026-07-08T12:00:57Z
