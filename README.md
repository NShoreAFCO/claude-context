# claude-context

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

> *"Before context passes 70%, write the current plan and key decisions to
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

## Install

```
/plugin marketplace add Ovid/claude-context
/plugin install claude-context@claude-context
```

Then any agent — or you — can ask:

```
/claude-context:claude-context
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

## Turn on live usage and cost

Every number in the report — context health included — comes from the collector, so
enable it once:

```
/claude-context:setup
```

This wires a small statusline helper that captures the usage and cost figures Claude
Code shares only with your statusline. Already have a statusline? Setup backs it up
and asks before changing anything — it never silently replaces your setup. (Live
5h/7d usage requires a Pro or Max subscription.)

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
