// scripts/coexist.mjs
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sidecarPath, snapshotPath } from './lib/config-dir.mjs';
import { readStdin, parseStdinJson } from './lib/stdin.mjs';

// Returns the sidecar object only when it stores a usable original command; else null.
function readSidecar(env, deps) {
  try {
    const obj = JSON.parse(deps.readFileSync(sidecarPath(env), 'utf8'));
    const command = obj?.original?.command;
    return typeof command === 'string' && command.trim() !== '' ? obj : null;
  } catch {
    return null;
  }
}

// Lazy so token-math/time/etc. aren't parsed until AFTER the child is on its way
// (design spec §3.4 "lean hot path"). Importing collect.mjs does not run it (isMain-guarded).
async function defaultLoadSnapshotLib() {
  const collect = await import('./collect.mjs');
  const snap = await import('./lib/snapshot.mjs');
  return {
    buildSnapshot: collect.buildSnapshot,
    compactLine: collect.compactLine,
    writeSnapshot: snap.writeSnapshot,
  };
}

export async function runCoexist({
  now = Date.now(),
  readInput = readStdin,
  env = process.env,
  deps = fs,
  spawn = nodeSpawn,
  write = (s) => process.stdout.write(s),
  loadSnapshotLib = defaultLoadSnapshotLib,
} = {}) {
  // Guarded read: a stdin 'error' must not reject before we can spawn the original (that
  // would blank the user's statusline). The default readStdin already swallows it; this
  // also covers an injected reader.
  let input = '';
  try {
    input = await readInput();
  } catch {
    /* proceed with empty input; the wrapped original still runs */
  }
  const sidecar = readSidecar(env, deps);

  // Degraded half-state: wired to coexist but no usable sidecar. Show OUR line (not a
  // blank statusline) as a visible signal, and still capture the snapshot.
  if (!sidecar) {
    try {
      const { buildSnapshot, compactLine, writeSnapshot } = await loadSnapshotLib();
      const snapshot = buildSnapshot(parseStdinJson(input), now);
      try {
        writeSnapshot(snapshotPath(snapshot.session_id, env), snapshot, { now, deps });
      } catch {
        /* best effort */
      }
      write(`${compactLine(snapshot)}\n`);
    } catch {
      write('\n');
    }
    return 0;
  }

  // Hot path: spawn the original FIRST, forward stdin, inherit stdout+stderr (the original
  // owns the display; inheriting also avoids a full-stderr-pipe deadlock in a chatty child).
  // Use `bash -c` (not `sh -c`) for consistency with command.mjs, which the plugin already
  // requires — a foreign statusline may rely on bashisms that a dash/busybox /bin/sh lacks.
  const child = spawn('bash', ['-c', sidecar.original.command], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env,
  });
  child.stdin.on('error', () => {}); // a stray write to an already-closed child stdin is expected/harmless; swallow the async EPIPE so it never crashes the wrapper or overrides the original's exit code

  // Attach the exit listeners SYNCHRONOUSLY, before the snapshot's `await` — an exit that
  // fires during that await can then never be missed (structurally race-free; the loader
  // timing this depends on is unverified on Bun). We resolve the code but await it last.
  const exitCode = new Promise((resolve) => {
    child.on('close', (code) => resolve(typeof code === 'number' ? code : 0));
    child.on('error', () => resolve(0)); // spawn failure: stay transparent, don't crash
  });

  try {
    child.stdin.write(input);
    child.stdin.end();
  } catch {
    /* child stdin may be closed */
  }

  // Snapshot AFTER the spawn and WITHOUT awaiting the child's exit — a slow/hung/broken
  // original never strands our data.
  try {
    const { buildSnapshot, writeSnapshot } = await loadSnapshotLib();
    const snapshot = buildSnapshot(parseStdinJson(input), now);
    writeSnapshot(snapshotPath(snapshot.session_id, env), snapshot, { now, deps });
  } catch {
    /* best-effort; never affects the child */
  }

  // Await exit ONLY to propagate the code. The snapshot is already on disk.
  return await exitCode;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  // Fail safe: any pre-spawn crash exits 0 (no line this tick, recovered next tick) rather
  // than a non-zero crash that could be read as the wrapped original failing.
  try {
    process.exit(await runCoexist());
  } catch {
    process.exit(0);
  }
}
