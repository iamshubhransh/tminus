import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { DB } from './db.ts';
import { buildFeatures, hashPath, normalizeModel } from './features.ts';
import { estimateRemaining, QUESTION_TOOLS, TodoState, toolCategory, type LiveEstimate, type ToolCategory } from './live.ts';
import { logError } from './log.ts';
import type { PriorResult, TrainingRow } from './predictor.ts';
import { repoInfo } from './repo.ts';
import {
  finishTurn, insertEvent, insertPrediction, insertTurn, isTrainable, recentFinished, reopenTurn,
  sessionTurnStats, updateFeatures, upsertSession, parseFeatures,
} from './store.ts';
import { contextFile, writeState, type LiveState, type SessionContextFile } from './state.ts';
import { activeMs, IdleClock } from './timing.ts';
import { TRAINABLE_TRIGGERS, type BucketKey, type Features, type NormalizedEvent, type Outcome, type Prediction, type Trigger } from './types.ts';

export interface Predictor {
  readonly version: string;
  readonly size: number;
  prior(key: BucketKey, features?: Features): PriorResult;
  add(row: TrainingRow): void;
}

/** Adapter hook used on ticks to notice interrupts that fire no hook (e.g. Esc in Claude Code). */
export type TranscriptProbe = (path: string, fromOffset: number) => { offset: number; interruptedAt: number | null };

export interface EngineOptions {
  db: DB;
  predictor: Predictor;
  now?: () => number;
  /** Write state files (disabled in some tests). */
  writeStates?: boolean;
  probes?: Record<string, TranscriptProbe>;
  /** Interval between rows in the predictions table while ticking, ms. */
  predictionEveryMs?: number;
  /** Count subagent tool calls as work in the activity signal (default true). */
  countSubagentWork?: boolean;
}

interface LiveTurn {
  id: number;
  promptId: string | null;
  trigger: Trigger;
  submittedAt: number;
  features: Features;
  prior: PriorResult;
  initial: Prediction;
  idle: IdleClock;
  /** Whose wait is open: 'main' or a subagent id. */
  waitOwner: string | null;
  /** Main-thread tool calls. */
  toolCalls: number;
  /** Tool calls made by this turn's subagents. Counted as work by the activity signal. */
  subagentCalls: number;
  /** Main-thread tool categories (the read -> edit phase signal). */
  toolHistory: ToolCategory[];
  todo: TodoState | null;
  lastEventAt: number;
  lastPredictionAt: number;
  estimate: LiveEstimate | null;
  transcriptOffset: number;
}

interface SessionRec {
  id: string;
  agent: string;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  mode: string | null;
  transcriptPath: string | null;
  lastEventAt: number;
  /** First live source to report a turn for this session wins ('hook' or 'tail'). */
  source: string | null;
  turn: LiveTurn | null;
  lastClosed: { turnId: number; promptId: string | null; closedAt: number; outcome: Outcome; turn: LiveTurn } | null;
  last: LiveState['last'];
}

const REOPEN_WINDOW_MS = 10 * 60 * 1000;
const ABANDON_MS = 6 * 60 * 60 * 1000;
const IMPLICIT_GAP_MS = 3_000;

export class Engine {
  private sessions = new Map<string, SessionRec>();
  private history: LiveState['history'] = [];
  private db: DB;
  private now: () => number;
  private writeStates: boolean;
  private probes: Record<string, TranscriptProbe>;
  private predictionEveryMs: number;
  private countSubagentWork: boolean;
  predictor: Predictor;
  /** Session that most recently received an event (drives current.json). */
  currentSession: string | null = null;

  constructor(opts: EngineOptions) {
    this.db = opts.db;
    this.predictor = opts.predictor;
    this.now = opts.now ?? Date.now;
    this.writeStates = opts.writeStates ?? true;
    this.probes = opts.probes ?? {};
    this.predictionEveryMs = opts.predictionEveryMs ?? 15_000;
    this.countSubagentWork = opts.countSubagentWork ?? true;
    this.refreshHistory();
  }

