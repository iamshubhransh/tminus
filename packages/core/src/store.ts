import type { DB } from './db.ts';
import { MIN_ACTIVE_MS, type TrainingRow } from './predictor.ts';
import { TRAINABLE_TRIGGERS, type Features, type NormalizedTurn, type Prediction, type TurnEvent } from './types.ts';

export interface TurnRow {
  id: number;
  session_id: string;
  agent: string;
  ext_id: string | null;
  submitted_at: number;
  finished_at: number | null;
  active_ms: number | null;
  idle_ms: number;
  outcome: string | null;
  model: string | null;
  effort: string | null;
  mode: string | null;
  context_pct: number | null;
  features_json: string | null;
  predicted_p10_ms: number | null;
  predicted_p50_ms: number | null;
  predicted_p90_ms: number | null;
  predictor: string | null;
  source: 'live' | 'backfill';
  trigger: string | null;
  tool_calls: number | null;
  subagent_tool_calls: number | null;
  todo_total: number | null;
  agent_duration_ms: number | null;
}

export function upsertSession(db: DB, s: { id: string; agent: string; projectHash: string | null; model: string | null; startedAt: number }): void {
  db.prepare(`
    INSERT INTO sessions (id, agent, project_path_hash, model, started_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      model = COALESCE(excluded.model, sessions.model),
      project_path_hash = COALESCE(sessions.project_path_hash, excluded.project_path_hash),
      started_at = MIN(COALESCE(sessions.started_at, excluded.started_at), excluded.started_at)
  `).run(s.id, s.agent, s.projectHash, s.model, s.startedAt);
}

export interface NewTurn {
  sessionId: string;
  agent: string;
  extId: string;
  submittedAt: number;
  model: string | null;
  effort: string | null;
  mode: string | null;
  contextPct: number | null;
  features: Features;
  prediction: Prediction | null;
  predictor: string | null;
  source: 'live' | 'backfill';
}

