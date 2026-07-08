---
description: Undo /claude-context:setup — restore your original statusline verbatim (or remove ours), reversing co-existence
allowed-tools: Bash, Read
---

Reverse whatever `/claude-context:setup` wired, using the tested `scripts/wiring.mjs`
module. Ownership is decided by the marker the current `statusLine` command carries — never
by string-matching a resolved command — so an upgraded plugin path still tears down cleanly.

## Step 1: Resolve the plugin dir

```bash
PLUGIN_DIR=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-context/*/ 2>/dev/null | awk -F/ '{ print $(NF-1) "\t" $0 }' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+[[:space:]]' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-)
```

## Step 2: Run teardown

```bash
node "{PLUGIN_DIR}scripts/wiring.mjs" teardown
```

It prints one JSON line with `action`. Report accordingly, then tell the user to **fully
restart Claude Code** if anything changed:

- `restored-original` — your original statusline is back; the sidecar and backup were removed.
- `removed-collect` — claude-context's own collector was removed; the slot is empty again.
- `coexist-no-sidecar-removed` — our wrapper was wired but the stored original was missing, so
  we removed our entry (slot empty). Nothing else to restore.
- `not-ours` — the slot no longer carries our marker (another tool or you changed it); we did
  **not** touch it. If `storedOriginalPreview` is shown, that is the statusline we had
  preserved (its file is given in `sidecarPath`) — restore it by hand if you want it back, then
  delete that `coexist.json` (`rm` it) to clear the orphaned pointer so a future
  `/claude-context:setup` starts clean.
- `noop-nothing-wired` — nothing of ours was wired; no change.
- `error` — `settings.json` is unparseable; fix or remove it, then re-run.
