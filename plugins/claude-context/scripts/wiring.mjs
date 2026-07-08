// scripts/wiring.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { settingsPath, sidecarPath, backupPath } from './lib/config-dir.mjs';
import { ensureDir, writeFileAtomic } from './lib/atomic-write.mjs';
import { detectMarker } from './lib/marker.mjs';
import { buildStatuslineCommand } from './lib/command.mjs';
import { previewCommand } from './lib/redact.mjs';

// Parse to a plain object, or undefined for missing/unparseable/non-object input. A
// bare-string/array/number JSON is not a usable settings.json and must not be spread into
// (that corrupts it into indexed-char keys), so it degrades to "unparseable".
function parsePlainObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
// Returns the parsed object, or undefined if the file is missing OR not a usable object.
// Callers distinguish missing from unparseable with existsSync and never overwrite the latter.
function readJson(file, deps) {
  try {
    return parsePlainObject(deps.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}
// Read settings.json ONCE, returning the raw bytes (for a verbatim backup) alongside the
// parsed object. Reading the raw content here — rather than re-reading it inside backupOnce —
// keeps a concurrent /setup from backing up the OTHER run's already-written wrapper.
function readSettings(sp, deps) {
  const exists = deps.existsSync(sp);
  let raw;
  try {
    raw = deps.readFileSync(sp, 'utf8');
  } catch {
    raw = null;
  }
  return { raw, exists, settings: raw == null ? undefined : parsePlainObject(raw) };
}
function currentCommand(settings) {
  const c = settings?.statusLine?.command;
  return typeof c === 'string' && c.trim() !== '' ? c : null;
}
// A `statusLine` present but without a usable string command is classified FOREIGN, not
// empty: the user configured something there, so we co-exist (preserving it in a sidecar)
// rather than silently overwriting it with our own collector.
function classify(command, hasStatusLine) {
  if (command == null) return hasStatusLine ? 'foreign' : 'empty';
  const marker = detectMarker(command);
  if (marker === 'collect') return 'ours-collect';
  if (marker === 'coexist') return 'ours-coexist';
  return 'foreign';
}
// A sidecar is restorable when it holds ANY stored `original` — teardown must round-trip
// exactly what wrap() stored, and wrap() deliberately stores a command-less foreign
// statusLine verbatim (an object with no string `command`). The stricter "runnable command"
// predicate lives only in coexist.mjs, where a command is needed to spawn the original.
function readSidecar(env, deps) {
  const s = readJson(sidecarPath(env), deps);
  return s && s.original != null ? s : null;
}

export function detect({ env = process.env, deps = fs } = {}) {
  const sp = settingsPath(env);
  const settings = readJson(sp, deps);
  if (settings === undefined && deps.existsSync(sp)) {
    return {
      slot: 'error',
      preview: null,
      hasSidecar: false,
      sidecarMatchesSlot: false,
      storedOriginalPreview: null,
    };
  }
  const s = settings ?? {};
  const command = currentCommand(s);
  const sidecar = readSidecar(env, deps);
  const storedCommand = sidecar ? sidecar.original.command : null;
  return {
    slot: classify(command, s.statusLine != null),
    preview: command == null ? null : previewCommand(command),
    hasSidecar: !!sidecar,
    sidecarMatchesSlot: !!sidecar && command != null && storedCommand === command,
    storedOriginalPreview: storedCommand == null ? null : previewCommand(storedCommand),
  };
}

// Write the single stable 0600 backup — exactly once per run, and only if there was a file
// to protect. Backs up state.rawOriginal (the bytes captured when this run first read
// settings.json), NOT a fresh read a concurrent /setup could have already overwritten.
// state.backedUp guards the "before the FIRST write" rule.
function backupOnce(env, deps, state) {
  if (state.backedUp) return;
  if (state.rawOriginal != null) {
    const bp = backupPath(env);
    // Write the backup only if one isn't already present. A re-run's (refresh's)
    // settings.json is our OWN wrapper, not the user's original, so clobbering the stable
    // backup would replace the true original with a wrapper. teardown removes the backup,
    // so the next fresh install starts clean.
    if (!deps.existsSync(bp)) {
      const tmp = `${bp}.${process.pid}.${state.now}.tmp`;
      writeFileAtomic(tmp, bp, state.rawOriginal, 0o600, { deps });
    }
  }
  state.backedUp = true;
}

function writeSettingsAtomic(env, deps, obj) {
  const sp = settingsPath(env);
  const dir = path.dirname(sp);
  ensureDir(dir, { deps });
  // Preserve the file's existing mode; default a new settings.json to 0600 (it may hold secrets).
  let mode = 0o600;
  try {
    mode = deps.statSync(sp).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = path.join(dir, `.settings.json.${process.pid}.${Date.now()}.tmp`);
  writeFileAtomic(tmp, sp, `${JSON.stringify(obj, null, 2)}\n`, mode, { deps });
}

function writeSidecarAtomic(env, deps, obj) {
  const scp = sidecarPath(env);
  const dir = path.dirname(scp);
  ensureDir(dir, { deps, tighten: true });
  const tmp = path.join(dir, `.coexist.json.${process.pid}.${Date.now()}.tmp`);
  writeFileAtomic(tmp, scp, `${JSON.stringify(obj, null, 2)}\n`, 0o600, { deps });
}

// KNOWN RACE (accepted, unguarded by design): wrap() and teardown() are lock-free,
// multi-file read-modify-write operations. Each classifies from a snapshot of settings.json
// taken at its start and then writes without re-validating. If a concurrent /teardown runs
// to completion between this run's initial read and its write, this run can act on a stale
// classification (e.g. refresh an `ours-coexist` slot that teardown just restored to the
// foreign original) and lose that original. The same read→write window can also lose a
// concurrent THIRD-PARTY write to settings.json — Claude Code persisting a `/config` change,
// or a hand edit — that lands after this run's read: the whole-file rewrite here is built from
// the stale in-memory copy, so that unrelated edit is silently dropped. Both our commands are
// agent-invoked and rarely fired simultaneously, and a concurrent foreign write to the same
// file in the sub-millisecond window is rarer still, so the likelihood is low; the fix (an
// exclusive lockfile, or re-read + re-classify before the final write) was judged not worth
// its stale-lock/complexity cost at this stage. If any of these races ever becomes common,
// guard the mutation here.
export function wrap({ env = process.env, deps = fs, now = Date.now(), runtime } = {}) {
  const sp = settingsPath(env);
  const { raw, exists, settings } = readSettings(sp, deps);
  if (settings === undefined && exists) return { action: 'error', reason: 'unparseable-settings' };
  const base = settings ?? {};
  const command = currentCommand(base);
  const slot = classify(command, base.statusLine != null);
  const state = { backedUp: false, now, rawOriginal: raw };

  const setVariant = (variant) => {
    // Build (and thus validate runtime) BEFORE any disk write, so a bad runtime never leaves
    // a half-written backup/sidecar behind.
    const command = buildStatuslineCommand({ variant, runtime });
    backupOnce(env, deps, state);
    writeSettingsAtomic(env, deps, {
      ...base,
      statusLine: { type: 'command', command },
    });
  };

  if (slot === 'empty') {
    setVariant('collect');
    return { action: 'wired-collect', slot };
  }
  if (slot === 'ours-collect') {
    setVariant('collect');
    return { action: 'refreshed-collect', slot };
  }
  if (slot === 'ours-coexist') {
    setVariant('coexist');
    return { action: 'refreshed-coexist', slot };
  }

  // slot === 'foreign'
  const sidecar = readSidecar(env, deps);
  if (sidecar) {
    if (sidecar.original.command === command) {
      setVariant('coexist');
      return { action: 'resumed-coexist', slot };
    }
    return {
      action: 'conflict',
      slot,
      storedOriginalPreview: previewCommand(sidecar.original.command),
      // Surface the orphan's path: this state is a dead-end until the stale sidecar is
      // cleared, so the caller (setup.md) can point the user at a recovery.
      sidecarPath: sidecarPath(env),
    };
  }
  // Fresh foreign wrap: build the wrapper command FIRST (validates runtime before any write),
  // then back up, store the ORIGINAL (safe ordering), then wire coexist.
  const wrapperCommand = buildStatuslineCommand({ variant: 'coexist', runtime });
  backupOnce(env, deps, state);
  writeSidecarAtomic(env, deps, {
    original: base.statusLine,
    wrapped_at: new Date(now).toISOString(),
  });
  writeSettingsAtomic(env, deps, {
    ...base,
    statusLine: { type: 'command', command: wrapperCommand },
  });
  return { action: 'wired-coexist', slot };
}

function removeIfPresent(file, deps) {
  try {
    deps.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

export function teardown({ env = process.env, deps = fs } = {}) {
  const sp = settingsPath(env);
  const { raw, exists, settings } = readSettings(sp, deps);
  if (settings === undefined && exists) return { action: 'error', reason: 'unparseable-settings' };
  const base = settings ?? {};
  const command = currentCommand(base);
  const marker = command == null ? null : detectMarker(command);
  const sidecar = readSidecar(env, deps);
  const state = { backedUp: false, now: Date.now(), rawOriginal: raw };
  // Every terminal teardown branch clears both our artifacts (the sidecar pointer and the
  // full-file backup); do it in one place so a new branch can't forget one.
  const clearArtifacts = () => {
    removeIfPresent(sidecarPath(env), deps);
    removeIfPresent(backupPath(env), deps);
  };

  if (marker === 'coexist') {
    if (sidecar) {
      backupOnce(env, deps, state);
      writeSettingsAtomic(env, deps, { ...base, statusLine: sidecar.original });
      clearArtifacts();
      return { action: 'restored-original' };
    }
    // Sidecar lost, but the 0600 backup is a verbatim copy of the pre-setup settings.json —
    // it still holds the user's original statusLine. Recover from it rather than deleting the
    // last surviving copy of the original (C1). Only its statusLine, not the whole file:
    // restoring the whole backup would revert unrelated settings.json edits made after wrap.
    const backup = readJson(backupPath(env), deps);
    if (backup && 'statusLine' in backup) {
      backupOnce(env, deps, state);
      writeSettingsAtomic(env, deps, { ...base, statusLine: backup.statusLine });
      clearArtifacts();
      return { action: 'restored-from-backup' };
    }
    // No sidecar AND no usable backup — genuinely nothing to restore. Back to empty, and clear
    // any present-but-unusable sidecar/backup so nothing is orphaned (matching removed-collect).
    backupOnce(env, deps, state);
    const next = { ...base };
    delete next.statusLine;
    writeSettingsAtomic(env, deps, next);
    clearArtifacts();
    return { action: 'coexist-no-sidecar-removed' };
  }
  if (marker === 'collect') {
    backupOnce(env, deps, state);
    const next = { ...base };
    delete next.statusLine;
    writeSettingsAtomic(env, deps, next);
    clearArtifacts();
    return { action: 'removed-collect' };
  }
  if (command == null) return { action: 'noop-nothing-wired' };
  // Non-empty but not our marker: never clobber. Report the stored original if we have one,
  // and surface the sidecar path so an orphan can be cleared by hand.
  return {
    action: 'not-ours',
    storedOriginalPreview: sidecar ? previewCommand(sidecar.original.command) : null,
    sidecarPath: sidecar ? sidecarPath(env) : null,
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const sub = process.argv[2];
  let result;
  try {
    if (sub === 'detect') result = detect();
    else if (sub === 'wrap') {
      result = wrap({ runtime: argValue(process.argv, '--runtime') });
    } else if (sub === 'teardown') result = teardown();
    else result = { action: 'error', reason: `unknown subcommand: ${sub ?? '(none)'}` };
  } catch (e) {
    result = { action: 'error', reason: String(e && e.message ? e.message : e) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
