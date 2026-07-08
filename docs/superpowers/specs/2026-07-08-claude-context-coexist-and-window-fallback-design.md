# claude-context — co-existing statusline + model-window fallback

**Date:** 2026-07-08
**Status:** Approved design; ready for implementation planning
**Supersedes/extends:** builds on `2026-07-07-claude-context-plugin-design.md`. Where
the two disagree on setup behavior and the report's window-size handling, **this
document wins.**

## 1. Purpose

Two related changes, driven by one principle: **the plugin must never take away or
break a user's existing tools, and must expose context data to agents with as little
setup friction as possible.**

1. **Co-existing statusline.** Today `/claude-context:setup` only takes an *empty*
   statusline slot; if something else (e.g. `claude-hud`) owns it, setup offers
   replace-or-keep, and "keep" leaves the plugin with no data at all. This design
   replaces that either/or with **invisible co-existence**: setup wraps the existing
   statusline so both run, the user's display is unchanged, and a new
   `/claude-context:teardown` restores the original verbatim. Setup **never** offers
   to replace, and **never** seizes a slot it doesn't own.

2. **Model-window fallback.** When no real window size is available (no collector
   snapshot), the report today returns `context: null`. This design lets the report
   compute context % from the transcript against a **per-model default window** (or a
   **user-declared** window), always flagged as assumed — so agents get a context
   reading even with zero setup, without ever dressing an assumption up as a
   measurement.

Both changes preserve the plugin's **one non-negotiable contract**: it is an
**instrument, not an advisor** — pure measurements and provenance, no
recommendations, labels, thresholds, or policy. Nothing here adds advice; the
window-size fallback adds a *flagged, approximate denominator*, which is a
measurement input, not a policy.

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

- The **transcript stores the base model id** (`claude-opus-4-8`, no `[1m]` marker);
  the real window size and the `[1m]` marker exist only in stdin → the snapshot.
  So a report reading only the transcript knows the token *usage* but not the
  *window size* — and cannot distinguish a 200K session from a 1M session of the
  same model.

## 3. Part A — co-existing statusline

### 3.1 Behavior: an invisible transparent tap

When setup wraps an existing statusline, claude-context becomes an **invisible tap**:
it reads stdin, writes its snapshot, and passes stdin through unchanged to the
original command, whose output is the *only* thing displayed. The user sees no
visual change.

### 3.2 Two wiring modes, chosen by the slot's contents at setup time

| Slot at setup | What we wire | Displayed line | Sidecar? |
|---|---|---|---|
| Empty / missing | `collect.mjs` (existing behavior) | our own compact line | no |
| A foreign command (claude-hud, etc.) | `coexist.mjs` | the *original* tool's line, unchanged | yes — stores the original |
| Already our `collect.mjs` or `coexist.mjs` | idempotent refresh of the resolved plugin path; **never re-wrap / nest** | unchanged | unchanged |

An empty slot still makes us the visible statusline (an invisible tap with nothing
to tap would be blank). We only go invisible when there is a real tool to preserve.

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

This "original-as-data" choice is the crux: it eliminates shell-escaping entirely
(the original command is never a substring of another shell command), makes teardown
a pure data operation, and keeps `settings.json` holding only `node coexist.mjs`.

### 3.4 `coexist.mjs` runtime flow — ordered for maximum safety

1. Read all of stdin into a buffer.
2. **Spawn the original** command (from the sidecar) via the platform shell
   (`sh -c` / `cmd /c`), write the buffered stdin to it, pipe its stdout straight to
   ours, and propagate its exit code. *This is the guaranteed path — the child is
   running before any snapshot work.*
3. `try { buildSnapshot(stdin); writeSnapshot(...) } catch {}` — best-effort,
   in-process (reusing the existing `collect.mjs`/`lib` functions), **after** the
   spawn so it can never block or crash the child.

Failure isolation is therefore **structural**: the original tool runs as long as
stdin is readable and its command is spawnable; the snapshot is a pure side effect
that runs after the child's output is already on its way out. The only way to break
the user's tool is a crash in the wrapper *before* step 2 — which is why the wrapper
stays minimal and gets a dedicated isolation test (§6).

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
- **Foreign command** → a **single confirm** (proceed / cancel — *not* a
  replace/keep menu). Show the redacted, truncated original and explain co-existence
  + teardown. On *proceed*: write the sidecar, then wire `coexist.mjs` with an
  **atomic** `settings.json` write. On *cancel*: change nothing, and state honestly
  that claude-context will have **no** live numbers until setup runs and co-exists
  (the old "still works in transcript-only mode" copy was inaccurate — with a foreign
  tool owning the slot and no snapshot ever written, there is nothing).
