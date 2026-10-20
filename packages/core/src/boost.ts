/**
 * Histogram gradient boosting for small tabular data, dependency-free and
 * serialisable to JSON. Losses: quantile (pinball, with Friedman TreeBoost
 * leaf values) and squared error. Features are binned once (<= 32 bins), so a
 * tree level costs O(rows x features). Missing values are encoded by the
 * caller as a sentinel (-1).
 */

export type TreeNode = { f: number; t: number; l: TreeNode; r: TreeNode } | { v: number };

export interface Booster {
  loss: 'quantile' | 'l2';
  alpha: number;
  f0: number;
  lr: number;
  trees: TreeNode[];
}

export interface BoostOpts {
  loss?: 'quantile' | 'l2';
  alpha?: number;
  rounds?: number;
  lr?: number;
  maxDepth?: number;
  /** Minimum total sample weight per leaf. */
  minLeaf?: number;
  subsample?: number;
  colsample?: number;
  /** L2 penalty on leaf values (l2 loss only), in units of sample weight. */
  lambda?: number;
  seed?: number;
  weights?: number[];
  bins?: number;
}

export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedQuantile(vals: number[], ws: number[], alpha: number): number {
  const idx = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
  let total = 0;
  for (const w of ws) total += w;
  if (total <= 0) return 0;
  const target = alpha * total;
  let acc = 0;
  for (const i of idx) {
    acc += ws[i];
    if (acc >= target) return vals[i];
  }
  return vals[idx[idx.length - 1]];
}

interface Binned {
  n: number;
  d: number;
  /** Row-major bin index. */
  xb: Uint8Array;
  /** Upper edge (split threshold) for each bin of each feature: x <= edges[f][b] goes left. */
  edges: number[][];
}

function binFeatures(X: number[][], maxBins: number): Binned {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const xb = new Uint8Array(n * d);
  const edges: number[][] = [];
  for (let f = 0; f < d; f++) {
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) vals[i] = X[i][f];
    const sorted = Array.from(vals).sort((a, b) => a - b);
    const uniq: number[] = [];
    for (const v of sorted) if (!uniq.length || uniq[uniq.length - 1] !== v) uniq.push(v);
    let e: number[];
    if (uniq.length <= maxBins) {
      e = uniq.slice(0, -1).map((v, i) => (v + uniq[i + 1]) / 2);
    } else {
      const s = new Set<number>();
      for (let k = 1; k < maxBins; k++) {
        const q = sorted[Math.min(n - 1, Math.floor((k / maxBins) * n))];
        // Threshold between q and the next distinct value so ties stay together.
        const j = uniq.indexOf(q);
        if (j >= 0 && j < uniq.length - 1) s.add((uniq[j] + uniq[j + 1]) / 2);
      }
      e = [...s].sort((a, b) => a - b);
    }
    edges.push(e);
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      // First edge with v <= edge; bins beyond the last edge = e.length.
      let lo = 0, hi = e.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (v <= e[mid]) hi = mid; else lo = mid + 1; }
      xb[i * d + f] = lo;
    }
  }
  return { n, d, xb, edges };
}

export function evalTree(n: TreeNode, x: number[]): number {
  while (!('v' in n)) n = x[n.f] <= n.t ? n.l : n.r;
  return n.v;
}

export function predictBooster(m: Booster, x: number[]): number {
  let y = m.f0;
  for (const t of m.trees) y += m.lr * evalTree(t, x);
  return y;
}

