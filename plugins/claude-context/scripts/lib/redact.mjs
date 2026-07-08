// Mask obvious secrets before a command is shown in the setup confirm. Best-effort — the
// goal is "don't echo a Bearer token / API key into the transcript", not perfect DLP.
export function redactSecrets(command) {
  if (typeof command !== 'string') return '';
  return command
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9._-]{6,}/g, 'sk-[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(
      /\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)("?)([^"\s]+)\3/gi,
      (_m, key, sep) => `${key}${sep}[REDACTED]`,
    );
}

export function previewCommand(command, max = 160) {
  const redacted = redactSecrets(command);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`;
}
