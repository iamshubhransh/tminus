/** The v2 model as shipped in 0.1–0.2.1 (frozen copy), kept as the lab's reference baseline. */
import { LogMixture } from '../packages/core/src/dist.ts';
import { quantileSorted } from '../packages/core/src/stats.ts';
import type { Features } from '../packages/core/src/types.ts';
import { INTENTS } from '../packages/core/src/types.ts';

/**
 * Predictor v2: a quantile gradient-boosted model (alpha = 0.5) of
 * log(active_ms) gives the location; the spread is the model's own
 * out-of-fold residuals (a conformal calibration step). The directly trained
 * alpha = 0.1 / 0.9 models were miscalibrated on held-out data (too narrow on
 * the low side), while residual-calibrated intervals hit their targets.
 * Small, dependency-free, serialisable to JSON, evaluated in-process by the
 * collector. Only used once `tminus eval` shows it beats v1 on held-out data.
 */

type Node = { f: number; t: number; l: Node; r: Node } | { v: number };

export interface QuantileModel { alpha: number; f0: number; lr: number; trees: Node[] }
export interface GbdtModel {
  version: 'v2';
  /** Bumped when the model layout changes; older files are ignored. */
  format: 2;
  trainedAt: string;
  n: number;
  featureNames: string[];
  vocab: { models: string[]; efforts: string[]; modes: string[] };
  median: QuantileModel;
  /** Sorted out-of-fold residuals, log(actual) - log(predicted median). */
  residuals: number[];
  /** Kernel width (log space) used to smooth the residuals into a distribution. */
  bandwidth: number;
}

export function isGbdtModel(m: unknown): m is GbdtModel {
  const x = m as GbdtModel;
  return !!x && x.version === 'v2' && x.format === 2 && !!x.median && Array.isArray(x.residuals) && x.residuals.length > 0;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['default', 'plan', 'auto', 'acceptEdits', 'bypassPermissions'];

export function buildVocab(rows: Features[]): GbdtModel['vocab'] {
  const counts = new Map<string, number>();
  for (const f of rows) {
    const m = f.session.model ?? '?';
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const models = [...counts.entries()].filter(([, n]) => n >= 10).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m]) => m);
  return { models, efforts: EFFORTS, modes: MODES };
}

export function featureNames(v: GbdtModel['vocab']): string[] {
  return [
    'log_chars', 'log_words', 'lines', 'refs', 'scope', 'code_block', 'question', 'urls', 'images',
    'context_pct', 'log_turn_index', 'log_recent_median', 'log_repo_files', 'hour', 'weekday',
    ...INTENTS.map((i) => `intent_${i}`),
    ...v.models.map((m) => `model_${m}`),
    ...v.efforts.map((e) => `effort_${e}`),
    ...v.modes.map((m) => `mode_${m}`),
  ];
}

export function vectorize(f: Features, v: GbdtModel['vocab']): number[] {
  const p = f.prompt;
  const s = f.session;
  return [
    Math.log1p(p.chars), Math.log1p(p.words), Math.min(p.lines, 200), Math.min(p.refs, 50), +p.scope, +p.codeBlock, +p.question,
    Math.min(p.urls, 10), Math.min(p.images, 20),
    s.contextPct ?? -1, Math.log1p(s.turnIndex), s.recentMedianMs ? Math.log(s.recentMedianMs) : -1,
    f.repo.files ? Math.log1p(f.repo.files) : -1, f.time.hour, f.time.weekday,
    ...INTENTS.map((i) => +(p.intent === i)),
    ...v.models.map((m) => +(s.model === m)),
    ...v.efforts.map((e) => +(s.effort === e)),
    ...v.modes.map((m) => +(s.mode === m)),
  ];
}

function evalTree(n: Node, x: number[]): number {
  while (!('v' in n)) n = x[n.f] <= n.t ? n.l : n.r;
  return n.v;
}

export function predictQuantile(m: QuantileModel, x: number[]): number {
  let y = m.f0;
  for (const t of m.trees) y += m.lr * evalTree(t, x);
  return y;
}

/** Deterministic PRNG so training is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TreeOpts { maxDepth: number; minLeaf: number; alpha: number }

/**
 * Fit a regression tree to the pinball-loss negative gradient, then set each
 * leaf to the alpha-quantile of the residuals that fall into it (Friedman's
 * TreeBoost for quantile loss).
 */
function fitTree(X: number[][], grad: number[], resid: number[], idx: number[], depth: number, o: TreeOpts, thresholds: number[][]): Node {
  const leaf = (): Node => ({ v: quantileSorted(idx.map((i) => resid[i]).sort((a, b) => a - b), o.alpha) });
  if (depth >= o.maxDepth || idx.length < 2 * o.minLeaf) return leaf();
  let total = 0;
  for (const i of idx) total += grad[i];
  const n = idx.length;
  let best = { gain: 1e-9, f: -1, t: 0 };
  for (let f = 0; f < thresholds.length; f++) {
    for (const t of thresholds[f]) {
      let sl = 0, nl = 0;
      for (const i of idx) if (X[i][f] <= t) { sl += grad[i]; nl++; }
      const nr = n - nl;
      if (nl < o.minLeaf || nr < o.minLeaf) continue;
      const sr = total - sl;
      const gain = (sl * sl) / nl + (sr * sr) / nr - (total * total) / n;
      if (gain > best.gain) best = { gain, f, t };
    }
  }
  if (best.f < 0) return leaf();
  const L: number[] = [], R: number[] = [];
  for (const i of idx) (X[i][best.f] <= best.t ? L : R).push(i);
  return { f: best.f, t: best.t, l: fitTree(X, grad, resid, L, depth + 1, o, thresholds), r: fitTree(X, grad, resid, R, depth + 1, o, thresholds) };
}

