import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ADAPTERS, type AgentAdapter } from '@tminus/adapters';
import {
  CHECKPOINTS, deleteBackfill, evaluate, getMeta, loadConfig, predictorStatus, trainableCount, trainV2, finishedTurns, fmtFactor, fmtPct, fmtPrecise, fmtRange, fmtShort, groupBy, importTurns, liveQuality,
  median, metrics, openDb, parseFeatures, paths, scoredTurns, setMeta, writeJsonAtomic, type DB, type Metrics, type Scored,
} from '@tminus/core';
import { flagBool, flagStr, type Args } from '../args.ts';
import { c, table } from '../ui.ts';
import { collectTurns } from './setup.ts';

export async function runBackfill(a: Args, adapters?: AgentAdapter[], brief = false): Promise<number> {
  const sinceStr = flagStr(a, 'since');
  const since = sinceStr ? new Date(sinceStr) : undefined;
  if (since && Number.isNaN(since.getTime())) { console.error(`bad --since: ${sinceStr}`); return 1; }
  const only = flagStr(a, 'agent', 'agents')?.split(',');
  const list = adapters ?? [];
  if (!adapters) for (const ad of ADAPTERS) if ((!only || only.includes(ad.id)) && await ad.detect()) list.push(ad);
  let files = 0;
  const t0 = Date.now();
  const turns = await collectTurns(list, since, () => { files++; });
  const db = openDb();
  try {
    if (flagBool(a, 'rebuild')) {
      // Re-derive every backfilled turn (e.g. after a parser improvement). Live turns are kept.
      const removed = deleteBackfill(db);
      console.log(c.dim(`Rebuilding: removed ${removed} backfilled turns; live turns kept.`));
    }
    const s = importTurns(db, turns);
    if (flagBool(a, 'quiet')) {
      // Background run (the collector upgrading an older database): retrain on the enriched data.
      try { promoteV2IfBetter(db); } catch { /* evaluation is optional */ }
      return 0;
    }
    const total = db.prepare(`SELECT COUNT(*) n FROM turns`).get().n;
    const agents = Object.entries(s.byAgent).map(([k, v]) => `${k} ${v}`).join(', ') || 'none new';
    console.log(`Read ${files} transcript files in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${s.seen} turns, ${s.imported} new (${agents}), ${s.skipped} already imported${s.enriched ? `, ${s.enriched} brought up to date` : ''}.`);
    if (s.imported) {
      const o = s.byOutcome;
      console.log(c.dim(`  outcomes: ${o.completed ?? 0} completed, ${o.interrupted ?? 0} interrupted, ${o.errored ?? 0} errored. ${total} turns in the database.`));
    }
    if (brief) {
      printHeadline(db);
      try {
        const r = promoteV2IfBetter(db);
        if (r.v2Wins && r.v2) console.log(c.dim(`  Predictor: v2 (beats v1 on ${r.folds.length} time folds of your history: typical miss ${fmtFactor(r.v2.mdae)} vs ${fmtFactor(r.v1.mdae)}).`));
        else if (r.v2) console.log(c.dim('  Predictor: v1 (v2 did not beat it on your history yet; re-checked automatically as you use your agents).'));
      } catch { /* evaluation is optional */ }
    }
  } finally { db.close(); }
  return 0;
}

function printHeadline(db: DB): void {
  const m = metrics(scoredTurns(db));
  if (!m.n) return;
  console.log(`  ${c.bold('From your history:')} typical miss ${fmtFactor(m.mdae)}, ${fmtPct(m.underP90)} finished under P90, ${fmtPct(m.inRange)} inside the shown range (n=${m.n}).`);
}

function metricRow(label: string, m: Metrics): string[] {
  return [label, String(m.n), m.n ? fmtFactor(m.mdae) : '–', fmtPct(m.underP90), fmtPct(m.inRange)];
}

const HEADER = ['', 'turns', 'typical miss', 'under P90', 'in range'];
const ALIGN: ('l' | 'r')[] = ['l', 'r', 'r', 'r', 'r'];

