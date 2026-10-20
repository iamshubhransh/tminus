import type { DB } from './db.ts';
import { setMeta } from './db.ts';
import { BucketPredictor } from './predictor.ts';
import { finishedTurns, importTurn, isTrainable, toTrainingRow } from './store.ts';
import { TRAINABLE_TRIGGERS, type NormalizedTurn } from './types.ts';

/** Below this much history a prediction is a cold-start guess; stats leave those out. */
export const COLD_START_N = 20;

export interface ImportSummary {
  seen: number;
  imported: number;
  skipped: number;
  byAgent: Record<string, number>;
  byOutcome: Record<string, number>;
}

/**
 * Import backfilled turns. Each new turn gets the prediction v1 *would have
 * made* using only turns that happened before it (prequential), so `tminus
 * stats` reports honest out-of-sample calibration on day one.
 */
export function importTurns(db: DB, turns: NormalizedTurn[]): ImportSummary {
  const summary: ImportSummary = { seen: turns.length, imported: 0, skipped: 0, byAgent: {}, byOutcome: {} };
  const existing = finishedTurns(db);
  const items: ({ at: number; old: (typeof existing)[number] } | { at: number; neu: NormalizedTurn })[] = [
    ...existing.map((old) => ({ at: old.submitted_at, old })),
    ...turns.map((neu) => ({ at: neu.submittedAt, neu })),
  ].sort((a, b) => a.at - b.at);

  const pred = new BucketPredictor();
  db.transaction(() => {
    for (const it of items) {
      if ('old' in it) {
        if (isTrainable(it.old)) pred.add(toTrainingRow(it.old));
        continue;
      }
      const t = it.neu;
      const intent = t.features.prompt.intent;
      const p = pred.predict({ model: t.model, effort: t.effort, intent });
      const id = importTurn(db, t, p, pred.size >= COLD_START_N ? 'v1' : 'v1:cold');
      if (id === null) { summary.skipped++; continue; }
      summary.imported++;
      summary.byAgent[t.agent] = (summary.byAgent[t.agent] ?? 0) + 1;
      summary.byOutcome[t.outcome] = (summary.byOutcome[t.outcome] ?? 0) + 1;
      const activeMs = t.finishedAt - t.submittedAt - t.idleMs;
      if (isTrainable({ outcome: t.outcome, active_ms: activeMs, trigger: t.features.trigger })) {
        pred.add({ model: t.model, effort: t.effort, intent, activeMs, toolCalls: t.toolCalls, todoTotal: t.todoTotal });
      }
    }
    setMeta(db, 'model_updated_at', String(Date.now()));
  });
  return summary;
}

export { TRAINABLE_TRIGGERS };