function candidateThresholds(X: number[][], maxPerFeature = 24): number[][] {
  const d = X[0]?.length ?? 0;
  const out: number[][] = [];
  for (let f = 0; f < d; f++) {
    const vals = [...new Set(X.map((x) => x[f]))].sort((a, b) => a - b);
    if (vals.length <= 1) { out.push([]); continue; }
    const ts: number[] = [];
    if (vals.length <= maxPerFeature) {
      for (let i = 0; i < vals.length - 1; i++) ts.push((vals[i] + vals[i + 1]) / 2);
    } else {
      for (let k = 1; k < maxPerFeature; k++) ts.push(quantileSorted(vals, k / maxPerFeature));
    }
    out.push([...new Set(ts)]);
  }
  return out;
}

export function trainQuantile(X: number[][], y: number[], alpha: number, opts: { rounds?: number; lr?: number; maxDepth?: number; minLeaf?: number; subsample?: number; seed?: number } = {}): QuantileModel {
  const rounds = opts.rounds ?? 150;
  const lr = opts.lr ?? 0.08;
  const o: TreeOpts = { maxDepth: opts.maxDepth ?? 3, minLeaf: opts.minLeaf ?? Math.max(5, Math.floor(y.length / 60)), alpha };
  const rand = mulberry32(opts.seed ?? 7);
  const thresholds = candidateThresholds(X);
  const f0 = quantileSorted([...y].sort((a, b) => a - b), alpha);
  const F = y.map(() => f0);
  const trees: Node[] = [];
  const all = y.map((_, i) => i);
  for (let r = 0; r < rounds; r++) {
    const idx = all.filter(() => rand() < (opts.subsample ?? 0.8));
    const resid = y.map((yi, i) => yi - F[i]);
    const grad = resid.map((e) => (e > 0 ? alpha : alpha - 1));
    const tree = fitTree(X, grad, resid, idx, 0, o, thresholds);
    trees.push(tree);
    for (let i = 0; i < y.length; i++) F[i] += lr * evalTree(tree, X[i]);
  }
  return { alpha, f0, lr, trees };
}

const MAX_RESIDUALS = 300;

export function trainGbdt(features: Features[], activeMs: number[], opts: { rounds?: number; cvFolds?: number } = {}): GbdtModel {
  const vocab = buildVocab(features);
  const X = features.map((f) => vectorize(f, vocab));
  const y = activeMs.map((ms) => Math.log(Math.max(ms, 1000)));
  const median = trainQuantile(X, y, 0.5, opts);

  // Out-of-fold residuals: each turn is predicted by a model that never saw it.
  const k = opts.cvFolds ?? 5;
  const residuals: number[] = [];
  for (let j = 0; j < k; j++) {
    const train: number[] = [], test: number[] = [];
    X.forEach((_, i) => (i % k === j ? test : train).push(i));
    if (!test.length || train.length < 10) continue;
    const m = trainQuantile(train.map((i) => X[i]), train.map((i) => y[i]), 0.5, opts);
    for (const i of test) residuals.push(y[i] - predictQuantile(m, X[i]));
  }
  residuals.sort((a, b) => a - b);
  // Keep an evenly spaced subset so the distribution stays cheap to evaluate every second.
  const kept = residuals.length <= MAX_RESIDUALS ? residuals
    : Array.from({ length: MAX_RESIDUALS }, (_, i) => quantileSorted(residuals, (i + 0.5) / MAX_RESIDUALS));
  return {
    version: 'v2',
    format: 2,
    trainedAt: new Date().toISOString(),
    n: y.length,
    featureNames: featureNames(vocab),
    vocab,
    median,
    residuals: kept,
    bandwidth: 0.15,
  };
}

/** Predictive distribution for one turn: the median prediction plus smoothed out-of-fold residuals. */
export function gbdtDistribution(m: GbdtModel, f: Features): LogMixture {
  const loc = predictQuantile(m.median, vectorize(f, m.vocab));
  return new LogMixture(m.residuals.map((r) => ({ w: 1, mu: loc + r, sd: m.bandwidth })));
}

/** Predict P10/P50/P90 in ms. */
export function predictGbdt(m: GbdtModel, f: Features): { p10: number; p50: number; p90: number } {
  const d = gbdtDistribution(m, f);
  return { p10: d.quantile(0.1), p50: d.quantile(0.5), p90: d.quantile(0.9) };
}