/** Live-update quality for live turns, from the predictions table. */
function liveFromPredictions(db: DB): { mdae: number[]; n: number } {
  const turns = finishedTurns(db, { source: 'live' }).filter((t) => t.outcome === 'completed' && (t.active_ms ?? 0) >= 1000);
  const stmt = db.prepare(`SELECT elapsed_ms, p50_remaining_ms FROM predictions WHERE turn_id = ? ORDER BY elapsed_ms`);
  const errs: number[][] = CHECKPOINTS.map(() => []);
  let n = 0;
  for (const t of turns) {
    const rows = stmt.all(t.id) as { elapsed_ms: number; p50_remaining_ms: number }[];
    if (!rows.length) continue;
    n++;
    CHECKPOINTS.forEach((cp, i) => {
      const target = cp * t.active_ms!;
      let best = rows[0];
      for (const r of rows) if (r.elapsed_ms <= target) best = r;
      const total = cp === 0 ? (t.predicted_p50_ms ?? best.elapsed_ms + best.p50_remaining_ms) : best.elapsed_ms + best.p50_remaining_ms;
      errs[i].push(Math.abs(Math.log(total / t.active_ms!)));
    });
  }
  return { mdae: errs.map((e) => (e.length ? median(e) : NaN)), n };
}

export async function cmdStats(a: Args): Promise<number> {
  const db = openDb();
  try {
    const scored = scoredTurns(db);
    const json: any = { sources: {}, intents: {}, models: {}, live_update: {} };
    if (!scored.length) {
      console.log('No finished turns with predictions yet. Run `tminus backfill` or use your agent for a bit.');
      return 0;
    }
    const bySource = groupBy(scored, (s) => s.source);
    const rows: string[][] = [HEADER];
    for (const src of ['live', 'backfill']) {
      const m = metrics(bySource.get(src) ?? []);
      json.sources[src] = m;
      rows.push(metricRow(src, m));
    }
    const all = metrics(scored);
    rows.push(metricRow(c.bold('all'), all));
    const ps = predictorStatus(db, loadConfig());
    console.log(c.bold(`tminus stats`) + c.dim(` · ${scored.length} finished turns with a prediction made before they started · active predictor: ${ps.active} (${ps.reason})`));
    console.log(table(rows, ALIGN));

    const breakdown = (title: string, key: (s: Scored) => string, into: any) => {
      const g = [...groupBy(scored, key).entries()].sort((x, y) => y[1].length - x[1].length);
      const r: string[][] = [[title, ...HEADER.slice(1)]];
      for (const [k, v] of g) { const m = metrics(v); into[k] = m; r.push(metricRow(k, m)); }
      console.log('\n' + table(r, ALIGN));
    };
    breakdown('intent', (s) => s.intent, json.intents);
    breakdown('model', (s) => s.model, json.models);

    console.log(c.bold('\nLive-update quality') + c.dim(' · typical miss of the predicted total, partway through a turn'));
    const lr: string[][] = [['', ...CHECKPOINTS.map((x) => `at ${Math.round(x * 100)}%`), 'turns']];
    const replay = liveQuality(db, 'backfill', { subagents: loadConfig().countSubagentWork });
    json.live_update.backfill_replay = replay;
    lr.push(['backfill (replayed)', ...replay.mdae.map((e) => (Number.isFinite(e) ? fmtFactor(e) : '–')), String(replay.n)]);
    const live = liveFromPredictions(db);
    json.live_update.live = live;
    lr.push(['live (as shown)', ...live.mdae.map((e) => (Number.isFinite(e) ? fmtFactor(e) : '–')), String(live.n)]);
    console.log(table(lr, ['l', 'r', 'r', 'r', 'r', 'r']));
    if (replay.snapshots) {
      console.log(`still-running calibration: ${fmtPct(replay.runningP50)} finished within the shown P50 remaining (target 50%), ${fmtPct(replay.runningP90)} within P90 (target 90%)` + c.dim(` · ${replay.snapshots} replayed snapshots`));
    }
    console.log(c.dim('\nTargets: ~90% under P90; ~80% inside the shown range (P10–P90). "Typical miss ×1.6" = median factor between predicted P50 and actual.'));
    if (ps.active === 'v2') console.log(c.dim('Backfilled turns keep the v1 prediction made when they were imported; v2\'s held-out numbers are in `tminus eval`. Live turns show the predictor that was active.'));
    if (flagBool(a, 'json')) console.log(JSON.stringify({ all, ...json }, null, 2));
  } finally { db.close(); }
  return 0;
}

