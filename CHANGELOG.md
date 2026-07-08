# Changelog

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
