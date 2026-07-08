# Agentic Code Review: ovid/coexist-statusline

**Date:** 2026-07-08 15:25:08
**Branch:** ovid/coexist-statusline -> main
**Commit:** f62459c79cfb95c1e23e4d9dbc301f822579c0cb
**Files changed:** 29 | **Lines changed:** +3875 / -189
**Diff size category:** Large (by line count; the reviewable *code* surface is ~600 lines — the bulk is docs, plan/spec, and tests)

## Executive Summary

This branch implements the "co-existing statusline" feature: `/claude-context:setup` now wraps a foreign statusline via an invisible tap (`coexist.mjs`) instead of replacing it, tracking ownership by an embedded marker and preserving the original in a `0600` sidecar for verbatim teardown. The implementation is faithful to the design spec and plan (all tasks present, 136/136 tests green, no plan contradictions), and the two highest-risk surfaces — the shell-escaping in `command.mjs` and path-traversal via session id — were verified **secure**. The most significant finding is a **teardown/restore contract violation** (Important): a foreign `statusLine` present-but-command-less is stored by `wrap()` but silently *deleted* rather than restored by `teardown()` — reported independently by three specialists and reproduced. The remaining findings cluster in the best-effort secret redactor (several real leak gaps) and in the lock-free wiring's backup/concurrency handling. No Critical, will-happen-in-normal-use defects were confirmed.

## Critical Issues

None found.

## Important Issues

### [I1] teardown silently discards a command-less co-existed original (and orphans its sidecar)
- **File:** `plugins/claude-context/scripts/wiring.mjs:250` (branch), root cause at `plugins/claude-context/scripts/wiring.mjs:58` (`readSidecar` gate) vs `plugins/claude-context/scripts/wiring.mjs:221` (`wrap` stores verbatim)
- **Bug:** `classify()` deliberately routes a `statusLine` that is *present but has no usable string `command`* to `foreign` (see the intent comment at `wiring.mjs:48-50`), and `wrap()`'s fresh-foreign path stores `original: base.statusLine` **verbatim** — an object with no `command`. But `readSidecar()` returns a sidecar only when `typeof s.original.command === 'string'`. So on teardown, `marker === 'coexist'` while `readSidecar()` returns `null`, sending control to the `coexist-no-sidecar-removed` branch, which does `delete next.statusLine` (discarding the user's original instead of restoring it) and never `removeIfPresent`s the still-present `coexist.json` (orphan left behind).
- **Impact:** Silent loss of the user's statusline configuration, reported to the user as a successful teardown — a direct violation of the documented "teardown restores your original statusline verbatim" contract. The trigger is narrow (a foreign `statusLine` whose `command` is absent or non-string), which keeps it Important rather than Critical, but it is exactly the shape `wrap()` explicitly opts to round-trip, and there is a passing test (`tests/wiring.test.mjs:191`) asserting `wrap()` stores it.
- **Suggested fix:** Make the teardown-side read accept any stored `original` object (require only `s.original != null`, not a string `command`) so the `coexist` branch restores `statusLine: sidecar.original` verbatim; keep the stricter "runnable command" predicate only for `coexist.mjs`'s degraded-mode decision. Additionally, `removeIfPresent(sidecarPath(env), deps)` in the `coexist-no-sidecar-removed` branch so a present sidecar file is never orphaned (matching the sibling `removed-collect` branch).
- **Confidence:** High (92) — reproduced end-to-end.
- **Found by:** Logic & Correctness, Error Handling & Edge Cases, Contract & Integration (3 specialists agreed)

### [I2] Redactor leaks non-HTTP connection-string passwords
- **File:** `plugins/claude-context/scripts/lib/redact.mjs:18`
- **Bug:** The basic-auth masking rule is anchored to `\bhttps?:\/\/`, so credential URLs with any other scheme pass through with the password intact.
- **Impact:** A foreign statusline that shells out to a DB/cache to show status (a common pattern) embeds a connection string; its password is echoed raw into the setup-confirmation transcript. Reproduced: `postgres://admin:S3cr3tPass@db/mydb`, `mysql://…`, `redis://…`, `mongodb://…` all leak; the `https://` control redacts correctly. This is the redactor's stated core job ("don't echo a Bearer token / API key into the transcript").
- **Suggested fix:** Broaden the scheme anchor to any URI scheme, e.g. `/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi`.
- **Confidence:** High (92) — reproduced.
- **Found by:** Security

