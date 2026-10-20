import { BucketPredictor, LogMixture, INTENTS, type TrainingRow } from '@tminus/core';
import { buildVocab, gbdtDistribution as legacyDistribution, trainGbdt as legacyTrain, vectorize } from './legacy-v2.ts';
import type { LabTurn } from './data.ts';
import { oofPredict, predictBooster, trainBooster, type BoostOpts } from './gbdt.ts';
import type { Candidate, Ctx, Fitted, Hist } from './protocol.ts';

export function trainingRow(t: LabTurn): TrainingRow {
  return {
    model: t.model, effort: t.effort, intent: t.features.prompt.intent, activeMs: t.activeMs,
    toolCalls: t.toolCalls + t.subagentToolCalls, todoTotal: 0,
  };
}

export const globalKde: Candidate = {
  name: 'global',
  fit(train) {
    const d = LogMixture.kde(train.slice(-300).map((t) => t.y));
    return { predict: () => d };
  },
};

export const v1: Candidate = {
  name: 'v1',
  fit(train) {
    const p = BucketPredictor.train(train.map(trainingRow));
    return { predict: (t) => p.prior({ model: t.model, effort: t.effort, intent: t.features.prompt.intent }).dist };
  },
};

/** v2 exactly as shipped in 0.1–0.2.1 (slow reference implementation, lab/legacy-v2.ts). */
export const v2: Candidate = {
  name: 'v2',
  fit(train) {
    const m = legacyTrain(train.map((t) => t.features), train.map((t) => Math.min(t.activeMs, 2 * 3600_000)));
    return { predict: (t) => legacyDistribution(m, t.features) };
  },
};

// ---------------------------------------------------------------------------
// Feature groups for the lab booster.

const EFFORT_ORD: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

export function modelFamily(m: string | null): string {
  if (!m) return '?';
  if (/opus/.test(m)) return 'opus';
  if (/sonnet/.test(m)) return 'sonnet';
  if (/haiku/.test(m)) return 'haiku';
  if (/fable/.test(m)) return 'fable';
  if (/codex/.test(m)) return 'gpt-codex';
  if (/gpt|o\d/.test(m)) return 'gpt';
  return 'other';
}

export type Group = 'base' | 'basenolen' | 'own' | 'agent' | 'effort' | 'family' | 'session' | 'project' | 'recent' | 'text' | 'prev' | 'knn';

export interface FeatureSet { names: string[]; vec: (t: LabTurn) => number[] }

