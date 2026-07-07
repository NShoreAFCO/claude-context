# claude-context — plugin design

**Date:** 2026-07-07
**Status:** Approved design, revised 2026-07-07; ready for implementation planning

## 1. Purpose

`claude-context` is a Claude Code plugin. It provides a skill —
`/claude-context:claude-context` (or `/claude-context` for short when no other
skill shares the name) — that reports, to both users and agents (including
subagents), how much of the current session's resources are being consumed:

- **Context window** occupancy (tokens used, window size, headroom, percentage)
- **Session (5-hour)** subscription usage and reset time
- **Weekly (7-day)** subscription usage and reset time
- Session **cost** and **compaction** count
- Data **provenance** (which source produced the numbers, and how fresh)

The tool is an **instrument, not an advisor**. It emits pure measurements and
provenance. It makes **no recommendations**, attaches **no evaluative labels**
(no "pressure"/"level"/traffic-light classifications), prescribes **no actions**,
and computes **no policy** (no "should compact", no threshold rules). A consumer
may collect this information for any reason and must remain **completely free** to
act on it however it chooses; deciding what to do with it is entirely the caller's
job and nothing in this plugin should influence that decision.

This repository (`claude-context`) *is* the installable plugin. The bundled
`claude-hud/` directory is retained as **reference only** and is not a shipped
plugin component.

### 1.1 Scope of measurement: whose numbers?

The figures describe the **session**, not an individual agent within it:

- **Context window** is the **main session's** occupancy — the view Claude Code
  pushes to the statusline (§2). A subagent that invokes the skill therefore reads
  the *session's* context, **not its own** private context window: a subagent has no
  statusline stdin, and the transcript fallback's newest-in-cwd heuristic cannot
  reliably isolate a single subagent's turns (see the `session_selection`
  provenance field).
- **Subscription usage (5h/7d)** and **cost** are **account-level** and shared by
  the main agent and every subagent alike.

This is deliberate and matches the primary use case: a subagent checking whether the
**parent** session is approaching auto-compaction — so it can checkpoint results
before guidance is lost — wants the session's context, not its own. Reporting a
subagent's *private* context is a **non-goal** (§9): the levers to do it reliably do
not exist, and the session-scoped reading is the more useful signal anyway.

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

Two properties of the stdin payload shape the design:

- **`rate_limits` is conditional.** It is present only for Claude.ai Pro/Max
  **subscribers**, and only **after the first API response** of a session. API /
  Console-billing accounts never receive it. So even with the collector correctly
  installed, 5h/7d usage can legitimately be absent — this is a distinct state
  from "collector not running" (see §4.2, §5.2).
- **Native fields exist.** Claude Code (v2.1.6+) sends `context_window.used_percentage`
  and `remaining_percentage` directly, and `rate_limits.*.resets_at` as a **Unix
  epoch in seconds**. The collector prefers the native percentage over recomputing
  it, and multiplies `resets_at` by 1000 before converting to ISO.

Therefore a command, by itself, cannot see true session/weekly usage. `claude-hud`
already built the bridge for this: its `externalUsageWritePath`
(`claude-hud/src/external-usage.ts`) lets the statusline write a `snapshot.json`
of usage that other local tools can read. This design uses the same idea with our
own collector, so that **claude-hud is never required**.

## 3. Approaches considered

| Approach | Why not chosen |
| --- | --- |
| Rely on built-in `/context` and `/usage` | Both are interactive and human-only: they render to the terminal, are not invocable by an agent or subagent, and emit no machine-readable JSON. This plugin exists to give **agents** the numbers on demand in a parseable form. |
| MCP-server-centric | MCP tool schemas load into every session (ongoing token cost), and MCP tools do not by themselves create the `/claude-context` slash command the user asked for. |
| Interop-only with claude-hud | Would make claude-hud a hard dependency. Explicitly disallowed. |
| Transcript-only | Cannot report true 5h/7d subscription usage — only estimates from token counts. |
| Full HUD + collector (fold in claude-hud) | Duplicates claude-hud and takes over the statusline slot for everyone. |