export function trainBooster(X: number[][], y: number[], o: BoostOpts = {}): Booster {
  const loss = o.loss ?? 'quantile';
  const alpha = o.alpha ?? 0.5;
  const rounds = o.rounds ?? 150;
  const lr = o.lr ?? 0.08;
  const maxDepth = o.maxDepth ?? 3;
  const n = y.length;
  const w = o.weights ?? new Array(n).fill(1);
  let wsum = 0;
  for (const x of w) wsum += x;
  const minLeaf = o.minLeaf ?? Math.max(5, wsum / 60);
  const subsample = o.subsample ?? 0.8;
  const colsample = o.colsample ?? 1;
  const lambda = o.lambda ?? 0;
  const B = Math.min(o.bins ?? 32, 255);
  const rand = mulberry32(o.seed ?? 7);
  const bx = binFeatures(X, B);
  const d = bx.d;

  const f0 = loss === 'quantile' ? weightedQuantile(y, w, alpha) : y.reduce((s, v, i) => s + v * w[i], 0) / wsum;
  const F = new Float64Array(n).fill(f0);
  const g = new Float64Array(n);
  const trees: TreeNode[] = [];
  const histG = new Float64Array(d * (B + 1));
  const histW = new Float64Array(d * (B + 1));

  const build = (rows: number[], depth: number, feats: number[]): TreeNode => {
    const leaf = (): TreeNode => {
      if (loss === 'quantile') {
        const r = rows.map((i) => y[i] - F[i]);
        return { v: weightedQuantile(r, rows.map((i) => w[i]), alpha) };
      }
      let s = 0, sw = 0;
      for (const i of rows) { s += w[i] * (y[i] - F[i]); sw += w[i]; }
      return { v: sw + lambda > 0 ? s / (sw + lambda) : 0 };
    };
    let W = 0, G = 0;
    for (const i of rows) { W += w[i]; G += w[i] * g[i]; }
    if (depth >= maxDepth || W < 2 * minLeaf) return leaf();
    histG.fill(0); histW.fill(0);
    for (const i of rows) {
      const base = i * d;
      const gi = w[i] * g[i], wi = w[i];
      for (const f of feats) {
        const k = f * (B + 1) + bx.xb[base + f];
        histG[k] += gi; histW[k] += wi;
      }
    }
    let best = { gain: 1e-12, f: -1, b: -1 };
    const parent = (G * G) / (W + lambda);
    for (const f of feats) {
      const nb = bx.edges[f].length;
      if (!nb) continue;
      let gl = 0, wl = 0;
      for (let b = 0; b < nb; b++) {
        const k = f * (B + 1) + b;
        gl += histG[k]; wl += histW[k];
        const wr = W - wl;
        if (wl < minLeaf || wr < minLeaf) continue;
        const gr = G - gl;
        const gain = (gl * gl) / (wl + lambda) + (gr * gr) / (wr + lambda) - parent;
        if (gain > best.gain) best = { gain, f, b };
      }
    }
    if (best.f < 0) return leaf();
    const L: number[] = [], R: number[] = [];
    for (const i of rows) (bx.xb[i * d + best.f] <= best.b ? L : R).push(i);
    return { f: best.f, t: bx.edges[best.f][best.b], l: build(L, depth + 1, feats), r: build(R, depth + 1, feats) };
  };

  const all = Array.from({ length: n }, (_, i) => i);
  const allFeats = Array.from({ length: d }, (_, f) => f);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) {
      const e = y[i] - F[i];
      g[i] = loss === 'quantile' ? (e > 0 ? alpha : alpha - 1) : e;
    }
    const rows = subsample < 1 ? all.filter(() => rand() < subsample) : all;
    const feats = colsample < 1 ? allFeats.filter(() => rand() < colsample) : allFeats;
    const tree = build(rows, 0, feats.length ? feats : allFeats);
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += lr * evalTree(tree, X[i]);
  }
  return { loss, alpha, f0, lr, trees };
}

/** Out-of-fold predictions with contiguous or interleaved folds (grouped by `group` when given). */
export function oofPredict(X: number[][], y: number[], o: BoostOpts, k = 5, group?: (string | number)[]): number[] {
  const n = y.length;
  const out = new Array(n).fill(NaN);
  const foldOf = (i: number) => {
    if (!group) return i % k;
    const s = String(group[i]);
    let h = 0;
    for (let j = 0; j < s.length; j++) h = (Math.imul(h, 31) + s.charCodeAt(j)) | 0;
    return Math.abs(h) % k;
  };
  for (let j = 0; j < k; j++) {
    const tr: number[] = [], te: number[] = [];
    for (let i = 0; i < n; i++) (foldOf(i) === j ? te : tr).push(i);
    if (!te.length || tr.length < 10) continue;
    const m = trainBooster(tr.map((i) => X[i]), tr.map((i) => y[i]), { ...o, weights: o.weights ? tr.map((i) => o.weights![i]) : undefined });
    for (const i of te) out[i] = predictBooster(m, X[i]);
  }
  return out;
}

/** Gain-based feature importance (split counts weighted by depth), for diagnostics. */
export function splitCounts(m: Booster, d: number): number[] {
  const c = new Array(d).fill(0);
  const walk = (t: TreeNode, depth: number) => {
    if ('v' in t) return;
    c[t.f] += 1 / (depth + 1);
    walk(t.l, depth + 1); walk(t.r, depth + 1);
  };
  for (const t of m.trees) walk(t, 0);
  return c;
}
