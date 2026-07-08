# claude-context — co-existing statusline

**Date:** 2026-07-08
**Status:** Revised per two pushback reviews (2026-07-08); ready for implementation planning
**Supersedes/extends:** builds on `2026-07-07-claude-context-plugin-design.md`. Where
the two disagree on setup behavior, **this document wins.**

> **Revision note (2026-07-08 pushback).** This spec originally proposed two features:
> a co-existing statusline (**Part A**) and a model-window fallback (**Part B**). Part B
> was **dropped** in review — see §8. The plugin keeps its current behavior of reporting
> nothing (and directing the user to `/claude-context:setup`) when no collector snapshot
> exists. What remains below is the co-existence design, tightened per the review.

> **Revision note (2026-07-08, second pushback).** A second review made four changes,
> folded into the sections below: (1) the marker ships in the **same** release as
> `coexist.mjs`, so no legacy marker-less-collector fallback is needed (§3.3); (2) the
> latency **budget** is replaced by a machine-dependent, recorded-and-disclosed
> measurement with **no asserted millisecond bound** (§3.4, §3.5, §5); (3) native
> PowerShell/cmd co-existence is **staged as a follow-up** — POSIX + Windows Git Bash
> co-exist now, native PowerShell is keep-only (§3.3, §3.5, §7); (4) the full-file backup
> is written **mode `0600`** and its mode is test-asserted (§3.5, §3.8, §5).

## 1. Purpose

One change, driven by one principle: **the plugin must never take away or break a
user's existing tools.**

**Co-existing statusline.** Today `/claude-context:setup` only takes an *empty*
statusline slot; if something else (e.g. `claude-hud`) owns it, setup offers
replace-or-keep, and "keep" leaves the plugin with no data at all. This design
replaces that either/or with **invisible co-existence**: setup wraps the existing
statusline so both run, the user's **displayed content is unchanged**, and a new
`/claude-context:teardown` restores the original verbatim. Setup **never** offers to
replace, and **never** seizes a slot it doesn't own.

This change preserves the plugin's **one non-negotiable contract**: it is an
**instrument, not an advisor** — pure measurements and provenance, no
recommendations, labels, thresholds, or policy. Nothing here adds advice.

## 2. Background: the constraints that force this design

Restated from the base spec, because the whole design turns on them:

- Claude Code delivers `context_window`, `rate_limits`, and `cost` **only to the
  statusline process, via stdin.** A skill/command invoked by an agent gets no
  stdin. This is confirmed by reading `claude-hud`: every native number it shows
  comes from stdin (`claude-hud/src/index.ts:82`, `src/stdin.ts`); its
  `external-usage.ts` is an *inter-tool file exchange* (usage only), **not** a second
  channel from Claude Code. There is no supported non-statusline source for context
  size, rate limits, or cost. **Therefore capturing them requires being — or
  wrapping — the statusline.**

- Claude Code has exactly **one** statusline slot. Two tools can only share it by
  one wrapping the other.

## 3. Co-existing statusline

### 3.1 Behavior: an invisible transparent tap

When setup wraps an existing statusline, claude-context becomes an **invisible tap**:
it reads stdin, writes its snapshot, and passes stdin through unchanged to the
original command, whose output is the *only* thing displayed. The user sees no change
in the **displayed content**. (Co-existence does add a per-refresh **latency** —
the wrapper runs ahead of the original tool on every refresh — which §3.4 measures and
discloses at setup, without asserting a fixed bound. "No visual change" means *content*,
not *timing*.)

### 3.2 Two wiring modes, chosen by the slot's contents at setup time

| Slot at setup | What we wire | Displayed line | Sidecar? |
|---|---|---|---|
| Empty / missing | `collect.mjs` (existing behavior) | our own compact line | no |
| A foreign command (claude-hud, etc.) | `coexist.mjs` | the *original* tool's line, unchanged | yes — stores the original |
| Already ours (carries our marker; see §3.3) | idempotent refresh of the resolved plugin path; **never re-wrap / nest** | unchanged | unchanged |

An empty slot still makes us the visible statusline (an invisible tap with nothing
to tap would be blank). We only go invisible when there is a real tool to preserve.
"Already ours" is decided by the **ownership marker** (§3.3), never by exact-matching a
resolved command string. (The foreign-command row ships for **POSIX + Windows Git Bash**;
native PowerShell/cmd co-existence is staged — §3.3, §7 — and there a foreign slot is
handled **keep-only**.)

### 3.3 Mechanism: a Node wrapper + a data sidecar

