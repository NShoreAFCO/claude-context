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
      .replace(/gh[pousr]_[A-Za-z0-9]{8,}/g, '[REDACTED]') // classic GitHub tokens
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]') // fine-grained GitHub PAT
      // Provider-specific key shapes with no label to key off.
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]') // AWS access-key id
      .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]') // Google API key
      .replace(/\bxox[a-z]-[A-Za-z0-9-]{8,}/gi, '[REDACTED]') // Slack bot/user/refresh (xoxb/xoxp/xoxe/…) token
      .replace(/\bxapp-[A-Za-z0-9-]{8,}/gi, '[REDACTED]') // Slack app-level token
      // Basic-auth URL: mask only the password segment, keep host/path usable in a preview.
      // Any URI scheme (postgres://, redis://, https://, …), not just http(s).
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, '$1[REDACTED]$3')
      // Labeled assignment. The name may be an env-var-style identifier that merely CONTAINS a
      // secret word (e.g. AWS_SECRET_ACCESS_KEY), so match the whole `_`/`-`-joined name — the
      // plain `\bsecret\b` boundary used before missed those.
      // The value may be double-quoted, single-quoted (either can contain spaces), or an
      // unquoted whitespace-free run. Anchoring the close-quote to the first whitespace-free
      // run (the old `"?…\3`) dropped the whole match on a quoted phrase — leaking it entirely.
      .replace(
        /\b([A-Za-z0-9_]*(?:key|token|secret|password)[A-Za-z0-9_]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^"\s]+)/gi,
        (_m, name, sep) => `${name}${sep}[REDACTED]`,
      )
  );
}

export function previewCommand(command, max = 160) {
  const redacted = redactSecrets(command);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`;
}
