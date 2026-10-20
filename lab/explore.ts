/** Univariate signal check: Spearman correlation of each feature with log duration. */
import { loadTurns } from './data.ts';
import { buildHistory } from './protocol.ts';
import { featureSet } from './candidates.ts';

const turns = await loadTurns();
const hist = buildHistory(turns);
const tr = turns.filter((t) => t.trainable);
const fs = featureSet(['base', 'agent', 'effort', 'family', 'session', 'project', 'recent', 'text', 'prev'], tr, hist);
const X = tr.map(fs.vec);
const y = tr.map((t) => t.y);
const rank = (v: number[]) => { const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]); const r = new Array(v.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++; for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2; i = j + 1; } return r; };
const corr = (a: number[], b: number[]) => { const n = a.length; const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0; };
const ry = rank(y);
const rows = fs.names.map((n, j) => {
  const col = X.map((x) => x[j]);
  const present = col.filter((v) => v !== -1).length;
  return { n, rho: corr(rank(col), ry), present };
}).filter((r) => Number.isFinite(r.rho)).sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
console.log(`n=${tr.length}, sd(log y)=${Math.sqrt(y.reduce((s, v) => s + (v - y.reduce((a, b) => a + b) / y.length) ** 2, 0) / y.length).toFixed(3)}`);
for (const r of rows.slice(0, 45)) console.log(`${r.n.padEnd(22)} rho=${r.rho >= 0 ? '+' : ''}${r.rho.toFixed(3)}  (non-missing ${r.present})`);
