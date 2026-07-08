# claude-context — co-existing statusline

**Date:** 2026-07-08
**Status:** Revised per four pushback reviews (2026-07-08); ready for implementation planning
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

> **Revision note (2026-07-08, third pushback).** A third review cut scope for an **alpha**
> (this note **supersedes the second note's points (2) and (3)**) and tightened three
> behaviors: (1) the **latency budget/measurement is dropped entirely**
> — no latency guarantee, no setup-time disclosure, no latency test; revisit only if it
> becomes a real problem (§3.4, §5, §7); (2) **native PowerShell/cmd is dropped for the
> alpha** — co-existence ships for **POSIX + Windows Git Bash** only, and even the existing
> empty-slot *collect* launcher for native PowerShell is removed; native PowerShell is
> reported as unsupported-for-alpha with **no** settings change (§3.3, §3.5, §7); (3)
> **orphaned-sidecar detection** compares the slot against the stored original and reports
> facts rather than asserting a cause (§3.7); (4) a **runtime-failed original** passes
> through transparently and the snapshot is written **regardless** of child outcome, now a
> documented guarantee (§3.4); (5) the child's **stderr passes through** alongside stdout
> (§3.4).

> **Revision note (2026-07-08, fourth pushback).** A fourth review made three changes and
> accepted one risk, folded into the sections below: (1) the installed-base risk of
> **marker-only ownership detection** — a pre-marker `collect` command from an already-shipped
> 0.2.0 could be misread as foreign on a later setup/teardown — was raised and **accepted
> as-is**; no legacy path-shape fallback is added (§3.3). (2) dropping native PowerShell is
> now called out as an **explicit regression** from 0.2.0's shipped empty-slot PowerShell
> collector, in §7 and §6 (CHANGELOG + README). (3) `wiring.mjs` gains a specified
> **two-phase contract** — a no-write `detect` mode (secret-redaction done in-module) that
> gates a separate `wrap`/`teardown` mutation on the human confirm (§3.8, §4, §5). (4)
> `coexist.mjs` writes the snapshot **without awaiting the child's exit**, so a hung/slow
> original never strands our data, with a matching test (§3.4, §5).

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
in the **displayed content**. (Co-existence does add a per-refresh **overhead** — the
wrapper runs ahead of the original tool on every refresh — which this spec neither bounds
nor measures; see §3.4. "No visual change" means *content*, not *timing*.)

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
native PowerShell/cmd is **unsupported in this alpha** — §3.3, §3.5, §7 — where setup makes
no change and reports it.)

### 3.3 Mechanism: a Node wrapper + a data sidecar

`statusLine.command` for the wrapped case is a **stable** invocation of
`scripts/coexist.mjs` (resolved to the newest installed plugin version exactly as
`collect.mjs` is today — bash re-glob on macOS/Linux/Git Bash). The user's original
`statusLine` object is stored as **data** in a sidecar, never interpolated into a shell
string:

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

