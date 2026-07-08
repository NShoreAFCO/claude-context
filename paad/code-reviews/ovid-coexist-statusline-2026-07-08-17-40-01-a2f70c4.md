# Agentic Code Review: ovid/coexist-statusline

**Date:** 2026-07-08 17:40:01
**Branch:** ovid/coexist-statusline -> main
**Commit:** a2f70c4fa2e59b66923d30989e18a8f1cc37e6ae
**Files changed:** 30 | **Lines changed:** +4152 / -189
**Diff size category:** Large (production surface ~600 lines of `.mjs` + ~280 lines of command markdown; remainder is docs + tests)

## Executive Summary

The co-existence rewrite is well-engineered and heavily hardened — the command-injection defense in `command.mjs` is solid, the atomic-write/backup ordering is sound, and 145 tests pass. Review surfaced **one Critical data-loss bug**: `/teardown`, in the "coexist marker but no sidecar" branch, deletes the one backup that still holds the user's original statusline (independently flagged by two specialists, reproduced end-to-end, and the existing test masks it with a `{}` placeholder). Six Important issues follow: three credential-redaction gaps that leak secrets into the setup-preview transcript, and three runtime/launch-correctness regressions around the `bun` runtime and the Git Bash version glob. Confidence is high — every finding was reproduced by running code, and none were rejected in verification.

## Critical Issues

### [C1] `/teardown` destroys the user's last recoverable copy of the original statusline
- **File:** `plugins/claude-context/scripts/wiring.mjs:285` (the `coexist-no-sidecar-removed` branch, lines 277–286)
- **Bug:** When the slot still carries the `coexist` marker but `readSidecar()` returns null (sidecar file missing / unparseable / `original` absent), teardown strips our `statusLine`, deletes the sidecar, and then unconditionally deletes the backup (`removeIfPresent(backupPath(env), deps)`). But `settings.json.claude-context.bak`, written by the original fresh-foreign `wrap()`, is a **verbatim copy of the pre-setup `settings.json` — it contains the user's original foreign `statusLine`**. Once the sidecar is lost, the backup is the sole remaining record of the original; this branch deletes it.
- **Impact:** Permanent, unrecoverable loss of the user's statusline configuration. After the branch runs, the original exists in neither `settings.json` (stripped), the sidecar (gone), nor the backup (deleted). Reproduced end-to-end: real foreign command `wrap()`'d → sidecar removed → `teardown` → `ORIGINAL recoverable from any file? false`. This directly violates the plugin's "never lose the user's original / fail safe" invariant. The comment at line 277 ("nothing to restore") and the `teardown.md:28` message ("the stored original was missing… Nothing else to restore") are both wrong — the backup *was* the thing to restore.
- **Trigger:** Foreign statusline `O` → `/setup` (writes backup=`O`, sidecar=`O`, wrapper) → sidecar becomes corrupt or is deleted (disk corruption, partial write, or a user `rm`-ing `coexist.json` per the recovery guidance the setup/teardown docs themselves give in adjacent flows) → `/teardown` hits this branch → backup deleted → `O` gone forever.
- **Suggested fix:** In the no-sidecar branch, do **not** delete the backup. Safest minimum: leave it in place and surface its path in the returned action (as the `not-ours` branch already does with `sidecarPath`), telling the user it holds their original. Alternatively, extract just `statusLine` from the backup and write it back. Do **not** restore the whole backup file — that would revert unrelated `settings.json` edits made after wrap.
- **Confidence:** High (95; reproduced end-to-end)
- **Found by:** Error Handling & Edge Cases + Concurrency & State (both independently)
- **Test note:** `tests/wiring.test.mjs:410` asserts the deletion is intended, but seeds the backup with the placeholder `'{}'`, so it never exercises the real-original-loss case — the assertion currently protects the bug. A fix must update this test to seed a real original and assert it survives (or is surfaced).

## Important Issues

