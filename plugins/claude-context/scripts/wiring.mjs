// scripts/wiring.mjs
import fs from 'node:fs';
import path from 'node:path';
import { settingsPath, sidecarPath, backupPath } from './lib/config-dir.mjs';
import { detectMarker } from './lib/marker.mjs';
import { buildStatuslineCommand } from './lib/command.mjs';
import { previewCommand } from './lib/redact.mjs';

// Returns the parsed object, or undefined if the file is missing OR unparseable. Callers
// distinguish the two with existsSync so an unreadable settings.json is never overwritten.
function readJson(file, deps) {
  try {
    return JSON.parse(deps.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}
function currentCommand(settings) {
  const c = settings?.statusLine?.command;
  return typeof c === 'string' && c.trim() !== '' ? c : null;
}
function classify(command) {
  if (command == null) return 'empty';
  const marker = detectMarker(command);
  if (marker === 'collect') return 'ours-collect';
  if (marker === 'coexist') return 'ours-coexist';
  return 'foreign';
}
function readSidecar(env, deps) {
  const s = readJson(sidecarPath(env), deps);
  return s && s.original && typeof s.original.command === 'string' ? s : null;
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
  const command = currentCommand(settings ?? {});
  const sidecar = readSidecar(env, deps);
  const storedCommand = sidecar ? sidecar.original.command : null;
  return {
    slot: classify(command),
    preview: command == null ? null : previewCommand(command),
    hasSidecar: !!sidecar,
    sidecarMatchesSlot: !!sidecar && command != null && storedCommand === command,
    storedOriginalPreview: storedCommand == null ? null : previewCommand(storedCommand),
  };
}

function ensureDir(dir, deps) {
  deps.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Copy settings.json to the single stable 0600 backup — exactly once per run, and only
// if there is a file to protect. state.backedUp guards the "before the FIRST write" rule.
function backupOnce(env, deps, state) {
  if (state.backedUp) return;
  const sp = settingsPath(env);
  if (deps.existsSync(sp)) {
    const bp = backupPath(env);
    const tmp = `${bp}.${process.pid}.${state.now}.tmp`;
    deps.writeFileSync(tmp, deps.readFileSync(sp), { mode: 0o600 });
    deps.renameSync(tmp, bp);
    deps.chmodSync(bp, 0o600);
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
  deps.renameSync(tmp, sp);
  deps.chmodSync(sp, mode);
}

function writeSidecarAtomic(env, deps, obj) {
  const scp = sidecarPath(env);
  const dir = path.dirname(scp);
  ensureDir(dir, deps);
  const tmp = path.join(dir, `.coexist.json.${process.pid}.${Date.now()}.tmp`);
  deps.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  deps.renameSync(tmp, scp);
  deps.chmodSync(scp, 0o600);
}

export function wrap({
  env = process.env,
  deps = fs,
  now = Date.now(),
  runtime,
  platform = 'posix',
} = {}) {
  const sp = settingsPath(env);
  const settings = readJson(sp, deps);
  if (settings === undefined && deps.existsSync(sp))
    return { action: 'error', reason: 'unparseable-settings' };
  const base = settings ?? {};
  const command = currentCommand(base);
  const slot = classify(command);
  const state = { backedUp: false, now };

  const setVariant = (variant) => {
    backupOnce(env, deps, state);
    writeSettingsAtomic(env, deps, {
      ...base,
      statusLine: {
        type: 'command',
        command: buildStatuslineCommand({ variant, runtime, platform }),
      },
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
    };
  }
  // Fresh foreign wrap: back up, store the ORIGINAL first (safe ordering), then wire coexist.
  backupOnce(env, deps, state);
  writeSidecarAtomic(env, deps, {
    original: base.statusLine,
    wrapped_at: new Date(now).toISOString(),
  });
  writeSettingsAtomic(env, deps, {
    ...base,
    statusLine: {
      type: 'command',
      command: buildStatuslineCommand({ variant: 'coexist', runtime, platform }),
    },
  });
  return { action: 'wired-coexist', slot };
}

// teardown() and CLI dispatch are added in Task 8.