### [I3] Redactor misses `github_pat_` fine-grained PATs and `xapp-`/`xoxe-` Slack tokens
- **File:** `plugins/claude-context/scripts/lib/redact.mjs:12` (GitHub), `plugins/claude-context/scripts/lib/redact.mjs:16` (Slack)
- **Bug:** `gh[pousr]_` covers classic `ghp_/gho_/ghu_/ghs_/ghr_` tokens but not the modern `github_pat_…` fine-grained PAT format; `xox[baprs]-` does not cover `xapp-` (app-level) or `xoxe-` (rotation/refresh) Slack tokens.
- **Impact:** These token shapes are echoed raw when not preceded by a `token=`-style label. Reproduced: `github_pat_11ABCDEF0123456789_abcdefghij`, `xapp-1-ABC-123-xyzABCdefGHI`, `xoxe-1-abcd…` all leak; the `ghp_…` control redacts.
- **Suggested fix:** Add `/\bgithub_pat_[A-Za-z0-9_]{20,}/g`, and broaden the Slack rule to `/\bxox[a-z]-[A-Za-z0-9-]{8,}/gi` plus `/\bxapp-[A-Za-z0-9-]{8,}/gi`.
- **Confidence:** High (90) — reproduced.
- **Found by:** Security

### [I4] Labeled quoted secret containing a space leaks entirely (redactor regression)
- **File:** `plugins/claude-context/scripts/lib/redact.mjs:22`
- **Bug:** The value capture `("?)([^"\s]+)\3` forces the closing quote to fall immediately after the first whitespace-free run. A quoted value that contains a space therefore fails the *entire* match, so nothing is redacted.
- **Impact:** The redactor's own core case — a labeled password — fails when the value is a quoted phrase. Reproduced: `password="my secret phrase"` and `api_token="abc def ghi"` pass through completely unchanged, while `password="mysecret"` (no space) and `api_key=SUPERSECRETVALUE` redact fine.
- **Suggested fix:** Allow a quoted alternative that permits spaces, e.g. value group `("([^"]*)"|([^"\s]+))`, redacting the inner capture.
- **Confidence:** High (90) — reproduced.
- **Found by:** Security

### [I5] Concurrent `/setup` racing `/teardown` can permanently lose the original statusline
- **File:** `plugins/claude-context/scripts/wiring.mjs:196` (the `ours-coexist` refresh acting on a stale classification) with `plugins/claude-context/scripts/wiring.mjs:126` (`backupOnce`)
- **Bug:** `wrap()` and `teardown()` are lock-free, multi-file read-modify-write operations that classify from a snapshot of `settings.json` taken at their start and then write without re-validating. Interleaving: both processes read `settings = WRAPPER`; `teardown` runs to completion (restores FOREIGN, deletes sidecar + backup); `setup` then executes its stale `ours-coexist` branch, re-writing the coexist WRAPPER settings and a backup of its stale wrapper bytes — but the `ours-coexist` path **never re-creates a sidecar**. Final state: wrapper wired, no sidecar, backup = wrapper → `coexist.mjs` runs degraded and the FOREIGN original is unrecoverable.
- **Impact:** Silent loss of the user's statusline — the exact failure the co-exist design promises never to cause. Likelihood is low: both are agent-invoked slash commands rarely fired simultaneously. Hence Important with low likelihood, not Critical. Shares its root cause with suggestion [S1].
- **Suggested fix:** Serialize the mutating operations with an exclusive lock (e.g. an `O_EXCL` lockfile in the config dir held for the whole `wrap`/`teardown`), or re-read + re-classify `settings.json` immediately before the final `writeSettingsAtomic` and abort with `conflict` if the slot changed. At minimum, the `existsSync`-guarded backup from [S1] plus having the `ours-coexist` refresh re-assert the sidecar preserves recoverability.
- **Confidence:** Medium (70) — reasoned interleaving, code path confirmed; not a runnable repro.
- **Found by:** Concurrency & State

## Suggestions

- **[S1] `backupOnce` clobbers the single stable backup on re-run** — `wiring.mjs:126` has no `existsSync(backupPath)` guard, so a 2nd `/setup` (`refreshed-coexist`) overwrites `settings.json.claude-context.bak` with the *wrapper* instead of the original. Reproduced. Impact is limited because the sidecar (primary restore path) survives and teardown-after-two-wraps still restores correctly — it only bites when the sidecar is also lost (i.e. combined with [I5]). Fix: `if (!deps.existsSync(bp)) { … }` — this also closes [I5]'s unrecoverability. *(Found by: Error Handling, Concurrency & State)*
- **[S2] Positional / abbreviated-name secrets not redacted** — `redact.mjs:22`; `mysql -u root -pMyS3cretPw`, `curl -u alice:s3cretpw https://x`, `MYSQL_PWD=topsecret`, `DB_PASS=letmein` pass through raw (the label rule matches only names literally containing `key|token|secret|password`). Outside the redactor's currently-advertised scope; optional. *(Found by: Security)*
- **[S3] `.tmp` file leaks on a `writeFileSync` failure** — `wiring.mjs:131`, `:149`, `:158`; `commitTemp` only unlinks the temp on a failed `renameSync`, not on a failed `writeFileSync(tmp,…)`. Reproduced: a partial write on a full/flaky FS leaves a stray `.tmp` (no corruption — rename never runs). Fix: mirror `snapshot.mjs:writeSnapshot`'s tracked-`tmp` unlink-on-any-failure. *(Found by: Error Handling)*
- **[S4] `sh -c` vs `bash -c` for the wrapped original** — `coexist.mjs:71` spawns `sh -c <original.command>` while everything else in the plugin uses `bash -c`. A foreign statusline relying on top-level bashisms could break under a dash/busybox `/bin/sh` (Debian/Ubuntu). Latent correctness edge only; fix: spawn `bash -c` for consistency. *(Found by: Security)*