### [I1] Git Bash version glob can launch an *older* plugin version
- **File:** `plugins/claude-context/scripts/lib/command.mjs:11` (the `gitbash` branch of `globExpr`)
- **Bug:** The gitbash branch resolves the newest plugin dir with `… | sort -V | tail -1`, where `sort -V` compares the **whole path line** `<config>/plugins/cache/<cache-id>/claude-context/<version>/`. Because `<cache-id>` precedes `<version>`, when two or more cache-id dirs each contain a `claude-context/<version>/`, `sort -V` orders by cache-id, not version. The POSIX branch (and the copies in `setup.md`/`teardown.md`) instead extract the version field via `awk -F/` and sort numerically on it — so the two platforms diverge.
- **Impact:** On Git Bash with claude-context cached under more than one cache-id (a re-added/renamed marketplace, or install from two sources), the statusline command persisted into `settings.json` launches whichever version sits under the lexically-largest cache-id, which may be older than the one `/setup`/`/teardown` resolve. Silent wrong-version launch + a POSIX-vs-gitbash inconsistency. Reproduced: `sort -V` on `.../ZZZ/.../0.9.0/` + `.../AAA/.../0.10.0/` picks `0.9.0`; the awk version-field sort picks `0.10.0`.
- **Suggested fix:** Make the gitbash branch extract and numerically sort the version segment, mirroring the POSIX branch (`awk -F/ '{print $(NF-1) "\t" $0}'` + version sort + `cut -f2-`).
- **Confidence:** High (85; divergence proven, gated on the uncommon multi-cache-id state)
- **Found by:** Logic & Correctness

### [I2] `bun` `--env-file /dev/null` guard dropped in the refactor to `command.mjs`
- **File:** `plugins/claude-context/scripts/lib/command.mjs` (body construction, ~line 35)
- **Bug:** `main`'s `setup.md:40` wired bun as `exec "{RUNTIME}" --env-file /dev/null …collect.mjs` specifically to stop bun auto-loading the project's `.env`. The new `buildStatuslineCommand` treats `runtime` as an opaque string and emits `exec 'bun' "${plugin_dir}scripts/coexist.mjs"` with **no `--env-file`**. `setup.md:35-36` still prefers bun on macOS/Linux (`command -v bun … || command -v node`), so a bun runtime really does reach `command.mjs`.
- **Impact:** bun auto-loads the project's `.env`/`.env.local` (cwd = project dir) on every ~300ms statusline tick. A project `.env` containing `CLAUDE_CONFIG_DIR=…` redirects the collector's snapshot dir, so `report.mjs` (a separate process) resolves the default `~/.claude/claude-context/`, finds nothing, and reports `setup_required: true` despite a healthy running collector. More broadly, arbitrary project secrets / `NODE_OPTIONS` from `.env` leak into the statusline process and any wrapped-original child it spawns. Regression from `main`.
- **Suggested fix:** In `command.mjs`, when the runtime basename is `bun`, insert `--env-file /dev/null` before the script arg (runtime can no longer be fully opaque — special-case bun, or always neutralize `.env`). Add a test for a bun runtime.
- **Confidence:** High (85; all three sub-claims verified)
- **Found by:** Contract & Integration

### [I3] `setup.md` invokes `wiring.mjs` with hardcoded `node`, but resolves the runtime preferring `bun`
- **File:** `plugins/claude-context/commands/setup.md:48` (`node "{PLUGIN_DIR}scripts/wiring.mjs" detect`) and `:89` (`node "…/wiring.mjs" wrap …`)
- **Bug:** Step 1 (`setup.md:36`) resolves `{RUNTIME_PATH}` as `command -v bun … || command -v node` (bun wins if present) and aborts only if *neither* exists. Steps 2 and 4 then invoke the wiring module with a literal `node`, not `{RUNTIME_PATH}`.
- **Impact:** On a bun-present / node-absent machine, Step 1 succeeds (bun found), then Step 2's `node "…/wiring.mjs" detect` fails with command-not-found — setup breaks even though bun is advertised as a supported runtime. Masked whenever both runtimes exist. Recoverable (install node), hence Important not Critical.
- **Suggested fix:** Use `"{RUNTIME_PATH}" "{PLUGIN_DIR}scripts/wiring.mjs" …` in Steps 2 and 4 (wiring.mjs is pure `node:` ESM and runs fine under bun), or make Step 1 require node specifically.
- **Confidence:** High (80)
- **Found by:** Contract & Integration