`statusLine.command` for the wrapped case is a **stable** invocation of
`scripts/coexist.mjs` (resolved to the newest installed plugin version exactly as
`collect.mjs` is today — bash re-glob on macOS/Linux/Git Bash, a Node launcher on
PowerShell). The user's original `statusLine` object is stored as **data** in a
sidecar, never interpolated into a shell string:

- **Sidecar:** `<config-dir>/claude-context/coexist.json`, mode `0600`, in the
  stable config dir (survives plugin upgrades). Stores the **entire original
  `statusLine` object** (not just the command string) so teardown restores it
  verbatim, plus a `wrapped_at` timestamp.

This "original-as-data" choice is a real win, but a bounded one: **our `settings.json`
never embeds the original as a substring**, so we author no escaped shell string, and
teardown is a pure data operation that keeps `settings.json` holding only our marked
`coexist.mjs` invocation. The original is handed to a shell **once**, at spawn time, as
a **single argument** (§3.4) — so escaping is not "eliminated," it is confined to that
one well-defined spawn, which §3.4 specifies per platform.

**Ownership marker.** Every command we write — `collect` and `coexist`, all platforms —
carries a **stable sentinel** that does not depend on the version-resolved path (e.g. an
env assignment `CLAUDE_CONTEXT_WRAPPER=collect` / `=coexist`, or an equivalent fixed
marker token embedded in the command). Ownership detection (§3.6) keys on the marker's
**presence and variant**, never on exact-matching the resolved command string — which
legitimately changes across plugin upgrades, `bun`-vs-`node`, or a different
`CLAUDE_CONFIG_DIR`. This makes "is this slot ours, and is it `collect` or `coexist`?" a
version-resilient, **tested** predicate (§3.8) rather than a brittle string compare (a
false "ours" would clobber a foreign tool; a false "foreign" would nest or block
teardown).

**No legacy fallback needed.** The marker is introduced by **this same release** as
`coexist.mjs`, and the plugin has no installed base of marker-less `collect.mjs` commands
in the wild, so ownership detection can rely on the marker alone — no path-shape fallback
for pre-marker installs. The one obligation this creates: ship the marker and co-existence
in **one** version and never release the marker separately later, which would open a
marker-less window in which an existing collector could be misread as foreign and
self-wrapped.

**Windows co-existence scope.** The wrapped path ships for **POSIX and Windows + Git
Bash** — both use the §3.4 POSIX `sh -c` spawn (Git Bash provides `sh`). **Native
PowerShell/cmd co-existence is a staged follow-up (§7):** the nested-`cmd` + batch-`%%`
materialization it requires (§3.4) is the riskiest corner in the feature and is
deliberately kept off this release's critical path. On native PowerShell/cmd a foreign
slot is therefore handled **keep-only** — setup changes nothing and reports that
co-existence isn't wired there yet (never a silent replace), preserving §1.

### 3.4 `coexist.mjs` runtime flow — ordered for maximum safety

1. Read all of stdin into a buffer.
2. **Spawn the original** command (from the sidecar), per platform:
   - **POSIX:** `spawn('sh', ['-c', originalCommand])` — the command is a single argv
     element, so we author no escaping; the shell receives it intact.
   - **Windows + Git Bash:** uses the same POSIX `sh -c` spawn above (Git Bash provides
     `sh`), so no extra escaping is authored. **Native PowerShell/cmd is deferred (§3.3,
     §7).** The follow-up that adds it will materialize the stored command into a `0600`
     `.cmd` file in the sidecar dir at wrap time and spawn `cmd /c <that>.cmd` (so cmd
     reads the body line-by-line instead of re-quoting an arbitrary, quote-laden,
     possibly already-`cmd /c` original) — and must solve the batch `%` → `%%` quirk
     **concretely, with a `%`-bearing test fixture**, rather than assume it away.

   Write the buffered stdin to the child, pipe its stdout straight to ours, and
   propagate its exit code. *This is the guaranteed path — the child is running before
   any snapshot work.*
3. `try { buildSnapshot(stdin); writeSnapshot(...) } catch {}` — best-effort,
   in-process (reusing the existing `collect.mjs`/`lib` functions), **after** the
   spawn so it can never block or crash the child.

**Lean hot path.** Keep the wrapper's *pre-spawn* work minimal — read stdin, resolve
the sidecar, spawn the child — and **lazy-load** the snapshot lib so `token-math` /
`time` / etc. are not parsed until *after* the child is on its way. The wrapper's own
Node cold-start sits in front of the original on every refresh; everything non-essential
is deferred past the spawn.

