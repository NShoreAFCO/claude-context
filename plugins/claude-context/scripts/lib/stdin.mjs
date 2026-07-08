// The statusline stdin reader, shared by every entry point Claude Code pipes JSON into
// (collect.mjs, coexist.mjs). Kept in one place so the two cannot drift: both must be
// crash-proof, since an uncaught stdin error in a wrapper blanks the user's statusline.

// Read the whole stream as UTF-8. Guarded: a stream 'error' event resolves to '' rather
// than rejecting, so a caller never crashes before it can spawn/print.
export async function readStdin(stream = process.stdin) {
  try {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

// Parse the statusline JSON, falling back to {} on empty/malformed input.
export function parseStdinJson(input) {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}
