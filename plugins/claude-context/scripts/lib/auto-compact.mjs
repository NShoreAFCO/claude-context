// The auto-compact window: how full the context gets before Claude Code compacts.
// Claude Code does not send it to the statusline, so it is read here from the same
// places Claude Code reads it, highest precedence first:
//   1. env CLAUDE_CODE_AUTO_COMPACT_WINDOW (k/M suffix; <100k → 100k, >1M → 1M;
//      anything unusable is ignored, as Claude Code does)
//   2. <project>/.claude/settings.local.json   (source 'local')
//   3. <project>/.claude/settings.json         (source 'project')
//   4. <config-dir>/settings.json              (source 'user')
// Within one file, modelSettings[<model>].autoCompactWindow beats the top-level key; a
// per-model "auto" means the model's tuned window (reported as not configured). The
// first file that sets either decides. Managed settings, `--settings` and the
// `--autocompact` flag are not observable from here.
//
// Settings files can hold secrets: only the two auto-compact keys are ever read out of
// the parsed object, nothing is logged, and any read/parse error counts as "absent".
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigDir } from './config-dir.mjs';

const MIN = 100000;
const MAX = 1000000;
const NONE = Object.freeze({ tokens: null, source: null });

function validTokens(v) {
  return Number.isInteger(v) && v >= MIN && v <= MAX;
}

function parseEnv(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(raw.trim());
  if (!m) return null;
  const mult = m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
  const tokens = Math.round(Number(m[1]) * mult);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return Math.min(MAX, Math.max(MIN, tokens));
}

// Settings key models by canonical name (`claude-opus-5-5`); stdin carries ids such as
// `claude-opus-5-5[1m]` or a date-suffixed id. Reduce both sides to the same base.
function baseModel(id) {
  if (typeof id !== 'string') return null;
  return id
    .trim()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
    .toLowerCase();
}

// → { decided: false } | { decided: true, tokens: number|null }
function fromFile(file, model, readFile) {
  let parsed;
  try {
    parsed = JSON.parse(readFile(file, 'utf8'));
  } catch {
    return { decided: false };
  }
  if (!parsed || typeof parsed !== 'object') return { decided: false };

  const ms = parsed.modelSettings;
  if (model && ms && typeof ms === 'object') {
    for (const [key, entry] of Object.entries(ms)) {
      if (baseModel(key) !== model || !entry || typeof entry !== 'object') continue;
      const v = entry.autoCompactWindow;
      if (v === 'auto') return { decided: true, tokens: null };
      if (validTokens(v)) return { decided: true, tokens: v };
    }
  }
  if (validTokens(parsed.autoCompactWindow)) {
    return { decided: true, tokens: parsed.autoCompactWindow };
  }
  return { decided: false };
}

export function readAutoCompactWindow({
  stdin,
  env = process.env,
  readFile = fs.readFileSync,
} = {}) {
  const fromEnv = parseEnv(env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (fromEnv != null) return { tokens: fromEnv, source: 'env' };

  const model = baseModel(stdin?.model?.id);
  const projectDir = stdin?.workspace?.project_dir || stdin?.cwd || null;
  const userFile = path.join(resolveConfigDir(env), 'settings.json');
  const files = [];
  if (typeof projectDir === 'string') {
    files.push([path.join(projectDir, '.claude', 'settings.local.json'), 'local']);
    // Started in the home dir, the "project" file is the user file: report it once, as user.
    const projectFile = path.join(projectDir, '.claude', 'settings.json');
    if (path.resolve(projectFile) !== path.resolve(userFile)) files.push([projectFile, 'project']);
  }
  files.push([userFile, 'user']);

  for (const [file, source] of files) {
    const r = fromFile(file, model, readFile);
    if (r.decided) return r.tokens == null ? { ...NONE } : { tokens: r.tokens, source };
  }
  return { ...NONE };
}
