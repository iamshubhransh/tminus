import { describe, expect, test } from 'bun:test';

// Model training is CPU-bound; shared CI runners are several times slower than a laptop.
const SLOW = 60_000;
import {
  buildFeatures, evaluate, importTurns, isGbdtModel, liveEstimate, liveQuality, locate, metrics, openDb, predictGbdt, priorQ,
  gbdtDistribution, replayObs, scoredTurns, sessionShift, trainGbdt, turnInfo,
  type NormalizedTurn, type TrainTurn, type TurnEvent,
} from '@tminus/core';

/** Deterministic pseudo-random lognormal-ish durations per intent. */
function synthTurns(n: number): NormalizedTurn[] {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const medians: Record<string, number> = { fix: 90_000, build_feature: 600_000, question: 20_000 };
  const out: NormalizedTurn[] = [];
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const intent = (['fix', 'build_feature', 'question'] as const)[i % 3];
    const ms = Math.round(medians[intent] * Math.exp(0.7 * gauss()));
    const at = t0 + i * 3_600_000;
    const prompt = intent === 'fix' ? 'fix the bug' : intent === 'question' ? 'what is this?' : 'build a new settings page';
    const features = buildFeatures(prompt, at, 'human', { model: 'm1', effort: 'high' });
    out.push({
      agent: 'claude-code', sessionId: `s${i % 7}`, extId: `e${i}`, projectHash: null, sessionStartedAt: at, submittedAt: at,
      finishedAt: at + ms, idleMs: 0, outcome: 'completed', model: 'm1', effort: 'high', mode: 'default', contextPct: null,
      features, toolCalls: Math.round(ms / 15_000), subagentToolCalls: 0, todoTotal: 0, agentDurationMs: ms,
      events: [
        { ts: at, kind: 'prompt_submit' },
        { ts: at + 1000, kind: 'phase', meta: { c: ['text', 'text:early'] } },
        ...Array.from({ length: Math.round(ms / 15_000) }, (_, k) => ({ ts: at + k * 15_000, kind: 'tool_start' as const, toolName: 'Read' })),
        // Tests then a commit near the end: the live model can learn how far along the turn is.
        { ts: at + Math.round(ms * 0.6), kind: 'phase', meta: { c: ['cmd:test'] } },
        { ts: at + Math.round(ms * 0.85), kind: 'phase', meta: { c: ['cmd:commit'] } },
        { ts: at + ms, kind: 'stop' },
      ].sort((a, b) => a.ts - b.ts) as TurnEvent[],
    });
  }
  return out;
}

describe('backfill import + evaluation', () => {
  test('import is idempotent and predictions are prequential', () => {
    const db = openDb(':memory:');
    const turns = synthTurns(300);
    const s1 = importTurns(db, turns);
    expect(s1.imported).toBe(300);
    expect(importTurns(db, turns).imported).toBe(0);
    const scored = scoredTurns(db);
    // Cold-start predictions (fewer than 20 prior turns) are excluded from stats.
    expect(scored.length).toBe(280);
    const m = metrics(scored);
    // Data is log-normal per intent, so a calibrated model lands near the targets.
    expect(m.underP90).toBeGreaterThan(0.82);
    expect(m.underP90).toBeLessThan(0.97);
    expect(m.inRange).toBeGreaterThan(0.7);
    expect(Math.exp(m.mdae)).toBeLessThan(2);
  }, SLOW);

  test('live replay: error shrinks once the turn is under way', () => {
    const db = openDb(':memory:');
    importTurns(db, synthTurns(240));
    const q = liveQuality(db, 'backfill');
    expect(q.n).toBeGreaterThan(200);
    expect(q.mdae[1]).toBeLessThan(q.mdae[0]);
    expect(q.runningP90).toBeGreaterThan(0.8);
  }, SLOW);

  test('rolling-origin v1 vs v2: every test turn is predicted by models trained only on earlier turns', () => {
    const db = openDb(':memory:');
    importTurns(db, synthTurns(260));
    const r = evaluate(db, { rounds: 20, folds: 4, minTrain: 100 });
    expect(r.folds.length).toBe(4);
    expect(r.folds[0].trainN).toBe(100);
    for (let i = 1; i < r.folds.length; i++) {
      expect(r.folds[i].trainN).toBe(r.folds[i - 1].trainN + r.folds[i - 1].testN);
      expect(r.folds[i].from).toBeGreaterThan(r.folds[i - 1].from);
    }
    expect(r.testN).toBe(160);
    expect(r.v1.n).toBe(160);
    expect(r.v2!.n).toBe(160);
    expect(r.live!.v1.snapshots).toBeGreaterThan(0);
    expect(r.reasons.length).toBe(5);
    expect(typeof r.v2Wins).toBe('boolean');
  }, SLOW);

  test('too little history: no evaluation, v2 not promoted', () => {
    const db = openDb(':memory:');
    importTurns(db, synthTurns(40));
    const r = evaluate(db);
    expect(r.v2).toBeNull();
    expect(r.v2Wins).toBe(false);
  });
});

