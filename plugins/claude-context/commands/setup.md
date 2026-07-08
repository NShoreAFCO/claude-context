---
description: Wire claude-context as your statusline — co-existing invisibly with any statusline you already run — so /claude-context can report live 5h/7d usage
allowed-tools: Bash, Read, AskUserQuestion
---

Wire claude-context into the user's `statusLine` so it can capture the `rate_limits`
and `cost` Claude Code sends only to the statusline process. If a **foreign** statusline
already owns the slot, claude-context **co-exists**: it wraps the existing command so both
run and the user's displayed line is unchanged (undo any time with
`/claude-context:teardown`). Setup **never** replaces or seizes a slot it doesn't own.

The dangerous `settings.json` surgery lives in the tested `scripts/wiring.mjs` module; this
command only detects the platform + runtime, asks the one confirm, and calls that module.

## Step 1: Detect platform, shell, and runtime

Use the environment context `Platform:` and `Shell:` values as the starting point.

**On `win32`, run `echo $OSTYPE` first** — a `powershell`/`pwsh`/`cmd` shell whose `$OSTYPE`
is `msys` or `cygwin` is actually driving a Git Bash environment. Resolve the branch:

| Platform | Shell | OSTYPE | Branch |
|----------|-------|--------|--------|
| `darwin` / `linux` | any | any | **posix** |
| `win32` | `bash` | any | **gitbash** |
| `win32` | `powershell`/`pwsh`/`cmd` | `msys` / `cygwin` | **gitbash** |
| `win32` | `powershell`/`pwsh`/`cmd` | other / empty | **native-powershell** |

**If the branch is `native-powershell`: stop here.** This alpha does **not** wire a
statusline on native PowerShell/cmd (a change from 0.2.0 — see the CHANGELOG). Make **no**
`settings.json` change. Tell the user: native PowerShell is **unsupported this alpha**; they
keep whatever statusline they have; live numbers are available by running Claude Code from
**Git Bash**, or in a later release. Do not proceed to Step 2.

Runtime: on macOS/Linux prefer `bun` then `node`
(`command -v bun 2>/dev/null || command -v node 2>/dev/null`); on Git Bash require `node`
(`command -v node`). If none is found, stop and tell the user to install Node.js LTS
(https://nodejs.org/), restart the shell, and re-run `/claude-context:setup`. Record the
resolved path as `{RUNTIME_PATH}`. (The `posix` / `gitbash` branch only gates the
native-PowerShell stop above; the wiring module needs no platform argument.)

## Step 2: Detect the current slot

Run the wiring module's no-write detector (it reads `settings.json`, classifies the slot,
and redacts any secrets in the preview **inside the module** — the raw command never reaches
this transcript):

```bash
"{RUNTIME_PATH}" "{PLUGIN_DIR}scripts/wiring.mjs" detect
```

Resolve `{PLUGIN_DIR}` the same way the statusline command does — the newest installed
version:

```bash
PLUGIN_DIR=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null | awk -F/ '{ print $(NF-1) "\t" $0 }' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+[[:space:]]' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-)
```

The detector prints one JSON line: `{ "slot", "preview", "hasSidecar", "sidecarMatchesSlot", "storedOriginalPreview" }`.

## Step 3: Decide and wire

- **`slot: "empty"` / `"ours-collect"` / `"ours-coexist"`** → no confirm needed. Go to Step 4.
- **`slot: "foreign"` with `sidecarMatchesSlot: true`** → a benign interrupted-install / manual-revert state; resume without a prompt. Go to Step 4.
- **`slot: "foreign"` (fresh, `hasSidecar: false`)** → use **AskUserQuestion** (a single
  proceed/cancel, **not** a replace/keep menu):
  - header: "Existing statusline detected"
  - question: show `preview` (already redacted) and explain: claude-context will run
    **alongside** it invisibly — the displayed line is unchanged — and `/claude-context:teardown`
    restores it verbatim.
  - options: "Proceed — co-exist (recommended)" · "Cancel — change nothing"
  - On **Cancel**: make no change. State honestly that claude-context will have **no** live
    numbers until setup runs and co-exists (with a foreign tool owning the slot and no
    snapshot ever written, there is nothing to report yet).
- **`slot: "foreign"` with `hasSidecar: true` and `sidecarMatchesSlot: false`** → a preserved
  statusline already exists but the slot now holds something we don't recognize (an interrupted
  or bad earlier setup can leave this). Do **not** overwrite. Report the facts and show
  `storedOriginalPreview`. This state **blocks co-existence** until the stale sidecar is cleared,
  so give the user the recovery: the sidecar lives at
  `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-context/coexist.json`, and deleting it (`rm` that
  file) lets a re-run of `/claude-context:setup` co-exist with whatever now owns the slot. That
  only discards claude-context's saved pointer to the *previous* original — it does not touch
  the current statusline. Stop.
- **`slot: "error"`** → `settings.json` is unparseable; do not touch it. Tell the user to fix
  or remove it, then re-run. Stop.

## Step 4: Apply via the wiring module

```bash
"{RUNTIME_PATH}" "{PLUGIN_DIR}scripts/wiring.mjs" wrap --runtime "{RUNTIME_PATH}"
```

It writes exactly one `0600` full-file `settings.json.claude-context.bak` before its first
write, then performs an atomic settings write (and, for a foreign slot, stores the entire
original `statusLine` object in `coexist.json` first). It prints one JSON line with `action`
(`wired-collect` / `wired-coexist` / `resumed-coexist` / `refreshed-collect` /
`refreshed-coexist` / `conflict` / `error`). Report the outcome and tell the user to **fully
restart Claude Code**. If `action` is `conflict` or `error`, report it and do not retry — a
`conflict` also carries `sidecarPath` (the stale `coexist.json` to `rm` per the Step 3
conflict recovery) before any re-run.

## Step 5: Verify a snapshot appears

After the user restarts and sends one message, confirm a snapshot exists. The collector keys
the file by session id, so match the glob:

```bash
cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/claude-context/snapshot-*.json
```

If one exists with a recent `updated_at`, setup worked. If not, re-check: the runtime path
(`ls -la {RUNTIME_PATH}`); the plugin cache glob
(`ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/`); on Windows,
that the branch matches the real environment (`echo $OSTYPE`). The most common cause is not
having fully restarted Claude Code.
