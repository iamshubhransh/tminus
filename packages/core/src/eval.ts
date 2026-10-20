import type { DB } from './db.ts';
import { LogMixture } from './dist.ts';
import { gbdtDistribution, trainGbdt, type GbdtModel } from './gbdt.ts';
import { estimateRemaining, QUESTION_TOOLS, TodoState, toolCategory, type LiveEstimate, type ToolCategory } from './live.ts';
import { BucketPredictor, TRAIN_CAP_MS, type PriorResult } from './predictor.ts';
import { median } from './stats.ts';
import { finishedTurns, isTrainable, parseFeatures, toTrainingRow, type TurnRow } from './store.ts';
import { IdleClock } from './timing.ts';
import type { Prediction } from './types.ts';

export interface Scored {
  actual: number;
  pred: Prediction;
  intent: string;
  model: string;
  source: string;
}

export interface Metrics {
  n: number;
  /** Median |log(pred_p50 / actual)|. exp() of it is the "typical miss" factor. */
  mdae: number;
  /** Share of turns that finished under P90 (target ~90%). */
  underP90: number;
  /** Share that landed inside the displayed range [P10, P90] (target ~80%). */
  inRange: number;
  /** Mean pinball loss at 0.5 and 0.9 in log space. */
  pinball50: number;
  pinball90: number;
}

function pinball(y: number, q: number, alpha: number): number {
  const e = y - q;
  return e >= 0 ? alpha * e : (alpha - 1) * e;
}

export function metrics(rows: Scored[]): Metrics {
  if (!rows.length) return { n: 0, mdae: NaN, underP90: NaN, inRange: NaN, pinball50: NaN, pinball90: NaN };
  const errs = rows.map((r) => Math.abs(Math.log(r.pred.p50 / r.actual)));
  let under = 0, inside = 0, p50 = 0, p90 = 0;
  for (const r of rows) {
    if (r.actual <= r.pred.p90) under++;
    if (r.actual >= r.pred.p10 && r.actual <= r.pred.p90) inside++;
    const y = Math.log(r.actual);
    p50 += pinball(y, Math.log(r.pred.p50), 0.5);
    p90 += pinball(y, Math.log(r.pred.p90), 0.9);
  }
  return {
    n: rows.length,
    mdae: median(errs),
    underP90: under / rows.length,
    inRange: inside / rows.length,
    pinball50: p50 / rows.length,
    pinball90: p90 / rows.length,
  };
}

/** Turns from the DB that have a stored prediction and a usable outcome. */
export function scoredTurns(db: DB): Scored[] {
  return finishedTurns(db)
    .filter((r) => isTrainable(r) && r.predicted_p50_ms && r.predicted_p90_ms && r.predictor !== 'v1:cold')
    .map((r) => ({
      actual: Math.min(r.active_ms!, TRAIN_CAP_MS),
      pred: { p10: r.predicted_p10_ms ?? r.predicted_p50_ms! / 3, p50: r.predicted_p50_ms!, p90: r.predicted_p90_ms! },
      intent: parseFeatures(r.features_json)?.prompt.intent ?? 'other',
      model: r.model ?? '?',
      source: r.source,
    }));
}

export function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    let arr = m.get(k);
    if (!arr) { arr = []; m.set(k, arr); }
    arr.push(x);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Live-update quality: replay a finished turn's events and ask "what would the
// estimate of the total have been at 0/25/50/75% of the way through?"

interface EventRow { ts: number; kind: string; tool_name: string | null; meta_json: string | null }

export const CHECKPOINTS = [0, 0.25, 0.5, 0.75];

