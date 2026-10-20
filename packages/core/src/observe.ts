import { QUESTION_TOOLS, toolCategory, type ToolCategory } from './live.ts';
import { IdleClock } from './timing.ts';

/**
 * What can be observed about a running turn at a given moment: tool activity,
 * its timing, and phase labels. One tracker is shared by the live engine and
 * by training/replay, so the learned live model sees identical features in
 * both places.
 */
export interface Obs {
  /** Active (non-idle) ms since submit. */
  elapsedMs: number;
  toolCalls: number;
  subCalls: number;
  edits: number;
  /** Tool categories in call order (main thread). */
  history: ToolCategory[];
  distinctTools: number;
  lastTool: string | null;
  /** Active ms since the last main-thread tool start or end (or since submit). */
  sinceEvent: number;
  /** Main-thread tools started and not yet finished. */
  running: number;
  runningFor: number;
  compactions: number;
  waits: number;
  /** Phase label counts so far. */
  phase: Record<string, number>;
  lastCmd: string | null;
  lastText: string[] | null;
  sinceText: number;
}

export class ObsTracker {
  toolCalls = 0;
  subCalls = 0;
  edits = 0;
  compactions = 0;
  waits = 0;
  history: ToolCategory[] = [];
  private names = new Set<string>();
  lastTool: string | null = null;
  private lastEvent = 0;
  private open: number[] = [];
  phase: Record<string, number> = {};
  lastCmd: string | null = null;
  lastText: string[] | null = null;
  private lastTextAt = 0;

  toolStart(name: string | null | undefined, at: number, subagent = false): void {
    if (subagent) { this.subCalls++; return; }
    this.toolCalls++;
    const cat = toolCategory(name);
    this.history.push(cat);
    if (this.history.length > 400) this.history.shift();
    if (cat === 'edit') this.edits++;
    const n = name ?? '?';
    this.names.add(n);
    this.lastTool = n;
    this.lastEvent = at;
    this.open.push(at);
  }

  toolEnd(at: number, subagent = false): void {
    if (subagent) return;
    this.lastEvent = at;
    this.open.shift();
  }

  waiting(): void { this.waits++; }
  compact(): void { this.compactions++; }

  phaseLabels(labels: string[], at: number): void {
    for (const c of labels) this.phase[c] = (this.phase[c] ?? 0) + 1;
    const cmd = labels.find((c) => c.startsWith('cmd:'));
    if (cmd) this.lastCmd = cmd;
    if (labels.includes('text')) { this.lastText = labels; this.lastTextAt = at; }
  }

  snapshot(elapsedMs: number): Obs {
    return {
      elapsedMs, toolCalls: this.toolCalls, subCalls: this.subCalls, edits: this.edits, history: this.history,
      distinctTools: this.names.size, lastTool: this.lastTool, sinceEvent: Math.max(0, elapsedMs - this.lastEvent),
      running: this.open.length, runningFor: this.open.length ? Math.max(0, elapsedMs - this.open[0]) : 0,
      compactions: this.compactions, waits: this.waits, phase: this.phase, lastCmd: this.lastCmd, lastText: this.lastText,
      sinceText: Math.max(0, elapsedMs - this.lastTextAt),
    };
  }
}

export interface ReplayEvent { ts: number; kind: string; toolName?: string | null; meta?: any }

/**
 * Replay a finished turn's stored events and return what was observable at
 * each active-elapsed time in `points` (ascending). Idle time (waiting on the
 * user) is excluded the same way the engine excludes it.
 */
export function replayObs(events: ReplayEvent[], submittedAt: number, points: number[]): Obs[] {
  const idle = new IdleClock();
  const tr = new ObsTracker();
  const elapsedAt = (ts: number) => Math.max(0, ts - submittedAt - idle.total(ts));
  const out: Obs[] = [];
  let i = 0;
  for (const target of points) {
    while (i < events.length && elapsedAt(events[i].ts) <= target) {
      const e = events[i++];
      const meta = e.meta ?? null;
      switch (e.kind) {
        case 'tool_start':
          if (meta?.subagent) { tr.toolStart(e.toolName, 0, true); break; }
          if (idle.waiting && idle.reason !== 'question') idle.endWait(e.ts);
          tr.toolStart(e.toolName, elapsedAt(e.ts));
          if (e.toolName && QUESTION_TOOLS.test(e.toolName)) idle.startWait(e.ts, 'question');
          break;
        case 'tool_end':
          if (idle.waiting) idle.endWait(e.ts);
          tr.toolEnd(elapsedAt(e.ts), !!meta?.subagent);
          break;
        case 'resumed':
          if (idle.waiting) idle.endWait(e.ts);
          break;
        case 'waiting_user':
          tr.waiting();
          idle.startWait(e.ts, meta?.reason ?? 'waiting');
          break;
        case 'compact':
          tr.compact();
          break;
        case 'phase':
          if (Array.isArray(meta?.c)) tr.phaseLabels(meta.c, elapsedAt(e.ts));
          break;
      }
    }
    // Copy the mutable parts so each snapshot stays as it was.
    const s = tr.snapshot(target);
    out.push({ ...s, history: [...s.history], phase: { ...s.phase } });
  }
  return out;
}

/** Events from DB rows (meta_json parsed). */
export function eventsFromRows(rows: { ts: number; kind: string; tool_name: string | null; meta_json: string | null }[]): ReplayEvent[] {
  return rows.map((r) => {
    let meta: any = null;
    if (r.meta_json) { try { meta = JSON.parse(r.meta_json); } catch { /* ignore */ } }
    return { ts: r.ts, kind: r.kind, toolName: r.tool_name, meta };
  });
}