**Latency.** Wrapping adds a **second Node cold-start** — the wrapper runs, then spawns the
original, which for a Node tool like `claude-hud` is itself another cold-start — ahead of
the original on every ~300ms refresh, against a base setup that already treats **300ms as
the render ceiling** (it moved the PowerShell version scan into a launcher for exactly this
reason). This overhead is **machine-dependent** — Node cold-start alone varies widely by
host and cache state — so this spec sets **no fixed millisecond target and asserts no
millisecond bound**: a hard threshold would be flaky in CI and, worse, dishonest as a
disclosed constant. Instead, three things: the *design* minimizes the overhead (the lean
pre-spawn hot path + lazy-loaded snapshot lib above); the §5 measurement **records and
prints** the wrapped-vs-direct overhead **without asserting a bound**; and setup
**discloses the overhead measured live on the user's machine** against the actual original
in the slot (§3.5) — an honest per-host number, in keeping with the instrument-not-advisor
contract, not a "< Nms" promise.

Failure isolation is therefore **structural**: the original tool runs as long as
stdin is readable and its command is spawnable; the snapshot is a pure side effect
that runs after the child's output is already on its way out. The only way to break
the user's tool is a crash in the wrapper *before* step 2 — which is why the wrapper
stays minimal and gets a dedicated isolation test (§5).

**Snapshot is byte-identical to today's.** The wrapper writes the same format via the
same `lib` functions, and because it *is* the statusline process it receives the full
stdin (context + rate_limits + cost). **The report engine needs zero changes** for
co-existence — a wrapped session produces a normal fresh `collector` snapshot with
full numbers.

**Degraded state:** if the wrapper is wired but the sidecar is missing/corrupt (a
broken half-state), it falls back to printing our own compact line rather than a
blank statusline, giving the user a visible signal that something is off.

### 3.5 Setup UX

- **Empty slot** → wire `collect.mjs` automatically (nothing to preserve).
- **Foreign command (POSIX / Windows Git Bash)** → a **single confirm** (proceed / cancel
  — *not* a replace/keep menu). Show the redacted, truncated original, explain
  co-existence + teardown, and **disclose the per-refresh latency overhead measured live
  on this machine** against the original in the slot (§3.4). On *proceed*: write the
  sidecar, then wire `coexist.mjs` with an **atomic** `settings.json` write. On *cancel*:
  change nothing, and state honestly that claude-context will have **no** live numbers
  until setup runs and co-exists (the old "still works in transcript-only mode" copy was
  inaccurate — with a foreign tool owning the slot and no snapshot ever written, there is
  nothing).
- **Foreign command (native PowerShell/cmd)** → co-existence is not yet wired there (§3.3,
  §7). Setup makes **no change** — **keep-only**, never a silent replace — and reports
  that co-existence isn't available on native PowerShell yet; the user keeps their
  statusline and can get live numbers via Git Bash or a future release.
- **Already ours** (marker present) → idempotent refresh; never nest.

**Full-file backup.** Before its first mutating write, the wiring module writes exactly
**one** full-file backup of `settings.json` to a **stable** path
(`settings.json.claude-context.bak` — overwritten each run, so no per-run timestamp
clutter), **mode `0600`** in the `0700` config dir. That mode is not incidental: because
`~/.claude/settings.json` routinely holds an `env` block with API keys/tokens, a
world-readable backup beside it would leak them — so the backup matches the `0600` every
other file this plugin writes (snapshot, sidecar). The sidecar restores the `statusLine`
object; this backup is the **whole-file recovery net** against a bad merge in the single
most dangerous operation (§3.8), since `~/.claude/settings.json` is frequently not under
version control. Teardown removes it on clean completion. This replaces the old per-write
timestamped `.bak` (which cluttered): **one** backup — not none, and not many.

### 3.6 Teardown (`commands/teardown.md`, new)

Ownership is decided by the §3.3 **marker** — which variant (`collect` / `coexist`), if
any, the current `statusLine` command carries — never by exact-string-matching a
resolved command.

- **Sidecar present + slot carries our `coexist` marker** → restore `statusLine` = the
  stored original object (atomic), delete the sidecar, remove the backup, tell the user
  to restart.
- **Slot carries our bare `collect` marker, no sidecar** (empty-slot install) → remove
  our `statusLine` entry, back to empty.
- **Never clobber a slot we don't own.** If the current `statusLine` carries **neither**
  our `collect` **nor** our `coexist` marker (the user or another tool changed it since
  setup), do **not** overwrite — report the situation and print the stored original so
  the user can restore by hand.
- **Idempotent:** nothing of ours wired → say so, no-op.

### 3.7 Interaction with a third statusline tool (fail-safe, not resurrect)

