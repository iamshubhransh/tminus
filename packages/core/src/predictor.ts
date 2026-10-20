import { LogMixture, fitSmall } from './dist.ts';
import { normalizeModel } from './features.ts';
import { quantileSorted } from './stats.ts';
import type { BucketKey, Intent, Prediction } from './types.ts';

/** Minimum samples for a bucket to be used, and the shrinkage constant. */
export const MIN_BUCKET_N = 8;
export const SHRINK_K = 8;
/** Training cap: outliers above 2h are kept in the DB but clipped for training. */
export const TRAIN_CAP_MS = 2 * 60 * 60 * 1000;
export const MIN_ACTIVE_MS = 1000;
/** Per-bucket sample memory: the most recent N samples (keeps the model adaptive and fast). */
const MAX_SAMPLES = 240;
/** Below this many samples a bucket is summarised by a fitted log-normal instead of a KDE. */
const KDE_MIN_N = 20;

/** Used before there is any history at all: median ~90s, wide. */
export const DEFAULT_PRIOR = LogMixture.lognormal(Math.log(90_000), 1.3);

export interface TrainingRow {
  model: string | null;
  effort: string | null;
  intent: Intent;
  activeMs: number;
  /** Total tool calls (main thread + subagents). */
  toolCalls?: number | null;
  todoTotal?: number | null;
}

interface Bucket {
  n: number;
  logs: number[];
  calls: number[];
  /** active_ms / todo_total for turns that had a todo list. */
  perTask: number[];
}

export type Level = 'global' | 'intent' | 'model+intent' | 'model+effort+intent' | 'v2';

export interface PriorResult {
  dist: LogMixture;
  level: Level;
  n: number;
  /** Shrinkage chain applied, most general first. */
  chain: { level: Level; n: number; w: number }[];
  /** Total tool calls for completed turns in the chosen bucket (sorted). */
  calls: number[];
  /** Typical active time per todo item (ms). */
  perTaskMs: number;
}

function keysFor(k: BucketKey): [Level, string][] {
  const m = normalizeModel(k.model) ?? '?';
  const e = k.effort ?? '?';
  return [
    ['global', 'g'],
    ['intent', `i|${k.intent}`],
    ['model+intent', `mi|${m}|${k.intent}`],
    ['model+effort+intent', `mei|${m}|${e}|${k.intent}`],
  ];
}

/**
 * Predictor v1: hierarchical buckets over log(active_ms).
 *   (model, effort, intent) -> (model, intent) -> (intent) -> global
 * The most specific bucket with >= 8 samples is used, shrunk toward its parent
 * chain with weight n / (n + 8).
 */
export class BucketPredictor {
  private buckets = new Map<string, Bucket>();
  private memo = new Map<string, PriorResult>();
  readonly version = 'v1';

  static train(rows: TrainingRow[]): BucketPredictor {
    const p = new BucketPredictor();
    for (const r of rows) p.add(r);
    return p;
  }

  get size(): number {
    return this.buckets.get('g')?.n ?? 0;
  }

  add(r: TrainingRow): void {
    if (!(r.activeMs >= MIN_ACTIVE_MS)) return;
    const log = Math.log(Math.min(r.activeMs, TRAIN_CAP_MS));
    for (const [, key] of keysFor({ model: r.model, effort: r.effort, intent: r.intent })) {
      let b = this.buckets.get(key);
      if (!b) { b = { n: 0, logs: [], calls: [], perTask: [] }; this.buckets.set(key, b); }
      b.n++;
      b.logs.push(log);
      if (b.logs.length > MAX_SAMPLES) b.logs.shift();
      if (r.toolCalls != null) {
        b.calls.push(r.toolCalls);
        if (b.calls.length > MAX_SAMPLES) b.calls.shift();
      }
      if (r.todoTotal && r.todoTotal > 0) {
        b.perTask.push(r.activeMs / r.todoTotal);
        if (b.perTask.length > MAX_SAMPLES) b.perTask.shift();
      }
    }
    this.memo.clear();
  }

  prior(k: BucketKey): PriorResult {
    const memoKey = keysFor(k)[3][1];
    const hit = this.memo.get(memoKey);
    if (hit) return hit;

    const levels = keysFor(k).map(([level, key]) => ({ level, b: this.buckets.get(key) }));
    // Most specific level with enough data.
    let last = 0;
    for (let i = 0; i < levels.length; i++) if ((levels[i].b?.n ?? 0) >= MIN_BUCKET_N) last = i;

    const chain: PriorResult['chain'] = [];
    let dist = DEFAULT_PRIOR;
    for (let i = 0; i <= last; i++) {
      const b = levels[i].b;
      if (!b || b.n === 0) continue;
      const own = b.logs.length >= KDE_MIN_N ? LogMixture.kde(b.logs) : fitSmall(b.logs, dist.logSd(), SHRINK_K);
      const w = b.n / (b.n + SHRINK_K);
      dist = LogMixture.blend(own, w, dist);
      chain.push({ level: levels[i].level, n: b.n, w });
    }

    const chosen = levels[last].b;
    const calls = pickCalls(levels.slice(0, last + 1).map((l) => l.b));
    const perTask = pickPerTask(levels.slice(0, last + 1).map((l) => l.b));
    const res: PriorResult = {
      dist,
      level: levels[last].level,
      n: chosen?.n ?? 0,
      chain,
      calls,
      perTaskMs: perTask,
    };
    this.memo.set(memoKey, res);
    return res;
  }

  predict(k: BucketKey): Prediction {
    const { dist } = this.prior(k);
    return { p10: dist.quantile(0.1), p50: dist.quantile(0.5), p90: dist.quantile(0.9) };
  }
}

/** Tool-call totals from the most specific bucket that has at least 8 of them. */
function pickCalls(chain: (Bucket | undefined)[]): number[] {
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]?.calls;
    if (c && c.length >= MIN_BUCKET_N) return [...c].sort((a, b) => a - b);
  }
  return [];
}

const DEFAULT_PER_TASK_MS = 75_000;

function pickPerTask(chain: (Bucket | undefined)[]): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]?.perTask;
    if (c && c.length >= 3) return quantileSorted([...c].sort((a, b) => a - b), 0.5);
  }
  return DEFAULT_PER_TASK_MS;
}
