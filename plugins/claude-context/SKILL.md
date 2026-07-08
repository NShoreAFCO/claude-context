---
description: Report the current session's resource facts — context-window occupancy, 5-hour and 7-day subscription usage, session cost, and compaction count — as pure measurements with provenance (human summary + machine-readable JSON block). Use when you or the user want to know how much context, quota, or cost the session has used — and, for agents and subagents, to gate your own behavior on those numbers: checkpoint or stop as context fills up (before Claude Code's auto-compaction silently drops CLAUDE.md guidance or recent instructions), or pause before exhausting the 5h/7d limit. Reports facts only; your instructions set the policy. Makes no recommendations.
name: claude-context
---

# claude-context

This skill surfaces the current session's resource facts on demand, for both the
user and agents (including subagents). It is an **instrument, not an advisor**: it
reports measurements and where they came from, and nothing else. It makes no
recommendations, attaches no evaluative or level labels, and prescribes no
actions. What to do with the numbers is entirely the caller's decision.

**When relaying this report, pass the measurements through as-is.** Do not add
recommendations, urgency, thresholds, or "you should…" framing of your own — even
though the numbers may invite it. Report what the instrument measured and the
provenance fields (`source`, `rate_limits_status`, `setup_required`,
`session_selection`); let the caller decide what it means.

## How to run it

Run the report engine with Bash and read its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" --session-id "${CLAUDE_SESSION_ID}"
```

Pass `--session-id` so the report reads **this** session's own snapshot rather than
a concurrent same-account session's. `${CLAUDE_SESSION_ID}` is substituted by Claude
Code; if your build doesn't expose it, the report falls back to the
`CLAUDE_CODE_SESSION_ID` environment variable, then to the newest snapshot (see
`session_selection` below). It prints a human-readable block and a fenced `json`
block, and always succeeds even with no collector running.

## Field reference

- **context.used_percentage** — percent of the context window in use (0–100).
- **context.used_tokens / window_size / headroom_tokens** — tokens in use, the
  window size, and tokens remaining. `used_tokens` = input + cache-read +
  cache-creation.
- **context.input_tokens / cache_read_tokens / cache_creation_tokens / output_tokens**
  — the token breakdown for the last measured turn.
- **rate_limits.five_hour / seven_day** — subscription usage windows, each with
  `used_percentage`, `resets_at` (ISO), and `resets_in_seconds`. Present only for
  Pro/Max accounts after the first API response; otherwise `null`.
- **cost_usd** — session cost in USD, or `null` when unavailable.
- **compactions** — number of compaction boundaries in the transcript.
- **source** — `collector` (a fresh snapshot, or — while idle — the stale
  snapshot's own context field), `transcript` (collector idle: context
  recomputed from the transcript against the stale snapshot's real window
  size), or `unavailable` (no snapshot has ever been written; `compactions` is
  also `null` in this state, since it is unknown rather than zero).
- **rate_limits_status** — `available`; `unavailable_plan` (collector on, account
  reports no subscription usage — either an API-key account or before the first
  Pro/Max response); `unavailable_provider` (Bedrock/Vertex, which don't report
  subscription usage); `unavailable_stale` (a snapshot exists but is past the
  freshness window — collector on but idle); or `unavailable_collector` (no
  snapshot has ever been written).
- **setup_required** — `true` only when no collector snapshot has ever been
  written (the not-set-up state): 5h/7d, cost, context, and compactions are all
  `null` and the human block explains how to run `/claude-context:setup`. `false`
  in every other state. Gate on this one field instead of inferring setup status
  from `source`/`rate_limits_status`.
- **session_selection** — how the report decided whose numbers these are:
  `session_id` (matched this session's own id — the snapshot and its transcript are
  definitively yours) or `unverified-snapshot` (this Claude Code build exposed no
  session id, so the newest snapshot was used and may belong to another concurrent
  same-account session). Omitted from the JSON in the not-set-up state, where there
  are no numbers to attribute. Gate on this when it matters that the context figures
  are your session's and not a neighbor's.
- **snapshot_age_seconds** — how old the snapshot is (collector mode, or the age
  of a stale snapshot reused in fallback).
- **model** — the reporting session's model as `{ id, display_name }`. From the
  collector, `id` carries the `[1m]` marker on a 1M-context session; from the
  transcript fallback it is the base id (no marker) and `display_name` is empty.
- **generated_at** — ISO-8601 time the report itself was produced. Distinct from
  `snapshot_age_seconds` (the snapshot's age): use `generated_at` to tell how fresh
  the *report* is, e.g. to ignore a cached copy.

## Whose numbers are these?

The **context** figures describe the **session** — the main agent's context window
(the view Claude Code sends to the statusline). Subscription **usage (5h/7d)** and
**cost** are **account-wide**, shared by the main agent and every subagent.

Because several Claude Code sessions can run under one account at once, the collector
keys its snapshot by session id and the report reads the one matching **your** session
(`session_selection: "session_id"`). If your Claude Code build exposes no session id,
the report falls back to the newest snapshot and flags it `unverified-snapshot` — in
that state the context/compaction figures may be a neighbouring session's, while the
account-wide 5h/7d/cost figures are identical across sessions and stay correct.

If you are a subagent, the context percentage is the **session's**, not your own
private window. Use it to judge whether the parent session is filling up — for
example, to checkpoint results to a file before it auto-compacts — not as a gauge of
your own subagent context, which this report does not measure.

## Sources and reliability

The report resolves to exactly three states, keyed on whether a collector snapshot
has ever been written:

- **Collector** — a fresh snapshot exists. Full numbers: context, 5h/7d usage, cost,
  and compactions, all `source: "collector"`, `rate_limits_status: "available"` (or
  one of the `unavailable_plan` / `unavailable_provider` variants when the account
  doesn't report subscription usage).
- **Collector idle** — a snapshot exists but is past the freshness window. Context is
  still accurate: recomputed from the transcript's latest usage against the stale
  snapshot's real window size (`source: "transcript"`), or, when the transcript has
  no usage to read, reported straight from the stale snapshot's own context field
  (`source: "collector"`). Either way `rate_limits_status: "unavailable_stale"` and
  5h/7d/cost are `null` — the collector is on, just not fresh, so it is never
  mistaken for "collector not installed."
- **Not set up** — no snapshot has ever been written. The report performs no
  transcript I/O and returns everything `null` (including `compactions`, which is
  unknown rather than zero), `source: "unavailable"`,
  `rate_limits_status: "unavailable_collector"`, and `setup_required: true`; the
  human block explains how to run `/claude-context:setup`.

Use the `source`, `rate_limits_status`, `setup_required`, and `session_selection`
fields to judge how much to trust each number.