/** Insert a turn; returns its id, or null if (agent, session, ext_id) already exists. */
export function insertTurn(db: DB, t: NewTurn): number | null {
  const existing = db.prepare(`SELECT id FROM turns WHERE agent = ? AND session_id = ? AND ext_id = ?`).get(t.agent, t.sessionId, t.extId);
  if (existing) return null;
  const r = db.prepare(`
    INSERT INTO turns (session_id, agent, ext_id, submitted_at, model, effort, mode, context_pct, features_json,
      predicted_p10_ms, predicted_p50_ms, predicted_p90_ms, predictor, source, trigger, idle_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    t.sessionId, t.agent, t.extId, t.submittedAt, t.model, t.effort, t.mode, t.contextPct, JSON.stringify(t.features),
    round(t.prediction?.p10), round(t.prediction?.p50), round(t.prediction?.p90), t.predictor, t.source, t.features.trigger,
  );
  return Number(r.lastInsertRowid);
}

export function finishTurn(db: DB, id: number, f: {
  finishedAt: number; activeMs: number; idleMs: number; outcome: string; toolCalls: number; subagentToolCalls?: number;
  todoTotal: number; agentDurationMs?: number | null;
}): void {
  db.prepare(`
    UPDATE turns SET finished_at = ?, active_ms = ?, idle_ms = ?, outcome = ?, tool_calls = ?, subagent_tool_calls = ?, todo_total = ?,
      agent_duration_ms = COALESCE(?, agent_duration_ms)
    WHERE id = ?
  `).run(f.finishedAt, Math.round(f.activeMs), Math.round(f.idleMs), f.outcome, f.toolCalls, f.subagentToolCalls ?? 0, f.todoTotal, f.agentDurationMs ?? null, id);
}

/** Remove every backfilled turn (events and predictions cascade) so history can be re-imported. */
export function deleteBackfill(db: DB): number {
  // Count first: some drivers include cascaded event/prediction rows in `changes`.
  const n = Number(db.prepare(`SELECT COUNT(*) n FROM turns WHERE source = 'backfill'`).get().n);
  db.prepare(`DELETE FROM turns WHERE source = 'backfill'`).run();
  return n;
}

export function reopenTurn(db: DB, id: number): void {
  db.prepare(`UPDATE turns SET finished_at = NULL, active_ms = NULL, outcome = NULL WHERE id = ?`).run(id);
}

export function updateFeatures(db: DB, id: number, features: Features): void {
  db.prepare(`UPDATE turns SET features_json = ? WHERE id = ?`).run(JSON.stringify(features), id);
}

export function insertEvent(db: DB, turnId: number | null, e: TurnEvent): void {
  db.prepare(`INSERT INTO events (turn_id, ts, kind, tool_name, meta_json) VALUES (?, ?, ?, ?, ?)`)
    .run(turnId, e.ts, e.kind, e.toolName ?? null, e.meta ? JSON.stringify(e.meta) : null);
}

export function insertPrediction(db: DB, turnId: number, ts: number, elapsedMs: number, p50: number, p90: number, weights: unknown): void {
  db.prepare(`INSERT INTO predictions (turn_id, ts, elapsed_ms, p50_remaining_ms, p90_remaining_ms, signal_weights_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(turnId, ts, Math.round(elapsedMs), Math.round(p50), Math.round(p90), JSON.stringify(weights));
}

/** Store a backfilled turn with its events. Idempotent. Returns the new id or null if it already existed. */
export function importTurn(db: DB, t: NormalizedTurn, prediction: Prediction | null, predictor: string | null): number | null {
  return db.transaction(() => {
    const id = insertTurn(db, {
      sessionId: t.sessionId, agent: t.agent, extId: t.extId, submittedAt: t.submittedAt,
      model: t.model, effort: t.effort, mode: t.mode, contextPct: t.contextPct,
      features: t.features, prediction, predictor, source: 'backfill',
    });
    if (id === null) return null;
    finishTurn(db, id, {
      finishedAt: t.finishedAt, activeMs: Math.max(0, t.finishedAt - t.submittedAt - t.idleMs), idleMs: t.idleMs,
      outcome: t.outcome, toolCalls: t.toolCalls, subagentToolCalls: t.subagentToolCalls ?? 0, todoTotal: t.todoTotal, agentDurationMs: t.agentDurationMs,
    });
    for (const e of t.events) insertEvent(db, id, e);
    return id;
  });
}

/**
 * Bring an already-imported turn up to date with a newer parser, without
 * deleting anything (transcripts the agent has since cleaned up can't be
 * re-read): fill model/effort if they were unknown, and add phase labels if the
 * turn has none. Returns true if anything changed.
 */
export function enrichTurn(db: DB, t: NormalizedTurn): boolean {
  const row = db.prepare(`SELECT id, model, effort, features_json FROM turns WHERE agent = ? AND session_id = ? AND ext_id = ?`)
    .get(t.agent, t.sessionId, t.extId) as { id: number; model: string | null; effort: string | null; features_json: string | null } | undefined;
  if (!row) return false;
  let changed = false;
  if ((!row.effort && t.effort) || (!row.model && t.model)) {
    const f = parseFeatures(row.features_json);
    if (f) { f.session.effort = f.session.effort ?? t.effort; f.session.model = f.session.model ?? t.model; }
    db.prepare(`UPDATE turns SET effort = COALESCE(effort, ?), model = COALESCE(model, ?), features_json = COALESCE(?, features_json) WHERE id = ?`)
      .run(t.effort, t.model, f ? JSON.stringify(f) : null, row.id);
    changed = true;
  }
  const phases = t.events.filter((e) => e.kind === 'phase');
  if (phases.length && !db.prepare(`SELECT 1 FROM events WHERE turn_id = ? AND kind = 'phase' LIMIT 1`).get(row.id)) {
    for (const e of phases) insertEvent(db, row.id, e);
    changed = true;
  }
  return changed;
}

/** Number of turns the models can learn from (same rule as isTrainable). */
export function trainableCount(db: DB): number {
  return Number(db.prepare(`
    SELECT COUNT(*) n FROM turns
    WHERE finished_at IS NOT NULL AND outcome = 'completed' AND active_ms >= ?
      AND (trigger IS NULL OR trigger IN (${TRAINABLE_TRIGGERS.map(() => '?').join(', ')}))
  `).get(MIN_ACTIVE_MS, ...TRAINABLE_TRIGGERS).n);
}

export function isTrainable(r: Pick<TurnRow, 'outcome' | 'active_ms' | 'trigger'>): boolean {
  return r.outcome === 'completed'
    && (r.active_ms ?? 0) >= MIN_ACTIVE_MS
    && (r.trigger == null || (TRAINABLE_TRIGGERS as string[]).includes(r.trigger));
}

export function toTrainingRow(r: TurnRow, opts: { subagents?: boolean } = {}): TrainingRow {
  const sub = opts.subagents ?? true ? (r.subagent_tool_calls ?? 0) : 0;
  const f = parseFeatures(r.features_json);
  return {
    model: r.model,
    effort: r.effort,
    intent: f?.prompt.intent ?? 'other',
    activeMs: r.active_ms ?? 0,
    // All tool calls the turn's work took: main thread plus (by default) its subagents.
    toolCalls: r.tool_calls == null ? null : r.tool_calls + sub,
    todoTotal: r.todo_total,
  };
}

/** All finished turns in time order. */
export function finishedTurns(db: DB, opts: { source?: 'live' | 'backfill'; before?: number } = {}): TurnRow[] {
  const where = ['finished_at IS NOT NULL'];
  const params: unknown[] = [];
  if (opts.source) { where.push('source = ?'); params.push(opts.source); }
  if (opts.before) { where.push('submitted_at < ?'); params.push(opts.before); }
  return db.prepare(`SELECT * FROM turns WHERE ${where.join(' AND ')} ORDER BY submitted_at ASC`).all(...params) as TurnRow[];
}

export function trainingRows(db: DB, before?: number, opts: { subagents?: boolean } = {}): TrainingRow[] {
  return finishedTurns(db, { before }).filter(isTrainable).map((r) => toTrainingRow(r, opts));
}

export function sessionTurnStats(db: DB, sessionId: string): { count: number; recentActive: number[] } {
  const rows = db.prepare(`SELECT active_ms FROM turns WHERE session_id = ? ORDER BY submitted_at DESC LIMIT 50`).all(sessionId) as { active_ms: number | null }[];
  return {
    count: rows.length,
    recentActive: rows.filter((r) => r.active_ms != null && r.active_ms > 0).slice(0, 3).map((r) => r.active_ms as number).reverse(),
  };
}

export function recentFinished(db: DB, n: number): TurnRow[] {
  return db.prepare(`SELECT * FROM turns WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?`).all(n) as TurnRow[];
}

export function parseFeatures(json: string | null): Features | null {
  if (!json) return null;
  try { return JSON.parse(json) as Features; } catch { return null; }
}

function round(x: number | undefined | null): number | null {
  return x == null || !Number.isFinite(x) ? null : Math.round(x);
}
