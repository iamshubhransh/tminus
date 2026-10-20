import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, type LiveState } from '@tminus/core';
import { colorEnabled, combine, fill, renderSegment } from '@tminus/render';

const NOW = Date.parse('2026-10-20T10:10:00Z');

function state(over: Partial<LiveState> = {}, turn: Partial<NonNullable<LiveState['turn']>> = {}): LiveState {
  return {
    v: 1, agent: 'claude-code', sessionId: 's', project: 'p', status: 'running', updatedAt: NOW,
    turn: {
      submittedAt: NOW - 60_000, elapsedMs: 60_000, idleMs: 0, intent: 'fix',
      p10RemainingMs: 60_000, p50RemainingMs: 120_000, p90RemainingMs: 300_000,
      p50TotalMs: 180_000, p90TotalMs: 600_000, overrun: false, todo: { done: 3, total: 7 }, toolCalls: 4,
      waitingSince: null, waitingReason: null, weights: { prior: 1, todo: 0, activity: 0 }, bucket: { level: 'global', n: 10 },
      ...turn,
    },
    last: null, history: [], ...over,
  };
}
const plain = (s: LiveState | null, now = NOW, cfg = DEFAULT_CONFIG) => renderSegment(s, now, cfg, 'none').text;

describe('statusline segment', () => {
  test('running', () => expect(plain(state())).toBe('⏳ ~2m · 1–5m · 3/7'));
  test('running without a todo list drops the separator', () => expect(plain(state({}, { todo: null }))).toBe('⏳ ~2m · 1–5m'));
  test('waiting on the user', () => expect(plain(state({ status: 'waiting' }))).toBe('⏸ waiting on you'));
  test('long overrun shows elapsed', () => {
    expect(plain(state({}, { elapsedMs: 9 * 60_000 + 20_000, p90TotalMs: 6 * 60_000 }))).toBe('⏳ running long · 9m');
  });
  test('finished: shows the result for 10s, then hides', () => {
    const s = state({ status: 'done', turn: null, last: { finishedAt: NOW - 3_000, actualMs: 252_000, p50Ms: 180_000, p90Ms: 600_000, outcome: 'completed', intent: 'fix' } });
    expect(plain(s)).toBe('✓ 4m12s · predicted 3m');
    expect(plain(s, NOW + 12_000)).toBe('');
  });
  test('interrupted turns are not celebrated', () => {
    const s = state({ status: 'done', turn: null, last: { finishedAt: NOW, actualMs: 1000, p50Ms: 1000, p90Ms: 2000, outcome: 'interrupted', intent: 'fix' } });
    expect(plain(s)).toBe('');
  });
  test('idle or no state renders nothing', () => {
    expect(plain(null)).toBe('');
    expect(plain(state({ status: 'idle', turn: null }))).toBe('');
  });
  test('elapsed keeps moving between collector writes', () => {
    const s = state({ updatedAt: NOW - 4_000 }, { elapsedMs: 9 * 60_000 - 2_000, p90TotalMs: 9 * 60_000 });
    expect(plain(s)).toContain('running long');
  });
  test('custom format string with all tokens', () => {
    const cfg = { ...DEFAULT_CONFIG, formats: { ...DEFAULT_CONFIG.formats, running: '[{status}] {p50} left ({range}) {todo} after {elapsed}' } };
    expect(plain(state(), NOW, cfg)).toBe('[⏳] 2m left (1–5m) 3/7 after 1m');
  });
  test('ANSI and tmux palettes', () => {
    expect(renderSegment(state(), NOW, DEFAULT_CONFIG, 'ansi').text).toMatch(/^\x1b\[38;5;\d+m.*\x1b\[0m$/);
    expect(renderSegment(state(), NOW, DEFAULT_CONFIG, 'tmux').text).toMatch(/^#\[fg=colour\d+\].*#\[default\]$/);
  });
  test('NO_COLOR wins over config', () => {
    process.env.NO_COLOR = '1';
    expect(colorEnabled(DEFAULT_CONFIG)).toBe(false);
    delete process.env.NO_COLOR;
    expect(colorEnabled(DEFAULT_CONFIG)).toBe(true);
    expect(colorEnabled({ ...DEFAULT_CONFIG, color: false })).toBe(false);
  });
});

describe('wrapping an existing statusline', () => {
  test('appends to the first line by default and leaves it alone when idle', () => {
    expect(combine('main line\nsecond\n', 'SEG', DEFAULT_CONFIG)).toBe('main line │ SEG\nsecond');
    expect(combine('main line\n', '', DEFAULT_CONFIG)).toBe('main line');
    expect(combine('', 'SEG', DEFAULT_CONFIG)).toBe('SEG');
    expect(combine('a\nb', 'SEG', { ...DEFAULT_CONFIG, wrapPosition: 'newline' })).toBe('a\nb\nSEG');
    expect(combine('a\nb', 'SEG', { ...DEFAULT_CONFIG, wrapPosition: 'append-last' })).toBe('a\nb │ SEG');
  });
  test('fill collapses separators around empty tokens', () => {
    expect(fill('{a} · {b} · {c}', { a: 'x', b: '', c: 'z' })).toBe('x · z');
    expect(fill('{a} · {b}', { a: '', b: '' })).toBe('');
  });
});
