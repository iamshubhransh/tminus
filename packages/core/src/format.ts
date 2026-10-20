/** Human duration formatting shared by renderers and the CLI. */

/** Rounded, glanceable: 40s, 2m, 1h20m. */
export function fmtShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = ms / 1000;
  if (s < 60) return `${Math.max(5, Math.round(s / 5) * 5)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const rm = Math.round(m - h * 60);
  return rm === 60 ? `${h + 1}h` : rm ? `${h}h${rm}m` : `${h}h`;
}

/** Precise: 4m12s, 1h03m, 38s. */
export function fmtPrecise(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** A range that shares its unit when it can: 1–5m, 30s–2m, 1h–1h40m. */
export function fmtRange(lo: number, hi: number): string {
  const a = fmtShort(lo);
  const b = fmtShort(hi);
  if (a === b) return a;
  const unit = (x: string) => (/^\d+m$/.test(x) ? 'm' : /^\d+s$/.test(x) ? 's' : null);
  if (unit(a) && unit(a) === unit(b)) return `${a.slice(0, -1)}–${b}`;
  return `${a}–${b}`;
}

/** "×1.6" style multiplicative error. */
export function fmtFactor(logErr: number): string {
  return `×${Math.exp(Math.abs(logErr)).toFixed(1)}`;
}

export function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–';
}
