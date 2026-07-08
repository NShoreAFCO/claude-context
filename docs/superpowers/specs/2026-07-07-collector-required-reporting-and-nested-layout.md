# claude-context — collector-required reporting & nested plugin layout

**Date:** 2026-07-07
**Status:** Approved design; ready for implementation planning
**Supersedes (in part):** the graceful-degradation behavior and flat single-plugin
layout in `2026-07-07-claude-context-plugin-design.md`. Where the two disagree, this
document wins for (a) the cold-start reporting behavior and (b) the repository layout.

## 1. Purpose & motivation

Two changes to the shipped `claude-context` plugin:

1. **Reporting behavior.** Today, when no collector snapshot exists, the report falls
   back to the transcript and *infers* the context-window size from the model id.
   Because the transcript stores the **base** model id (`claude-opus-4-8`, no `[1m]`
   marker), a 1M-context session is guessed as 200k — producing a misleading figure
   (e.g. `~24% used` when the true occupancy against a 1M window is ~5%). A number
   that wrong should not be reported at all. The plugin's whole contract is that a
   consumer can act on its numbers; a fabricated window undermines that.

2. **Repository layout.** The repo is currently a *flat* single-plugin marketplace
   (`source: "./"`), so a `/plugin install` copies the entire repo — `docs/`,
   `tests/`, `paad/`, `CLAUDE.md` — into the plugin cache. Moving the shipped plugin
   into `plugins/claude-context/` yields a lean install and room to grow, matching the
   documented multi-plugin catalog layout.

Neither change alters the **instrument-not-advisor** contract (§6): the new cold-start
output *explains how to configure the tool*; it prescribes nothing about resource usage.

## 2. Reporting behavior

The report resolves to exactly one of three states, keyed on **whether a snapshot has
ever been written** (not on transcript availability):

| State | Trigger | Context | 5h / 7d / cost | Compactions | `source` |
|---|---|---|---|---|---|
| **Collector active** | Fresh snapshot for this session (or newest) | Full, from snapshot | Present (or typed-unavailable) | From snapshot's `transcript_path` | `collector` |
| **Collector idle** | A snapshot exists but is past the freshness window | Accurate — transcript's latest usage against the snapshot's **real** window size (or the stale snapshot's own `context` if the transcript has no usage) | `null`, flagged `unavailable_stale` | From transcript | `transcript` (→ `collector` on the snapshot-context fallback; see §2.1) |
| **Not set up** | **No snapshot has ever been written** | **None** | `null`, flagged `unavailable_collector` | **None** | `unavailable` |

### 2.1 The only logic change

The transcript-context branch in `resolveReport` must run **only when a snapshot
supplied a real window size** (`knownWindow > 0`). Concretely:

- **Snapshot exists but stale** (`knownWindow > 0`): unchanged. Report the transcript's
  latest usage against the real window (accurate `%`, `source: transcript`), compactions
  from the transcript, rate limits/cost `null` (`unavailable_stale`). If the transcript
  yields no usage, fall back to the **stale snapshot's own `context` field** (it already
  carries the real window), still flagged stale — never tell an already-set-up user to run
  setup. **Provenance in this fallback sub-case:** because the numbers now come from the
  snapshot rather than the transcript, report `source: collector` (not `transcript`) — the
  figures genuinely originate in the collector's snapshot, distinguished from a live
  reading only by `rate_limits_status: unavailable_stale` and the reported
  `snapshot_age_seconds`. This keeps `source` an honest origin label instead of overloading
  it to mean "the idle bucket," so a consumer's rule never mistakes snapshot-derived
  context for transcript-derived context.
- **No snapshot at all** (`knownWindow` absent): **do not read the transcript.**
  Return the *not-set-up* state directly. No window is ever inferred.

Because window inference only ever fired in the no-snapshot branch, removing that branch
eliminates the guess entirely; the stale path never inferred and is untouched.

### 2.2 Cold-start ("not set up") output

**Human block:**

```
Claude Context — collector not configured

No resource facts are available for this session yet: the usage collector
has not recorded a snapshot, so there is nothing to measure.

To enable reporting — context %, 5-hour / 7-day usage, session cost, and
compaction count — run:

    /claude-context:setup

That wires a statusline helper which captures the figures Claude Code sends
only to the statusline. Once it has run, this report returns live numbers.
```

