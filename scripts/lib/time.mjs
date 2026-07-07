// Adapted from claude-hud (MIT, © Jarrod Watts): epoch parsing + reset formatting.
export function epochToMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1e12 ? value : value * 1000;
  // ECMAScript caps Date at ±8.64e15 ms; beyond it new Date(ms).toISOString() throws.
  if (ms > 8.64e15) return null;
  return ms;
}

export function formatDuration(totalSeconds) {
  if (totalSeconds == null || totalSeconds < 0) return null;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function clockHM(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