export function featureSet(groups: Group[], train: LabTurn[], hist: Map<string, Hist>): FeatureSet {
  const vocab = buildVocab(train.map((t) => t.features));
  const parts: { names: string[]; f: (t: LabTurn, h: Hist) => number[] }[] = [];
  if (groups.includes('base')) {
    const names = ['log_chars', 'log_words', 'lines', 'refs', 'scope', 'code_block', 'question', 'urls', 'images', 'context_pct', 'log_turn_index', 'log_recent_median', 'log_repo_files', 'hour', 'weekday',
      ...INTENTS.map((i) => `intent_${i}`), ...vocab.models.map((m) => `model_${m}`), ...vocab.efforts.map((e) => `effort_${e}`), ...vocab.modes.map((m) => `mode_${m}`)];
    parts.push({ names, f: (t) => vectorize(t.features, vocab) });
  }
  if (groups.includes('basenolen')) {
    // Production base features minus the raw length ones (log_chars, log_words, lines), to swap in own-text lengths.
    const names = ['refs', 'scope', 'code_block', 'question', 'urls', 'images', 'context_pct', 'log_turn_index', 'log_recent_median', 'log_repo_files', 'hour', 'weekday',
      ...INTENTS.map((i) => `intent_${i}`), ...vocab.models.map((m) => `model_${m}`), ...vocab.efforts.map((e) => `effort_${e}`), ...vocab.modes.map((m) => `mode_${m}`)];
    parts.push({ names, f: (t) => vectorize(t.features, vocab).slice(3) });
  }
  if (groups.includes('own')) {
    const ks = ['o_log_chars', 'o_log_words', 'o_lines', 'o_log_pasted', 'o_pasted_blocks', 'o_compact'];
    parts.push({ names: ks, f: (t) => ks.map((k) => t.text[k] ?? -1) });
  }
  if (groups.includes('agent')) parts.push({ names: ['is_codex', 'is_sdk'], f: (t) => [+(t.agent === 'codex'), +(t.trigger === 'sdk')] });
  if (groups.includes('effort')) parts.push({ names: ['effort_ord'], f: (t) => [t.effort ? EFFORT_ORD[t.effort] ?? -1 : -1] });
  if (groups.includes('family')) {
    const fams = ['opus', 'fable', 'sonnet', 'haiku', 'gpt-codex', 'gpt'];
    parts.push({ names: fams.map((f) => `fam_${f}`), f: (t) => fams.map((f) => +(modelFamily(t.model) === f)) });
  }
  if (groups.includes('session')) {
    const ks = ['s_prev', 's_done', 's_mean', 's_last', 's_last2', 's_last_calls', 's_last_gap', 's_last_interrupted', 's_last_system', 's_age'];
    parts.push({ names: ks, f: (_t, h) => ks.map((k) => h[k] ?? -1) });
  }
  if (groups.includes('project')) {
    const ks = ['pr_n', 'pr_mean', 'pr_med'];
    parts.push({ names: ks, f: (_t, h) => ks.map((k) => h[k] ?? -1) });
  }
  if (groups.includes('recent')) {
    const ks = ['g_recent', 'a_recent'];
    parts.push({ names: ks, f: (_t, h) => ks.map((k) => h[k] ?? -1) });
  }
  if (groups.includes('knn')) {
    const ks = ['k_mean', 'k_max', 'k_n', 'k_y1'];
    parts.push({ names: ks, f: (_t, h) => ks.map((k) => h[k] ?? -1) });
  }
  if (groups.includes('text')) {
    const ks = Object.keys(train.find((t) => Object.keys(t.text).length)?.text ?? {}).filter((k) => k.startsWith('p_'));
    parts.push({ names: ks, f: (t) => ks.map((k) => t.text[k] ?? -1) });
  }
  if (groups.includes('prev')) {
    const ks = Object.keys(train.find((t) => Object.keys(t.text).length)?.text ?? {}).filter((k) => k.startsWith('a_'));
    parts.push({ names: ks, f: (t) => ks.map((k) => t.text[k] ?? -1) });
  }
  const names = parts.flatMap((p) => p.names);
  // Groups like "-model_" drop every feature whose name starts with that prefix (ablations).
  const drops = (groups as string[]).filter((g) => g.startsWith('-')).map((g) => g.slice(1));
  const keep = names.map((n) => !drops.some((d) => n.startsWith(d)));
  return {
    names: names.filter((_, i) => keep[i]),
    vec: (t) => { const h = hist.get(t.key) ?? {}; return parts.flatMap((p) => p.f(t, h)).filter((_, i) => keep[i]); },
  };
}

// ---------------------------------------------------------------------------
// Lab booster candidate: median model + out-of-fold residual spread (v2's recipe).

export interface GbOpts {
  groups: Group[];
  boost?: BoostOpts;
  /** KDE bandwidth for the residual spread. */
  bw?: number;
  /** Residual pool size. */
  maxResid?: number;
  /** Recency weighting half-life in turns (undefined = equal weights). */
  halfLife?: number;
  name?: string;
  /** Heteroscedastic spread: a second booster predicts log |residual|; residuals are pooled after dividing by it. */
  scale?: boolean;
  /** Shrink the predicted log-scale toward its mean (0 = homoscedastic, 1 = full). */
  scaleShrink?: number;
  /** Average this many boosters trained with different seeds (bagging). */
  bag?: number;
}