**Ownership marker.** Every command we write — `collect` and `coexist`, on both supported
paths (POSIX + Git Bash) — carries a **stable sentinel** that does not depend on the
version-resolved path (e.g. an
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

**Windows scope (alpha).** The wrapped path — and *all* wiring this release writes — ships
for **POSIX and Windows + Git Bash** only; both use the §3.4 POSIX `sh -c` spawn (Git Bash
provides `sh`) and carry the marker in the bash env-assignment form. **Native
PowerShell/cmd is dropped for this alpha (§7)** — not just co-existence but the existing
empty-slot `collect` launcher too: its nested-`cmd` + batch-`%%` materialization (§3.4)
and the lack of a natural env-assignment slot for the marker in the `cmd /c` form are the
riskiest corner in the feature and are deliberately kept off this release. On native
PowerShell/cmd setup therefore **changes nothing** and reports that this alpha is
unsupported there (never a silent replace), preserving §1; live numbers are available via
Git Bash.

### 3.4 `coexist.mjs` runtime flow — ordered for maximum safety

1. Read all of stdin into a buffer.
2. **Spawn the original** command (from the sidecar), per platform:
   - **POSIX:** `spawn('sh', ['-c', originalCommand])` — the command is a single argv
     element, so we author no escaping; the shell receives it intact.
   - **Windows + Git Bash:** uses the same POSIX `sh -c` spawn above (Git Bash provides
     `sh`), so no extra escaping is authored. **Native PowerShell/cmd is out of scope for
     this alpha (§3.3, §7).** If it ever returns, it would materialize the stored command
     into a `0600` `.cmd` file in the sidecar dir at wrap time and spawn `cmd /c <that>.cmd`
     (so cmd reads the body line-by-line instead of re-quoting an arbitrary, quote-laden,
     possibly already-`cmd /c` original), solving the batch `%` → `%%` quirk **concretely,
     with a `%`-bearing test fixture**, rather than assuming it away.

   Write the buffered stdin to the child, pass its stdout **and stderr** straight through
   to ours (inheriting both is simplest — the wrapper adds nothing to either on the normal
   path — and it also forecloses a full-stderr-pipe deadlock in a chatty child), and
   propagate its exit code. *This is the guaranteed path — the child is running before any
   snapshot work.*
3. `try { buildSnapshot(stdin); writeSnapshot(...) } catch {}` — best-effort,
   in-process (reusing the existing `collect.mjs`/`lib` functions), **after the spawn and
   without awaiting the child's exit**, so it can never block or crash the child. The child's
   exit code is propagated by awaiting the child **separately**; the snapshot write does not
   sit behind it, so **a slow or hung original never strands our data.** **The snapshot is
   written regardless of how the child fares** — a broken, missing, non-zero-exiting, *or
   wedged* original still yields a fresh snapshot from this refresh's stdin, so
   claude-context's *data* survives even when the original's *display* is broken (see
   "Runtime-failed original" below).

**Lean hot path.** Keep the wrapper's *pre-spawn* work minimal — read stdin, resolve
the sidecar, spawn the child — and **lazy-load** the snapshot lib so `token-math` /
`time` / etc. are not parsed until *after* the child is on its way. The wrapper's own
Node cold-start sits in front of the original on every refresh; everything non-essential
is deferred past the spawn.

**Overhead (not bounded, not measured).** Wrapping adds a **second Node cold-start** — the
wrapper runs, then spawns the original, which for a Node tool like `claude-hud` is itself
another cold-start — ahead of the original on every ~300ms refresh. This overhead is
**machine-dependent** (Node cold-start alone varies widely by host and cache state), so
this **alpha** sets **no latency target, asserts no bound, and does not measure or disclose
a number** — a latency guarantee we can't honestly make is not worth faking, and a live
setup-time measurement against the real original risked perturbing a side-effecting foreign
tool for a number dominated by cache warmth. The *design* still minimizes the overhead (the
lean pre-spawn hot path + lazy-loaded snapshot lib above); that is the whole of our latency
story for the alpha. If per-refresh cost ever proves a real problem in practice, it returns
as its own concern — by which point the plugin's shape may have moved anyway.

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

**Runtime-failed original.** Distinct from a missing sidecar: if the sidecar is present and
valid but the stored original **fails at runtime** (uninstalled, moved, exits non-zero, or
prints nothing), the wrapper shows **exactly what the original produces — even blank — and
does not substitute our own line.** Masking the user's own tool failing would hide breakage
they need to see; a transparent tap stays transparent even when what it taps is broken. (The
snapshot is still written either way — see step 3 — so the report keeps working regardless.)

### 3.5 Setup UX

- **Empty slot (POSIX / Windows Git Bash)** → wire `collect.mjs` automatically (nothing to
  preserve).
- **Foreign command (POSIX / Windows Git Bash)** → a **single confirm** (proceed / cancel
  — *not* a replace/keep menu). Show the redacted, truncated original, and explain
  co-existence + teardown. On *proceed*: write the sidecar, then wire `coexist.mjs` with an
  **atomic** `settings.json` write. On *cancel*: change nothing, and state honestly that
  claude-context will have **no** live numbers until setup runs and co-exists (the old
  "still works in transcript-only mode" copy was inaccurate — with a foreign tool owning the
  slot and no snapshot ever written, there is nothing).
- **Native PowerShell/cmd (any slot)** → **unsupported in this alpha (§3.3, §7).** Setup
  makes **no change** — never a silent write or replace — and reports that this alpha
  doesn't wire a statusline on native PowerShell yet; the user keeps whatever they have and
  can get live numbers via Git Bash or a later release.
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
- **Orphaned-sidecar detection** — if setup later runs and finds a foreign command in the
  slot **while a sidecar already exists**, it **must not silently overwrite** the stored
  pointer. It first **compares the slot command against the sidecar's stored original**:
  - **They match** (or the slot is unmarked and equals what we would wrap) → a benign state,
    not a hostile one: an install interrupted between the sidecar write and the settings
    write (§3.5's safe ordering makes this transient possible), or a manual revert. Setup
    **resumes normally**, re-wiring `coexist.mjs` against the already-stored original.
  - **The slot is something else entirely** → something we can't attribute changed the slot.
    Setup **reports the facts** ("a preserved statusline exists — X — but the slot now holds
    a command we don't recognize") **without asserting a cause**, and does not overwrite the
    stored pointer, so X is never lost.

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
mutating write; and **orphaned-sidecar detection**.

**Two-phase contract (setup).** A foreign slot requires a human proceed/cancel **before**
any write (§3.5), so the module exposes two modes rather than one do-everything call.
`wiring.mjs detect` reads the current slot and returns
`{ slot: empty | foreign | ours-collect | ours-coexist, preview, stored_original? }`
**with no writes** — and does the secret-redaction + truncation of `preview` **inside the
module**, so the raw command (which may carry tokens) never transits the agent transcript.
The markdown renders the single confirm from that result; only on *proceed* does it call
`wiring.mjs wrap` (or `wiring.mjs teardown`), which performs the mutation. This makes
**"no settings write before the user proceeds"** a test-enforced boundary, not a convention.
(Empty and already-ours slots need no confirm, so setup may call `wrap` directly.)

The markdown commands shrink to: detect platform/runtime, resolve the plugin path, call
`wiring.mjs detect`, render the confirm when the slot is foreign, call
`wiring.mjs wrap`/`teardown` on proceed, report the outcome. (This is a small, deliberate
departure from the all-markdown setup convention, justified by the safety stakes.)

## 4. Architecture / new components

- **New `scripts/coexist.mjs`** — the invisible-tap wrapper (§3.4). New I/O entry
  point (spawns the child, forwards stdin/stdout/stderr, writes the snapshot regardless of
  child outcome). Ships for **POSIX + Windows Git Bash** (the `sh -c` spawn). *(Native
  PowerShell/cmd is out of scope for the alpha, §7.)*
- **New `scripts/wiring.mjs`** — tested `settings.json` + sidecar surgery for setup
  and teardown (§3.8): atomic read-modify-write, one full-file backup before the first
  write, marker-based ownership detection, orphaned-sidecar handling. Exposes a no-write
  **`detect`** mode (returns the slot classification + an in-module-redacted preview) and
  the mutating **`wrap`/`teardown`** modes, so the human confirm gates the write (§3.8).
  New I/O entry point.
- **New `commands/teardown.md`** — the teardown command (§3.6).
- **Modified `commands/setup.md`** — co-exist wiring + single-confirm + orphaned-sidecar
  handling; **removes the native-PowerShell branch** (unsupported this alpha); delegates
  surgery to `wiring.mjs`.
- **Report engine unchanged.** Co-existence produces a normal fresh `collector`
  snapshot, so `report.mjs` and its state machine need **no** changes.
- **Runtime files (not shipped):** `coexist.json` (sidecar),
  `settings.json.claude-context.bak` (one full-file backup, removed on clean teardown),
  and on Windows the materialized original `.cmd`.

The "only two I/O entry points" convention grows to four (`collect`, `report`,
`coexist`, `wiring`); `lib/*` stays pure.

## 5. Testing

- **New `tests/coexist.test.mjs`** (safety-critical): writes a correct snapshot from
  stdin; spawns the child, forwards stdin, passes its stdout **and stderr** through, and
  adds nothing of its own; **failure isolation** — snapshot write throws yet the child still
  runs and its output still appears; child spawned even when snapshot building throws
  synchronously; missing/corrupt sidecar → degrades to our own line; **runtime-failed
  original** — a valid sidecar whose stored original exits non-zero / prints nothing → the
  wrapper adds nothing, propagates the child's exit code, **and still writes the snapshot**;
  **hung/slow original** — a child that stalls (does not exit promptly) → the snapshot is
  still written promptly, not blocked behind the child's exit;
  **forwards a realistic quote-laden original** (a representative `claude-hud` `bash -c '…'`
  string, with its nested `'"'"'` quoting) via the POSIX/Git-Bash `sh -c` spawn and asserts
  the child runs and its stdout passes through.
- **New `tests/wiring.test.mjs`**: empty → wires `collect.mjs` (marked), no sidecar;
  foreign → sidecar stores the whole original `statusLine` object + wires `coexist.mjs`
  (marked), atomically, preserving other settings keys; **marker detection round-trips on
  the bash env-assignment form** (POSIX + Git Bash); **writes exactly one full-file backup
  before the first mutating write, and asserts its mode is `0600`**; idempotent for
  already-ours **via marker detection**, never nests; teardown restores the original
  verbatim, deletes the sidecar, **and removes the backup**; **never-clobber-unowned**
  (decided by marker, not string compare); **orphaned-sidecar detection** (slot matches
  stored original → resume; slot differs → report facts, don't overwrite); **`detect` mode
  returns the slot classification + a redacted, truncated preview and performs no writes**,
  and **`wrap` is a separate call** so a cancel between the two leaves `settings.json`
  untouched (confirm-gates-mutation).
- **Rewritten `tests/setup.test.mjs`**: replace the Replace/Keep/backup assertions
  with positive facts — wires `collect.mjs` for empty and `coexist.mjs` for occupied,
  calls the wiring module, references `/teardown`, keeps the snapshot-glob check. The
  **platform matrix is now POSIX + Git Bash only** — assert the native-PowerShell wiring
  branch is gone and that setup reports native PowerShell as unsupported for this alpha.
  (Assert positive presence, **not** word-absence — the doc legitimately says "never
  replaces", so grepping for "replace" would false-positive, per the base contract's
  warning.)
- Unchanged and still green: **report core (now entirely unchanged)**, snapshot,
  token-math, time, transcript, config-dir, collect, manifest, skill, docs. The Task-9
  denylist over `report.mjs` output is unaffected.

## 6. Documentation

- **README.md** — rewrite "Already have a statusline?" into the co-exist story (runs
  alongside your tool invisibly, displayed content unchanged, undo with `/teardown`),
  noting co-existence is available on **POSIX and Windows + Git Bash** in this alpha
  (native PowerShell/cmd is not wired this alpha — **a regression from 0.2.0's empty-slot
  PowerShell collector, now removed** — use Git Bash for live numbers — §7),
  plus a short "what if another statusline plugin takes over?"
  fail-safe note. **Do not claim any zero-setup functionality** — the
  plugin reports nothing until setup runs (the "works with zero setup" selling point is
  removed; §8). Preserve the substrings the docs test requires
  (`/plugin install claude-context`, `/claude-context:setup`, the "no
  advice/recommendations" phrase).
- **CHANGELOG.md** — a new versioned entry for co-exist + teardown, **noting the removed
  native-PowerShell empty-slot collector as a breaking change** for native-PowerShell users
  (§7) so the regression has a discoverable trail.
- **CLAUDE.md** — rewrite the "Setup wiring" convention bullet (co-exist by wrapping
  invisibly and reversibly on **POSIX + Git Bash** — native PowerShell is unsupported this
  alpha, no settings change; never replaces; teardown restores verbatim; a tested wiring
  script does the surgery, including one `0600` full-file backup + marker-based ownership;
  stays 1-deep; fails safe). Update the entry-point count (2 → 4). (No report state-machine
  change — Part B was dropped, §8.)

## 7. Non-goals

- **Not** an N-way statusline multiplexer (stays 1-deep; §3.7).
- **No** change to the report engine's states — co-existence produces a normal
  `collector` snapshot; the report is untouched.
- **No** recommendations, labels, thresholds, or policy — the instrument-not-advisor
  contract is unchanged.
- **No latency guarantee or measurement** — co-existence adds an unbounded, unmeasured
  per-refresh overhead this alpha neither targets nor discloses (§3.4); revisit only if it
  becomes a real problem.
- **Out of scope for this alpha:** native PowerShell/cmd support of any kind — not just
  co-existence but the empty-slot `collect` launcher too. **This is an explicit regression
  from the shipped 0.2.0 surface**, which wires an empty-slot PowerShell collector via a
  `statusline.mjs` launcher + `cmd /c`; that launcher is removed this release. Setup makes
  **no** change on native PowerShell and reports it as unsupported (§3.3, §3.5) — so an
  already-wired 0.2.0 collector in `settings.json` keeps running untouched, but **new**
  native-PowerShell installs (and anyone who re-runs setup) get no statusline until they
  switch to Git Bash or a later release. POSIX and Windows + Git Bash are wired now. If it
  ever returns, co-existence there would materialize the stored original into a `0600`
  `.cmd` and spawn nested `cmd` (with the batch `%` → `%%` quirk solved concretely and
  covered by a `%`-bearing test).
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
