/**
 * Residual correction: shift each prediction by a partially pooled estimate of
 * the error the same model has been making on recent, already-finished turns:
 *
 *   g = sum(last kG errors overall)              / (nG + kappaG)
 *   p = (sum(last kP errors in project) + kappaP*g) / (nP + kappaP)
 *   s = (sum(last kS errors in session) + kappaS*p) / (nS + kappaS)
 *
 * and the prediction moves by s. Only turns that finished before this one was
 * submitted are used, so it is exactly what the collector could do live.
 */
import { LogMixture } from '@tminus/core';
import type { LabTurn } from './data.ts';
import type { RunResult, Row } from './protocol.ts';

export interface CorrectOpts {
  kG?: number; kappaG?: number;
  kP?: number; kappaP?: number;
  kS?: number; kappaS?: number;
  /** Disable a level by setting its k to 0. */
  name?: string;
}

export interface Pools { global: number[]; project: number[]; session: number[] }

export function pooledShift(p: Pools, o: CorrectOpts): number {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const g = p.global.length ? sum(p.global) / (p.global.length + (o.kappaG ?? 10)) : 0;
  const pr = (sum(p.project) + (o.kappaP ?? 5) * g) / (p.project.length + (o.kappaP ?? 5));
  return (sum(p.session) + (o.kappaS ?? 3) * pr) / (p.session.length + (o.kappaS ?? 3));
}

export function residualCorrect(base: RunResult, turns: LabTurn[], o: CorrectOpts): RunResult {
  const byKey = new Map(turns.map((t) => [t.key, t]));
  const scored = base.rows.map((r) => ({ r, t: byKey.get(r.key)! })).sort((a, b) => a.t.submittedAt - b.t.submittedAt);
  const byFinish = [...scored].sort((a, b) => a.t.finishedAt - b.t.finishedAt);
  const finished: { t: LabTurn; e: number }[] = [];
  let fi = 0;
  const rows: Row[] = [];
  const dists = new Map<string, LogMixture>();
  const kG = o.kG ?? 10, kP = o.kP ?? 5, kS = o.kS ?? 5;
  for (const { r, t } of scored) {
    while (fi < byFinish.length && byFinish[fi].t.finishedAt < t.submittedAt) {
      const f = byFinish[fi++];
      finished.push({ t: f.t, e: f.r.y - f.r.q50 });
    }
    const pools: Pools = { global: [], project: [], session: [] };
    for (let j = finished.length - 1; j >= 0; j--) {
      const u = finished[j];
      if (pools.global.length < kG) pools.global.push(u.e);
      if (t.project && u.t.project === t.project && pools.project.length < kP) pools.project.push(u.e);
      if (u.t.sessionId === t.sessionId && pools.session.length < kS) pools.session.push(u.e);
      if (pools.global.length >= kG && pools.project.length >= kP && pools.session.length >= kS) break;
    }
    const shift = pooledShift(pools, o);
    rows.push({ ...r, q10: r.q10 + shift, q50: r.q50 + shift, q90: r.q90 + shift });
    const d = base.dists.get(r.key)!;
    dists.set(r.key, new LogMixture(d.comps.map((c) => ({ ...c, mu: c.mu + shift }))));
  }
  const order = new Map(base.rows.map((r, i) => [r.key, i]));
  rows.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
  return { name: o.name ?? `${base.name}+rc`, rows, dists, fits: base.fits };
}

/**
 * Adaptive conformal calibration (Gibbs & Candès, 2021), one-sided for each end
 * of the range: after every finished turn, the quantile level used for P90 moves
 * up if the turn ran past it (and down slightly if not), and likewise for P10.
 * Keeps the shown range honest when the kind of work drifts.
 */
export function adaptiveConformal(base: RunResult, turns: LabTurn[], o: { gamma: number; name?: string }): RunResult {
  const byKey = new Map(turns.map((t) => [t.key, t]));
  const scored = base.rows.map((r) => ({ r, t: byKey.get(r.key)! })).sort((a, b) => a.t.submittedAt - b.t.submittedAt);
  const byFinish = [...scored].sort((a, b) => a.t.finishedAt - b.t.finishedAt);
  let lo = 0.1, hi = 0.9, fi = 0;
  const shown = new Map<string, Row>();
  const rows: Row[] = [];
  for (const { r, t } of scored) {
    while (fi < byFinish.length && byFinish[fi].t.finishedAt < t.submittedAt) {
      const f = shown.get(byFinish[fi].t.key);
      fi++;
      if (!f) continue;
      hi = Math.min(0.995, Math.max(0.5, hi + o.gamma * ((f.y > f.q90 ? 1 : 0) - 0.1)));
      lo = Math.max(0.005, Math.min(0.5, lo - o.gamma * ((f.y < f.q10 ? 1 : 0) - 0.1)));
    }
    const d = base.dists.get(r.key)!;
    const row = { ...r, q10: Math.log(d.quantile(lo)), q90: Math.log(d.quantile(hi)) };
    shown.set(r.key, row);
    rows.push(row);
  }
  const order = new Map(base.rows.map((x, i) => [x.key, i]));
  rows.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
  return { ...base, name: o.name ?? `${base.name}+aci`, rows };
}
