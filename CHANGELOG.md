# Changelog

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
