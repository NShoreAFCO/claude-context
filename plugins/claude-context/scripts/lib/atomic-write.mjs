// scripts/lib/atomic-write.mjs
// Adapted from claude-hud (MIT, © Jarrod Watts): src/external-usage.ts write robustness.
// The 0600-file / 0700-dir / atomic-rename / temp-cleanup dance, in one place so the
// snapshot writer and the settings.json writer can't drift (this routine was gotten wrong
// once already — see the temp-cleanup regression tests).
import fs from 'node:fs';

// mkdir the dir at 0700; optionally tighten an existing loose one (older version / umask).
// mkdir's mode only applies to a dir it creates, hence the best-effort chmod. Never used on
// the user's top-level config dir — only our own subdir.
export function ensureDir(dir, { deps = fs, tighten = false } = {}) {
  deps.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (tighten) {
    try {
      deps.chmodSync(dir, 0o700);
    } catch {
      /* not ours to chmod; the 0600 file still protects content */
    }
  }
}

// Write `data` to `tmp` then atomically rename it into `dest`, unlinking `tmp` on ANY
// failure — a partial write on a full/flaky FS (ENOSPC) as well as a failed rename — so a
// stray per-attempt temp is never left behind. THROWS on failure (the snapshot writer
// catches it into its tri-state; the settings writer lets it propagate). The mode is applied
// at write time; the trailing chmod is best-effort — it cannot un-commit an already-renamed file.
export function writeFileAtomic(tmp, dest, data, mode, { deps = fs } = {}) {
  try {
    deps.writeFileSync(tmp, data, { mode });
    deps.renameSync(tmp, dest);
  } catch (e) {
    try {
      deps.unlinkSync(tmp);
    } catch {
      /* already gone / never created */
    }
    throw e;
  }
  try {
    deps.chmodSync(dest, mode);
  } catch {
    /* best-effort umask-defeat; the temp already carried the mode */
  }
}