**Chosen:** a **Skill-first** design with our **own opt-in collector** and a
**transcript-only fallback**, structured so an MCP interface could be added later
with no rework. The collector needs the single `statusLine` slot to receive
`rate_limits`; setup therefore only takes an **empty** slot automatically, and
when a statusline already exists it asks the user to **replace or keep** it (§4.1,
§7) rather than seizing the slot. claude-hud is only an *optional convenience* for
people who already run it, and is never required.

## 4. Architecture

Two cooperating pieces plus the skill that ties them together.

### 4.1 Collector (`collect.mjs`)

An **opt-in** statusline script. On each statusline refresh (~300ms) Claude Code
pipes the stdin JSON to it. The collector:

1. Parses `context_window` (including the native `used_percentage` /
   `remaining_percentage` when present), `rate_limits` (converting each
   `resets_at` from epoch **seconds** to milliseconds), `cost`, `model`, and
   `transcript_path`.
2. Writes a private `snapshot.json` (atomic write, throttled to avoid churn,
   mode `0600`), mirroring the robustness patterns in
   `claude-hud/src/external-usage.ts`.
3. Prints a **compact one-line summary** to stdout so the statusline slot stays
   useful (context % + 5h/7d usage). A `--silent` flag suppresses that line.

The collector is **never installed automatically**. It is wired only when the
user runs `/claude-context:setup`, and only into the `statusLine` slot:

- **Empty slot** → the collector takes it.
- **A statusline already exists** → setup does not seize the slot. It backs up the
  current setting and asks the user to **replace** it with the collector (gaining
  live 5h/7d usage) or **keep** their own (in which case `/claude-context` runs in
  transcript-only mode — full context health, no live subscription usage). This is
  claude-hud's proven detect-and-ask behavior; the collector never runs, captures,
  or appends to another statusline command.

### 4.2 Report engine (`report.mjs`)

What the skill runs. It resolves the data with graceful degradation:

1. **Primary — snapshot.** If a fresh `snapshot.json` exists (within a staleness
   window, e.g. 5 min), read it for context + rate limits + cost. Context
   percentage comes from the snapshot's captured native value when available.
   `source: "collector"`.
   - If the snapshot is fresh but carries **no rate limits** (the account is not a
     Pro/Max subscription, or no API response has happened yet), context and cost
     are still real; `rate_limits.*` are reported `null` with a message that
     distinguishes "not available for this plan" from "collector off" (§5.2). The
     source stays `"collector"`.
