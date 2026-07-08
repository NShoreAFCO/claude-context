// scripts/wiring.mjs
import fs from 'node:fs';
import { settingsPath, sidecarPath } from './lib/config-dir.mjs';
import { detectMarker } from './lib/marker.mjs';
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

// wrap() and teardown() are added in Tasks 7-8. CLI dispatch is added in Task 8.
