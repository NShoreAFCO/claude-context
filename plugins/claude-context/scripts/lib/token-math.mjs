function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
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
