# claude-context

> ⚠️ **Alpha software.** Early and actively changing: expect breaking changes between
> versions and rough edges. **macOS, Linux, and Windows + Git Bash only** (POSIX shells) —
> native PowerShell/cmd is unsupported this release. Everything setup touches is reversible
> with `/claude-context:teardown`.

**Your agents can't manage a budget they can't see.** `claude-context` gives Claude
Code and its subagents a live, machine-readable read of their own context window,
subscription usage, and cost — so they can follow *your* rules about when to stop,
checkpoint, or hand off.

On demand, any agent in your session can ask *"how much have we used?"* and get back
context-window occupancy, 5-hour and 7-day usage, session cost, and compaction count
— as plain numbers it can branch on. You write the rule; the agent reads the gauge.

## Why this matters: the silent auto-compaction trap

When a session fills up, Claude Code **auto-compacts** — it summarizes the
conversation to make room. Helpful, until it quietly drops the very instructions you
were relying on. This isn't hypothetical; it's a recurring, documented failure:

- Auto-compact loses the instructions from your most recent request —
  [claude-code#22376](https://github.com/anthropics/claude-code/issues/22376)
- Your `CLAUDE.md` project rules get summarized away, and the agent stops following
  them — [claude-code#24460](https://github.com/anthropics/claude-code/issues/24460),
  [claude-code#6354](https://github.com/anthropics/claude-code/issues/6354)

An agent working blind hits that wall at full speed. An agent that can **watch its
own context percentage** doesn't. Give it a rule —

> *"Before context passes 50%, write the current plan and key decisions to
> `PROGRESS.md`, then stop for review."*
> *"Don't start a new subtask above 40% context."*

— and it acts *before* the compaction it otherwise never sees coming, so your
guidance survives.

## The same goes for your budget

Subscription limits are just as invisible to an agent mid-task. With `claude-context`
it can honor guardrails you set:

> *"If we're about to cross 80% of the weekly limit, summarize progress and pause."*
> *"Don't fan out three subagents when the 5-hour window is nearly spent."*

Your agents can only make those calls if they can read the numbers.

## Instrument, not advisor — on purpose

`claude-context` gives **no advice and no recommendations** of its own — no baked-in
thresholds, no "you should compact," no traffic lights. That's not a missing feature;
it's the whole design. The plugin supplies the *facts*; **your** instructions supply
the *policy*. The 40% rule, the budget guardrail, the checkpoint trigger — those live
in your `CLAUDE.md`, your skills, and your subagent prompts, where you control them. A
tool that hard-coded its own thresholds would just fight the ones you wrote.

## Doesn't `/context` already show this?

At your keyboard, largely yes — and in more detail. Claude Code's built-in `/context` breaks
context usage down by category (system prompt, tools, MCP, skills, messages) more thoroughly
than this plugin's single context line. If a human reading the terminal is all you need,
reach for `/context`.

But `/context` is a command **you type**: it runs inside Claude Code and prints to your
screen. There is no tool, script, or CLI entry point an *agent* can call to produce it — a
subagent mid-task can't run `/context` and read the result, it would have to ask you to type
it and wait. `/context` also can't show 5h/7d usage, cost, or compaction count at all,
because those reach only the statusline (see [below](#turn-on-live-usage-and-cost)), never
the transcript `/context` reads from.

`claude-context` is for the other side of that line. Its report is backed by a plain script
an agent runs and parses as JSON — the programmatic entry point `/context` lacks — and it
carries the usage, cost, and compaction numbers `/context` can't see. **`/context` is for
you; `claude-context` is for your agents.**

## Install

Add marketplace:

```
/plugin marketplace add Ovid/claude-context
```

Install (must be a separate prompt):

```
/plugin install claude-context@claude-context
```

Set up:

```
/claude-context:setup
```

Then any agent — or you — can ask:

```
/claude-context:claude-context
```

Or:

```
/claude-context
```

Reporting requires the one-time `/claude-context:setup` (see below). Before that's
been run, the report itself explains how to enable it rather than guessing at
numbers it doesn't have. Once set up, it returns a short human summary **and** a
machine-readable JSON block, so an agent can parse its own resource state directly:

```
Claude Context — Opus 4.8 (1M context)
Context: 25% used · 245k / 1M tokens · 755k headroom
Session (5h): 9% used · resets in 2h 16m (at 14:30)
Weekly (7d): 2% used · resets in 6d 21h
Cost: $24.94 · Compactions: 0
Source: collector · snapshot 3s old
```

## How your rules read the numbers

The report returns two shapes of the same reading: the human summary above, and the
machine-readable JSON an agent branches on (abbreviated here to the fields rules use — the
full block also carries the token breakdown, `resets_at` timestamps, `model`, and
`session_selection`):

```json
{
  "context":     { "used_percentage": 25, "used_tokens": 245000, "window_size": 1000000, "headroom_tokens": 755000 },
  "rate_limits": {
    "five_hour": { "used_percentage": 9, "resets_in_seconds": 8160 },
    "seven_day": { "used_percentage": 2, "resets_in_seconds": 594000 }
  },
  "cost_usd": 24.94,
  "compactions": 0,
  "source": "collector",
  "rate_limits_status": "available",
  "setup_required": false,
  "snapshot_age_seconds": 3
}
```

An agent doesn't watch these numbers on its own — it reads them only when a rule tells it
to. So a working rule names *when* to check, *which field* to read, and *your* threshold.
Put something like this in your `CLAUDE.md`, a skill, or a subagent prompt:

```markdown
## Resource guardrails

Before starting a new subtask, run `/claude-context` and read the JSON block:

- If `context.used_percentage` is above 50, write the current plan and open decisions
  to `PROGRESS.md`, then stop for review.
- Before fanning out subagents, if `rate_limits.five_hour.used_percentage` is above 80,
  summarize progress and pause instead of spawning them.
- If `rate_limits.seven_day.used_percentage` is above 80, stop and tell me first.
- If `setup_required` is true or `rate_limits_status` is not `available`, the number
  isn't live — say so instead of acting on a stale or missing value.
```

The thresholds (50, 80) and the actions are yours; the plugin only supplies the fields —
facts from the tool, policy from you.

## Turn on live usage and cost

Every number in the report — context health included — comes from the collector, so
enable it once:

```
/claude-context:setup
```

This wires a small statusline helper — the **collector** — into your Claude Code
settings. (Live 5h/7d usage requires a Pro or Max subscription.)

**Why a statusline, though?** Claude Code sends the live context-window size,
subscription usage, and cost to exactly **one** place: the process that renders your
statusline, over stdin, a few times a second. A slash command or skill run mid-session
— like the report — gets none of that. It can only read the session transcript, which
carries token counts but no usage and no cost. So the only way to see those numbers is
to sit in the statusline slot, record each update to a private per-session snapshot,
and read that snapshot back when the report runs. That snapshot is the entire reason
`/claude-context:setup` exists — the collector is not a display, it's a tap.

### Already have a statusline?

Only one thing can hold the statusline slot, so claude-context **co-exists** rather than
evict. `/claude-context:setup` first copies your existing statusline command into a private
sidecar file, then puts itself in the slot as a wrapper that runs your original *and* taps
its input for the snapshot. Both run; your **displayed line is unchanged**. Because the
original was saved verbatim, `/claude-context:teardown` restores that exact statusline and
removes the sidecar. Setup **never** replaces or takes over a slot it doesn't own.

Co-existence is available on **macOS, Linux, and Windows + Git Bash** in this alpha. On
**native PowerShell/cmd** claude-context does not wire a statusline this release (a change
from 0.2.0, which shipped an empty-slot PowerShell collector) — run Claude Code from **Git
Bash** for live numbers, or wait for a later release.

**What if another statusline plugin later takes over the slot?** claude-context fails safe:
your original command is still stored, `/claude-context:teardown` refuses to clobber the new
tool and instead shows you the preserved original. claude-context stays one level deep — it
co-exists with exactly one prior statusline, not several.

### Platform support and limits

- **macOS / Linux** — fully supported.
- **Windows + Git Bash** — supported, but everything runs through `bash`: the collector
  command *and* any statusline it wraps are executed via `bash -c`, so Git Bash must be on
  your `PATH`, and a foreign statusline is re-spawned under bash rather than your native shell.
- **Native PowerShell / cmd** — setup makes no change this release (see above). Run Claude
  Code from Git Bash for live numbers.
- **How setup tells them apart on Windows** — it runs `bash -c 'echo $OSTYPE'`, whatever
  shell the session uses. `msys`/`cygwin` means Git Bash is on `PATH` and setup proceeds
  (even from a PowerShell session); anything else, including WSL's `bash.exe`
  (`linux-gnu`) or no `bash` at all, is treated as native PowerShell.
- **File privacy is POSIX-only.** On macOS/Linux the snapshot, the co-existence sidecar, and
  the one-time `settings.json` backup are written owner-only (`0600`). Windows filesystems
  don't honor those mode bits, so on Windows those files are private *by location*, not by OS
  permission — treat a shared Windows machine accordingly.
- **`settings.json` gets normalized.** Setup and teardown rewrite `settings.json` as standard
  2-space JSON. Your original **statusline** is restored verbatim; the surrounding file's own
  indentation and key order are not preserved.

## Every number says how much to trust it

An agent making decisions needs to know when a reading is solid and when it's a
fallback. So every report carries its own provenance: where each number came from
(`source`), whether subscription usage is actually available (`rate_limits_status`),
whether the collector has ever been set up (`setup_required`), and whose session the
numbers belong to (`session_selection`). A missing or stale figure is labeled as
such — never dressed up as a live one — so your rules never fire on a number that
isn't real.

## Whose numbers are these?

The **context** reading is the *session's* — the main agent's context window (what
Claude Code's statusline sees). Subscription **usage (5h/7d)** and **cost** are
*account-wide*, shared across the main agent and every subagent.

So when a subagent asks, it reads the **session's** context, not a private window of
its own. That's usually the signal you want: a subagent can tell whether the
**parent** session is nearing auto-compaction and checkpoint its findings before
that guidance is lost. It is **not** a per-subagent context gauge — a subagent
cannot read its own private context this way.

## Credits

`claude-context` adapts battle-tested statusline and transcript-parsing code from
[claude-hud](https://github.com/jarrodwatts/claude-hud) by Jarrod Watts, used under
the MIT License. Thank you.

## License

MIT — see [LICENSE](./LICENSE).
