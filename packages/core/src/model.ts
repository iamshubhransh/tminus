import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';
import { getMeta, type DB } from './db.ts';
import type { Predictor } from './engine.ts';
import { gbdtDistribution, isGbdtModel, type GbdtModel, type PastTurn } from './gbdt.ts';
import { logError } from './log.ts';
import { paths } from './paths.ts';
import { BucketPredictor, type PriorResult, type TrainingRow } from './predictor.ts';
import { trainingRows } from './store.ts';
import type { BucketKey, Features } from './types.ts';

/**
 * v2 supplies the submit-time distribution (shifted by its errors on the
 * session's recent turns) and the learned live model; v1 still supplies
 * tool-call and per-task stats for the fallback live blend.
 */
export class GbdtPredictor implements Predictor {
  readonly version = 'v2';
  constructor(private v1: BucketPredictor, readonly model: GbdtModel) {}
  get size() { return this.v1.size; }
  get live() { return this.model.live; }
  prior(key: BucketKey, features?: Features, past: PastTurn[] = []): PriorResult {
    const base = this.v1.prior(key);
    if (!features) return base;
    return { ...base, dist: gbdtDistribution(this.model, features, past), level: 'v2', n: this.model.n };
  }
  add(row: TrainingRow): void { this.v1.add(row); }
}

/**
 * The active predictor. With the default `predictor: "v2"`, v2 is used only
 * when `tminus eval` has shown it beats v1 on this machine's history (meta
 * `v2_eligible`); otherwise, or with `predictor: "v1"`, the bucket model is used.
 */
export function loadPredictor(db: DB, cfg: Config): Predictor {
  const v1 = BucketPredictor.train(trainingRows(db, undefined, { subagents: cfg.countSubagentWork }));
  if (cfg.predictor === 'v2' && getMeta(db, 'v2_eligible') === '1') {
    try {
      const model = JSON.parse(readFileSync(paths.modelV2, 'utf8'));
      if (isGbdtModel(model)) return new GbdtPredictor(v1, model);
      logError('collector', 'v2 model file has an old layout; using v1 until `tminus eval` retrains it');
    } catch (e) {
      logError('collector', 'v2 model unavailable, using v1', e);
    }
  }
  return v1;
}

/** Which predictor would be used right now, and why (for status/doctor). */
export function predictorStatus(db: DB, cfg: Config): { active: 'v1' | 'v2'; reason: string } {
  if (cfg.predictor !== 'v2') return { active: 'v1', reason: 'set to v1 in config' };
  if (getMeta(db, 'v2_eligible') !== '1') return { active: 'v1', reason: 'v2 has not beaten v1 on your history yet' };
  try {
    if (isGbdtModel(JSON.parse(readFileSync(paths.modelV2, 'utf8')))) return { active: 'v2', reason: 'beat v1 in `tminus eval`' };
  } catch { /* fall through */ }
  return { active: 'v1', reason: 'v2 model file missing; run `tminus eval`' };
}
