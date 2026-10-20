import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderStatusline } from '@tminus/render';
import { writeState, type LiveState } from '@tminus/core';

const root = join(import.meta.dir, '..');
// The statusline runs the render-only bundle; fall back to the CLI bundle, then source.
const bundle = [join(root, 'packages/cli/dist/tminus-render.js'), join(root, 'packages/cli/dist/tminus.js')].find(existsSync);
const source = join(root, 'packages/cli/src/index.ts');
const input = JSON.stringify({ session_id: 'bench', model: { id: 'claude-opus-5-5' }, context_window: { used_percentage: 20 } });

const now = Date.now();
const state: LiveState = {
  v: 1, agent: 'claude-code', sessionId: 'bench', project: 'p', status: 'running', updatedAt: now,
  turn: {
    submittedAt: now - 60_000, elapsedMs: 60_000, idleMs: 0, intent: 'fix', p10RemainingMs: 60_000, p50RemainingMs: 120_000,
    p90RemainingMs: 300_000, p50TotalMs: 180_000, p90TotalMs: 600_000, overrun: false, todo: { done: 3, total: 7 }, toolCalls: 4,
    waitingSince: null, waitingReason: null, weights: { prior: 1, todo: 0, activity: 0 }, bucket: { level: 'global', n: 1 },
  },
  last: null, history: [],
};

test('in-process statusline render is well under 30ms', async () => {
  writeState(state);
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    const out = await renderStatusline({ stdin: input, color: false });
    times.push(performance.now() - t0);
    expect(out).toContain('~2m');
  }
  times.sort((a, b) => a - b);
  expect(times[25]).toBeLessThan(5);
});

test('end-to-end statusline process (spawn + render + exit) is under 30ms', () => {
  writeState(state);
  const script = bundle ?? source;
  const run = () => {
    const t0 = performance.now();
    const r = spawnSync('bun', [script, 'render', '--statusline', '--no-color'], { input, env: process.env, encoding: 'utf8' });
    const dt = performance.now() - t0;
    expect(r.stdout).toContain('⏳');
    return dt;
  };
  run(); run(); // warm the file cache
  const times = Array.from({ length: 15 }, run).sort((a, b) => a - b);
  // 30ms is the product budget. Shared CI VMs start processes much more slowly than real
  // machines, so CI may raise this via TMINUS_RENDER_BUDGET_MS; `tminus doctor` checks 30ms on the user's machine.
  const budget = Number(process.env.TMINUS_RENDER_BUDGET_MS ?? 30);
  console.log(`render p50 ${times[7].toFixed(1)}ms p90 ${times[13].toFixed(1)}ms (${script.split('/').pop()}, budget ${budget}ms)`);
  expect(times[7]).toBeLessThan(budget);
});
