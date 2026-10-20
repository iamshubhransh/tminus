/** Where do the errors come from? Residuals of one candidate, broken down. */
import { loadTurns } from './data.ts';
import { buildHistory, runSubmit, summarize, type Ctx, type Row } from './protocol.ts';
import { REGISTRY } from './registry.ts';

const name = process.argv[2] ?? 'gb:base';
const turns = await loadTurns();
const ctx: Ctx = { hist: buildHistory(turns), all: turns };
const r = runSubmit(REGISTRY[name](), turns, ctx, { split: (process.argv[3] as any) ?? 'dev' });
const byKey = new Map(turns.map((t) => [t.key, t]));
const group = (label: string, f: (row: Row) => string) => {
  const m = new Map<string, Row[]>();
  for (const row of r.rows) { const k = f(row); (m.get(k) ?? m.set(k, []).get(k)!).push(row); }
  console.log(`\n${label}`);
  for (const [k, rows] of [...m].sort((a, b) => b[1].length - a[1].length)) {
    const s = summarize(rows);
    const bias = rows.reduce((a, x) => a + (x.y - x.q50), 0) / rows.length;
    console.log(`  ${k.padEnd(34)} n=${String(s.n).padEnd(4)} typical ×${Math.exp(s.mdae).toFixed(2)}  MAE ${s.mae.toFixed(2)}  bias ${bias >= 0 ? '+' : ''}${bias.toFixed(2)}  QS ${s.qs.toFixed(3)}  in80 ${Math.round(s.cov80 * 100)}%`);
  }
};
group('by agent/trigger', (row) => { const t = byKey.get(row.key)!; return `${t.agent}/${t.trigger}`; });
group('by model/effort', (row) => { const t = byKey.get(row.key)!; return `${t.model}/${t.effort}`; });
group('by week', (row) => new Date(byKey.get(row.key)!.submittedAt).toISOString().slice(0, 10).replace(/-\d\d$/, '') + ' w' + Math.floor(new Date(byKey.get(row.key)!.submittedAt).getUTCDate() / 7));
group('by intent', (row) => byKey.get(row.key)!.features.prompt.intent);
group('by session size', (row) => { const n = turns.filter((t) => t.sessionId === byKey.get(row.key)!.sessionId).length; return n === 1 ? '1' : n < 10 ? '2-9' : n < 50 ? '10-49' : '50+'; });
group('by actual duration', (row) => { const s = Math.exp(row.y) / 1000; return s < 30 ? '<30s' : s < 120 ? '30s-2m' : s < 600 ? '2-10m' : s < 1800 ? '10-30m' : '30m+'; });
