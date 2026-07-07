const DEFAULT_WINDOW = 200_000;
const MILLION = 1_000_000;

// Matches "[1m]" or a "1m" token bounded by non-alphanumerics (e.g. "-1m").
const ONE_MILLION = /\[1m\]|(^|[^0-9a-z])1m([^0-9a-z]|$)/;

export function inferWindowSize(model) {
  const id = String(model?.id ?? '').toLowerCase();
  return ONE_MILLION.test(id) ? MILLION : DEFAULT_WINDOW;
}