- **Already ours** → idempotent refresh; never nest.

The old timestamped `settings.json.bak` step is **removed**; the sidecar plus atomic
writes are the safety net.

### 3.6 Teardown (`commands/teardown.md`, new)

- **Sidecar present + we own the current slot** (`coexist.mjs`) → restore
  `statusLine` = the stored original object (atomic), delete the sidecar, tell the
  user to restart.
- **Bare `collect.mjs`, no sidecar** (empty-slot install) → remove our `statusLine`
  entry, back to empty.
- **Never clobber a slot we don't own.** If the current `statusLine` is neither our
  `collect.mjs` nor our `coexist.mjs` (the user or another tool changed it since
  setup), do **not** overwrite — report the situation and print the stored original
  so the user can restore by hand.
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
re-derived from prose on every run. This makes atomicity, idempotency, and
never-clobber-unowned into test-enforced guarantees. The markdown commands shrink to:
detect platform/runtime, resolve the plugin path, call the wiring module, report the
outcome. (This is a small, deliberate departure from the all-markdown setup
convention, justified by the safety stakes.)

## 4. Part B — model-window fallback

### 4.1 The problem and the researched facts

Without a snapshot, the report knows token usage (from the transcript) but not the
window size, and returns `context: null`. This design supplies a denominator from a
per-model default table or a user override, always flagged.

Researched facts (2026-07-08), which drive the table:

- **Every current Claude Code model *defaults* to a 200,000-token window. 1M is an
  opt-in, not the default.** Claude Code exposes them as *separate* picker entries
  ("Opus" vs "Opus (1M context)"), and standard-mode auto-compaction fires at ~200K.
- Per-model: Sonnet 5, Opus 4.8, Fable 5 → 200K standard (1M available); Haiku 4.5 →
  200K (its hard maximum, no 1M option).
- **The transcript cannot distinguish 200K from 1M** for a model that supports both:
  it records only the base id (`claude-opus-4-8`), and the `[1m]` marker lives only in
  stdin → the snapshot.

### 4.2 The default table (keyed by base model id)

| Base model id (from transcript) | Assumed default window |
|---|---|
| `claude-sonnet-5` | 200,000 |
| `claude-opus-4-8` | 200,000 |
| `claude-haiku-4-5` | 200,000 |
| `claude-fable-5` | 200,000 |
| unknown / unmapped | 200,000 |

All current models default to 200,000. This is both the *actual standard default*
and the **safe direction**: if the real window is 1M and we assume 200K, we *overstate*
% (reports "fuller" than reality) — annoying but safe for a tool meant to help agents
checkpoint before compaction. Assuming 1M when the real window is 200K would
*understate* % and let an agent blow past auto-compaction thinking it had headroom.
A 1M user recovers the correct number via the collector (real) or the config override
(declared).

### 4.3 Precedence and provenance

Denominator precedence (real always wins, as required):

1. **Real captured window** (snapshot) → `window_size_source: collector`
2. **User config override** → `window_size_source: config`
3. **Model-default table** → `window_size_source: model-default`

A new provenance field **`window_size_source`** (`collector` | `config` |
`model-default`) is added alongside the existing `source`. `source` describes where
the *token/context* reading came from (e.g. `transcript`); `window_size_source`
describes the *denominator*. So a zero-setup Opus session reports:
`source: transcript`, `window_size_source: model-default`, `setup_required: true`,
with 5h/7d/cost still `null`. Every number continues to state exactly how much to
trust it.

### 4.4 Config file

`<config-dir>/claude-context/config.json` (user-authored, runtime, **not shipped**):

```json
{ "context_window_size": 1000000 }
```

A single scalar the user sets if they run a non-default (e.g. 1M) window. It applies
regardless of the session's model. (A per-model map is a possible later extension;
YAGNI for now — the table already provides per-model defaults, and the collector
provides the real value when installed.) Malformed/absent config → ignored, falls
through to the table.

### 4.5 Effect on the report's state machine

