// scripts/wiring.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { settingsPath, sidecarPath, backupPath } from './lib/config-dir.mjs';
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

function ensureDir(dir, deps, { tighten = false } = {}) {
  deps.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to a dir it creates; tighten an existing loose one (older
  // version / umask). Only for our own subdir — never the user's top-level config dir.
  if (tighten) {
    try {
      deps.chmodSync(dir, 0o700);
    } catch {
      /* not ours to chmod; the 0600 file still protects content */
    }
  }
}

// Move a temp into place, unlinking the temp if the rename fails so a flaky FS never leaks
// a per-attempt temp file. The trailing chmod is best-effort — the mode is already applied
// at temp-write time, so a chmod failure must NOT fail an already-committed write.
function commitTemp(deps, tmp, dest, mode) {
  try {
    deps.renameSync(tmp, dest);
  } catch (e) {
    try {
      deps.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
  try {
    deps.chmodSync(dest, mode);
  } catch {
    /* best-effort umask-defeat; the temp already carried the mode */
  }
}

// Write the single stable 0600 backup — exactly once per run, and only if there was a file
// to protect. Backs up state.rawOriginal (the bytes captured when this run first read
// settings.json), NOT a fresh read a concurrent /setup could have already overwritten.
// state.backedUp guards the "before the FIRST write" rule.
function backupOnce(env, deps, state) {
  if (state.backedUp) return;
  if (state.rawOriginal != null) {
    const bp = backupPath(env);
    const tmp = `${bp}.${process.pid}.${state.now}.tmp`;
    deps.writeFileSync(tmp, state.rawOriginal, { mode: 0o600 });
    commitTemp(deps, tmp, bp, 0o600);
  }
  state.backedUp = true;
}

function writeSettingsAtomic(env, deps, obj) {
  const sp = settingsPath(env);
  const dir = path.dirname(sp);
  ensureDir(dir, deps);
  // Preserve the file's existing mode; default a new settings.json to 0600 (it may hold secrets).
  let mode = 0o600;
  try {
    mode = deps.statSync(sp).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = path.join(dir, `.settings.json.${process.pid}.${Date.now()}.tmp`);
  deps.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode });
  commitTemp(deps, tmp, sp, mode);
}

function writeSidecarAtomic(env, deps, obj) {
  const scp = sidecarPath(env);
  const dir = path.dirname(scp);
  ensureDir(dir, deps, { tighten: true });
  const tmp = path.join(dir, `.coexist.json.${process.pid}.${Date.now()}.tmp`);
  deps.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  commitTemp(deps, tmp, scp, 0o600);
}

export function wrap({
  env = process.env,
  deps = fs,
  now = Date.now(),
  runtime,
  platform = 'posix',
} = {}) {
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
    const command = buildStatuslineCommand({ variant, runtime, platform });
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
  const wrapperCommand = buildStatuslineCommand({ variant: 'coexist', runtime, platform });
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

  if (marker === 'coexist') {
    if (sidecar) {
      backupOnce(env, deps, state);
      writeSettingsAtomic(env, deps, { ...base, statusLine: sidecar.original });
      removeIfPresent(sidecarPath(env), deps);
      removeIfPresent(backupPath(env), deps);
      return { action: 'restored-original' };
    }
    // Our wrapper is wired but there's no restorable sidecar — nothing to restore. Back to
    // empty, and clear any present-but-unusable sidecar file so it is never orphaned
    // (matching the removed-collect branch).
    backupOnce(env, deps, state);
    const next = { ...base };
    delete next.statusLine;
    writeSettingsAtomic(env, deps, next);
    removeIfPresent(sidecarPath(env), deps);
    removeIfPresent(backupPath(env), deps);
    return { action: 'coexist-no-sidecar-removed' };
  }
  if (marker === 'collect') {
    backupOnce(env, deps, state);
    const next = { ...base };
    delete next.statusLine;
    writeSettingsAtomic(env, deps, next);
    removeIfPresent(sidecarPath(env), deps);
    removeIfPresent(backupPath(env), deps);
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
      result = wrap({
        runtime: argValue(process.argv, '--runtime'),
        platform: argValue(process.argv, '--platform') ?? 'posix',
      });
    } else if (sub === 'teardown') result = teardown();
    else result = { action: 'error', reason: `unknown subcommand: ${sub ?? '(none)'}` };
  } catch (e) {
    result = { action: 'error', reason: String(e && e.message ? e.message : e) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
