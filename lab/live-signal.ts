/** Does live activity carry information about remaining time beyond elapsed time + the submit prior? */
import { loadTurns } from './data.ts';
import { buildHistory, observe } from './protocol.ts';
import { featureSet, residualDist } from './candidates.ts';
import { oofPredict } from './gbdt.ts';
import { LIVE_NAMES, PHASE_NAMES, liveVec, snapshotTimes, type PriorQ } from './live.ts';

const turns = await loadTurns();
const hist = buildHistory(turns);
const tr = turns.filter((t) => t.trainable);
const fs = featureSet(['base'], tr, hist);
const X = tr.map(fs.vec), y = tr.map((t) => t.y);
const oof = oofPredict(X, y, { loss: 'quantile', alpha: 0.5 }, 5);
const resid = residualDist(y.map((v, i) => v - oof[i]));
const rq = (p: number) => resid[Math.floor(p * (resid.length - 1))];
const LX: number[][] = [], LY: number[] = [], LG: number[] = [], LW: number[] = [];
tr.forEach((t, i) => {
  const T = Math.min(t.activeMs, 7200_000);
  const times = snapshotTimes(T);
  const q: PriorQ = { l10: oof[i] + rq(0.1), l50: oof[i] + rq(0.5), l90: oof[i] + rq(0.9) };
  observe(t, times).forEach((o, j) => { LX.push(liveVec(t, q, o, true)); LY.push(Math.log(Math.max(T - times[j], 500))); LG.push(i); LW.push(1 / times.length); });
});
const ALL = [...LIVE_NAMES, ...PHASE_NAMES];
const idx = (n: string) => ALL.indexOf(n);
const mae = (p: number[]) => { let s = 0, w = 0; p.forEach((v, i) => { s += LW[i] * Math.abs(LY[i] - v); w += LW[i]; }); return s / w; };
console.log(`${LX.length} snapshots from ${tr.length} turns (per-turn weighted MAE of log remaining)`);
console.log(`survival prior median only        ${mae(LX.map((x) => x[idx('p_rem50')])).toFixed(3)}`);
const subsets: [string, string[]][] = [
  ['elapsed + prior', ['log_t', 'p_l10', 'p_l50', 'p_l90', 'p_rem50', 'p_rem90', 't_over_p50', 't_over_p90']],
  ['+ activity counts', ['log_t', 'p_l10', 'p_l50', 'p_l90', 'p_rem50', 'p_rem90', 't_over_p50', 't_over_p90', 'log_calls', 'log_sub', 'rate', 'log_edits', 'edit_share', 'recent_edit_share', 'distinct']],
  ['+ timing of last event', ['log_t', 'p_l10', 'p_l50', 'p_l90', 'p_rem50', 'p_rem90', 't_over_p50', 't_over_p90', 'log_since', 'running', 'log_running_for', 'since_over_t']],
  ['everything (no phase)', LIVE_NAMES],
  ['elapsed + prior + phase', ['log_t', 'p_l10', 'p_l50', 'p_l90', 'p_rem50', 'p_rem90', 't_over_p50', 't_over_p90', ...PHASE_NAMES]],
  ['everything + phase', ALL],
];
for (const [label, names] of subsets) {
  const cols = names.map(idx);
  const sub = LX.map((x) => cols.map((c) => x[c]));
  const p = oofPredict(sub, LY, { loss: 'quantile', alpha: 0.5, rounds: 200, lr: 0.06, maxDepth: 4, minLeaf: 20, weights: LW }, 5, LG);
  console.log(`${label.padEnd(33)} ${mae(p).toFixed(3)}`);
}
