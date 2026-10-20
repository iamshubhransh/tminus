/** Do a candidate's residuals carry over? Correlate each turn's residual with earlier residuals (global / session / project). */
import { loadTurns } from './data.ts';
import { buildHistory, runSubmit, type Ctx } from './protocol.ts';
import { REGISTRY } from './registry.ts';

const name = process.argv[2] ?? 'gb:base';
const turns = await loadTurns();
const ctx: Ctx = { hist: buildHistory(turns), all: turns };
const r = runSubmit(REGISTRY[name](), turns, ctx, { split: 'all' });
const byKey = new Map(turns.map((t) => [t.key, t]));
const res = r.rows.map((row) => ({ t: byKey.get(row.key)!, e: row.y - row.q50 })).sort((a, b) => a.t.submittedAt - b.t.submittedAt);
const corr = (a: number[], b: number[]) => { const n = a.length; const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
for (const scope of ['global', 'session', 'project', 'agent'] as const) {
  for (const k of [1, 3, 10, 30]) {
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < res.length; i++) {
      const cur = res[i];
      const prev = res.slice(0, i).filter((p) => p.t.finishedAt < cur.t.submittedAt && (scope === 'global' || (scope === 'session' ? p.t.sessionId === cur.t.sessionId : scope === 'project' ? p.t.project === cur.t.project : p.t.agent === cur.t.agent))).slice(-k);
      if (!prev.length) continue;
      xs.push(prev.reduce((s, p) => s + p.e, 0) / prev.length); ys.push(cur.e);
    }
    console.log(`${scope.padEnd(8)} last ${String(k).padEnd(3)} n=${String(xs.length).padEnd(4)} corr(mean prev residual, residual) = ${corr(xs, ys).toFixed(3)}`);
  }
}