export function gb(o: GbOpts): Candidate {
  return {
    name: o.name ?? `gb[${o.groups.join('+')}]`,
    fit(train: LabTurn[], ctx: Ctx): Fitted {
      const fs = featureSet(o.groups, train, ctx.hist);
      const X = train.map(fs.vec);
      const y = train.map((t) => t.y);
      const weights = o.halfLife ? train.map((_, i) => Math.pow(0.5, (train.length - 1 - i) / o.halfLife!)) : undefined;
      const bo: BoostOpts = { loss: 'quantile', alpha: 0.5, ...o.boost, weights };
      const bag = o.bag ?? 1;
      const ms = Array.from({ length: bag }, (_, k) => trainBooster(X, y, { ...bo, seed: 7 + k * 101, subsample: bag > 1 ? (bo.subsample ?? 0.7) : bo.subsample }));
      const locOf = (x: number[]) => ms.reduce((s, m) => s + predictBooster(m, x), 0) / ms.length;
      const oofs = Array.from({ length: bag }, (_, k) => oofPredict(X, y, { ...bo, seed: 7 + k * 101, subsample: bag > 1 ? (bo.subsample ?? 0.7) : bo.subsample }, 5));
      const oof = y.map((_, i) => oofs.reduce((s, a) => s + a[i], 0) / bag);
      const raw = y.map((v, i) => v - oof[i]);
      const bw = o.bw ?? 0.15;
      let scaleOf = (_x: number[]) => 1;
      let zs = raw;
      if (o.scale) {
        const lr = raw.map((r) => Math.log(Math.abs(r) + 0.05));
        const so: BoostOpts = { loss: 'l2', rounds: 100, lr: 0.05, maxDepth: 2, minLeaf: 20 };
        const sm = trainBooster(X, lr, so);
        const soof = oofPredict(X, lr, so, 5);
        const mean = lr.reduce((a, b) => a + b, 0) / lr.length;
        const k = o.scaleShrink ?? 1;
        scaleOf = (x) => Math.exp(k * (predictBooster(sm, x) - mean));
        zs = raw.map((r, i) => r / Math.exp(k * (soof[i] - mean)));
      }
      const resid = residualDist(zs, o.maxResid ?? 300);
      return {
        predict: (t) => {
          const x = fs.vec(t);
          const loc = locOf(x);
          const s = scaleOf(x);
          return new LogMixture(resid.map((r) => ({ w: 1, mu: loc + s * r, sd: bw * s })));
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Ridge regression on log duration, with missing-value indicators, log1p for
// counts, standardisation, and lambda chosen by k-fold CV on the training set.

export interface Linear { mu: number[]; sd: number[]; w: number[]; b: number; transform: (x: number[]) => number[] }

function solve(A: number[][], b: number[]): number[] {
  // Gaussian elimination with partial pivoting (A is small and SPD after the ridge term).
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

/** Build a transform: missing (-1 sentinel on otherwise non-negative features) -> indicator + mean; big counts -> log1p. */
export function linearTransform(X: number[][]): (x: number[]) => number[] {
  const d = X[0]?.length ?? 0;
  const kind: ('plain' | 'miss' | 'log' | 'misslog')[] = [];
  const fill: number[] = [];
  for (let f = 0; f < d; f++) {
    const col = X.map((x) => x[f]);
    const real = col.filter((v) => v !== -1);
    const nonneg = real.every((v) => v >= 0);
    const hasMiss = nonneg && real.length < col.length && real.length > 0;
    const max = Math.max(...real, 0);
    const isCount = nonneg && max > 3 && real.every((v) => Number.isInteger(v));
    kind.push(hasMiss ? (isCount ? 'misslog' : 'miss') : isCount ? 'log' : 'plain');
    const tv = real.map((v) => (isCount ? Math.log1p(v) : v));
    fill.push(tv.length ? tv.reduce((a, b) => a + b, 0) / tv.length : 0);
  }
  return (x) => {
    const out: number[] = [];
    for (let f = 0; f < d; f++) {
      const k = kind[f];
      const v = x[f];
      if (k === 'plain') out.push(v);
      else if (k === 'log') out.push(Math.log1p(Math.max(0, v)));
      else {
        const miss = v === -1;
        out.push(miss ? fill[f] : k === 'misslog' ? Math.log1p(v) : v, miss ? 1 : 0);
      }
    }
    return out;
  };
}

export function fitRidge(X: number[][], y: number[], lambda: number, weights?: number[]): Linear {
  const transform = linearTransform(X);
  const Z0 = X.map(transform);
  const d = Z0[0].length;
  const n = y.length;
  const w = weights ?? new Array(n).fill(1);
  const W = w.reduce((a, b) => a + b, 0);
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += w[i] * Z0[i][j];
    m /= W;
    let v = 0;
    for (let i = 0; i < n; i++) v += w[i] * (Z0[i][j] - m) ** 2;
    mu[j] = m; sd[j] = Math.sqrt(v / W) || 1;
  }
  const Z = Z0.map((z) => z.map((v, j) => (v - mu[j]) / sd[j]));
  const ym = y.reduce((s, v, i) => s + w[i] * v, 0) / W;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    const zi = Z[i], wi = w[i], yi = y[i] - ym;
    for (let j = 0; j < d; j++) {
      if (!zi[j]) continue;
      b[j] += wi * zi[j] * yi;
      for (let k = j; k < d; k++) A[j][k] += wi * zi[j] * zi[k];
    }
  }
  for (let j = 0; j < d; j++) { for (let k = 0; k < j; k++) A[j][k] = A[k][j]; A[j][j] += lambda; }
  return { mu, sd, w: solve(A, b), b: ym, transform };
}

export function predictLinear(m: Linear, x: number[]): number {
  const z = m.transform(x);
  let s = m.b;
  for (let j = 0; j < z.length; j++) s += m.w[j] * (z[j] - m.mu[j]) / m.sd[j];
  return s;
}

const LAMBDAS = [1, 3, 10, 30, 100, 300, 1000];

export function cvRidge(X: number[][], y: number[], weights?: number[], k = 5): { lambda: number; oof: number[] } {
  let best = { lambda: LAMBDAS[0], err: Infinity, oof: [] as number[] };
  for (const lambda of LAMBDAS) {
    const oof = new Array(y.length).fill(NaN);
    for (let j = 0; j < k; j++) {
      const tr: number[] = [], te: number[] = [];
      y.forEach((_, i) => (i % k === j ? te : tr).push(i));
      const m = fitRidge(tr.map((i) => X[i]), tr.map((i) => y[i]), lambda, weights ? tr.map((i) => weights[i]) : undefined);
      for (const i of te) oof[i] = predictLinear(m, X[i]);
    }
    const err = oof.reduce((s, p, i) => s + Math.abs(y[i] - p), 0);
    if (err < best.err) best = { lambda, err, oof };
  }
  return { lambda: best.lambda, oof: best.oof };
}

export function residualDist(resid: number[], max = 300): number[] {
  let r = resid.filter(Number.isFinite).sort((a, b) => a - b);
  if (r.length > max) r = Array.from({ length: max }, (_, i) => r[Math.floor(((i + 0.5) / max) * r.length)]);
  return r;
}

export function ridge(o: { groups: Group[]; lambda?: number; halfLife?: number; bw?: number; name?: string }): Candidate {
  return {
    name: o.name ?? `ridge[${o.groups.join('+')}]${o.lambda ? `λ${o.lambda}` : ''}`,
    fit(train, ctx) {
      const fs = featureSet(o.groups, train, ctx.hist);
      const X = train.map(fs.vec);
      const y = train.map((t) => t.y);
      const weights = o.halfLife ? train.map((_, i) => Math.pow(0.5, (train.length - 1 - i) / o.halfLife!)) : undefined;
      const cv = cvRidge(X, y, weights);
      const lambda = o.lambda ?? cv.lambda;
      const m = fitRidge(X, y, lambda, weights);
      const resid = residualDist(y.map((v, i) => v - cv.oof[i]));
      const bw = o.bw ?? 0.15;
      return {
        predict: (t) => {
          const loc = predictLinear(m, fs.vec(t));
          return new LogMixture(resid.map((r) => ({ w: 1, mu: loc + r, sd: bw })));
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The production engine, end to end (packages/core/src/gbdt.ts), for parity checks
// against the lab's own implementation of the same recipe.

import { gbdtDistribution, liveEstimate as prodLive, priorQ, replayObs, trainGbdt, turnInfo, type PastTurn } from '@tminus/core';

export function production(): Candidate {
  return {
    name: 'production-v2',
    fit(train, ctx) {
      const model = trainGbdt(train.map((t) => ({ id: t.key, features: t.features, activeMs: t.activeMs, agent: t.agent, submittedAt: t.submittedAt, events: t.events })));
      const trainable = ctx.all.filter((u) => u.trainable);
      const pastFor = (t: LabTurn): PastTurn[] => trainable
        .filter((u) => u.sessionId === t.sessionId && u.finishedAt < t.submittedAt)
        .sort((a, b) => a.finishedAt - b.finishedAt).slice(-3)
        .map((u) => ({ id: u.key, features: u.features, activeMs: u.activeMs }));
      return {
        predict: (t) => gbdtDistribution(model, t.features, pastFor(t)),
        live: model.live ? (t, prior, ob) => {
          const o = replayObs(t.events as any, t.submittedAt, [ob.elapsedMs])[0];
          const b = prodLive(model.live!, turnInfo(t.agent, t.features), prior, priorQ(prior), o).blended;
          return { p10: Math.min(b.p10, b.p50 * 0.9), p50: b.p50, p90: Math.max(b.p90, b.p50 * 1.1) };
        } : undefined,
      };
    },
  };
}
