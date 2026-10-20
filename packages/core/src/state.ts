import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './paths.ts';

/**
 * The state file is the only thing renderers read. It is written atomically
 * (temp file + rename) by the collector, so a reader never sees a torn write.
 */
export interface LiveState {
  v: 1;
  agent: string;
  sessionId: string;
  project: string | null;
  status: 'running' | 'waiting' | 'done' | 'idle';
  updatedAt: number;
  turn: null | {
    submittedAt: number;
    elapsedMs: number;
    idleMs: number;
    intent: string;
    p10RemainingMs: number;
    p50RemainingMs: number;
    p90RemainingMs: number;
    /** Prediction made at submit time (total duration). */
    p50TotalMs: number;
    p90TotalMs: number;
    overrun: boolean;
    todo: { done: number; total: number } | null;
    toolCalls: number;
    /** Tool calls made inside subagents this turn (absent in older state files). */
    subagentToolCalls?: number;
    waitingSince: number | null;
    waitingReason: string | null;
    weights: { prior: number; todo: number; activity: number; learned?: number };
    bucket: { level: string; n: number };
  };
  last: null | {
    finishedAt: number;
    actualMs: number;
    p50Ms: number | null;
    p90Ms: number | null;
    outcome: string;
    intent: string;
  };
  /** Last 10 turns, newest first (for the menubar). */
  history: { finishedAt: number; actualMs: number; p50Ms: number | null; p90Ms: number | null; intent: string; outcome: string }[];
}

export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

export function writeState(state: LiveState, makeCurrent = true): void {
  writeJsonAtomic(paths.sessionState(state.sessionId), state);
  if (makeCurrent) writeJsonAtomic(paths.current, state);
}

export function readState(file: string): LiveState | null {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return s && s.v === 1 ? (s as LiveState) : null;
  } catch {
    return null;
  }
}

/** Context snapshot the statusline leaves for the collector (model, effort, context %). */
export interface SessionContextFile {
  ts: number;
  model: string | null;
  effort: string | null;
  contextPct: number | null;
}

export function contextFile(sessionId: string): string {
  return paths.sessionState(sessionId).replace(/\.json$/, '.ctx.json');
}