If a third plugin later **overwrites** the slot (the common case — most statusline
setups just assign the slot), the chain breaks: the third plugin displays, and both
the original tool and claude-context stop (our wrapper, which ran the original, is no
longer invoked). **No plugin can prevent another from overwriting `settings.json`;**
this is a Claude Code single-slot reality, not something this design can veto. The
design's obligation is to **fail safe**, and it does:

- **No data loss** — the original command is still in the sidecar, recoverable.
- **Teardown won't compound it** — the never-clobber-unowned rule (§3.6) means
  teardown refuses to overwrite the third plugin and instead reports the stored
  original.
- **Orphaned-sidecar detection** — if setup later runs and finds a foreign command in
  the slot **while a sidecar already exists** (something displaced us), it **must not
  silently overwrite** the stored pointer; it surfaces the situation
  ("another statusline replaced claude-context; your previously-preserved statusline
  was X") rather than losing X.

**Deliberate non-goal (YAGNI):** claude-context stays **1-deep** — it reliably
co-exists with exactly one prior statusline. It is **not** an N-way multiplexer that
runs and merges several tools' output (that is a different feature with its own
"which line wins?" UX). If a third tool won't itself chain, our job ends at *fail
safe + recoverable*.

### 3.8 The riskiest operation is scripted and tested

The `settings.json` read-modify-write (wrap on setup, restore on teardown) plus
sidecar management is the single most dangerous operation — a bad merge or a
non-atomic write breaks the user's tool. It is therefore implemented as a **small,
tested wiring module** (`scripts/wiring.mjs`) that both commands invoke, rather than
re-derived from prose on every run. This makes the following into **test-enforced
guarantees**: atomicity; idempotency; **never-clobber-unowned** (decided by the §3.3
marker, not a string compare); a **single `0600` full-file backup** before the first
mutating write; and **orphaned-sidecar detection**. The markdown commands shrink to: detect
platform/runtime, resolve the plugin path, call the wiring module, report the outcome.
(This is a small, deliberate departure from the all-markdown setup convention, justified
by the safety stakes.)

## 4. Architecture / new components

- **New `scripts/coexist.mjs`** — the invisible-tap wrapper (§3.4). New I/O entry
  point (spawns the child, writes the snapshot). Ships for **POSIX + Windows Git Bash**
  (the `sh -c` spawn). *(Native PowerShell/cmd — materializing the stored original into a
  `0600` `.cmd` for spawning — is the staged follow-up, §7.)*
- **New `scripts/wiring.mjs`** — tested `settings.json` + sidecar surgery for setup
  and teardown (§3.8): atomic read-modify-write, one full-file backup before the first
  write, marker-based ownership detection, orphaned-sidecar handling. New I/O entry
  point.
- **New `commands/teardown.md`** — the teardown command (§3.6).
- **Modified `commands/setup.md`** — co-exist wiring + single-confirm + latency
  disclosure + orphaned-sidecar handling; delegates surgery to `wiring.mjs`.
- **Report engine unchanged.** Co-existence produces a normal fresh `collector`
  snapshot, so `report.mjs` and its state machine need **no** changes.
- **Runtime files (not shipped):** `coexist.json` (sidecar),
  `settings.json.claude-context.bak` (one full-file backup, removed on clean teardown),
  and on Windows the materialized original `.cmd`.

The "only two I/O entry points" convention grows to four (`collect`, `report`,
`coexist`, `wiring`); `lib/*` stays pure.

## 5. Testing

- **New `tests/coexist.test.mjs`** (safety-critical): writes a correct snapshot from
  stdin; spawns the child, forwards stdin, pipes its stdout through, and adds nothing
  of its own; **failure isolation** — snapshot write throws yet the child still runs
  and its output still appears; child spawned even when snapshot building throws
  synchronously; missing/corrupt sidecar → degrades to our own line; **forwards a
  realistic quote-laden original** (a representative `claude-hud` `bash -c '…'` string,
  with its nested `'"'"'` quoting) via the POSIX/Git-Bash `sh -c` spawn and asserts the
  child runs and its stdout passes through (issue 6); **records and prints the wrapper's
  added latency** over invoking the original directly — a machine-dependent measurement
  for disclosure, **asserting no millisecond bound** (issue 4, Option A).
- **New `tests/wiring.test.mjs`**: empty → wires `collect.mjs` (marked), no sidecar;
  foreign → sidecar stores the whole original `statusLine` object + wires `coexist.mjs`
  (marked), atomically, preserving other settings keys; **writes exactly one full-file
  backup before the first mutating write, and asserts its mode is `0600`** (issue 3 +
  Issue 4); idempotent for already-ours **via marker detection**, never nests (issue 5);
  teardown restores the original verbatim, deletes the sidecar, **and removes the
  backup**; **never-clobber-unowned** (decided by marker, not string compare);
  **orphaned-sidecar detection**.
