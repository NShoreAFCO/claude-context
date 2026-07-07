# claude-context — plugin design

**Date:** 2026-07-07
**Status:** Approved design, ready for implementation planning

## 1. Purpose

`claude-context` is a Claude Code plugin. It provides a skill, `/claude-context`,
that reports — to both users and agents (including subagents) — how much of the
current session's resources are being consumed:

- **Context window** occupancy (tokens used, window size, headroom, percentage)
- **Session (5-hour)** subscription usage and reset time
- **Weekly (7-day)** subscription usage and reset time
- Session **cost** and **compaction** count
- Data **provenance** (which source produced the numbers, and how fresh)

The tool is an **instrument, not an advisor**. It emits pure measurements and
provenance. It makes **no recommendations**, attaches **no evaluative labels**
(no "pressure"/"level" classifications), and prescribes **no actions**. A
consumer may collect this information for any reason; deciding what to do with it
is entirely the caller's job.

This repository (`claude-context`) *is* the installable plugin. The bundled
`claude-hud/` directory is retained as **reference only** and is not a shipped
plugin component.

## 2. Background: the core constraint

Claude Code delivers session telemetry to different consumers differently:

- **`context_window`, `rate_limits`, and `cost`** are pushed via **stdin JSON to
  the statusline process only** (this is how the reference project `claude-hud`
  obtains them — see `claude-hud/src/stdin.ts` and `claude-hud/src/types.ts`).
  The true 5-hour and 7-day subscription usage percentages exist **only** here;
  they are the official values surfaced from Anthropic's API.
- A **slash command or agent-invoked skill receives no such stdin.** On its own
  it can read only the **transcript JSONL**, which contains per-message token
  `usage` (enough to compute context-window occupancy) but **no `rate_limits`**.

Therefore a command, by itself, cannot see true session/weekly usage. `claude-hud`
already built the bridge for this: its `externalUsageWritePath`
(`claude-hud/src/external-usage.ts`) lets the statusline write a `snapshot.json`
of usage that other local tools can read. This design uses the same idea with our
own collector, so that **claude-hud is never required**.

## 3. Approaches considered

| Approach | Why not chosen |
| --- | --- |
| MCP-server-centric (per the shared proposal doc) | MCP tool schemas load into every session (ongoing token cost), and MCP tools do not by themselves create the `/claude-context` slash command the user asked for. |
| Interop-only with claude-hud | Would make claude-hud a hard dependency. Explicitly disallowed. |
| Transcript-only | Cannot report true 5h/7d subscription usage — only estimates from token counts. |
| Full HUD + collector (fold in claude-hud) | Duplicates claude-hud and takes over the statusline slot for everyone. |

**Chosen:** a **Skill-first** design with our **own opt-in collector** and a
**transcript-only fallback**, structured so an MCP interface could be added later
with no rework. claude-hud is only an *optional convenience* for people who
already run it and do not want two statuslines.

## 4. Architecture

Two cooperating pieces plus the skill that ties them together.

### 4.1 Collector (`collect.mjs`)

An **opt-in** statusline script. On each statusline refresh (~300ms) Claude Code
pipes the stdin JSON to it. The collector:

1. Parses `context_window`, `rate_limits`, `cost`, `model`, and `transcript_path`.
2. Writes a private `snapshot.json` (atomic write, throttled to avoid churn,
   mode `0600`), mirroring the robustness patterns in
   `claude-hud/src/external-usage.ts`.
3. Prints a **compact one-line summary** to stdout so the statusline slot stays
   useful (context % + 5h/7d usage). A `--silent` flag suppresses all output for
   users who want a blank statusline.

The collector is **never installed automatically**. It is wired only when the
user runs `/claude-context:setup`, so we never clobber an existing statusline
silently.

### 4.2 Report engine (`report.mjs`)

What the skill runs. It resolves the data with graceful degradation:

1. **Primary — snapshot.** If a fresh `snapshot.json` exists (within a staleness
   window, e.g. 5 min), read it. Provides full context + rate limits + cost.
   `source: "collector"`.
