/** Small numeric helpers. Everything here is dependency-free and deterministic. */

export const Z90 = 1.2815515655446004; // Φ⁻¹(0.9)

export function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function quantile(values: number[], q: number): number {
  return quantileSorted([...values].sort((a, b) => a - b), q);
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

export function mean(values: number[]): number {
  if (!values.length) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) ** 2;
  return Math.sqrt(s / (values.length - 1));
}

/**
 * Complementary error function with fractional error < 1.2e-7 everywhere
 * (Numerical Recipes erfcc). Relative accuracy in the far tail is what makes
 * survival conditioning stable for long-running turns.
 */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(
    -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
  );
  return x >= 0 ? r : 2 - r;
}

/** log(1 - Φ(z)), accurate deep into the upper tail. */
export function logNormSf(z: number): number {
  if (z < 25) return Math.log(0.5 * erfc(z / Math.SQRT2));
  const z2 = z * z;
  return -0.5 * z2 - Math.log(z) - 0.5 * Math.log(2 * Math.PI) + Math.log(1 - 1 / z2 + 3 / (z2 * z2));
}

export function normCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** Acklam's inverse normal CDF (relative error < 1.15e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function logSumExp(xs: number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