### [I4] `Authorization: Basic <base64>` header is not redacted — credential leak into the setup transcript
- **File:** `plugins/claude-context/scripts/lib/redact.mjs` (Bearer rule ~line 8; the basic-auth rule ~lines 19–21 only covers the `scheme://user:pass@` URL form)
- **Bug:** There is no rule for the HTTP `Authorization: Basic …` header form, and `Authorization` contains none of `key/token/secret/pass/pwd`, so the labeled-assignment rule misses it too.
- **Impact:** A foreign statusline like `curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="` echoes the header **verbatim** into the setup-preview transcript. The base64 decodes to `user:password`. Reproduced: output == input, unchanged. Contradicts the module's stated "don't echo a Bearer token / API key into the transcript" contract.
- **Suggested fix:** Add `.replace(/\bBasic\s+[A-Za-z0-9+/=]+/g, 'Basic [REDACTED]')` (optionally a generic `Authorization:\s*\S+\s+\S+` catch-all).
- **Confidence:** High (88)
- **Found by:** Security

### [I5] Space-separated secret flags (`--api-key VALUE`, `--password VALUE`) are not redacted — credential leak
- **File:** `plugins/claude-context/scripts/lib/redact.mjs` (labeled-assignment rule ~line 35 requires a `[:=]` separator; the `-p` rule ~line 27 only matches an *attached* lowercase `-p`)
- **Bug:** No rule handles the `--flag VALUE` (space-separated) form for any flag name. The most common CLI credential shape slips through.
- **Impact:** `statusline --api-key 0123456789abcdef…` and `fetch --password Hunter2Pass!` are echoed unchanged into the setup-preview transcript (control: attached `--api-key=…` *is* masked). Given the module's explicit "over-redaction preferred over a leak" contract, this is a gap, not accepted best-effort — and it's the highest-likelihood of the three redaction gaps.
- **Suggested fix:** Add a case-insensitive rule for `(--?(?:api[-_]?key|token|secret|password|pass|pwd|auth)\s+)(\S+)` → `$1[REDACTED]`, mirroring the attached `-p` rule.
- **Confidence:** High (90)
- **Found by:** Security

### [I6] Bearer token containing base64 `+` / `/` is partially leaked
- **File:** `plugins/claude-context/scripts/lib/redact.mjs:8` (`/Bearer\s+[A-Za-z0-9._-]+/gi` — the char class excludes `+` and `/`)
- **Bug:** A standard (non-url-safe) base64 bearer token is truncated at the first `+` or `/`, so everything after it is echoed. Standard-base64 tokens almost always contain `+`/`/`.
- **Impact:** Reproduced: `Authorization: Bearer AbC0+xYz/98wQ==` → `Bearer [REDACTED]+xYz/98wQ==` — the substring `+xYz/98wQ==` leaks. A partial credential is still a credential leak, and under-redacts against the module's over-redaction philosophy.
- **Suggested fix:** Widen the Bearer (and any base64 token) class to include `+/=`, e.g. `/Bearer\s+[A-Za-z0-9._\-+/=]+/gi`.
- **Confidence:** High (85)
- **Found by:** Security

## Suggestions

