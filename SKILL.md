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
provenance fields (`source`, `rate_limits_status`, `window_size_inferred`,
`session_selection`); let the caller decide what it means.

## How to run it

Run the report engine with Bash and read its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs"
```

It prints a human-readable block and a fenced `json` block. It always succeeds,
even with no collector running.

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
- **source** — `collector` (from the statusline snapshot), `transcript`
  (context-only fallback), or `unavailable` (no measurement yet).
- **rate_limits_status** — `available`; `unavailable_plan` (collector on, account
  reports no subscription usage — either an API-key account or before the first
  Pro/Max response); `unavailable_provider` (Bedrock/Vertex, which don't report
  subscription usage); `unavailable_stale` (a snapshot exists but is past the
  freshness window — collector on but idle); or `unavailable_collector` (no
  snapshot has ever been written).
- **session_selection** — `transcript_path` (pinned from the snapshot) or
  `newest-in-cwd-heuristic` (guessed; may resolve to a different parallel session).
- **snapshot_age_seconds** — how old the snapshot is (collector mode, or the age
  of a stale snapshot reused in fallback).
- **window_size_inferred** — `true` only when the report had no snapshot to read
  the real context-window size from and had to guess it from the model id (a 1M
  session can't be detected this way); the `%` on that line is approximate.

## Whose numbers are these?

The **context** figures describe the **session** — the main agent's context window
(the view Claude Code sends to the statusline). Subscription **usage (5h/7d)** and
**cost** are **account-wide**, shared by the main agent and every subagent.

If you are a subagent, the context percentage is the **session's**, not your own
private window. Use it to judge whether the parent session is filling up — for
example, to checkpoint results to a file before it auto-compacts — not as a gauge of
your own subagent context, which this report does not measure.

## Sources and reliability

Live 5h/7d usage and cost require the opt-in collector, wired with
`/claude-context:setup`. Without it — or when the collector is on but idle and its
snapshot has gone stale — `/claude-context:claude-context` still reports context
health from the transcript (`source: "transcript"`), and 5h/7d/cost are `null`. A
stale snapshot is reported distinctly (`rate_limits_status: "unavailable_stale"`)
and still supplies the real window size, so it is never mistaken for "collector not
installed." Use the `source`, `rate_limits_status`, `window_size_inferred`, and
`session_selection` fields to judge how much to trust each number.
