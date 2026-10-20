import { describe, expect, test } from 'bun:test';
import {
  activeMs, BucketPredictor, DEFAULT_PRIOR, estimateRemaining, IdleClock, LogMixture, MIN_BUCKET_N, priorSignal, SHRINK_K,
  TodoState, todoSignal, unionLength, type ToolCategory, type TrainingRow,
} from '@tminus/core';

const row = (intent: any, activeMs: number, model = 'm1', effort = 'high'): TrainingRow => ({ model, effort, intent, activeMs, toolCalls: 10 });

describe('bucket shrinkage', () => {
  test('falls back to the default prior with no data', () => {
    const p = new BucketPredictor();
    const pr = p.prior({ model: 'm1', effort: 'high', intent: 'fix' });
    expect(pr.chain).toEqual([]);
    expect(pr.dist).toBe(DEFAULT_PRIOR);
  });

  test('uses the most specific bucket with at least 8 samples', () => {
    const rows: TrainingRow[] = [];
    for (let i = 0; i < 30; i++) rows.push(row('fix', 60_000 + i * 1000, 'm1', 'low'));
    for (let i = 0; i < 7; i++) rows.push(row('fix', 600_000, 'm1', 'high')); // too few for (m1, high, fix)
    const p = BucketPredictor.train(rows);
    const pr = p.prior({ model: 'm1', effort: 'high', intent: 'fix' });
    expect(pr.level).toBe('model+intent');
    expect(pr.n).toBe(37);
    // With 8 samples the most specific bucket is used.
    p.add(row('fix', 600_000, 'm1', 'high'));
    expect(p.prior({ model: 'm1', effort: 'high', intent: 'fix' }).level).toBe('model+effort+intent');
    expect(MIN_BUCKET_N).toBe(8);
  });

  test('shrink weight is n / (n + 8) and pulls toward the parent', () => {
    const rows: TrainingRow[] = [];
    for (let i = 0; i < 200; i++) rows.push(row('build_feature', 300_000 * (1 + (i % 5) / 10), 'm1', 'low'));
    for (let i = 0; i < 8; i++) rows.push(row('fix', 20_000, 'm1', 'low'));
    const p = BucketPredictor.train(rows);
    const pr = p.prior({ model: 'm1', effort: 'low', intent: 'fix' });
    const last = pr.chain[pr.chain.length - 1];
    expect(last.n).toBe(8);
    expect(last.w).toBeCloseTo(8 / (8 + SHRINK_K), 10);
    const median = pr.dist.quantile(0.5);
    // Half the mass comes from the much slower parent, so the median sits above 20s.
    expect(median).toBeGreaterThan(20_000);
    expect(median).toBeLessThan(330_000);
  });

  test('quantiles are ordered and outliers are capped for training', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row('other', 30_000 + i * 2000));
    rows.push(row('other', 50 * 3_600_000)); // 50h outlier
    rows.push(row('other', 200)); // under 1s: discarded
    const p = BucketPredictor.train(rows);
    expect(p.size).toBe(51);
    const q = p.predict({ model: 'm1', effort: 'high', intent: 'other' });
    expect(q.p10).toBeLessThan(q.p50);
    expect(q.p50).toBeLessThan(q.p90);
    expect(q.p90).toBeLessThan(2 * 3_600_000);
  });
});

describe('survival conditioning', () => {
  const prior = LogMixture.lognormal(Math.log(120_000), 1.2);

  test('at t=0 the remaining quantiles equal the prior quantiles', () => {
    expect(prior.remainingQuantile(0, 0.5) / prior.quantile(0.5)).toBeCloseTo(1, 2);
  });

  test('a turn that has run long predicts more remaining time, never a frozen value', () => {
    const at = [60_000, 300_000, 900_000, 3_600_000, 4 * 3_600_000].map((t) => priorSignal(prior, t).p50);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1]);
  });

  test('works deep in the tail without NaN', () => {
    const s = priorSignal(prior, 48 * 3_600_000);
    expect(Number.isFinite(s.p50)).toBe(true);
    expect(s.p90).toBeGreaterThan(s.p50);
  });

  test('mean residual life is consistent with the median', () => {
    const m = prior.meanRemaining(600_000);
    expect(m).toBeGreaterThan(prior.remainingQuantile(600_000, 0.5));
  });
});

describe('todo blending', () => {
  const prior = LogMixture.lognormal(Math.log(300_000), 1.0);
  const base = { prior, toolHistory: [] as ToolCategory[], bucketCalls: [] as number[], perTaskPriorMs: 60_000 };
  const list = (done: number, total: number) => {
    const t = new TodoState();
    t.apply({ kind: 'snapshot', items: Array.from({ length: total }, (_, i) => ({ id: String(i), status: 'pending' as const })) }, 0);
    for (let i = 0; i < done; i++) t.apply({ kind: 'upsert', id: String(i), status: 'completed' }, (i + 1) * 60_000);
    return t;
  };

  test('weight is zero without a todo list and rises with completed items', () => {
    expect(estimateRemaining({ ...base, elapsedMs: 10_000, toolCalls: 0, todo: null }).weights.todo).toBe(0);
    const w = [0, 1, 3, 6].map((d) => estimateRemaining({ ...base, elapsedMs: d * 60_000 + 1000, toolCalls: 0, todo: list(d, 8) }).weights.todo);
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeGreaterThan(w[i - 1]);
  });

  test('remaining tracks (total - done) x pace', () => {
    const t = list(4, 8);
    const s = todoSignal(t, 4 * 60_000 + 1000, 60_000)!;
    expect(s.p50).toBeGreaterThan(3 * 60_000 * 0.8);
    expect(s.p50).toBeLessThan(4 * 60_000 * 1.6);
  });

  test('tasks added mid-run raise the estimate', () => {
    const t = list(2, 4);
    const before = todoSignal(t, 120_500, 60_000)!.p50;
    t.apply({ kind: 'upsert', id: 'new1', status: 'pending' }, 120_500);
    t.apply({ kind: 'upsert', id: 'new2', status: 'pending' }, 120_500);
    expect(t.total).toBe(6);
    expect(todoSignal(t, 120_500, 60_000)!.p50).toBeGreaterThan(before);
  });

  test('P90 is inflated when signals disagree', () => {
    const agree = estimateRemaining({ ...base, elapsedMs: 240_500, toolCalls: 0, todo: list(4, 8) });
    expect(agree.p90RemainingMs).toBeGreaterThan(agree.p50RemainingMs);
    expect(agree.weights.prior + agree.weights.todo + agree.weights.activity).toBeCloseTo(1, 10);
  });
});

describe('idle-time subtraction', () => {
  test('active = finished - submitted - idle', () => {
    const c = new IdleClock();
    c.startWait(10_000, 'permission');
    c.startWait(12_000); // nested start keeps the earliest
    expect(c.total(15_000)).toBe(5_000);
    c.endWait(40_000);
    c.startWait(50_000);
    c.endWait(55_000);
    expect(c.idleMs).toBe(35_000);
    expect(activeMs(0, 100_000, c.idleMs)).toBe(65_000);
  });

  test('overlapping waits are counted once', () => {
    expect(unionLength([[0, 10], [5, 15], [20, 25], [24, 30], [40, 40]])).toBe(25);
  });
});
