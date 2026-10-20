import { fmtPrecise, fmtRange, fmtShort, type Config, type LiveState } from '@tminus/core';

export type Palette = 'ansi' | 'tmux' | 'none';
type Tone = 'running' | 'waiting' | 'overrun' | 'done';

const ANSI: Record<Tone, string> = {
  running: '\x1b[38;5;117m',
  waiting: '\x1b[38;5;221m',
  overrun: '\x1b[38;5;209m',
  done: '\x1b[38;5;114m',
};
const TMUX: Record<Tone, string> = {
  running: '#[fg=colour117]',
  waiting: '#[fg=colour221]',
  overrun: '#[fg=colour209]',
  done: '#[fg=colour114]',
};

/** A state older than this means the collector is gone; don't pretend to count. */
const STALE_MS = 30_000;

export function colorEnabled(cfg: Config, flag?: boolean): boolean {
  if (process.env.NO_COLOR) return false;
  if (flag === false) return false;
  return cfg.color;
}

function paint(text: string, tone: Tone, palette: Palette): string {
  if (!text || palette === 'none') return text;
  return palette === 'ansi' ? `${ANSI[tone]}${text}\x1b[0m` : `${TMUX[tone]}${text}#[default]`;
}

/** Substitute {tokens}; tokens that render empty take their dangling separators with them. */
export function fill(format: string, tokens: Record<string, string>): string {
  const out = format.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? '');
  return out
    .replace(/(\s*·\s*){2,}/g, ' · ')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface SegmentResult { text: string; tone: Tone | null; stale: boolean }

/**
 * Pure: state + clock -> segment text. Running:  ⏳ ~2m · 1–5m · 3/7
 * Waiting: ⏸ waiting on you. Overrun: ⏳ running long · 9m. Done: ✓ 4m12s · predicted 3m (for a few seconds).
 */
export function renderSegment(state: LiveState | null, now: number, cfg: Config, palette: Palette, formatOverride?: string): SegmentResult {
  if (!state) return { text: '', tone: null, stale: false };
  const age = now - state.updatedAt;
  const t = state.turn;

  if ((state.status === 'running' || state.status === 'waiting') && t) {
    const stale = age > STALE_MS;
    // The collector rewrites the file every second; bridge the gap so elapsed never looks stuck.
    const drift = state.status === 'running' && age > 0 && age < STALE_MS ? age : 0;
    const elapsed = t.elapsedMs + drift;
    const tokens = {
      status: '⏳',
      p50: fmtShort(Math.max(1000, t.p50RemainingMs - drift)),
      range: fmtRange(Math.max(1000, t.p10RemainingMs - drift), Math.max(1000, t.p90RemainingMs - drift)),
      todo: t.todo ? `${t.todo.done}/${t.todo.total}` : '',
      elapsed: fmtShort(elapsed),
      actual: '', predicted: fmtShort(t.p50TotalMs),
    };
    let tone: Tone = 'running';
    let fmt = formatOverride ?? cfg.formats.running;
    if (state.status === 'waiting') { tone = 'waiting'; fmt = cfg.formats.waiting; tokens.status = '⏸'; }
    else if (elapsed > t.p90TotalMs) { tone = 'overrun'; fmt = cfg.formats.overrun; }
    return { text: paint(fill(fmt, tokens), tone, palette), tone, stale };
  }

  if (state.status === 'done' && state.last && state.last.outcome === 'completed') {
    if (now - state.last.finishedAt > cfg.doneLingerSec * 1000) return { text: '', tone: null, stale: false };
    const tokens = {
      status: '✓',
      actual: fmtPrecise(state.last.actualMs),
      predicted: state.last.p50Ms ? fmtShort(state.last.p50Ms) : '?',
      elapsed: fmtPrecise(state.last.actualMs),
      p50: '', range: '', todo: '',
    };
    return { text: paint(fill(cfg.formats.done, tokens), 'done', palette), tone: 'done', stale: false };
  }
  return { text: '', tone: null, stale: false };
}