2. **Fallback — transcript.** If the snapshot is missing or stale, compute
   context occupancy from the **last assistant message's `usage`** (`input_tokens +
   cache_read_input_tokens + cache_creation_input_tokens`). Infer window size
   from the model (200k default; 1M for 1M-context variants) — the native
   percentage is not present in the transcript, so this estimate is inherently
   approximate. Rate limits and cost are reported as **unavailable**.
   `source: "transcript"`.
3. **Cold start — no data.** If there is neither a fresh snapshot nor a usable
   assistant `usage` (e.g. the very first turn of a fresh session with the
   collector off), context is genuinely unmeasurable. The engine emits context
   fields as `null` with `source: "unavailable"` and a one-line human message
   ("No measurement yet — no assistant turn recorded and collector is off"). It
   never returns `NaN%`, divides by zero, or crashes.

**Which transcript.** When a snapshot exists, the engine uses the exact
`transcript_path` recorded in it (§5.1) — this pins *this* session unambiguously.
Only in pure fallback (no snapshot) does it guess the session by taking the
most-recently-modified `.jsonl` under the encoded-cwd directory of the resolved
Claude config dir (§5.1). That guess is **best-effort**: with parallel sessions in
the same cwd (multiple windows, subagents, or a `git worktree` of the same repo)
it can resolve to a different session, so the fallback output labels session
selection as heuristic (§5.2). If the skill runtime turns out to expose the
current `transcript_path` directly, prefer it over the mtime guess — worth a spike
during implementation.

**Compactions.** The compaction count is *always* derived from the transcript
(counting `compact_boundary` entries that carry a valid timestamp), because it
appears in neither the stdin payload nor `snapshot.json`. The engine therefore
reads the transcript for the compaction count on every run — using the snapshot's
`transcript_path` in collector mode — even when every other field comes from the
snapshot.

The engine always produces output; it never hard-fails just because the collector
is off. It emits both a human block and a JSON block (see §5).

### 4.3 Skill (`SKILL.md`)

Surfaces as `/claude-context:claude-context` (short form `/claude-context` when
unambiguous); discoverable and invocable by Claude and subagents from its
description. Its body:

- States what the tool is for (surfacing the session's resource facts on demand).
- Provides a **field reference** defining every number and its units.
- Explains the sources and the `source`/freshness fields so a caller can
  judge reliability.
- States explicitly that **interpretation and any resulting action are entirely
  the caller's** — the skill prescribes nothing and computes no policy. No
  70/85/90 rules, no stop/summarize/compact guidance, no evaluative labels.
- Tells Claude to run `scripts/report.mjs` (under `${CLAUDE_PLUGIN_ROOT}`) via
  Bash and read its output.

## 5. Data contracts

### 5.1 `snapshot.json`

Deterministic path: `<config-dir>/claude-context/snapshot.json` (mode `0600`),
where `<config-dir>` is `CLAUDE_CONFIG_DIR` when set, otherwise
`os.homedir()/.claude` — resolved identically by both `collect.mjs` (writer) and
`report.mjs` (reader), matching claude-hud's `claude-config-dir.ts`. The path is
derived this way so the two scripts agree without relying on plugin env vars (the
user-configured statusline process may not receive `CLAUDE_PLUGIN_DATA`) **and**
so it honors a relocated config directory.

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

`context.used_percentage` is the native stdin value when Claude Code provides it,
falling back to `round(used_tokens / window_size * 100)`. Each `rate_limits.*.resets_at`
is stored as ISO after converting the stdin epoch-seconds value. `rate_limits` is
omitted or `null` when the stdin payload carried none. Writes are throttled
(≈30s, per `claude-hud`'s `EXTERNAL_USAGE_WRITE_THROTTLE_MS`) and atomic (temp
file + rename + chmod). Invalid/partial payloads are handled defensively.

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

**Human block (collector on, but no subscription usage for this plan):**
```
Claude Context — Opus 4.8
Context: 46% used · 92k / 200k tokens · 108k headroom
Session (5h): unavailable — no subscription usage reported for this plan
Weekly (7d): unavailable — no subscription usage reported for this plan
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
Source: transcript fallback · context only · session: newest-in-cwd (heuristic)
```

**Human block (cold start — no snapshot and no assistant turn yet):**
```
Claude Context — Opus 4.8
Context: unavailable — no measurement yet (no assistant turn recorded, collector off)
Session (5h): unavailable — enable the collector with /claude-context:setup
Weekly (7d): unavailable — enable the collector with /claude-context:setup
Cost: unavailable · Compactions: 0
Source: unavailable
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
  "rate_limits_status": "available",
  "session_selection": "transcript_path",
  "snapshot_age_seconds": 4,
  "generated_at": "2026-07-07T13:00:04.000Z"
}
```

`source` is one of `"collector"`, `"transcript"`, or `"unavailable"`.
`rate_limits_status` is `"available"`, `"unavailable_plan"` (collector on, but the
account/plan reports no 5h/7d — `rate_limits.*` and their fields are `null`), or
`"unavailable_collector"` (no fresh snapshot). In transcript fallback,
`rate_limits.*` and `cost_usd` are `null`; in the `"unavailable"` cold-start
state, `context.*` are `null` as well. Whenever a transcript is read, the JSON
carries `session_selection` so a caller can judge whether the reported session is
unambiguous: `"transcript_path"` when pinned from the snapshot,
`"newest-in-cwd-heuristic"` when guessed in pure fallback. There is no
`suggested_action` field, no level/pressure label, and no derived/predictive
metric — measurements and provenance, nothing evaluative.

## 6. Repository / plugin layout

```
claude-context/                     # repo root = plugin root
├── .claude-plugin/
│   ├── plugin.json                 # name: claude-context, version, metadata
│   └── marketplace.json            # enables /plugin marketplace add <owner>/claude-context
├── SKILL.md                        # the /claude-context skill (single SKILL.md at root):
│                                   #   interface + field reference (no action guidance)
├── scripts/
│   ├── report.mjs                  # report engine (snapshot → transcript fallback → human + JSON)
│   ├── collect.mjs                 # statusline collector (stdin → snapshot; prints compact line, --silent)
│   └── lib/                        # dependency-free helpers adapted from claude-hud (MIT — notice preserved):
│                                   #   snapshot read/write, transcript last-usage, model→window,
│                                   #   token math (headroom/percentage), time formatting, config-dir resolution
├── commands/
│   └── setup.md                    # /claude-context:setup — FIRST-CLASS deliverable:
│                                   #   version-resilient statusLine invocation across macOS/Linux bash,
│                                   #   Windows Git Bash/MSYS, and Windows PowerShell; empty slot → take it,
│                                   #   existing statusline → replace-or-keep; then verify a snapshot appears.
│                                   #   Reuse claude-hud/commands/setup.md's proven version-resolution strings.
├── tests/                          # node:test units + fixtures
├── README.md
├── LICENSE
├── CHANGELOG.md
└── claude-hud/                     # reference only — NOT a shipped plugin component
```

**Invocation name.** Plugin skills are always namespaced `plugin-name:skill-name`,
so the fully-qualified name is **`/claude-context:claude-context`** — and both a
single `SKILL.md` at the plugin root (frontmatter `name: claude-context`) and a
`skills/claude-context/SKILL.md` subdirectory produce that same name. The root
layout is used here because the reference recommends it for a stable,
install-directory-independent name. The unqualified `/claude-context` resolves to
it when no other skill shares the name (documented for project/nested skills; treat
it as best-effort for plugin skills and verify during implementation). The setup
command is `/claude-context:setup`.

**Runtime:** self-contained Node ESM, **zero dependencies, no build step**. The
collector and reporter are `.mjs` run directly (no `dist/` compile step, unlike
claude-hud's TypeScript build). Requires Node 18+ or Bun (the same requirement
`claude-hud` documents, and generally present wherever Claude Code runs).

## 7. Setup, distribution, and interop

- **Install:** `/plugin marketplace add <owner>/claude-context` →
  `/plugin install claude-context`. `defaultEnabled` may be left unset (it
  defaults to `true`); the collector is the opt-in part, not the plugin.
- **Without setup:** `/claude-context` still returns full **context** health from
  the transcript fallback. Only live 5h/7d usage requires the collector.
- **`/claude-context:setup`:** writes a `statusLine` entry into the user's
  settings that invokes `collect.mjs` through a **version-resilient** path
  (resolving the newest installed plugin version at runtime, following the pattern
  in `claude-hud/commands/setup.md`, since `${CLAUDE_PLUGIN_ROOT}` changes on
  update and `statusLine` is not a valid `plugin.json` field). This is a
  **first-class deliverable**, not a one-line command file: the version-resolution
  and invocation must work across macOS/Linux bash, Windows Git Bash/MSYS, and
  Windows PowerShell, each with its own quoting and runtime-detection rules. Reuse
  claude-hud's battle-tested version-resolution command strings rather than
  re-deriving them, and test against the platform matrix in §8. After wiring,
  setup verifies the collector is producing a snapshot.
- **Existing statusline (replace-or-keep):** if a `statusLine` entry is already
  present, setup does **not** overwrite it silently. It backs up the current
  setting (as claude-hud does) and asks the user to **replace** it with the
  collector or **keep** their own. Keeping means `/claude-context` reports
  context-only (no live 5h/7d). The collector never runs, captures, or appends to
  another statusline command — there is no chaining.
- **claude-hud (optional, never required):** claude-hud is just one possible
  existing statusline, handled by replace-or-keep above. The plugin does **not**
  read claude-hud's own external-usage snapshot and does **not** ask claude-hud to
  write ours — our collector is always the single writer of the rich
  `snapshot.json`. Nothing in the plugin depends on claude-hud being present, and
  the plugin never errors or degrades when it is absent.

## 8. Testing

Node's built-in `node:test` (matching `claude-hud`). Coverage:

- Snapshot **write** (atomic, throttled, correct shape/permissions) and **read**
  (including staleness rejection and malformed-input handling).
- **Native-percentage capture**: when stdin carries `context_window.used_percentage`,
  the snapshot stores it; otherwise it is computed from token math.
- **`resets_at` conversion**: epoch-seconds stdin values become correct ISO
  timestamps (and `resets_in_seconds` in the report).
- **Config-dir resolution**: writer and reader agree on the snapshot path with and
  without `CLAUDE_CONFIG_DIR` set.
- Transcript **last-usage extraction** (correct token sum from the final
  assistant message; duplicate-usage de-duplication as in
  `claude-hud/src/transcript.ts`).
- **Model → window-size** inference (200k default; 1M variants).
- **Token math** (percentage, headroom) and **time formatting** (resets-in / at).
- **Fallback path**: no/stale snapshot → context-only report with `source:
  "transcript"` and `null` usage/cost.
- **Subscriber-null path**: fresh snapshot with no `rate_limits` → `source:
  "collector"`, `rate_limits_status: "unavailable_plan"`, context and cost
  populated, 5h/7d `null` with the "not available for this plan" message.
- **Cold-start path**: no snapshot *and* no usable assistant `usage` → `source:
  "unavailable"`, `null` context fields, one-line message, and never `NaN`,
  divide-by-zero, or a crash.
- **Session selection**: snapshot present → transcript pinned from its
  `transcript_path`; no snapshot → newest-`.jsonl`-in-cwd heuristic with the
  output labeled heuristic (§5.2).
- **Compactions**: always sourced from the transcript (valid-timestamp
  `compact_boundary` entries) in both collector and fallback modes.
- **Setup (platform matrix)**: version resolution and statusLine command
  generation validated for macOS/Linux bash, Windows Git Bash/MSYS, and Windows
  PowerShell; and the replace-or-keep branch (empty slot → take it; existing
  statusline → back up and ask, never overwrite silently).
- **Report shape**: human block and JSON block match the contract in §5; no
  `suggested_action`, no evaluative labels, and no derived metrics ever appear.

Fixture transcripts and sample stdin payloads mirror `claude-hud`'s test approach.

## 9. Explicit non-goals

- No recommendations, suggested actions, or evaluative/level labels of any kind.
- No policy computation (no "should compact", no threshold/70-85-90 rules).
- No derived or predictive metrics (context-growth rate, estimated turns to
  compaction, average tool cost, etc.). Raw measurements and provenance only; any
  derivation is the consumer's to do.
- No dependency on claude-hud.
- No always-on MCP server in this iteration (kept possible for a later addition).
- No network calls, credential scraping, or undocumented API use. Local-only,
  consistent with `claude-hud`'s security posture.

## 10. Assumed defaults (adjustable)

- Collector prints a compact one-line statusline summary by default; `--silent`
  suppresses it.
- Snapshot lives at `<config-dir>/claude-context/snapshot.json`, mode `0600`,
  where `<config-dir>` honors `CLAUDE_CONFIG_DIR`.
- Snapshot write throttle: ≈30s (per claude-hud). Reader staleness window for
  "fresh": 5 minutes — so if the statusline stops refreshing (idle session), the
  snapshot naturally ages out and the report falls back to transcript.
- If a `statusLine` command already exists, setup backs it up and asks
  replace-or-keep rather than overwriting; an empty slot is simply taken over.
- `claude-hud/` remains in the repo as reference and is excluded from the shipped
  plugin.