**JSON block:** the machine contract is preserved as an all-`null` payload plus
provenance — "no data" means null values, not an absent response:

```json
{
  "model": {},
  "context": { "used_percentage": null, "used_tokens": null, "window_size": null,
    "headroom_tokens": null, "input_tokens": null, "cache_read_tokens": null,
    "cache_creation_tokens": null, "output_tokens": null },
  "rate_limits": { "five_hour": null, "seven_day": null },
  "cost_usd": null,
  "compactions": null,
  "source": "unavailable",
  "rate_limits_status": "unavailable_collector",
  "setup_required": true,
  "generated_at": "<ISO-8601>"
}
```

- **`setup_required`** (new, boolean) is an explicit machine signal so a consumer can
  gate on one field instead of inferring from `source`/`rate_limits_status`. It is
  **always present** on every report: `true` only in the not-set-up state, `false` in
  the collector-active and collector-idle states.
- **`compactions`** is `null` here (not `0`): at cold start we deliberately skip all
  transcript I/O, so the count is *unknown*, not *zero*.
- `window_size_inferred` is **removed** (see §3). `session_selection` is omitted when
  there is neither snapshot nor transcript to attribute.

## 3. Code removed (now dead)

- `scripts/lib/model-window.mjs` and `tests/model-window.test.mjs` — the sole caller of
  `inferWindowSize` was the removed guess (verified: the collector reads the real window
  from stdin and never infers).
- The `inferWindowSize` import and its use in `report.mjs`.
- The `window_size_inferred` output field — the JSON key, the "`~% … window inferred`"
  human-render branch, and its documentation in `SKILL.md` and `README.md`. It can only
  ever be `false` after this change, so it is vestigial.

## 4. Repository layout (nested)

```
/                                       ← marketplace catalog + dev infra (NOT shipped)
├── .claude-plugin/marketplace.json     ← plugin entry source: "./plugins/claude-context"
├── README.md · CLAUDE.md · LICENSE     ← project front page, agent guidance, canonical license
├── docs/ · paad/                       ← design records, reviews
├── package.json                        ← dev tooling; test glob unchanged
├── tests/  (+ tests/fixtures/)         ← stays at root so it does NOT ship
└── plugins/claude-context/             ← THE shipped plugin (only this dir is copied)
    ├── .claude-plugin/plugin.json
    ├── SKILL.md
    ├── LICENSE                          ← copy, so the shipped plugin carries its license
    ├── commands/setup.md
    └── scripts/{collect,report}.mjs + lib/
```

**Moves** into `plugins/claude-context/`: `plugin.json`, `SKILL.md`, `commands/`,
`scripts/` (with `lib/`), and a **copy** of `LICENSE`.

**Stays** at repo root: `marketplace.json`, `README.md`, `CLAUDE.md`, `LICENSE` (the
canonical repo license — the plugin's `LICENSE` is a *copy in addition to*, not a
replacement for, this one, so GitHub license detection and `tests/docs.test.mjs`'s root
read both keep working), `docs/`, `paad/`, `package.json`, and `tests/` (with `fixtures/`).
Keeping tests outside the plugin dir is deliberate — it is the reason for nesting: the
shipped/cached plugin stays lean.

**Path rewrites required:**

- `marketplace.json`: plugin entry `source` `"./"` → `"./plugins/claude-context"`.
- `tests/*.test.mjs`: import specifiers `../scripts/…` → `../plugins/claude-context/scripts/…`.
  Fixture paths (`fixtures/…`) are unchanged.
- `CLAUDE.md`: update path references (`scripts/…`, `SKILL.md`, `commands/…`) to the
  nested locations.

**No change required:**

- `SKILL.md` already invokes `${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs`; `scripts/` moves
  with it, so the plugin-root-relative path still resolves.
- `commands/setup.md` resolves the collector from the install-cache glob
  `…/plugins/cache/*/claude-context/*/scripts/collect.mjs`; the cached plugin root is
  unchanged by repo nesting, and the plugin name stays `claude-context`.

## 5. Docs & versioning

- **README.md**: remove the "works out of the box / reads context health straight from
  the transcript" framing — false at first run. Replace with: reporting requires the
  one-time `/claude-context:setup`; before that the report explains how to enable it.
  Remove `window_size_inferred` from the provenance section. Canonical install form
  `/plugin install claude-context@claude-context`.
