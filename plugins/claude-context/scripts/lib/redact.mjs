// Mask obvious secrets before a command is shown in the setup confirm. Best-effort — the
// goal is "don't echo a Bearer token / API key into the transcript", not perfect DLP, so
// over-redaction is acceptable and preferred over a leak.
export function redactSecrets(command) {
  if (typeof command !== 'string') return '';
  return (
    command
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      // JWT / triple-segment token (header.payload.signature) — before sk-/generic rules.
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/sk-[A-Za-z0-9._-]{6,}/g, 'sk-[REDACTED]')
      .replace(/gh[pousr]_[A-Za-z0-9]{8,}/g, '[REDACTED]')
      // Provider-specific key shapes with no label to key off.
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]') // AWS access-key id
      .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]') // Google API key
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/gi, '[REDACTED]') // Slack token
      // Basic-auth URL: mask only the password segment, keep host/path usable in a preview.
      .replace(/(\bhttps?:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, '$1[REDACTED]$3')
      // Labeled assignment. The name may be an env-var-style identifier that merely CONTAINS a
      // secret word (e.g. AWS_SECRET_ACCESS_KEY), so match the whole `_`/`-`-joined name — the
      // plain `\bsecret\b` boundary used before missed those.
      .replace(
        /\b([A-Za-z0-9_]*(?:key|token|secret|password)[A-Za-z0-9_]*)(\s*[:=]\s*)("?)([^"\s]+)\3/gi,
        (_m, name, sep) => `${name}${sep}[REDACTED]`,
      )
  );
}

export function previewCommand(command, max = 160) {
  const redacted = redactSecrets(command);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`;
}