/** Replay a finished turn's events and return the live estimate at each active-elapsed time point. */
export function replayEstimates(
  turn: TurnRow, events: EventRow[], prior: PriorResult, points: number[], opts: { subagents?: boolean } = {},
): LiveEstimate[] {
  const countSubagents = opts.subagents ?? true;
  const idle = new IdleClock();
  let toolCalls = 0;
  const history: ToolCategory[] = [];
  let todo: TodoState | null = null;
  const out: LiveEstimate[] = [];
  let ei = 0;
  const elapsedAt = (ts: number) => Math.max(0, ts - turn.submitted_at - idle.total(ts));

  for (const target of points) {
    // Advance through events that happened before this much active time had passed.
    while (ei < events.length && elapsedAt(events[ei].ts) <= target) {
      const e = events[ei++];
      const meta = e.meta_json ? JSON.parse(e.meta_json) : null;
      switch (e.kind) {
        case 'tool_start':
          if (meta?.subagent) {
            // Subagent work: counted, but it neither ends the main thread's waits nor shifts its phase.
            if (countSubagents) toolCalls++;
            break;
          }
          if (idle.waiting && idle.reason !== 'question') idle.endWait(e.ts);
          toolCalls++;
          history.push(toolCategory(e.tool_name));
          if (e.tool_name && QUESTION_TOOLS.test(e.tool_name)) idle.startWait(e.ts, 'question');
          break;
        case 'tool_end':
        case 'resumed':
          if (idle.waiting) idle.endWait(e.ts);
          break;
        case 'waiting_user':
          idle.startWait(e.ts, meta?.reason ?? 'waiting');
          break;
        case 'todo_update':
          if (meta && typeof meta.total === 'number') {
            if (!todo) todo = new TodoState();
            const items = Array.from({ length: meta.total }, (_, i) => ({ id: String(i), status: i < meta.done ? 'completed' as const : 'pending' as const }));
            todo.apply({ kind: 'snapshot', items }, elapsedAt(e.ts));
          }
          break;
      }
    }
    out.push(estimateRemaining({
      elapsedMs: target, prior: prior.dist, toolCalls, toolHistory: history, todo,
      perTaskPriorMs: prior.perTaskMs, bucketCalls: prior.calls,
    }));
  }
  return out;
}

/** |log(predicted total / actual)| at each checkpoint (fraction of the actual active time). */
export function simulateLive(turn: TurnRow, events: EventRow[], prior: PriorResult, checkpoints = CHECKPOINTS, opts: { subagents?: boolean } = {}): number[] {
  const actual = Math.max(turn.active_ms ?? 0, 1);
  const points = checkpoints.map((cp) => cp * actual);
  return replayEstimates(turn, events, prior, points, opts).map((est, i) => Math.abs(Math.log((points[i] + est.p50RemainingMs) / actual)));
}

export interface LiveQuality {
  checkpoints: number[];
  mdae: number[];
  n: number;
  /**
   * Calibration of the live estimate among turns still running: at log-spaced
   * elapsed times, the share whose true remaining time was within the shown
   * P50 (target 50%) and P90 (target 90%).
   */
  runningP50: number;
  runningP90: number;
  snapshots: number;
}

/**
 * Prequential replay over finished turns in time order: each turn is replayed
 * with a model trained only on turns before it.
 */
export function liveQuality(db: DB, source: 'live' | 'backfill' | null = null, opts: { subagents?: boolean } = {}): LiveQuality {
  const rows = finishedTurns(db);
  const pred = new BucketPredictor();
  const errs: number[][] = CHECKPOINTS.map(() => []);
  const evStmt = db.prepare(`SELECT ts, kind, tool_name, meta_json FROM events WHERE turn_id = ? ORDER BY ts, id`);
  let n = 0, snaps = 0, in50 = 0, in90 = 0;
  for (const r of rows) {
    const trainable = isTrainable(r);
    if (trainable && (!source || r.source === source) && pred.size >= 20) {
      const f = parseFeatures(r.features_json);
      const prior = pred.prior({ model: r.model, effort: r.effort, intent: f?.prompt.intent ?? 'other' });
      const events = evStmt.all(r.id) as EventRow[];
      simulateLive(r, events, prior, CHECKPOINTS, opts).forEach((e, i) => errs[i].push(e));
      const actual = r.active_ms ?? 0;
      const grid: number[] = [];
      for (let t = 3000; t < actual; t *= 1.5) grid.push(t);
      replayEstimates(r, events, prior, grid, opts).forEach((est, i) => {
        const remaining = actual - grid[i];
        snaps++;
        if (remaining <= est.p50RemainingMs) in50++;
        if (remaining <= est.p90RemainingMs) in90++;
      });
      n++;
    }
    if (trainable) pred.add(toTrainingRow(r, opts));
  }
  return {
    checkpoints: CHECKPOINTS, mdae: errs.map((e) => (e.length ? median(e) : NaN)), n,
    runningP50: snaps ? in50 / snaps : NaN, runningP90: snaps ? in90 / snaps : NaN, snapshots: snaps,
  };
}

