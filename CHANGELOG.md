# Changelog

## 0.3.1

Bug-fix and hardening release over 0.3.0. No new features; the co-existing statusline and
the report's shape are unchanged.

- **`compactions` reports `null`, never a fabricated `0`,** when the transcript can't be
  read or its path is absent — so a rule keyed on the compaction count never acts on an
  invented value.
- **Session identity:** the report falls through to the `CLAUDE_CODE_SESSION_ID` env var
  when the passed `--session-id` is empty or unexpanded, instead of degrading to another
  session's newest snapshot.
- **Bun support:** setup, teardown, and the statusline resolve `bun` or `node` rather than
  hardcoding `node`; under Bun the collector runs with `--env-file /dev/null` so it can't
  auto-load the project's `.env`.
- **Secret redaction:** the setup preview masks many more credential shapes (AWS/Google/
  Slack keys, JWTs, basic-auth URLs, positional and abbreviated tokens), so a wrapped
  statusline command can't leak secrets into the setup transcript.
- **Setup/teardown robustness:** never clobber the one-time settings backup on re-setup;
  never strand a temp file on a failed write; recover the original statusline from the
  backup when the sidecar is lost; restore a command-less original verbatim; refuse to
  seize a slot whose marker isn't ours.
- **Command safety:** the runtime path is single-quoted in the persisted statusline command,
  so a path containing shell metacharacters can't execute.
- **Git Bash:** the plugin-dir resolver filters to semver directories and sorts by version
  field (matching POSIX), always launching the newest installed version rather than an older
  cached one.
- **Fail-safe statusline:** a stdin stream error or a failed spawn of the wrapped original
  degrades to our own line instead of blanking the statusline.
- **Docs:** the README flags alpha status up front, explains why the plugin needs a
  statusline, and documents the Windows limitations (POSIX-only file modes, the `bash`
  dependency, `settings.json` normalization).

## 0.3.0

- **Co-existing statusline.** `/claude-context:setup` now wraps an existing (foreign)
  statusline instead of offering replace-or-keep: both run, your displayed line is unchanged,
  and the new `/claude-context:teardown` restores the original verbatim. Setup never replaces
  or seizes a slot it doesn't own.
- **New `/claude-context:teardown` command.**
- **BREAKING (native PowerShell/cmd):** this release removes the empty-slot PowerShell
  collector shipped in 0.2.0. Native PowerShell/cmd is unsupported this alpha; setup makes no
  settings change there. Use Git Bash for live numbers. POSIX and Windows + Git Bash are
  wired as before (now via the tested `wiring.mjs` module).

## 0.2.0

- Reporting now requires the collector: with no snapshot ever written, the report
  returns a not-set-up state (all-null values, new `setup_required: true`, and a
  human block explaining `/claude-context:setup`) instead of inferring the context
  window from the transcript. Removed the `window_size_inferred` field and the
  `model-window` inference module. A stale snapshot still reports accurate context
  (from the transcript, or the snapshot's own field) flagged `unavailable_stale`.
- Repository relocated the shipped plugin into `plugins/claude-context/` so
  `/plugin install` copies a lean tree (docs, tests, and dev infra stay at the root).

## 0.1.0

- Initial release: `/claude-context:claude-context` skill, opt-in `collect.mjs`
  statusline collector, `report.mjs` engine with snapshot → transcript → cold-start
  degradation, and `/claude-context:setup`. Pure measurements and provenance; no
  recommendations, labels, policy, or derived metrics.
