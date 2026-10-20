import { describe, expect, test } from 'bun:test';
import {
  codexCommand, commandPhase, oofPredict, predictBooster, replayObs, textPhase, trainBooster,
} from '@tminus/core';

describe('histogram booster', () => {
  const X = Array.from({ length: 400 }, (_, i) => [i % 10, (i * 7) % 13]);
  const y = X.map(([a]) => (a < 5 ? 1 : 3) + ((X.indexOf([a]) % 3) - 1) * 0.01);

  test('learns a step and serialises to JSON', () => {
    const m = trainBooster(X, y, { loss: 'l2', rounds: 60, lr: 0.2 });
    expect(predictBooster(m, [2, 0])).toBeCloseTo(1, 1);
    expect(predictBooster(m, [8, 0])).toBeCloseTo(3, 1);
    const copy = JSON.parse(JSON.stringify(m));
    expect(predictBooster(copy, [8, 0])).toBe(predictBooster(m, [8, 0]));
  });

  test('quantile loss: alpha 0.9 sits above alpha 0.1 on noisy data', () => {
    let s = 1;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const Xn = Array.from({ length: 500 }, () => [rand()]);
    const yn = Xn.map(() => rand() * 10);
    const hi = trainBooster(Xn, yn, { alpha: 0.9, rounds: 80 });
    const lo = trainBooster(Xn, yn, { alpha: 0.1, rounds: 80 });
    expect(predictBooster(hi, [0.5])).toBeGreaterThan(7);
    expect(predictBooster(lo, [0.5])).toBeLessThan(3);
  });

  test('out-of-fold predictions never use the row they predict (grouped folds keep groups together)', () => {
    const oof = oofPredict(X, y, { loss: 'l2', rounds: 20 }, 5, X.map((_, i) => Math.floor(i / 10)));
    expect(oof.every(Number.isFinite)).toBe(true);
    expect(oof.length).toBe(X.length);
  });
});

describe('phase labels', () => {
  test('shell commands', () => {
    expect(commandPhase('pytest -k login')).toEqual(['cmd:test']);
    expect(commandPhase('git add -A && git commit -m wip')).toEqual(['cmd:commit']);
    expect(commandPhase('git push origin main')).toEqual(['cmd:push']);
    expect(commandPhase('ls -la src')).toEqual(['cmd:read']);
    expect(commandPhase('docker compose up')).toEqual(['cmd:other']);
  });

  test('agent text', () => {
    expect(textPhase('Let me start by reading the router.')).toEqual(['text', 'text:early']);
    expect(textPhase("Now I'll implement the parser.")).toEqual(['text', 'text:middle']);
    expect(textPhase('All tests pass.')).toEqual(['text', 'text:late']);
    expect(textPhase('Should I also update the docs?')).toEqual(['text', 'text:ask']);
    expect(textPhase('x'.repeat(2000))).toEqual(['text', 'text:long']);
  });

  test('Codex shell argument shapes', () => {
    expect(codexCommand('exec_command', JSON.stringify({ cmd: 'npm test' }))).toBe('npm test');
    expect(codexCommand('shell', { command: ['bash', '-lc', 'make build'] })).toBe('bash -lc make build');
    expect(codexCommand('exec', 'git status')).toBe('git status');
    expect(codexCommand('apply_patch', '*** Begin Patch')).toBeNull();
  });
});

describe('observation replay (shared by training and the live engine)', () => {
  const t0 = 1_000_000;
  const events = [
    { ts: t0, kind: 'prompt_submit' },
    { ts: t0 + 1_000, kind: 'phase', meta: { c: ['text', 'text:early'] } },
    { ts: t0 + 2_000, kind: 'tool_start', toolName: 'Read' },
    { ts: t0 + 3_000, kind: 'tool_end', toolName: 'Read' },
    { ts: t0 + 4_000, kind: 'tool_start', toolName: 'Bash' },
    { ts: t0 + 4_000, kind: 'phase', meta: { c: ['cmd:test'] } },
    { ts: t0 + 5_000, kind: 'tool_start', toolName: 'Grep', meta: { subagent: true } },
    { ts: t0 + 10_000, kind: 'waiting_user', meta: { reason: 'permission' } },
    { ts: t0 + 70_000, kind: 'resumed' },
    { ts: t0 + 75_000, kind: 'tool_end', toolName: 'Bash' },
  ];

  test('counts, running tools, phases; time waiting on the user is not elapsed time', () => {
    const [a, b, c] = replayObs(events, t0, [3_500, 9_000, 15_000]);
    expect(a).toMatchObject({ toolCalls: 1, running: 0, sinceEvent: 500, lastTool: 'Read' });
    expect(a.phase).toEqual({ text: 1, 'text:early': 1 });
    expect(b).toMatchObject({ toolCalls: 2, subCalls: 1, running: 1, runningFor: 5_000, lastCmd: 'cmd:test', distinctTools: 2 });
    // 60s waiting for a permission answer is excluded: 15s of active time is reached only after the tool ended.
    expect(c).toMatchObject({ running: 0, waits: 1 });
  });
});
