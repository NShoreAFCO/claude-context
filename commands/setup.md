---
description: Wire the claude-context collector as your statusline so /claude-context can report live 5h/7d usage
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

Wire `scripts/collect.mjs` into the user's `statusLine` so it can capture the
`rate_limits` and `cost` that Claude Code sends only to the statusline process.
The collector writes a private snapshot the report engine reads; it prints one
compact line and never runs or appends to any other statusline command.

## Step 1: Detect platform, shell, and runtime

Use the environment context `Platform:` and `Shell:` values as the starting point.
The cache glob is always `claude-context` and the wired source is always
`scripts/collect.mjs` (no `dist/`/`src` split, no `COLUMNS` export).

**On `win32`, run `echo $OSTYPE` first** — a `powershell`/`pwsh`/`cmd` shell whose
`$OSTYPE` is `msys` or `cygwin` is actually driving a Git Bash command environment,
where bash expands `$env:VAR`/`$(...)` before PowerShell runs, so the PowerShell
form is unsafe. Resolve the branch from this matrix:

| Platform | Shell | OSTYPE | Use |
|----------|-------|--------|-----|
| `darwin` / `linux` | any | any | macOS/Linux (bash) |
| `win32` | `bash` | any | Windows + Git Bash |
| `win32` | `powershell`/`pwsh`/`cmd` | `msys` / `cygwin` | Windows + Git Bash |
| `win32` | `powershell`/`pwsh`/`cmd` | other / empty | Windows + PowerShell |