// ---------------------------------------------------------------------------
// v1 vs v2, rolling-origin: several consecutive time folds, each trained only
// on the turns before it. One split can flatter either model; a model has to
// win on the pooled numbers *and* on most folds to be promoted.

export interface LiveCalibration {
  /** Median |log(predicted total / actual)| at 25/50/75% of the turn. */
  mdae: number[];
  /** Share of still-running snapshots that finished within the shown P50 / P90 remaining. */
  runningP50: number;
  runningP90: number;
  snapshots: number;
}

export interface FoldResult {
  trainN: number;
  testN: number;
  from: number;
  v1: Metrics;
  v2: Metrics;
}

export interface EvalReport {
  trainN: number;
  testN: number;
  splitAt: number;
  folds: FoldResult[];
  /** Pooled over every fold's test turns. */
  v1: Metrics;
  v2: Metrics | null;
  live: { v1: LiveCalibration; v2: LiveCalibration } | null;
  v2Wins: boolean;
  /** Why v2 did or did not win, one line per criterion. */
  reasons: string[];
}

const LIVE_POINTS = [0.25, 0.5, 0.75];

function liveCalibration(turns: { row: TurnRow; events: EventRow[]; prior: PriorResult }[], opts: { subagents?: boolean }): LiveCalibration {
  const errs: number[][] = LIVE_POINTS.map(() => []);
  let snaps = 0, in50 = 0, in90 = 0;
  for (const { row, events, prior } of turns) {
    const actual = row.active_ms ?? 0;
    simulateLive(row, events, prior, LIVE_POINTS, opts).forEach((e, i) => errs[i].push(e));
    const grid: number[] = [];
    for (let t = 3000; t < actual; t *= 1.5) grid.push(t);
    replayEstimates(row, events, prior, grid, opts).forEach((est, i) => {
      snaps++;
      if (actual - grid[i] <= est.p50RemainingMs) in50++;
      if (actual - grid[i] <= est.p90RemainingMs) in90++;
    });
  }
  return { mdae: errs.map((e) => (e.length ? median(e) : NaN)), runningP50: snaps ? in50 / snaps : NaN, runningP90: snaps ? in90 / snaps : NaN, snapshots: snaps };
}

