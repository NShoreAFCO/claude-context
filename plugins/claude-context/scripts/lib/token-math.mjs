// Coerce to a finite number, defaulting a non-number/NaN/Infinity to 0 (num) or null
// (numOrNull). The canonical copies — imported by collect/report/transcript rather than
// re-declared, since they're byte-identical everywhere they're needed.
export function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function usedTokens(usage) {
  return (
    num(usage?.input_tokens) +
    num(usage?.cache_read_input_tokens) +
    num(usage?.cache_creation_input_tokens)
  );
}

export function percentage(used, windowSize) {
  if (!windowSize || windowSize <= 0) return null;
  return Math.round((used / windowSize) * 100);
}

export function headroom(used, windowSize) {
  if (!windowSize || windowSize <= 0) return null;
  return Math.max(0, windowSize - used);
}

// The window usage is measured against once an auto-compact window is configured: Claude
// Code caps that window at the model's window, so it is the smaller of the positive values.
export function effectiveWindow(windowSize, autoCompactWindow) {
  const sizes = [windowSize, autoCompactWindow].filter((v) => typeof v === 'number' && v > 0);
  return sizes.length ? Math.min(...sizes) : null;
}

// Compact token count for the statusline: 999, 84k, 1M, 1.5M. A value that rounds to 1000k
// prints as 1M.
export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k`;
  return `${Number((n / 1e6).toFixed(1))}M`;
}