2. **Fallback — transcript.** If the snapshot is missing or stale, locate the
   current session's transcript (the most-recently-modified `.jsonl` under the
   `~/.claude/projects/<encoded-cwd>/` directory), and compute context occupancy
   from the **last assistant message's `usage`** (`input_tokens +
   cache_read_input_tokens + cache_creation_input_tokens`). Infer window size
   from the model (200k default; 1M for 1M-context variants). Rate limits and
   cost are reported as **unavailable**. `source: "transcript"`.

The engine always produces output; it never hard-fails just because the collector
is off. It emits both a human block and a JSON block (see §5).

### 4.3 Skill (`SKILL.md`)

Surfaces as `/claude-context`; discoverable and invocable by Claude and
subagents from its description. Its body:

- States what the tool is for (surfacing the session's resource facts on demand).
- Provides a **field reference** defining every number and its units.
- Explains the two sources and the `source`/freshness fields so a caller can
  judge reliability.
- States explicitly that **interpretation and any resulting action are entirely
  the caller's** — the skill prescribes nothing. No 70/85/90 action rules, no
  stop/summarize/compact guidance.
- Tells Claude to run `scripts/report.mjs` via Bash and read its output.

## 5. Data contracts

### 5.1 `snapshot.json`

Deterministic path: `~/.claude/claude-context/snapshot.json` (mode `0600`).
Both `collect.mjs` (writer) and `report.mjs` (reader) derive this path from
`os.homedir()` so they agree without relying on plugin env vars (the
user-configured statusline process may not receive `CLAUDE_PLUGIN_DATA`).

```json
{
  "updated_at": "2026-07-07T13:00:00.000Z",
  "model": { "id": "claude-opus-4-8", "display_name": "Opus 4.8" },
  "context": {
    "window_size": 200000,
    "used_tokens": 92000,
    "used_percentage": 46,
    "input_tokens": 1200,
    "cache_read_tokens": 88000,
    "cache_creation_tokens": 2800,
    "output_tokens": 0
  },
  "rate_limits": {
    "five_hour": { "used_percentage": 25, "resets_at": "2026-07-07T14:30:00.000Z" },
    "seven_day": { "used_percentage": 61, "resets_at": "2026-07-10T17:00:00.000Z" }
  },
  "cost": { "total_cost_usd": 0.42 },
  "transcript_path": "/Users/.../session.jsonl"
}
```

Writes are throttled and atomic (temp file + rename + chmod), following
`claude-hud/src/external-usage.ts`. Invalid/partial payloads are handled
defensively.

### 5.2 Report output

**Human block (collector source):**
```
Claude Context — Opus 4.8
Context: 46% used · 92k / 200k tokens · 108k headroom
Session (5h): 25% used · resets in 1h 30m (at 14:30)
Weekly (7d): 61% used · resets in 3d 4h
Cost: $0.42 · Compactions: 1
Source: collector · snapshot 4s old
```

**Human block (transcript fallback — factual, no advice):**
```
Claude Context — Opus 4.8
Context: 46% used · 92k / 200k tokens · 108k headroom
Session (5h): unavailable — enable the collector with /claude-context:setup
Weekly (7d): unavailable — enable the collector with /claude-context:setup
Cost: unavailable · Compactions: 1
Source: transcript fallback · context only
```

**JSON block — pure measurements and provenance only:**
```json
{
  "model": { "id": "claude-opus-4-8", "display_name": "Opus 4.8" },
  "context": {
    "used_percentage": 46,
    "used_tokens": 92000,
    "window_size": 200000,
    "headroom_tokens": 108000,
    "input_tokens": 1200,
    "cache_read_tokens": 88000,
    "cache_creation_tokens": 2800,
    "output_tokens": 0
  },
  "rate_limits": {
    "five_hour": { "used_percentage": 25, "resets_at": "2026-07-07T14:30:00.000Z", "resets_in_seconds": 5400 },
    "seven_day": { "used_percentage": 61, "resets_at": "2026-07-10T17:00:00.000Z", "resets_in_seconds": 273600 }
  },
  "cost_usd": 0.42,
  "compactions": 1,
  "source": "collector",
  "snapshot_age_seconds": 4,
  "generated_at": "2026-07-07T13:00:04.000Z"
}
```

When usage is unavailable (transcript fallback), `rate_limits.*` and `cost_usd`
are `null` and `source` is `"transcript"`. There is no `suggested_action` field
and no level/pressure label — measurements and provenance, nothing evaluative.

## 6. Repository / plugin layout

```
claude-context/                     # repo root = plugin root
├── .claude-plugin/
│   ├── plugin.json                 # name: claude-context, version, metadata
│   └── marketplace.json            # enables /plugin marketplace add <owner>/claude-context
├── skills/claude-context/
│   ├── SKILL.md                    # interface + field reference (no action guidance)
│   └── scripts/
│       ├── report.mjs              # report engine (snapshot → transcript fallback → human + JSON)
│       ├── collect.mjs             # statusline collector (stdin → snapshot; prints compact line, --silent)
│       └── lib/                    # dependency-free helpers adapted from claude-hud:
│                                   #   snapshot read/write, transcript last-usage, model→window,
│                                   #   token math (headroom/percentage), time formatting
├── commands/
│   └── setup.md                    # /claude-context:setup — wire collector into settings.json statusLine
│                                   #   (version-resilient invocation) or print claude-hud interop note; verify
├── tests/                          # node:test units + fixtures
├── README.md
├── LICENSE
├── CHANGELOG.md
└── claude-hud/                     # reference only — NOT a shipped plugin component
```

**Runtime:** self-contained Node ESM, **zero dependencies, no build step**.
Requires Node 18+ or Bun (the same requirement `claude-hud` already documents,
and generally present wherever Claude Code runs).

## 7. Setup, distribution, and interop

- **Install:** `/plugin marketplace add <owner>/claude-context` →
  `/plugin install claude-context`. `defaultEnabled: true`.
- **Without setup:** `/claude-context` still returns full **context** health from
  the transcript fallback. Only live 5h/7d usage requires the collector.
- **`/claude-context:setup`:** writes a `statusLine` entry into the user's
  `~/.claude/settings.json` that invokes `collect.mjs` through a
  **version-resilient** path (resolving the newest installed plugin version at
  runtime, following the pattern in `claude-hud/commands/setup.md`, since
  `${CLAUDE_PLUGIN_ROOT}` changes on update and `statusLine` is not a valid
  `plugin.json` field). It then verifies the collector is producing a snapshot.
- **claude-hud interop (optional, never required):** if the user already runs
  claude-hud and does not want two statuslines, setup instead documents pointing
  claude-hud's `externalUsageWritePath` at our snapshot location. Nothing in the
  plugin depends on claude-hud being present, and the plugin never errors or
  degrades when it is absent.

## 8. Testing

Node's built-in `node:test` (matching `claude-hud`). Coverage:

- Snapshot **write** (atomic, throttled, correct shape/permissions) and **read**
  (including staleness rejection and malformed-input handling).
- Transcript **last-usage extraction** (correct token sum from the final
  assistant message; duplicate-usage de-duplication as in
  `claude-hud/src/transcript.ts`).
- **Model → window-size** inference (200k default; 1M variants).
- **Token math** (percentage, headroom) and **time formatting** (resets-in / at).
- **Fallback path**: no/stale snapshot → context-only report with `source:
  "transcript"` and `null` usage/cost.
- **Report shape**: human block and JSON block match the contract in §5; no
  `suggested_action` and no evaluative labels ever appear.

Fixture transcripts and sample stdin payloads mirror `claude-hud`'s test approach.

## 9. Explicit non-goals

- No recommendations, suggested actions, or evaluative/level labels of any kind.
- No dependency on claude-hud.
- No always-on MCP server in this iteration (kept possible for a later addition).
- No network calls, credential scraping, or undocumented API use. Local-only,
  consistent with `claude-hud`'s security posture.

## 10. Assumed defaults (adjustable)

- Collector prints a compact one-line statusline summary by default; `--silent`
  suppresses it.
- Snapshot lives at `~/.claude/claude-context/snapshot.json`, mode `0600`.
- Snapshot staleness window for "fresh": 5 minutes.
- `claude-hud/` remains in the repo as reference and is excluded from the shipped
  plugin.