export async function cmdHistory(a: Args): Promise<number> {
  const n = Number(flagStr(a, 'n', 'limit') ?? 20);
  const db = openDb();
  try {
    const rows = db.prepare(`SELECT * FROM turns WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?`).all(n) as any[];
    if (flagBool(a, 'json')) { console.log(JSON.stringify(rows.map(safeRow), null, 2)); return 0; }
    const out: string[][] = [['when', 'agent', 'intent', 'predicted', 'range', 'actual', 'outcome', 'miss']];
    for (const r of rows.reverse()) {
      const f = parseFeatures(r.features_json);
      const when = new Date(r.submitted_at);
      const ratio = r.predicted_p50_ms && r.active_ms ? r.active_ms / r.predicted_p50_ms : null;
      const inside = r.predicted_p10_ms != null && r.active_ms >= r.predicted_p10_ms && r.active_ms <= r.predicted_p90_ms;
      out.push([
        `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`,
        r.agent === 'claude-code' ? 'claude' : r.agent,
        f?.prompt.intent ?? '?',
        r.predicted_p50_ms ? `~${fmtShort(r.predicted_p50_ms)}` : '–',
        r.predicted_p10_ms ? fmtRange(r.predicted_p10_ms, r.predicted_p90_ms) : '–',
        fmtPrecise(r.active_ms ?? 0),
        r.outcome === 'completed' ? c.green('✓') : r.outcome === 'interrupted' ? c.yellow('interrupted') : c.red(r.outcome),
        ratio ? (inside ? fmtFactor(Math.log(ratio)) : c.yellow(fmtFactor(Math.log(ratio)))) : '–',
      ]);
    }
    console.log(table(out, ['l', 'l', 'l', 'r', 'r', 'r', 'l', 'r']));
  } finally { db.close(); }
  return 0;
}

function safeRow(r: any) {
  const { features_json, ...rest } = r;
  return { ...rest, features: parseFeatures(features_json) };
}

const CSV_COLS = [
  'agent', 'session', 'date', 'hour', 'weekday', 'intent', 'trigger', 'chars', 'words', 'lines', 'refs', 'scope', 'code_block', 'question',
  'images', 'model', 'effort', 'mode', 'context_pct', 'turn_index', 'recent_median_ms', 'repo_files', 'repo_language',
  'tool_calls', 'todo_total', 'active_ms', 'idle_ms', 'outcome', 'predicted_p10_ms', 'predicted_p50_ms', 'predicted_p90_ms', 'source',
];

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Anonymized features + durations. Session ids are hashed; there is no prompt text to export. */
export async function cmdExport(a: Args): Promise<number> {
  const db = openDb();
  try {
    const rows = finishedTurns(db);
    const lines = [CSV_COLS.join(',')];
    for (const r of rows) {
      const f = parseFeatures(r.features_json);
      const d = new Date(r.submitted_at);
      lines.push([
        r.agent, createHash('sha256').update(r.session_id).digest('hex').slice(0, 12), d.toISOString().slice(0, 10), f?.time.hour, f?.time.weekday,
        f?.prompt.intent, r.trigger, f?.prompt.chars, f?.prompt.words, f?.prompt.lines, f?.prompt.refs, f?.prompt.scope ? 1 : 0,
        f?.prompt.codeBlock ? 1 : 0, f?.prompt.question ? 1 : 0, f?.prompt.images, r.model, r.effort, r.mode, r.context_pct,
        f?.session.turnIndex, f?.session.recentMedianMs, f?.repo.files, f?.repo.language, r.tool_calls, r.todo_total,
        r.active_ms, r.idle_ms, r.outcome, r.predicted_p10_ms, r.predicted_p50_ms, r.predicted_p90_ms, r.source,
      ].map(csvCell).join(','));
    }
    const out = flagStr(a, 'out', 'o');
    if (out) { writeFileSync(out, lines.join('\n') + '\n'); console.error(`wrote ${rows.length} rows to ${out}`); }
    else process.stdout.write(lines.join('\n') + '\n');
  } finally { db.close(); }
  return 0;
}

