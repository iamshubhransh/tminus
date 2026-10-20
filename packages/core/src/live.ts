import { LogMixture } from './dist.ts';
import { clamp, Z90 } from './stats.ts';
import type { TodoChange, TodoStatus } from './types.ts';

/** Tools that mostly change files (edit-heavy phase = late in the task). */
const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch|str_replace\w*|create_file|write_file|edit_file)$/i;
/** Tools that mostly gather context (read-heavy phase = early). */
const READ_TOOLS = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch|view|read_file|list_dir|search|grep|find|ImageView|view_image)$/i;
/** Tools whose duration is time spent waiting for the human. */
export const QUESTION_TOOLS = /^(AskUserQuestion|ExitPlanMode|request_user_input(_async)?)$/;

export type ToolCategory = 'edit' | 'read' | 'other';
export function toolCategory(name: string | null | undefined): ToolCategory {
  if (!name) return 'other';
  if (EDIT_TOOLS.test(name)) return 'edit';
  if (READ_TOOLS.test(name)) return 'read';
  return 'other';
}

/** Todo list state reconstructed from snapshots (TodoWrite, update_plan) or upserts (TaskCreate/TaskUpdate). */
export class TodoState {
  items = new Map<string, TodoStatus>();
  /** Active elapsed ms when the list first appeared. */
  startedAtActive: number | null = null;
  /** Active elapsed ms at each completion, in order. */
  completions: number[] = [];

  apply(change: TodoChange, activeElapsed: number): void {
    const before = this.done;
    if (change.kind === 'snapshot') {
      this.items = new Map(change.items.map((i) => [i.id, i.status]));
    } else {
      this.items.set(change.id, change.status);
    }
    if (this.startedAtActive === null && this.total > 0) this.startedAtActive = activeElapsed;
    const after = this.done;
    for (let i = before; i < after; i++) this.completions.push(activeElapsed);
    if (after < before) this.completions.length = after;
  }

  get total(): number {
    let n = 0;
    for (const s of this.items.values()) if (s !== 'deleted') n++;
    return n;
  }

  get done(): number {
    let n = 0;
    for (const s of this.items.values()) if (s === 'completed') n++;
    return n;
  }

  get inProgress(): number {
    let n = 0;
    for (const s of this.items.values()) if (s === 'in_progress') n++;
    return n;
  }
}

export interface LiveInput {
  /** Active (non-idle) time elapsed so far, ms. */
  elapsedMs: number;
  prior: LogMixture;
  toolCalls: number;
  /** Tool categories in call order. */
  toolHistory: ToolCategory[];
  todo: TodoState | null;
  /** Prior per-todo-item time before any item completes. */
  perTaskPriorMs: number;
  /** Sorted total tool calls of completed turns in this bucket. */
  bucketCalls: number[];
}

export interface Signal { p10: number; p50: number; p90: number }
export interface LiveEstimate {
  elapsedMs: number;
  p10RemainingMs: number;
  p50RemainingMs: number;
  p90RemainingMs: number;
  weights: { prior: number; todo: number; activity: number };
  signals: { prior: Signal; todo: Signal | null; activity: Signal | null };
}

const MIN_REMAINING_MS = 1_000;

/** 1. Survival-conditioned prior: quantiles of (T - t | T > t). */
export function priorSignal(prior: LogMixture, elapsedMs: number): Signal {
  return {
    p10: prior.remainingQuantile(elapsedMs, 0.1),
    p50: prior.remainingQuantile(elapsedMs, 0.5),
    p90: prior.remainingQuantile(elapsedMs, 0.9),
  };
}

const TASK_SD = 0.8;

/**
 * 2. Todo progress: remaining ≈ (total - done) × time per task. The current task
 * is survival-conditioned on how long it has already been running, so the
 * estimate keeps moving between completions instead of freezing.
 */
