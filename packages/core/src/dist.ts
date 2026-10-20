import { logNormSf, logSumExp, normCdf, std, mean, Z90 } from './stats.ts';

export interface Component { w: number; mu: number; sd: number }

/**
 * A distribution over turn duration, represented as a Gaussian mixture in
 * log(ms) space. A single component is a log-normal; many narrow components
 * centred on observed samples is a kernel-smoothed empirical distribution.
 * Mixtures compose, which is how hierarchical shrinkage is expressed.
 */
export class LogMixture {
  readonly comps: Component[];

  constructor(comps: Component[]) {
    const total = comps.reduce((s, c) => s + c.w, 0);
    this.comps = total > 0 ? comps.filter((c) => c.w > 0).map((c) => ({ ...c, w: c.w / total })) : [{ w: 1, mu: Math.log(60_000), sd: 1.2 }];
  }

  static lognormal(mu: number, sd: number): LogMixture {
    return new LogMixture([{ w: 1, mu, sd: Math.max(sd, 0.05) }]);
  }

  /** Lognormal from a median and P90 (both in ms). */
  static fromQuantiles(p50Ms: number, p90Ms: number): LogMixture {
    const mu = Math.log(Math.max(p50Ms, 1));
    const sd = Math.max(0.1, (Math.log(Math.max(p90Ms, p50Ms * 1.05)) - mu) / Z90);
    return LogMixture.lognormal(mu, sd);
  }

  /** Kernel-smoothed empirical distribution of log-ms samples (Silverman bandwidth). */
  static kde(logSamples: number[], minBandwidth = 0.12): LogMixture {
    if (logSamples.length === 0) throw new Error('kde needs samples');
    const s = std(logSamples) || 0.8;
    const h = Math.max(minBandwidth, 1.06 * s * Math.pow(logSamples.length, -0.2));
    return new LogMixture(logSamples.map((mu) => ({ w: 1, mu, sd: h })));
  }

  /** Weighted blend: w * a + (1 - w) * b. */
  static blend(a: LogMixture, w: number, b: LogMixture): LogMixture {
    if (w >= 1) return a;
    if (w <= 0) return b;
    return new LogMixture([
      ...a.comps.map((c) => ({ ...c, w: c.w * w })),
      ...b.comps.map((c) => ({ ...c, w: c.w * (1 - w) })),
    ]);
  }

  /** P(log T <= x). */
  cdf(x: number): number {
    let p = 0;
    for (const c of this.comps) p += c.w * normCdf((x - c.mu) / c.sd);
    return p;
  }

  /** log P(log T > x), stable far into the tail. */
  logSf(x: number): number {
    return logSumExp(this.comps.map((c) => Math.log(c.w) + logNormSf((x - c.mu) / c.sd)));
  }

  private bounds(): [number, number] {
    let lo = Infinity, hi = -Infinity;
    for (const c of this.comps) {
      lo = Math.min(lo, c.mu - 8 * c.sd);
      hi = Math.max(hi, c.mu + 8 * c.sd);
    }
    return [lo, hi];
  }

  /** Quantile in ms. */
  quantile(q: number): number {
    let [lo, hi] = this.bounds();
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (this.cdf(mid) < q) lo = mid; else hi = mid;
    }
    return Math.exp((lo + hi) / 2);
  }

  /**
   * Survival-conditioned quantile of the *remaining* time, given the turn has
   * already run for `elapsedMs`: the q-quantile of (T - t | T > t).
   * Solved in log-survival space so it keeps working when t is deep in the
   * tail. Because the tail is log-normal the answer grows with t; it never
   * collapses to a frozen "1 min left".
   */
  remainingQuantile(elapsedMs: number, q: number): number {
    const t = Math.max(elapsedMs, 1);
    const lt = Math.log(t);
    const base = this.logSf(lt);
    if (!Number.isFinite(base)) return this.quantile(q);
    const target = base + Math.log(1 - q);
    let lo = lt;
    let hi = Math.max(lt, this.bounds()[1]) + 2;
    while (this.logSf(hi) > target && hi < lt + 40) hi += 4;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (this.logSf(mid) > target) lo = mid; else hi = mid;
    }
    return Math.max(0, Math.exp((lo + hi) / 2) - t);
  }

  /** E[T - t | T > t] by averaging conditional quantiles (midpoint rule). */
  meanRemaining(elapsedMs: number, points = 19): number {
    let s = 0;
    for (let i = 0; i < points; i++) s += this.remainingQuantile(elapsedMs, (i + 0.5) / points);
    return s / points;
  }

  /** Moments of the mixture in log space. */
  logMean(): number {
    return this.comps.reduce((s, c) => s + c.w * c.mu, 0);
  }

  logSd(): number {
    const m = this.logMean();
    const v = this.comps.reduce((s, c) => s + c.w * (c.sd * c.sd + (c.mu - m) ** 2), 0);
    return Math.sqrt(v);
  }
}

/** Pooled log-normal fit for a small sample, with sd shrunk toward a parent sd. */
export function fitSmall(logSamples: number[], parentSd: number, k = 8): LogMixture {
  const n = logSamples.length;
  const mu = mean(logSamples);
  const s = n > 1 ? std(logSamples) : parentSd;
  const sd = Math.sqrt(((n - 1) * s * s + k * parentSd * parentSd) / (n - 1 + k));
  return LogMixture.lognormal(mu, sd);
}