- **[S1] `coexist.mjs:73` — synchronous `spawn` throw blanks the statusline.** The sidecar-present hot path has no try/catch inside `runCoexist`; `spawn('bash', ['-c', cmd])` throws *synchronously* (`ERR_INVALID_ARG_VALUE`) if the stored command contains a NUL/control byte, which `readSidecar`'s `command.trim() !== ''` guard doesn't reject. The `isMain` catch then does `process.exit(0)` with no fallback line → blank statusline, repeating every tick. Real gap in the crash-proof contract, but the NUL-byte trigger (in a command copied verbatim from the user's own `settings.json`) is contrived — hence Suggestion. Fix: wrap the spawn in try/catch and emit a fallback line on failure, mirroring the no-sidecar degraded path. (Found by Error Handling; reproduced, confidence 75.)

## Plan Alignment

Plan/design docs consulted: `docs/superpowers/plans/2026-07-08-claude-context-coexist.md`, `docs/superpowers/specs/2026-07-08-claude-context-coexist-statusline-design.md`.

- **Implemented:** All 11 planned tasks are reflected in the diff — config-dir paths (Task 1), ownership marker (2), redaction (3), command builder (4), invisible-tap `coexist.mjs` (5), `wiring.mjs` detect/wrap/teardown with the exact `slot`/`action` values + single 0600 backup + atomic writes (6–8), `setup.md` rewrite delegating to the module (9), `teardown.md` + manifest registration (10), README/CHANGELOG/version bump to 0.3.0 (11). Several areas are hardened *beyond* the plan (anchored marker regex, ENOSPC/temp cleanup, synchronous exit-listener attachment, documented accepted race).
- **Not yet implemented (correctly deferred/dropped):** native PowerShell/cmd wiring (spec §7 non-goal); Part B model-window fallback + `config.json` override (spec §8, dropped — `report.mjs` correctly unchanged); latency budget/disclosure (dropped); N-way multiplexing (stays 1-deep). No milestone-required item is missing.
- **Deviations (all confirmed benign — documentation/code drift, no functional defect):**
  - **D1:** `coexist.mjs:73` uses `bash -c`, but spec §3.4/§4 and the plan say `sh -c`. Deliberate post-plan fix (commit `3b4b165`, "S4"); `bash -c` is a functional superset (the wrapper is already launched via `bash -c`). Reconcile the docs.
  - **D2:** `collect.mjs` was modified and a new `lib/stdin.mjs` added, though the plan lists `collect` as unchanged and doesn't name that module. Benign shared crash-proof-reader refactor; `tests/stdin.test.mjs` covers it. Note it in the plan/CLAUDE.md lib list if kept.
  - **D3:** `wrap`/`teardown` return an extra `sidecarPath` field beyond the plan's "locked" shape (`wiring.mjs:233`, `:303`); additive, improves orphan recovery, all consumers handle it. Update the plan's note.
- **Instrument-not-advisor contract:** honored. `report.mjs` is untouched and the no-advice denylist test over report output is unchanged. The `"Proceed — co-exist (recommended)"` string in `setup.md:70` is an install confirm, not a resource-fact recommendation, and is taken verbatim from the plan — not a violation.

## Review Metadata

- **Agents dispatched:** Logic & Correctness; Error Handling & Edge Cases; Contract & Integration; Concurrency & State; Security; Plan Alignment; plus a single Verifier.
- **Scope:** Changed production code — `scripts/{coexist,wiring,collect}.mjs`, `scripts/lib/{command,marker,redact,stdin,config-dir}.mjs`; changed commands — `commands/{setup,teardown}.md`; adjacent unchanged (integration surface) — `scripts/lib/{snapshot,token-math,time}.mjs`, `scripts/report.mjs`; tests — `tests/{coexist,wiring,command,marker,redact,stdin,setup,docs}.test.mjs`.
- **Raw findings:** 12 (9 bug-candidates across specialists + 3 plan deviations); the teardown data-loss bug was reported independently by 2 specialists.
- **Verified findings:** 8 code findings (1 Critical, 6 Important, 1 Suggestion) + 3 benign plan deviations.
- **Filtered out:** 0 rejected in verification; 1 duplicate merged (teardown data-loss).
- **Steering files consulted:** `CLAUDE.md` (project instructions — no code/steering contradiction found; the code deliberately evolved past the plan, which CLAUDE.md itself says is expected).
- **Plan/design docs consulted:** `docs/superpowers/plans/2026-07-08-claude-context-coexist.md`, `docs/superpowers/specs/2026-07-08-claude-context-coexist-statusline-design.md`.

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
- **Probe time:** 2026-07-08T15:24:25Z