This **changes the "not set up" state.** Today it does *zero transcript I/O* and
returns `context: null`, deliberately refusing to guess a window it cannot verify.
With this feature, "not set up" now **reads the transcript and computes context %
against the assumed/declared window, flagged via `window_size_source`.** This is a
deliberate softening of "never guess a window size" → "guess only from a documented
per-model default or a user-declared value, and never label it measured." The core
**instrument-not-advisor / no-advice contract is untouched**: an assumed *denominator*
is a flagged measurement input, not a recommendation, label, or threshold. The
collector-idle state is unchanged (it still uses the snapshot's real window).

## 5. Architecture / new components

- **New `scripts/coexist.mjs`** — the invisible-tap wrapper (§3.4). New I/O entry
  point (writes snapshot, spawns child).
- **New `scripts/wiring.mjs`** — tested `settings.json` + sidecar surgery for setup
  and teardown (§3.8). New I/O entry point.
- **New `scripts/lib/model-windows.mjs`** — **pure** table + resolver: given a base
  model id and a parsed config object, returns `{ window, window_size_source }`. No
  I/O.
- **New `commands/teardown.md`** — the teardown command (§3.6).
- **Modified `commands/setup.md`** — co-exist wiring + single-confirm + orphaned-
  sidecar handling; delegates surgery to `wiring.mjs`.
- **Modified `scripts/report.mjs`** — reads `config.json`, applies the denominator
  precedence, emits `window_size_source`; the not-set-up path now computes context
  from the transcript.
- **Runtime files (not shipped):** `coexist.json` (sidecar), `config.json` (window
  override).

The "only two I/O entry points" convention grows to four (`collect`, `report`,
`coexist`, `wiring`); `lib/*` stays pure (`model-windows.mjs` included).

## 6. Testing

- **New `tests/coexist.test.mjs`** (safety-critical): writes a correct snapshot from
  stdin; spawns the child, forwards stdin, pipes its stdout through, and adds nothing
  of its own; **failure isolation** — snapshot write throws yet the child still runs
  and its output still appears; child spawned even when snapshot building throws
  synchronously; missing/corrupt sidecar → degrades to our own line.
- **New `tests/wiring.test.mjs`**: empty → wires `collect.mjs`, no sidecar; foreign →
  sidecar stores the whole original `statusLine` object + wires `coexist.mjs`,
  atomically, preserving other settings keys; idempotent for already-ours (no nest);
  teardown restores the original verbatim and deletes the sidecar; **never-clobber-
  unowned**; **orphaned-sidecar detection**.
- **New `tests/model-windows.test.mjs`**: table values; precedence real > config >
  model-default; `window_size_source` on each path; malformed config ignored;
  unknown model id → 200,000.
- **Rewritten `tests/setup.test.mjs`**: replace the Replace/Keep/backup assertions
  with positive facts — wires `collect.mjs` for empty and `coexist.mjs` for occupied,
  calls the wiring module, references `/teardown`, keeps the platform matrix and the
  snapshot-glob check. (Assert positive presence, **not** word-absence — the doc
  legitimately says "never replaces", so grepping for "replace" would false-positive,
  per the base contract's warning.)
- **Modified report tests**: not-set-up now yields a transcript-derived context %
  with `window_size_source: model-default`; add config-override and
  precedence cases.
- Unchanged and still green: report core, snapshot, token-math, time, transcript,
  config-dir, collect, manifest, skill, docs. The Task-9 denylist over `report.mjs`
  output is unaffected.

## 7. Documentation

- **README.md** — rewrite "Already have a statusline?" into the co-exist story (runs
  alongside your tool invisibly, display unchanged, undo with `/teardown`), plus a
  short "what if another statusline plugin takes over?" fail-safe note, plus the
  config-window override and the 200K-standard/1M-opt-in reality. Preserve the
  substrings the docs test requires (`/plugin install claude-context`,
  `/claude-context:setup`, the "no advice/recommendations" phrase).
- **CHANGELOG.md** — a new versioned entry for co-exist + teardown + window fallback.
- **CLAUDE.md** — rewrite the "Setup wiring" convention bullet (co-exist by wrapping
  invisibly and reversibly; never replaces; teardown restores verbatim; a tested
  wiring script does the surgery; stays 1-deep; fails safe). Update the state-machine
  description (not-set-up now computes a flagged, assumed context %), the entry-point
  count (2 → 4), and the "never guess a window size" note.

## 8. Non-goals

- **Not** an N-way statusline multiplexer (stays 1-deep; §3.7).
- **Not** a per-model config map (single scalar override; §4.4).
- **No** change to the collector-idle or full-collector report states beyond adding
  `window_size_source`.
- **No** recommendations, labels, thresholds, or policy — the instrument-not-advisor
  contract is unchanged.