- **SKILL.md**: rewrite the three-state / sources section (collector required for any
  numbers), update the field reference (drop `window_size_inferred`, add
  `setup_required`), and describe `compactions: null` at cold start.
- **CLAUDE.md**: update the architecture/degradation description to the three states
  above and the nested paths.
- **marketplace.json**: while editing, move `description`/`version` from `metadata` to
  the top level (current-spec location). Cosmetic.
- **Version**: bump `plugin.json` `0.1.0` → `0.2.0` (removed a documented field, changed
  behavior) and add a `CHANGELOG.md` entry.

## 6. Contract constraints (unchanged, must hold)

- **Instrument, not advisor.** The cold-start text instructs the user to *configure the
  tool* (`/claude-context:setup`); it must not acquire resource-policy vocabulary
  (thresholds, "should", traffic-light/level labels, recommendations about usage). The
  existing denylist test over `report.mjs`'s rendered output (design Task 9) must still
  pass; extend its fixtures to cover the new cold-start human block.
- **Provenance is first-class.** `source`, `rate_limits_status`, `session_selection`
  remain on every applicable report. `setup_required` joins them as an explicit signal.
- **Golden fixtures unchanged.** `tests/fixtures/real-stdin.json` and
  `real-transcript.jsonl` are redacted live captures and must not be replaced with
  synthesized data.

## 7. Testing impact

The move touches more test files than just the ones with `../scripts/…` imports. Group the
edits by *kind* so none is missed — following "update import paths" literally leaves the
`readFileSync` data paths and the `source` assertion stale and turns `npm test` red:

- **Delete** — `tests/model-window.test.mjs` (its helper and field are gone, §3).
- **Import specifiers** (`../scripts/…` → `../plugins/claude-context/scripts/…`), the
  eight surviving importers: `report.test.mjs`, `report-integration.test.mjs`,
  `collect.test.mjs`, `config-dir.test.mjs`, `snapshot.test.mjs`, `transcript.test.mjs`,
  `token-math.test.mjs`, `time.test.mjs`. Fixture paths (`fixtures/…`) are unchanged.
- **`readFileSync` data paths** — files that *moved* under `plugins/claude-context/`:
  - `tests/manifest.test.mjs`: read `plugin.json` from the **nested**
    `plugins/claude-context/.claude-plugin/plugin.json`; keep reading `marketplace.json`
    from the **root** `.claude-plugin/marketplace.json` (it stays). The two `readJson`
    calls now resolve against different base paths.
  - `tests/setup.test.mjs`: `commands/setup.md` → `plugins/claude-context/commands/setup.md`.
  - `tests/skill.test.mjs`: `SKILL.md` → `plugins/claude-context/SKILL.md`.
  - `tests/docs.test.mjs`: `README.md`, `CHANGELOG.md`, and `LICENSE` **all stay at root**
    (LICENSE by the §4 decision), so this file needs **no path change** — listed here only
    to record that it was checked, not overlooked.
- **Assertion-value change** — `tests/manifest.test.mjs` asserts `plugins[0].source ===
  './'`; update it to `'./plugins/claude-context'` to match §4.
- **Behavioral updates** — `tests/report.test.mjs` and `tests/report-integration.test.mjs`:
  cold start now asserts the not-set-up human block + all-null JSON + `setup_required: true`
  + `compactions: null` (previously it asserted an inferred-window `~%`). Add/keep a
  stale-snapshot case asserting an accurate `%` against the real window, **and** a
  snapshot-context fallback case asserting `source: collector` +
  `rate_limits_status: unavailable_stale` (§2.1).
- **Verify** the denylist test covers the new cold-start rendering.
- `npm test` (`node --test tests/*.test.mjs`) remains the runner; glob unchanged.

## 8. Non-goals

- No change to the collector's *snapshot shape* — `collect.mjs` already reads the real
  window from stdin. (The build did add a statusline "snapshot not saved" write-failure
  marker to `collect.mjs`; that touches the rendered line, not the captured data.)
- No change to the fresh-collector or stale-collector output shapes beyond removing
  `window_size_inferred`.
- No second plugin is added; the catalog simply gains the `plugins/` directory it will
  need if one ever is.