export function todoSignal(todo: TodoState, elapsedMs: number, perTaskPriorMs: number): Signal | null {
  const total = todo.total;
  if (total < 1 || todo.startedAtActive === null) return null;
  const done = todo.done;
  const lastMark = todo.completions.length ? todo.completions[todo.completions.length - 1] : todo.startedAtActive;
  let perTask = perTaskPriorMs;
  if (done >= 1) {
    const measured = (lastMark - todo.startedAtActive) / done;
    // Blend measured pace with the prior; trust the measurement more as it accumulates.
    perTask = Math.exp((done * Math.log(Math.max(measured, 2_000)) + Math.log(perTaskPriorMs)) / (done + 1));
  }
  const sinceLast = Math.max(0, elapsedMs - lastMark);
  const left = total - done;
  if (left <= 0) {
    // Everything ticked off: the agent is wrapping up (summary, final checks).
    const wrap = LogMixture.lognormal(Math.log(20_000), 0.9);
    return { p10: wrap.remainingQuantile(sinceLast, 0.1), p50: wrap.remainingQuantile(sinceLast, 0.5), p90: wrap.remainingQuantile(sinceLast, 0.9) };
  }
  const current = LogMixture.lognormal(Math.log(perTask), TASK_SD);
  const rest = left - 1;
  // Sum of iid log-normals for untouched tasks: moment-matched normal.
  const m = perTask * Math.exp(TASK_SD ** 2 / 2);
  const v = perTask ** 2 * Math.exp(TASK_SD ** 2) * (Math.exp(TASK_SD ** 2) - 1);
  const restMean = rest * m;
  const restSd = Math.sqrt(rest * v);
  return {
    p10: current.remainingQuantile(sinceLast, 0.1) + Math.max(rest * perTask * 0.6, restMean - Z90 * restSd),
    p50: current.remainingQuantile(sinceLast, 0.5) + rest * perTask,
    p90: current.remainingQuantile(sinceLast, 0.9) + restMean + Z90 * restSd,
  };
}

/**
 * 3. Activity rate: how far through the turn are we, judged by tool calls so far
 * against this bucket's typical total, nudged later when the recent mix shifts
 * from reading to editing.
 */
export function activitySignal(input: LiveInput): Signal | null {
  const n = input.toolCalls;
  if (n < 3 || input.elapsedMs < 5_000) return null;
  const calls = input.bucketCalls;
  let expectedTotal: number;
  const above = calls.filter((c) => c >= n);
  if (above.length >= 3) expectedTotal = above[Math.floor(above.length / 2)];
  else expectedTotal = n * 1.3 + 2;
  expectedTotal = Math.max(expectedTotal, n + 1);
  let f = n / expectedTotal;

  const hist = input.toolHistory;
  if (hist.length >= 6) {
    const recent = hist.slice(-8);
    const share = (xs: ToolCategory[]) => xs.filter((c) => c === 'edit').length / Math.max(1, xs.filter((c) => c !== 'other').length || xs.length);
    const shift = share(recent) - share(hist);
    f += 0.25 * shift;
  }
  f = clamp(f, 0.05, 0.95);
  const p50 = input.elapsedMs * (1 - f) / f;
  const sd = calls.length >= 8 ? 0.7 : 0.9;
  return { p10: p50 * Math.exp(-Z90 * sd), p50, p90: p50 * Math.exp(Z90 * sd) };
}

/**
 * Blend the signals in log space. The prior's weight decays as evidence
 * arrives; the todo weight rises with completed items; P90 is inflated by
 * the disagreement between signals.
 */
export function estimateRemaining(input: LiveInput): LiveEstimate {
  const prior = priorSignal(input.prior, input.elapsedMs);
  const todo = input.todo ? todoSignal(input.todo, input.elapsedMs, input.perTaskPriorMs) : null;
  const activity = activitySignal(input);

  const done = input.todo?.done ?? 0;
  let wPrior = 1 / (1 + 0.4 * done + 0.03 * input.toolCalls);
  let wTodo = todo ? 1.5 * (done + 0.3) / (done + 1.3) : 0;
  let wAct = activity ? (input.bucketCalls.length >= 8 ? 0.35 : 0.15) * Math.min(1, input.toolCalls / 12) : 0;
  const sum = wPrior + wTodo + wAct;
  wPrior /= sum; wTodo /= sum; wAct /= sum;

  const parts: [number, Signal][] = [[wPrior, prior]];
  if (todo) parts.push([wTodo, todo]);
  if (activity) parts.push([wAct, activity]);

  const lg = (x: number) => Math.log(Math.max(x, MIN_REMAINING_MS));
  const wavg = (pick: (s: Signal) => number) => parts.reduce((s, [w, sig]) => s + w * lg(pick(sig)), 0);
  const l50 = wavg((s) => s.p50);
  const spread = Math.sqrt(parts.reduce((s, [w, sig]) => s + w * (lg(sig.p50) - l50) ** 2, 0));
  const l90 = wavg((s) => s.p90) + Z90 * spread;
  const l10 = wavg((s) => s.p10) - Z90 * spread;

  const p50 = Math.exp(l50);
  return {
    elapsedMs: input.elapsedMs,
    p10RemainingMs: Math.min(Math.exp(l10), p50 * 0.9),
    p50RemainingMs: p50,
    p90RemainingMs: Math.max(Math.exp(l90), p50 * 1.1),
    weights: { prior: wPrior, todo: wTodo, activity: wAct },
    signals: { prior, todo, activity },
  };
}