## Plan Alignment

Design/plan docs found and consulted: `docs/superpowers/specs/2026-07-08-claude-context-coexist-statusline-design.md`, `docs/superpowers/plans/2026-07-08-claude-context-coexist.md`.

- **Implemented:** All 11 plan tasks are reflected in code — config-dir paths, ownership marker, redaction (done inside `wiring.detect` so raw commands never transit the transcript), command builder (POSIX + gitbash), invisible-tap wrapper, wiring detect/wrap/teardown + CLI, setup.md rewrite, teardown.md + manifest registration, and docs/version bump. Version **0.3.0 is consistent** across `package.json`, `plugin.json`, `marketplace.json`, and CHANGELOG (enforced by `tests/manifest.test.mjs`).
- **Not yet implemented:** None. The one scoped-out item — native PowerShell/cmd wiring — is correctly absent by design; `setup.md:29-33` stops on the `native-powershell` branch and makes no settings change, and the 0.2.0 `cmd /c` launcher is gone. Documented as a 0.2.0 regression in CHANGELOG/README.
- **Deviations:** No contradictions of a documented invariant. Deviations from the literal plan text are all conservative *hardening* enhancements aligned with the spec's intent: a new `lib/stdin.mjs` shared crash-proof reader (and `collect.mjs` refactored to use it); `classify()` gaining a `hasStatusLine` argument so a command-less slot is co-existed rather than seized; additive `sidecarPath` fields on `conflict`/`not-ours` returns; an anchored `detectMarker` regex; inner single-quoting of the runtime in `command.mjs`; a broader redactor; and race/Bun hardening in `coexist.mjs`. The "instrument, not advisor" contract is intact — no new reported recommendation/threshold/label was introduced (the setup-wizard "(recommended)" button is a UX affordance for the co-existence decision, outside the reported-facts contract). The dropped "Part B" model-window fallback leaves no orphaned code or docs; `report.mjs` is unchanged.

## Review Metadata

- **Agents dispatched:** Logic & Correctness; Error Handling & Edge Cases; Contract & Integration; Concurrency & State; Security; Plan Alignment; Verifier
- **Scope:** Changed + adjacent code — `plugins/claude-context/scripts/{wiring,coexist,collect}.mjs`, `plugins/claude-context/scripts/lib/{command,marker,redact,stdin,config-dir}.mjs`, adjacent `lib/snapshot.mjs` and `report.mjs`, `commands/{setup,teardown}.md`, and the sibling test suites `tests/{wiring,coexist,command,marker,redact,stdin,config-dir}.test.mjs`
- **Raw findings:** 11 reported across specialists → 10 distinct after dedup (finding [I1] raised by 3 specialists; [S1] by 2)
- **Verified findings:** 9 (5 Important, 4 Suggestion)
- **Filtered out:** 1 (the two divergent `readSidecar` implementations were judged an intentional, benign difference — coexist needs a runnable command, teardown needs any restorable original; the genuinely harmful command-less case is captured as [I1])
- **Steering files consulted:** `CLAUDE.md`
- **Plan/design docs consulted:** `docs/superpowers/specs/2026-07-08-claude-context-coexist-statusline-design.md`, `docs/superpowers/plans/2026-07-08-claude-context-coexist.md`
- **Verified secure (no finding):** `command.mjs` shell-escaping against a crafted `runtime` (executed a repro — `$()`/backtick/`${}`/lone-`'` do not survive the double `shSingleQuote`); session-id path-traversal via `sanitizeSessionId`; file modes (0600 applied at `O_CREAT`, no world-readable window); `coexist.mjs`'s "structurally race-free" exit-code/snapshot ordering; the `spawn('sh', …)` trust boundary (the command is the user's own prior config — no new trust boundary crossed)

## Model Attribution

- **Orchestrator:** `claude-opus-4-8[1m]` (source: system-prompt)
- **Specialists:**
  - Logic & Correctness: `inherit<claude-opus-4-8[1m]>` (source: dispatched+inherited)
  - Error Handling & Edge Cases: `inherit<claude-opus-4-8[1m]>` (source: dispatched+inherited)
  - Contract & Integration: `inherit<claude-opus-4-8[1m]>` (source: dispatched+inherited)
  - Concurrency & State: `inherit<claude-opus-4-8[1m]>` (source: dispatched+inherited)
  - Security: `inherit<claude-opus-4-8[1m]>` (source: dispatched+inherited)
  - Plan Alignment: `inherit<claude-opus-4-8[1m]>` (source: dispatched+inherited)
  - Verifier: `inherit<claude-opus-4-8[1m]>` (source: dispatched+inherited)
- **Probe time:** 2026-07-08T13:07:32Z