  get activeTurns(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.turn) n++;
    return n;
  }

  /** Apply one normalized event. `source` distinguishes hook events from file tailing. */
  handle(ev: NormalizedEvent, source = 'hook'): void {
    const s = this.session(ev);
    if (s.source && s.source !== source && (ev.kind === 'prompt_submit' || s.turn)) {
      // Another live source already owns this session; avoid double counting.
      return;
    }
    if (ev.kind === 'prompt_submit' && !s.source) s.source = source;
    s.lastEventAt = Math.max(s.lastEventAt, ev.ts);
    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.model) s.model = normalizeModel(ev.model);
    if (ev.effort) s.effort = ev.effort;
    if (ev.mode) s.mode = ev.mode;
    if (ev.transcriptPath) s.transcriptPath = ev.transcriptPath;
    this.currentSession = s.id;

    switch (ev.kind) {
      case 'session_start':
        if (s.turn) this.close(s, 'interrupted', s.turn.lastEventAt);
        this.record(s, null, ev);
        return;
      case 'prompt_submit':
        if (s.turn) this.close(s, 'interrupted', s.turn.lastEventAt);
        this.open(s, ev);
        this.record(s, s.turn, ev);
        this.update(s, true);
        return;
      case 'stop':
        if (!s.turn) return;
        this.record(s, s.turn, ev);
        this.close(s, 'completed', ev.ts);
        return;
      case 'error':
        if (!s.turn) return;
        this.record(s, s.turn, ev);
        this.close(s, ev.reason === 'interrupted' ? 'interrupted' : 'errored', ev.ts);
        return;
      case 'session_end':
        if (s.turn) this.close(s, 'interrupted', s.turn.lastEventAt);
        return;
    }

    let t = s.turn;
    if (!t) t = this.maybeResume(s, ev, source);
    if (!t) return;
    t.lastEventAt = Math.max(t.lastEventAt, ev.ts);
    this.apply(t, ev);
    this.record(s, t, ev);
    this.update(s, true);
  }

  /**
   * Rebuild open live turns after a collector restart by replaying their
   * stored events. Turns older than the abandon window are closed instead.
   */
  restore(): number {
    const now = this.now();
    const rows = this.db.prepare(`SELECT * FROM turns WHERE finished_at IS NULL AND source = 'live' ORDER BY submitted_at`).all() as any[];
    const evStmt = this.db.prepare(`SELECT ts, kind, tool_name, meta_json FROM events WHERE turn_id = ? ORDER BY ts, id`);
    let restored = 0;
    for (const r of rows) {
      const events = evStmt.all(r.id) as { ts: number; kind: string; tool_name: string | null; meta_json: string | null }[];
      const lastTs = events.length ? events[events.length - 1].ts : r.submitted_at;
      const features = parseFeatures(r.features_json);
      if (!features || now - lastTs > ABANDON_MS) {
        finishTurn(this.db, r.id, { finishedAt: lastTs, activeMs: Math.max(0, lastTs - r.submitted_at - (r.idle_ms ?? 0)), idleMs: r.idle_ms ?? 0, outcome: 'interrupted', toolCalls: 0, todoTotal: 0 });
        continue;
      }
      const s = this.session({ agent: r.agent, sessionId: r.session_id, kind: 'session_start', ts: r.submitted_at, model: r.model, effort: r.effort, mode: r.mode });
      if (s.turn) this.close(s, 'interrupted', s.turn.lastEventAt);
      const prior = this.predictor.prior({ model: r.model, effort: r.effort, intent: features.prompt.intent }, features);
      const t: LiveTurn = {
        id: r.id, promptId: r.ext_id, trigger: (r.trigger ?? 'human') as Trigger, submittedAt: r.submitted_at, features, prior,
        initial: { p10: r.predicted_p10_ms ?? prior.dist.quantile(0.1), p50: r.predicted_p50_ms ?? prior.dist.quantile(0.5), p90: r.predicted_p90_ms ?? prior.dist.quantile(0.9) },
        idle: new IdleClock(), waitOwner: null, toolCalls: 0, subagentCalls: 0, toolHistory: [], todo: null,
        lastEventAt: lastTs, lastPredictionAt: 0, estimate: null, transcriptOffset: 0,
      };
      for (const e of events) {
        const meta = e.meta_json ? JSON.parse(e.meta_json) : {};
        const todo = meta.todo ? { kind: 'snapshot' as const, items: Array.from({ length: meta.todo.total }, (_, i) => ({ id: String(i), status: i < meta.todo.done ? 'completed' as const : 'pending' as const })) } : null;
        this.apply(t, {
          agent: r.agent, sessionId: r.session_id, kind: e.kind as any, ts: e.ts, toolName: e.tool_name,
          durationMs: meta.durationMs ?? null, reason: meta.reason ?? null, subagentId: meta.subagent ? 'sub' : null, todo,
        });
      }
      s.turn = t;
      s.lastEventAt = lastTs;
      s.source = 'hook';
      restored++;
      this.update(s, false);
    }
    return restored;
  }

  /** Periodic update: elapsed time moves the survival-conditioned estimate even without events. */
  tick(): void {
    const now = this.now();
    for (const s of this.sessions.values()) {
      const t = s.turn;
      if (!t) continue;
      const probe = this.probes[s.agent];
      if (probe && s.transcriptPath) {
        try {
          const r = probe(s.transcriptPath, t.transcriptOffset);
          t.transcriptOffset = r.offset;
          if (r.interruptedAt && r.interruptedAt >= t.submittedAt) {
            this.close(s, 'interrupted', Math.max(t.lastEventAt, r.interruptedAt));
            continue;
          }
        } catch (e) { logError('collector', 'probe failed', e); }
      }
      if (now - t.lastEventAt > ABANDON_MS) {
        this.close(s, 'interrupted', t.lastEventAt);
        continue;
      }
      this.update(s, false);
    }
  }

  // ---------------------------------------------------------------------------

  private session(ev: NormalizedEvent): SessionRec {
    let s = this.sessions.get(ev.sessionId);
    if (!s) {
      s = {
        id: ev.sessionId, agent: ev.agent, cwd: ev.cwd ?? null, model: normalizeModel(ev.model ?? null),
        effort: ev.effort ?? null, mode: ev.mode ?? null, transcriptPath: ev.transcriptPath ?? null,
        lastEventAt: ev.ts, source: null, turn: null, lastClosed: null, last: null,
      };
      this.sessions.set(ev.sessionId, s);
      upsertSession(this.db, { id: s.id, agent: s.agent, projectHash: hashPath(ev.cwd), model: s.model, startedAt: ev.ts });
    }
    return s;
  }

  private open(s: SessionRec, ev: NormalizedEvent, implicit: Trigger | null = null): LiveTurn {
    const ctx = this.contextFor(s);
    const stats = sessionTurnStats(this.db, s.id);
    const repo = repoInfoCached(s.cwd);
    const features = buildFeatures('', ev.ts, implicit ?? ev.trigger ?? 'human', {
      model: ctx.model, effort: ctx.effort, mode: s.mode, contextPct: ev.contextPct ?? ctx.contextPct,
      turnIndex: stats.count, recentActiveMs: stats.recentActive, repoFiles: repo?.files ?? null, repoLanguage: repo?.language ?? null,
    });
    if (ev.promptFeatures) features.prompt = ev.promptFeatures;
    else if (implicit) features.prompt.intent = 'other';

    const key: BucketKey = { model: features.session.model, effort: features.session.effort, intent: features.prompt.intent };
    const prior = this.predictor.prior(key, features);
    const initial: Prediction = { p10: prior.dist.quantile(0.1), p50: prior.dist.quantile(0.5), p90: prior.dist.quantile(0.9) };
    const baseId = ev.promptId ?? `live-${ev.ts}`;
    // A reused prompt id gets the same #2, #3 suffix backfill gives it, so the two stay deduplicated.
    let id: number | null = null;
    for (let n = 1; id === null && n < 50; n++) {
      id = insertTurn(this.db, {
        sessionId: s.id, agent: s.agent, extId: n === 1 ? baseId : `${baseId}#${n}`, submittedAt: ev.ts,
        model: features.session.model, effort: features.session.effort, mode: features.session.mode,
        contextPct: features.session.contextPct, features, prediction: initial, predictor: this.predictor.version, source: 'live',
      });
    }
    if (id === null) throw new Error(`could not allocate a turn id for ${baseId}`);

    const t: LiveTurn = {
      id, promptId: ev.promptId ?? null, trigger: features.trigger, submittedAt: ev.ts, features, prior, initial,
      idle: new IdleClock(), waitOwner: null, toolCalls: 0, subagentCalls: 0, toolHistory: [], todo: null,
      lastEventAt: ev.ts, lastPredictionAt: 0, estimate: null, transcriptOffset: fileSize(s.transcriptPath),
    };
    s.turn = t;
    if (!repo && s.cwd) this.fillRepoLater(t, s.cwd);
    return t;
  }

  /** Repo scan can take a moment on first sight of a repo; do it after the first estimate is out. */
  private fillRepoLater(t: LiveTurn, cwd: string): void {
    setTimeout(() => {
      try {
        const info = repoInfo(cwd);
        repoCacheMem.set(cwd, info);
        t.features.repo = { files: info.files, language: info.language };
        updateFeatures(this.db, t.id, t.features);
      } catch (e) { logError('collector', 'repo scan failed', e); }
    }, 50);
  }

  /** A tool event with no open turn: a stop hook continuation, or an agent-initiated turn. */
  private maybeResume(s: SessionRec, ev: NormalizedEvent, source: string): LiveTurn | null {
    const lc = s.lastClosed;
    if (ev.subagentId) return null; // background subagents finishing after the turn ended
    if (ev.kind !== 'tool_start' && ev.kind !== 'waiting_user') return null;
    if (lc && lc.outcome === 'completed' && ev.ts - lc.closedAt < REOPEN_WINDOW_MS
      && (ev.promptId ? ev.promptId === lc.promptId : ev.ts - lc.closedAt < IMPLICIT_GAP_MS)) {
      reopenTurn(this.db, lc.turnId);
      s.turn = lc.turn;
      s.lastClosed = null;
      return s.turn;
    }
    if (lc && ev.promptId && ev.promptId === lc.promptId) return null;
    if (!s.source) s.source = source;
    const t = this.open(s, { ...ev, promptFeatures: null }, 'notification');
    this.record(s, t, { ...ev, kind: 'prompt_submit', toolName: null });
    return t;
  }

  private apply(t: LiveTurn, ev: NormalizedEvent): void {
    const owner = ev.subagentId ?? 'main';
    const endIfOwner = (ts: number) => {
      if (t.idle.waiting && (t.waitOwner === owner || t.waitOwner === null)) { t.idle.endWait(ts); t.waitOwner = null; }
    };
    switch (ev.kind) {
      case 'tool_start': {
        endIfOwner(ev.ts);
        if (!ev.subagentId) {
          t.toolCalls++;
          t.toolHistory.push(toolCategory(ev.toolName));
          if (t.toolHistory.length > 200) t.toolHistory.shift();
        } else if (samePrompt(ev.promptId, t.promptId)) {
          // A background subagent from an earlier prompt is not this turn's work.
          t.subagentCalls++;
        }
        if (ev.toolName && QUESTION_TOOLS.test(ev.toolName)) {
          t.idle.startWait(ev.ts, 'question');
          t.waitOwner = owner;
        }
        break;
      }
      case 'tool_end': {
        if (t.idle.waiting && (t.waitOwner === owner || t.waitOwner === null)) {
          // A permission wait ends when the user answers; the tool then runs for duration_ms.
          const end = t.idle.reason !== 'question' && ev.durationMs ? Math.max(t.idle.waitingSince!, ev.ts - ev.durationMs) : ev.ts;
          t.idle.endWait(end);
          t.waitOwner = null;
        }
        break;
      }
      case 'waiting_user':
        t.idle.startWait(ev.ts, ev.reason ?? 'waiting');
        if (t.waitOwner === null) t.waitOwner = owner;
        break;
      case 'resumed':
        if (t.idle.waiting) { t.idle.endWait(ev.ts); t.waitOwner = null; }
        break;
      default:
        break;
    }
    if (ev.todo) {
      if (!t.todo) t.todo = new TodoState();
      t.todo.apply(ev.todo, this.elapsed(t, ev.ts));
    }
  }

  private record(s: SessionRec, t: LiveTurn | null, ev: NormalizedEvent): void {
    // Background subagents from an earlier prompt are not part of this turn's record.
    if (t && ev.subagentId && !samePrompt(ev.promptId, t.promptId)) return;
    const meta: Record<string, unknown> = {};
    if (ev.toolUseId) meta.toolUseId = ev.toolUseId;
    if (ev.durationMs != null) meta.durationMs = ev.durationMs;
    if (ev.reason) meta.reason = ev.reason;
    if (ev.subagentId) meta.subagent = true;
    if (ev.todo && t?.todo) meta.todo = { done: t.todo.done, total: t.todo.total };
    try {
      insertEvent(this.db, t?.id ?? null, { ts: ev.ts, kind: ev.kind, toolName: ev.toolName ?? null, meta: Object.keys(meta).length ? meta : null });
    } catch (e) { logError('collector', `event insert failed for ${s.id}`, e); }
  }

  /** Tool calls that count as work for the activity signal. */
  private work(t: LiveTurn): number {
    return t.toolCalls + (this.countSubagentWork ? t.subagentCalls : 0);
  }

  private elapsed(t: LiveTurn, at: number): number {
    return Math.max(0, at - t.submittedAt - t.idle.total(at));
  }

  private update(s: SessionRec, fromEvent: boolean): void {
    const t = s.turn;
    if (!t) return;
    const now = Math.max(this.now(), t.lastEventAt);
    try {
      t.estimate = estimateRemaining({
        elapsedMs: this.elapsed(t, now),
        prior: t.prior.dist,
        toolCalls: this.work(t),
        toolHistory: t.toolHistory,
        todo: t.todo,
        perTaskPriorMs: t.prior.perTaskMs,
        bucketCalls: t.prior.calls,
      });
    } catch (e) {
      logError('collector', 'estimate failed', e);
      return;
    }
    if (fromEvent || now - t.lastPredictionAt >= this.predictionEveryMs) {
      t.lastPredictionAt = now;
      insertPrediction(this.db, t.id, now, t.estimate.elapsedMs, t.estimate.p50RemainingMs, t.estimate.p90RemainingMs, t.estimate.weights);
    }
    this.emit(s, now);
  }

  private close(s: SessionRec, outcome: Outcome, at: number): void {
    const t = s.turn;
    if (!t) return;
    const finishedAt = Math.max(at, t.submittedAt);
    if (t.idle.waiting) t.idle.endWait(finishedAt);
    this.fillSessionFeatures(s, t);
    const active = activeMs(t.submittedAt, finishedAt, t.idle.idleMs);
    finishTurn(this.db, t.id, {
      finishedAt, activeMs: active, idleMs: t.idle.idleMs, outcome,
      toolCalls: t.toolCalls, subagentToolCalls: t.subagentCalls, todoTotal: t.todo?.total ?? 0,
    });
    if (isTrainable({ outcome, active_ms: active, trigger: t.trigger })) {
      this.predictor.add({
        model: t.features.session.model, effort: t.features.session.effort, intent: t.features.prompt.intent,
        activeMs: active, toolCalls: this.work(t), todoTotal: t.todo?.total ?? 0,
      });
    }
    s.last = {
      finishedAt, actualMs: active, p50Ms: t.initial.p50, p90Ms: t.initial.p90, outcome, intent: t.features.prompt.intent,
    };
    s.lastClosed = { turnId: t.id, promptId: t.promptId, closedAt: finishedAt, outcome, turn: t };
    s.turn = null;
    this.refreshHistory();
    this.emit(s, this.now());
  }

  /**
   * Model and effort are not in every hook payload (UserPromptSubmit has
   * neither). If they were unknown at submit, record them once later events or
   * the transcript reveal them, so the turn trains the right bucket.
   */
  private fillSessionFeatures(s: SessionRec, t: LiveTurn): void {
    const f = t.features.session;
    if (f.model && f.effort) return;
    const model = f.model ?? normalizeModel(s.model ?? sniffModel(s.transcriptPath));
    const effort = f.effort ?? s.effort;
    if (model === f.model && effort === f.effort) return;
    f.model = model;
    f.effort = effort;
    try {
      this.db.prepare(`UPDATE turns SET model = ?, effort = ?, features_json = ? WHERE id = ?`).run(model, effort, JSON.stringify(t.features), t.id);
    } catch (e) { logError('collector', 'feature patch failed', e); }
  }

  private refreshHistory(): void {
    try {
      this.history = recentFinished(this.db, 10).map((r) => ({
        finishedAt: r.finished_at!, actualMs: r.active_ms ?? 0, p50Ms: r.predicted_p50_ms, p90Ms: r.predicted_p90_ms,
        intent: parseFeatures(r.features_json)?.prompt.intent ?? 'other', outcome: r.outcome ?? 'completed',
      }));
    } catch (e) { logError('collector', 'history failed', e); }
  }

  /** Build and write the state file for a session. */
  stateFor(s: SessionRec, now: number): LiveState {
    const t = s.turn;
    const est = t?.estimate;
    return {
      v: 1,
      agent: s.agent,
      sessionId: s.id,
      project: s.cwd ? basename(s.cwd) : null,
      status: t ? (t.idle.waiting ? 'waiting' : 'running') : s.last ? 'done' : 'idle',
      updatedAt: now,
      turn: t && est ? {
        submittedAt: t.submittedAt,
        elapsedMs: est.elapsedMs,
        idleMs: t.idle.total(now),
        intent: t.features.prompt.intent,
        p10RemainingMs: est.p10RemainingMs,
        p50RemainingMs: est.p50RemainingMs,
        p90RemainingMs: est.p90RemainingMs,
        p50TotalMs: t.initial.p50,
        p90TotalMs: t.initial.p90,
        overrun: est.elapsedMs > t.initial.p90,
        todo: t.todo && t.todo.total > 0 ? { done: t.todo.done, total: t.todo.total } : null,
        toolCalls: t.toolCalls,
        subagentToolCalls: t.subagentCalls,
        waitingSince: t.idle.waitingSince,
        waitingReason: t.idle.reason,
        weights: est.weights,
        bucket: { level: t.prior.level, n: t.prior.n },
      } : null,
      last: s.last,
      history: this.history,
    };
  }

  private emit(s: SessionRec, now: number): void {
    if (!this.writeStates) return;
    try {
      writeState(this.stateFor(s, now), this.currentSession === s.id || this.currentSession === null);
    } catch (e) { logError('collector', 'state write failed', e); }
  }

  /** Inspect a session (used by `tminus status` and tests). */
  snapshot(sessionId: string): LiveState | null {
    const s = this.sessions.get(sessionId);
    return s ? this.stateFor(s, this.now()) : null;
  }

  private contextFor(s: SessionRec): { model: string | null; effort: string | null; contextPct: number | null } {
    let ctx: SessionContextFile | null = null;
    try { ctx = JSON.parse(readFileSync(contextFile(s.id), 'utf8')); } catch { /* statusline not installed */ }
    const fresh = ctx && this.now() - ctx.ts < 6 * 60 * 60 * 1000 ? ctx : null;
    const model = normalizeModel(fresh?.model ?? s.model ?? sniffModel(s.transcriptPath));
    if (model && !s.model) s.model = model;
    return { model, effort: s.effort ?? fresh?.effort ?? null, contextPct: fresh?.contextPct ?? null };
  }
}

const repoCacheMem = new Map<string, { files: number | null; language: string | null }>();
/** Only returns a repo scan already done by this process; otherwise null (filled in after the first estimate). */
function repoInfoCached(cwd: string | null): { files: number | null; language: string | null } | null {
  return cwd ? repoCacheMem.get(cwd) ?? null : null;
}

/** Does a subagent event belong to this turn? Prompt ids may carry a #n suffix for reused ids. */
export function samePrompt(eventPrompt: string | null | undefined, turnPrompt: string | null): boolean {
  if (!eventPrompt || !turnPrompt) return true;
  return eventPrompt === turnPrompt.replace(/#\d+$/, '');
}

function fileSize(p: string | null): number {
  if (!p) return 0;
  try { return statSync(p).size; } catch { return 0; }
}

/** Last model id mentioned in the tail of a transcript. */
export function sniffModel(path: string | null): string | null {
  if (!path) return null;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const matches = [...buf.toString('utf8').matchAll(/"model"\s*:\s*"([^"<][^"]{1,80})"/g)];
      return matches.length ? matches[matches.length - 1][1] : null;
    } finally { closeSync(fd); }
  } catch { return null; }
}

export { TRAINABLE_TRIGGERS };