const asTrain = (t: NormalizedTurn, i: number): TrainTurn => ({
  id: i, features: t.features, activeMs: t.finishedAt - t.submittedAt, agent: t.agent, submittedAt: t.submittedAt, events: t.events,
});

describe('v2: bagged median GBDT + out-of-fold residuals + live model', () => {
  const data = synthTurns(300);
  const m = trainGbdt(data.map(asTrain), { rounds: 40 });

  test('separates intents; quantiles are ordered; the model round-trips through JSON', () => {
    const fix = predictGbdt(m, buildFeatures('fix the bug', 0, 'human', { model: 'm1', effort: 'high' }));
    const build = predictGbdt(m, buildFeatures('build a new settings page', 0, 'human', { model: 'm1', effort: 'high' }));
    expect(fix.p10).toBeLessThan(fix.p50);
    expect(fix.p50).toBeLessThan(fix.p90);
    expect(build.p50).toBeGreaterThan(fix.p50 * 3);
    const copy = JSON.parse(JSON.stringify(m));
    expect(isGbdtModel(copy)).toBe(true);
    expect(predictGbdt(copy, data[0].features)).toEqual(predictGbdt(m, data[0].features));
  });

  test('residual spread matches the data (log sd 0.7 -> P10..P90 spans about exp(2 x 1.28 x 0.7))', () => {
    const p = predictGbdt(m, buildFeatures('fix the bug', 0, 'human', { model: 'm1', effort: 'high' }));
    const ratio = p.p90 / p.p10;
    expect(ratio).toBeGreaterThan(Math.exp(2 * 1.28 * 0.7) * 0.7);
    expect(ratio).toBeLessThan(Math.exp(2 * 1.28 * 0.7) * 1.5);
    expect(m.residuals.length).toBeGreaterThan(100);
  });

  test('old model files are rejected', () => {
    expect(isGbdtModel({ version: 'v2', quantiles: [] })).toBe(false);
    expect(isGbdtModel({ ...m, format: 2 })).toBe(false);
  });

  test('session correction uses honest (out-of-fold) errors for turns the model was trained on', () => {
    expect(Object.keys(m.oof).length).toBe(300);
    const past = [{ id: 0, features: data[0].features, activeMs: data[0].finishedAt - data[0].submittedAt }];
    const honest = Math.log(past[0].activeMs) - m.oof['0'];
    expect(sessionShift(m, past)).toBeCloseTo(honest / (1 + m.session.kappa), 6);
    // A session that keeps running 3x longer than predicted moves the next prediction up.
    const f = data[1].features;
    const slow = [1, 2, 3].map(() => ({ features: f, activeMs: Math.exp(locate(m, f)) * 3 }));
    expect(predictGbdt(m, f, slow).p50).toBeGreaterThan(predictGbdt(m, f).p50 * 1.5);
  });

  test('the live model trains on phase-labelled events; its quantiles are ordered and it sees late phases', () => {
    expect(m.live).not.toBeNull();
    const t = data.find((x) => x.features.prompt.intent === 'build_feature')!;
    const T = t.finishedAt - t.submittedAt;
    const d = gbdtDistribution(m, t.features);
    const [early, late] = replayObs(t.events as any, t.submittedAt, [T * 0.3, T * 0.9]).map((o) => liveEstimate(m.live!, turnInfo(t.agent, t.features), d, priorQ(d), o).blended);
    for (const e of [early, late]) { expect(e.p10).toBeLessThan(e.p50); expect(e.p50).toBeLessThan(e.p90); }
    expect(late.p50).toBeLessThan(early.p50);
    const noPhases = trainGbdt(data.map((x, i) => ({ ...asTrain(x, i), events: x.events.filter((e) => e.kind !== 'phase') })), { rounds: 10 });
    expect(noPhases.live).toBeNull();
  });
});
