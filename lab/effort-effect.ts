/**
 * Within-session effect of effort level (and model) on duration, controlling for prompt features:
 * OLS of log duration on prompt features + effort level + session fixed effects, with a session bootstrap CI.
 */
import { loadTurns } from './data.ts';
import { mulberry32 } from './gbdt.ts';
import { modelFamily } from './candidates.ts';

const turns = (await loadTurns()).filter((t) => t.trainable && t.agent === 'claude-code');
const ORD: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const sessions = new Map<string, typeof turns>();
for (const t of turns) (sessions.get(t.sessionId) ?? sessions.set(t.sessionId, []).get(t.sessionId)!).push(t);
// Sessions where effort or model actually varied are the only ones that identify a within-session effect.
const varied = [...sessions.values()].filter((s) => s.length >= 4 && (new Set(s.map((t) => t.effort)).size > 1 || new Set(s.map((t) => t.model)).size > 1));
console.log(`Claude Code turns ${turns.length}; sessions where effort or model changed mid-session: ${varied.length} (${varied.reduce((a, s) => a + s.length, 0)} turns)`);
const row = (t: (typeof turns)[number]) => {
  const p = t.features.prompt;
  return [Math.log1p(p.chars), Math.log1p(p.refs), +p.question, +(p.intent === 'question'), +(p.intent === 'build_feature'), +(p.intent === 'small_edit'), ORD[t.effort ?? ''] ?? 3, +(modelFamily(t.model) === 'fable')];
};
function ols(groups: (typeof turns)[]): number[] {
  // Demean within session (fixed effects), then least squares.
  const X: number[][] = [], y: number[] = [];
  for (const g of groups) {
    const rows = g.map(row), ys = g.map((t) => t.y);
    const mx = rows[0].map((_, j) => rows.reduce((a, r) => a + r[j], 0) / rows.length), my = ys.reduce((a, b) => a + b, 0) / ys.length;
    rows.forEach((r, i) => { X.push(r.map((v, j) => v - mx[j])); y.push(ys[i] - my); });
  }
  const d = X[0].length;
  const A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => X.reduce((a, r) => a + r[i] * r[j], 0) + (i === j ? 1e-6 : 0)));
  const b = Array.from({ length: d }, (_, i) => X.reduce((a, r, k) => a + r[i] * y[k], 0));
  // Solve A w = b.
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < d; c++) { let p = c; for (let r = c + 1; r < d; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; for (let r = c + 1; r < d; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= d; k++) M[r][k] -= f * M[c][k]; } }
  const w = new Array(d).fill(0);
  for (let r = d - 1; r >= 0; r--) { let s = M[r][d]; for (let k = r + 1; k < d; k++) s -= M[r][k] * w[k]; w[r] = s / M[r][r]; }
  return w;
}
const all = [...sessions.values()].filter((s) => s.length >= 2);
const w = ols(all);
const rand = mulberry32(5);
const boots: number[][] = [];
for (let k = 0; k < 1000; k++) boots.push(ols(Array.from({ length: all.length }, () => all[Math.floor(rand() * all.length)])));
const ci = (j: number) => { const v = boots.map((b) => b[j]).sort((a, b) => a - b); return [v[25], v[975]]; };
const [elo, ehi] = ci(6), [flo, fhi] = ci(7);
console.log(`effort, per level (medium→high→xhigh), within session: ×${Math.exp(w[6]).toFixed(2)}  95% CI ×${Math.exp(elo).toFixed(2)}–×${Math.exp(ehi).toFixed(2)}`);
console.log(`Fable vs Opus, within session: ×${Math.exp(w[7]).toFixed(2)}  95% CI ×${Math.exp(flo).toFixed(2)}–×${Math.exp(fhi).toFixed(2)}`);
const raw = (e: string) => { const v = turns.filter((t) => t.effort === e).map((t) => t.activeMs / 1000).sort((a, b) => a - b); return `${e} median ${Math.round(v[v.length >> 1])}s (n=${v.length})`; };
console.log('raw medians (no controls):', ['medium', 'high', 'xhigh'].map(raw).join(', '));