- **Rewritten `tests/setup.test.mjs`**: replace the Replace/Keep/backup assertions
  with positive facts — wires `collect.mjs` for empty and `coexist.mjs` for occupied,
  calls the wiring module, references `/teardown`, keeps the platform matrix and the
  snapshot-glob check. (Assert positive presence, **not** word-absence — the doc
  legitimately says "never replaces", so grepping for "replace" would false-positive,
  per the base contract's warning.)
- Unchanged and still green: **report core (now entirely unchanged)**, snapshot,
  token-math, time, transcript, config-dir, collect, manifest, skill, docs. The Task-9
  denylist over `report.mjs` output is unaffected.

## 6. Documentation

- **README.md** — rewrite "Already have a statusline?" into the co-exist story (runs
  alongside your tool invisibly, displayed content unchanged, a **per-refresh overhead
  disclosed at setup**, undo with `/teardown`), noting co-existence is available on
  **POSIX and Windows + Git Bash** today (native PowerShell keeps its statusline
  untouched for now — §7), plus a short "what if another statusline plugin takes over?"
  fail-safe note. **Do not claim any zero-setup functionality** — the
  plugin reports nothing until setup runs (the "works with zero setup" selling point is
  removed; §8). Preserve the substrings the docs test requires
  (`/plugin install claude-context`, `/claude-context:setup`, the "no
  advice/recommendations" phrase).
- **CHANGELOG.md** — a new versioned entry for co-exist + teardown.
- **CLAUDE.md** — rewrite the "Setup wiring" convention bullet (co-exist by wrapping
  invisibly and reversibly on **POSIX + Git Bash** — native PowerShell staged, keep-only
  for now; never replaces; teardown restores verbatim; a tested wiring script does the
  surgery, including one `0600` full-file backup + marker-based ownership; stays 1-deep;
  fails safe). Update the entry-point count (2 → 4). (No report state-machine change —
  Part B was dropped, §8.)

## 7. Non-goals

- **Not** an N-way statusline multiplexer (stays 1-deep; §3.7).
- **No** change to the report engine's states — co-existence produces a normal
  `collector` snapshot; the report is untouched.
- **No** recommendations, labels, thresholds, or policy — the instrument-not-advisor
  contract is unchanged.
- **Staged follow-up (not in this release):** native PowerShell/cmd co-existence, which
  requires materializing the stored original into a `0600` `.cmd` and spawning nested
  `cmd` (with the batch `%` → `%%` quirk solved concretely and covered by a `%`-bearing
  test). Until it lands, native PowerShell/cmd handles a foreign slot **keep-only**
  (§3.3, §3.5); POSIX and Windows + Git Bash co-exist now.
- **Dropped from this spec:** the model-window fallback and its per-model default table
  and `config.json` override (§8).

## 8. Dropped: model-window fallback (Part B)

An earlier draft of this spec included **Part B**: with no collector snapshot, the
report would compute context % from the transcript against a per-model **default 200K
window** (or a user-declared `config.json` override), flagged with a new
`window_size_source` provenance field — the goal being a context reading with *zero
setup*. It was **dropped** in the 2026-07-08 pushback review for three converging
reasons:

1. **No way to locate the transcript.** With no snapshot there is no `transcript_path`;
   the report receives only `--session-id`. Reading a transcript would require
   resurrecting the `session-id`→transcript resolver (`transcriptForSession` /
   `encodeProjectDir` / `findNewestTranscript`) **deliberately deleted in `ffc3421`**
   because it re-introduced the cwd-guessing cross-session-read bug that `C1` removed.
2. **State-machine contradiction.** A not-set-up session would carry
   `setup_required: true` (which today forces the `COLD_START_HUMAN` "nothing to
   measure" block) **alongside** a computed context %, and `source: transcript`
   hardcodes "window from snapshot" in the human rendering — both would need reworking.
3. **Conflicts with prominent setup.** The decision to make setup prominent and have
   the skill **take no action** when setup has not run is the opposite of Part B's
   "produce an approximate reading with no setup."

**Resulting behavior (unchanged from today):** with no collector snapshot the report
reports nothing (everything `null`, `setup_required: true`) and directs the user to
`/claude-context:setup`. The **"works with zero setup" goal is explicitly removed.** If
a per-model / declared-window denominator is ever wanted, it returns as its own spec,
with the transcript-location and rendering problems solved first.