Runtime: on macOS/Linux prefer `bun` then `node` (`command -v bun 2>/dev/null ||
command -v node 2>/dev/null`); on Windows require `node` (`command -v node`), never
bun. If none is found, stop and tell the user to install Node.js LTS
(https://nodejs.org/) — on Windows, note that Git Bash finding no `node` is distinct
from Claude Code being installed — then restart the shell and re-run
`/claude-context:setup`. Verify the resolved path with `ls -la {RUNTIME_PATH}`.

**macOS/Linux (node)** — generated command:
```
bash -c 'plugin_dir=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null | awk -F/ '"'"'{ print $(NF-1) "\t" $(0) }'"'"' | grep -E '"'"'^[0-9]+\.[0-9]+\.[0-9]+[[:space:]]'"'"' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-); exec "{RUNTIME_PATH}" "${plugin_dir}scripts/collect.mjs"'
```
(Use `--env-file /dev/null` after `{RUNTIME_PATH}` when the runtime is `bun`.)

**Windows + Git Bash** — use `sort -V` (avoids nested quotes), per claude-hud's
Git Bash branch, with the same `claude-context` glob and `scripts/collect.mjs`
source:
```
plugin_dir=$(ls -1d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null | sort -V | tail -1); exec "{RUNTIME_PATH}" "${plugin_dir}scripts/collect.mjs"
```

**Windows + PowerShell** (Platform `win32`, Shell `powershell`/`pwsh`/`cmd`, OSTYPE
other/empty). PowerShell startup plus a `Sort-Object [version]` scan can exceed
Claude Code's ~300ms render cadence on every refresh, so write a small Node launcher
once at setup and invoke it through `cmd.exe` each refresh.

1. Plugin path (the trailing `\*` is required, or the glob resolves the
   `claude-context` dir itself and the version match fails):
   ```powershell
   $claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }
   (Get-ChildItem (Join-Path $claudeDir "plugins\cache\*\claude-context\*") -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+(\.\d+)+$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).FullName
   ```

2. Runtime (require node): `(Get-Command node -ErrorAction SilentlyContinue).Source`.

3. Write the launcher to `$claudeDir\plugins\claude-context\statusline.mjs`. It finds
   the newest installed `claude-context` version and **imports `scripts/collect.mjs`
   and calls `runCli()`** — importing alone does not run the collector (its CLI body
   is `isMain`-guarded), so the explicit call is required. There is no `COLUMNS`
   handling.
   ```js
   import fs from 'node:fs';
   import os from 'node:os';
   import path from 'node:path';
   import { pathToFileURL } from 'node:url';

   const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
   const cacheDir = path.join(claudeDir, 'plugins', 'cache');

   function versionParts(value) {
     const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
     return match ? match.slice(1, 4).map(Number) : null;
   }
   function compareVersions(a, b) {
     for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
     return 0;
   }

   const candidates = [];
   try {
     for (const marketplace of fs.readdirSync(cacheDir, { withFileTypes: true })) {
       if (!marketplace.isDirectory()) continue;
       const pluginRoot = path.join(cacheDir, marketplace.name, 'claude-context');
       let versions = [];
       try { versions = fs.readdirSync(pluginRoot, { withFileTypes: true }); } catch { continue; }
       for (const version of versions) {
         if (!version.isDirectory()) continue;
         const parts = versionParts(version.name);
         if (!parts) continue;
         const dir = path.join(pluginRoot, version.name);
         if (fs.existsSync(path.join(dir, 'scripts', 'collect.mjs'))) candidates.push({ dir, parts });
       }
     }
   } catch { process.exit(0); }

   candidates.sort((a, b) => compareVersions(a.parts, b.parts));
   const latest = candidates.at(-1);
   if (!latest) process.exit(0);

   const mod = await import(pathToFileURL(path.join(latest.dir, 'scripts', 'collect.mjs')).href);
   if (typeof mod.runCli === 'function') await mod.runCli();
   ```
   Assign that launcher source to `$wrapperBody` via a single-quoted here-string
   (`@'` … `'@`), then write it UTF-8 **without a BOM** (PS 5.1's `Set-Content
   -Encoding UTF8` emits a BOM):
   ```powershell
   $wrapperDir = Join-Path $claudeDir "plugins\claude-context"
   New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
   $wrapperPath = Join-Path $wrapperDir "statusline.mjs"
   [System.IO.File]::WriteAllText($wrapperPath, $wrapperBody, (New-Object System.Text.UTF8Encoding $false))
   ```

4. Generated command (`{RUNTIME_PATH}` = the node path from step 2; `{CMD_PATH}` =
   `$env:SystemRoot\System32\cmd.exe`, falling back to `cmd.exe`; `{WRAPPER_PATH}` =
   `$wrapperPath`):
   ```
   {CMD_PATH} /d /s /c ""{RUNTIME_PATH}" "{WRAPPER_PATH}""
   ```

## Step 2: Test the command

Run the generated command with a sample stdin payload and confirm it prints one
line without error:
```bash
echo '{"model":{"display_name":"Test"},"context_window":{"context_window_size":200000,"current_usage":{"input_tokens":1000}}}' | {GENERATED_COMMAND}
```

## Step 3: Detect an existing statusline, back it up, and decide

Read `statusLine.command` from the settings file
(`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`, or the PowerShell
equivalent). **Always create a timestamped backup before any write** — on
macOS/Linux `cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d-%H%M%S)"`, on PowerShell
`Copy-Item $settingsPath "$settingsPath.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"`.
When showing the existing command in the prompt, redact obvious secrets (Bearer
tokens, `sk-…`, `gh[pousr]_…`, and `api_key`/`token`/`secret` assignments) and
truncate to ~160 chars — never print the raw command.

- **Empty / missing** → take the slot: write the generated command (Step 4).
- **Already claude-context** → idempotent update: overwrite with the new command.
- **Anything else** → use AskUserQuestion:
  - header: "Existing statusline detected"
  - question: show the redacted command preview and ask what to do.
  - options:
    - "Replace it with claude-context (your current statusline is backed up)"
    - "Keep my statusline (claude-context reports context-only, no live 5h/7d)"
    - "Cancel setup"
  - On **Keep** or **Cancel**: make no `statusLine` change; tell the user
    `/claude-context:claude-context` still works in transcript-only mode.

## Step 4: Apply configuration

Merge `{ "statusLine": { "type": "command", "command": "{GENERATED_COMMAND}" } }`
into `settings.json` with a real JSON serializer (never string concatenation);
preserve all other settings. On Windows PowerShell, write UTF-8 without a BOM via
`[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding $false)`.
Tell the user to fully restart Claude Code.

## Step 5: Verify a snapshot appears

After the user restarts and sends one message, confirm the snapshot exists:
```bash
cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-context/snapshot.json"
```
If it exists and has an `updated_at` within the last few minutes, setup worked.
If not, check, in order: the runtime path resolves (`ls -la {RUNTIME_PATH}`); the
plugin cache glob matches an installed version (`ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/`);
on Windows, that the `Platform:`/`Shell:` branch matches the actual command
environment (re-check `echo $OSTYPE`); and on PowerShell, that
`'{}' | & cmd.exe /c '{GENERATED_COMMAND}'` prints a compact line. The most common
cause is not having fully restarted Claude Code after the write.