export function evaluate(db: DB, opts: { folds?: number; minTrain?: number; rounds?: number; subagents?: boolean } = {}): EvalReport {
  const sub = { subagents: opts.subagents ?? true };
  const rows = finishedTurns(db).filter(isTrainable).filter((r) => parseFeatures(r.features_json));
  const nFolds = opts.folds ?? 5;
  const minTrain = Math.max(60, Math.min(opts.minTrain ?? 200, Math.floor(rows.length * 0.5)));
  const block = Math.floor((rows.length - minTrain) / nFolds);
  const empty: EvalReport = { trainN: rows.length, testN: 0, splitAt: 0, folds: [], v1: metrics([]), v2: null, live: null, v2Wins: false, reasons: ['not enough finished turns to evaluate (need at least 60 + a test fold)'] };
  if (block < 5) return empty;

  const evStmt = db.prepare(`SELECT ts, kind, tool_name, meta_json FROM events WHERE turn_id = ? ORDER BY ts, id`);
  const score = (r: TurnRow, p: Prediction): Scored => ({
    actual: Math.min(r.active_ms!, TRAIN_CAP_MS), pred: p, intent: parseFeatures(r.features_json)!.prompt.intent, model: r.model ?? '?', source: r.source,
  });
  const folds: FoldResult[] = [];
  const all1: Scored[] = [], all2: Scored[] = [];
  const live1: Parameters<typeof liveCalibration>[0] = [], live2: Parameters<typeof liveCalibration>[0] = [];

  for (let k = 0; k < nFolds; k++) {
    const cut = minTrain + k * block;
    const train = rows.slice(0, cut);
    const test = rows.slice(cut, k === nFolds - 1 ? rows.length : cut + block);
    const v1 = BucketPredictor.train(train.map((r) => toTrainingRow(r, sub)));
    const model = trainGbdt(train.map((r) => parseFeatures(r.features_json)!), train.map((r) => Math.min(r.active_ms!, TRAIN_CAP_MS)), { rounds: opts.rounds });
    const s1: Scored[] = [], s2: Scored[] = [];
    for (const r of test) {
      const f = parseFeatures(r.features_json)!;
      const prior1 = v1.prior({ model: r.model, effort: r.effort, intent: f.prompt.intent });
      // Score exactly the distribution the live engine would use for this turn.
      const d2 = gbdtDistribution(model, f);
      s1.push(score(r, { p10: prior1.dist.quantile(0.1), p50: prior1.dist.quantile(0.5), p90: prior1.dist.quantile(0.9) }));
      s2.push(score(r, { p10: d2.quantile(0.1), p50: d2.quantile(0.5), p90: d2.quantile(0.9) }));
      const events = evStmt.all(r.id) as EventRow[];
      live1.push({ row: r, events, prior: prior1 });
      live2.push({ row: r, events, prior: { ...prior1, dist: d2 } });
    }
    all1.push(...s1);
    all2.push(...s2);
    folds.push({ trainN: train.length, testN: test.length, from: test[0].submitted_at, v1: metrics(s1), v2: metrics(s2) });
  }

  const m1 = metrics(all1), m2 = metrics(all2);
  const l1 = liveCalibration(live1, sub), l2 = liveCalibration(live2, sub);
  const foldWins = folds.filter((f) => f.v2.mdae < f.v1.mdae).length;
  const calGap = (m: Metrics) => Math.abs(m.underP90 - 0.9);
  const liveGap = (l: LiveCalibration) => Math.abs(l.runningP90 - 0.9);
  const checks: [boolean, string][] = [
    [m2.mdae < m1.mdae, `typical miss ${fmtX(m2.mdae)} vs ${fmtX(m1.mdae)}`],
    [foldWins > nFolds / 2, `lower typical miss on ${foldWins} of ${nFolds} folds`],
    [m2.pinball90 <= m1.pinball90, `P90 pinball loss ${m2.pinball90.toFixed(3)} vs ${m1.pinball90.toFixed(3)}`],
    [calGap(m2) <= calGap(m1) + 0.03, `under P90 ${pct(m2.underP90)} vs ${pct(m1.underP90)} (target 90%)`],
    [liveGap(l2) <= liveGap(l1) + 0.03, `live P90 calibration ${pct(l2.runningP90)} vs ${pct(l1.runningP90)} (target 90%)`],
  ];
  return {
    trainN: minTrain, testN: all1.length, splitAt: folds[0].from, folds, v1: m1, v2: m2, live: { v1: l1, v2: l2 },
    v2Wins: checks.every(([ok]) => ok),
    reasons: checks.map(([ok, msg]) => `${ok ? 'pass' : 'fail'}: ${msg}`),
  };
}

/** Train the v2 model on every trainable turn (used after it has won the evaluation). */
export function trainV2(db: DB, rounds?: number): GbdtModel | null {
  const rows = finishedTurns(db).filter(isTrainable).filter((r) => parseFeatures(r.features_json));
  if (rows.length < 60) return null;
  return trainGbdt(rows.map((r) => parseFeatures(r.features_json)!), rows.map((r) => Math.min(r.active_ms!, TRAIN_CAP_MS)), { rounds });
}

const fmtX = (logErr: number) => `×${Math.exp(logErr).toFixed(2)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Lognormal prior from a v2 prediction, for survival conditioning in the live engine. */
export function priorFromQuantiles(p: Prediction): LogMixture {
  return LogMixture.fromQuantiles(p.p50, p.p90);
}
