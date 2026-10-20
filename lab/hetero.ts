/** Is the error size predictable from the features (heteroscedasticity)? */
import { loadTurns } from './data.ts';
import { buildHistory } from './protocol.ts';
import { featureSet } from './candidates.ts';
import { oofPredict } from './gbdt.ts';

const turns = await loadTurns();
const hist = buildHistory(turns);
const tr = turns.filter((t) => t.trainable);
const fs = featureSet(['base', 'agent'], tr, hist);
const X = tr.map(fs.vec), y = tr.map((t) => t.y);
const loc = oofPredict(X, y, { loss: 'quantile', alpha: 0.5 }, 5);
const absr = y.map((v, i) => Math.abs(v - loc[i]));
const lr = absr.map((a) => Math.log(a + 0.05));
const scaleOof = oofPredict(X, lr, { loss: 'l2', rounds: 100, lr: 0.05, maxDepth: 2, minLeaf: 20 }, 5);
const rank = (v: number[]) => { const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]); const r = new Array(v.length); idx.forEach((k, i) => (r[k] = i)); return r; };
const corr = (a: number[], b: number[]) => { const n = a.length; const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
console.log(`Spearman(predicted scale, actual |residual|) out of fold: ${corr(rank(scaleOof), rank(absr)).toFixed(3)}`);
const q = [...scaleOof].sort((a, b) => a - b);
const tert = (v: number) => (v < q[Math.floor(q.length / 3)] ? 'low' : v < q[Math.floor((2 * q.length) / 3)] ? 'mid' : 'high');
for (const g of ['low', 'mid', 'high']) {
  const rs = absr.filter((_, i) => tert(scaleOof[i]) === g).sort((a, b) => a - b);
  console.log(`  predicted-scale tercile ${g.padEnd(4)}: median |residual| ${rs[rs.length >> 1].toFixed(2)}  P80 ${rs[Math.floor(rs.length * 0.8)].toFixed(2)}  (n=${rs.length})`);
}
for (const [k, name] of [['is_sdk', 'sdk'], ['log_chars', 'prompt length']] as const) {
  const j = fs.names.indexOf(k);
  console.log(`Spearman(${name}, |residual|) = ${corr(rank(X.map((x) => x[j])), rank(absr)).toFixed(3)}`);
}