/** Run the v1/v2 comparison; if v2 wins, save it and mark it eligible. Returns the report. */
export function promoteV2IfBetter(db: DB, rounds?: number): ReturnType<typeof evaluate> {
  setMeta(db, 'v2_evaluated_n', String(trainableCount(db)));
  const r = evaluate(db, { rounds, subagents: loadConfig().countSubagentWork });
  if (r.v2Wins) {
    // It won on held-out folds; the saved model is trained on everything.
    const model = trainV2(db, rounds);
    if (model) {
      writeJsonAtomic(paths.modelV2, model);
      setMeta(db, 'v2_eligible', '1');
      setMeta(db, 'v2_trained_n', String(model.n));
      setMeta(db, 'model_updated_at', String(Date.now()));
    }
  } else if (r.v2) {
    if (getMeta(db, 'v2_eligible') === '1') setMeta(db, 'model_updated_at', String(Date.now()));
    setMeta(db, 'v2_eligible', '0');
  }
  return r;
}

export async function cmdEval(a: Args): Promise<number> {
  const db = openDb();
  try {
    const rounds = flagStr(a, 'rounds');
    const r = promoteV2IfBetter(db, rounds ? Number(rounds) : undefined);
    if (flagBool(a, 'quiet')) return 0;
    if (!r.v2) { console.log(r.reasons[0]); return 0; }
    console.log(c.bold('tminus eval') + c.dim(` · rolling origin: ${r.folds.length} consecutive time folds, each trained only on earlier turns (${r.testN} test turns from ${new Date(r.splitAt).toISOString().slice(0, 10)})`));
    const row = (name: string, m: Metrics) => [name, String(m.n), fmtFactor(m.mdae), fmtPct(m.underP90), fmtPct(m.inRange), m.pinball50.toFixed(3), m.pinball90.toFixed(3)];
    console.log(table([['pooled', 'test', 'typical miss', 'under P90', 'in range', 'pinball@.5', 'pinball@.9'], row('v1 buckets', r.v1), row('v2 learned', r.v2)], ['l', 'r', 'r', 'r', 'r', 'r', 'r']));
    const fr: string[][] = [['fold', 'train', 'test', 'from', 'v1 miss', 'v2 miss', 'v1 <P90', 'v2 <P90']];
    r.folds.forEach((f, i) => fr.push([String(i + 1), String(f.trainN), String(f.testN), new Date(f.from).toISOString().slice(0, 10),
      fmtFactor(f.v1.mdae), fmtFactor(f.v2.mdae), fmtPct(f.v1.underP90), fmtPct(f.v2.underP90)]));
    console.log('\n' + table(fr, ['r', 'r', 'r', 'l', 'r', 'r', 'r', 'r']));
    if (r.live) {
      const lr = (name: string, l: typeof r.live.v1) => [name, ...l.mdae.map(fmtFactor), fmtPct(l.runningP50), fmtPct(l.runningP90)];
      console.log('\n' + table([['live (replayed)', 'at 25%', 'at 50%', 'at 75%', 'P50 cal', 'P90 cal'], lr('v1 blend', r.live.v1), lr('v2 live model', r.live.v2)], ['l', 'r', 'r', 'r', 'r', 'r']));
    }
    console.log('');
    for (const line of r.reasons) console.log(line.startsWith('pass') ? c.green(`  ✓ ${line.slice(6)}`) : c.yellow(`  ✗ ${line.slice(6)}`));
    const active = loadConfig().predictor;
    if (r.v2Wins) console.log(c.green(`\nv2 beats v1. Saved and ${active === 'v2' ? 'active' : 'eligible (enable with `tminus config set predictor v2`)'}.`));
    else console.log(c.dim(`\nv1 stays the predictor: v2 did not pass every check.`));
  } finally { db.close(); }
  return 0;
}
