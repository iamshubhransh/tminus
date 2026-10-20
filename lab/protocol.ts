/**
 * Evaluation protocol for the lab.
 *
 * Prequential, like production: turns are scored in time order, each by a
 * model trained only on turns that finished before it was submitted, and the
 * model is retrained every `every` turns (the collector retrains every 25).
 * The last 20% of turns is a holdout that is only scored once, at the end.
 */
import { LogMixture, IdleClock, QUESTION_TOOLS, TodoState, toolCategory, type ToolCategory } from '@tminus/core';
import type { LabTurn } from './data.ts';
import { mulberry32 } from './gbdt.ts';

// ---------------------------------------------------------------------------
// History features: computed from turns that finished before this one started.

export type Hist = Record<string, number>;

export function buildHistory(turns: LabTurn[]): Map<string, Hist> {
  const out = new Map<string, Hist>();
  const byFinish = [...turns].sort((a, b) => a.finishedAt - b.finishedAt);
  // Running aggregates, advanced as turns finish.
  type Agg = { n: number; sum: number; ys: number[]; last: LabTurn[]; first: number };
  const sess = new Map<string, Agg>();
  const proj = new Map<string, Agg>();
  const agentRecent = new Map<string, number[]>();
  const recent: number[] = [];
  const recentTs: number[] = [];
  let fi = 0;
  const add = (m: Map<string, Agg>, k: string | null, t: LabTurn) => {
    if (!k) return;
    let a = m.get(k);
    if (!a) { a = { n: 0, sum: 0, ys: [], last: [], first: t.submittedAt }; m.set(k, a); }
    a.last.push(t);
    if (a.last.length > 5) a.last.shift();
    if (t.trainable) { a.n++; a.sum += t.y; a.ys.push(t.y); }
  };
  const ordered = [...turns].sort((a, b) => a.submittedAt - b.submittedAt);
  const doneTrainable: LabTurn[] = [];
  const sessionFirst = new Map<string, number>();
  const sessionCount = new Map<string, number>();
  for (const t of ordered) {
    while (fi < byFinish.length && byFinish[fi].finishedAt < t.submittedAt) {
      const d = byFinish[fi++];
      add(sess, d.sessionId, d);
      add(proj, d.project, d);
      if (d.trainable) doneTrainable.push(d);
      if (d.trainable) {
        recent.push(d.y); recentTs.push(d.finishedAt);
        if (recent.length > 30) { recent.shift(); recentTs.shift(); }
        const ar = agentRecent.get(d.agent) ?? [];
        ar.push(d.y); if (ar.length > 30) ar.shift();
        agentRecent.set(d.agent, ar);
      }
    }
    if (!sessionFirst.has(t.sessionId)) sessionFirst.set(t.sessionId, t.submittedAt);
    const sc = sessionCount.get(t.sessionId) ?? 0;
    sessionCount.set(t.sessionId, sc + 1);
    const s = sess.get(t.sessionId);
    const p = t.project ? proj.get(t.project) : undefined;
    const lastT = s?.last[s.last.length - 1];
    const lastDone = s ? [...s.last].reverse().find((x) => x.trainable) : undefined;
    const prevDone = s ? [...s.last].reverse().filter((x) => x.trainable)[1] : undefined;
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : -1);
    const med = (xs: number[]) => { if (!xs.length) return -1; const s2 = [...xs].sort((a, b) => a - b); return s2[s2.length >> 1]; };
    const ar = agentRecent.get(t.agent) ?? [];
    // Most similar earlier prompts (Jaccard over hashed word/bigram sets).
    const mine = new Set(t.tokens);
    const sims: { s: number; y: number }[] = [];
    if (mine.size) {
      for (const u of doneTrainable) {
        if (!u.tokens.length) continue;
        let inter = 0;
        for (const k of u.tokens) if (mine.has(k)) inter++;
        const s = inter / (mine.size + u.tokens.length - inter);
        if (s > 0.15) sims.push({ s, y: u.y });
      }
      sims.sort((a, b) => b.s - a.s);
    }
    const top = sims.slice(0, 5);
    const wsum = top.reduce((a, x) => a + x.s, 0);
    out.set(t.key, {
      k_mean: top.length ? top.reduce((a, x) => a + x.s * x.y, 0) / wsum : -1,
      k_max: top.length ? top[0].s : 0,
      k_n: top.length,
      k_y1: top.length ? top[0].y : -1,
      s_prev: sc,
      s_done: s?.n ?? 0,
      s_mean: s && s.n ? s.sum / s.n : -1,
      s_last: lastDone ? lastDone.y : -1,
      s_last2: prevDone ? prevDone.y : -1,
      s_last_calls: lastT ? Math.log1p(lastT.toolCalls + lastT.subagentToolCalls) : -1,
      s_last_gap: lastT ? Math.log1p(Math.max(0, t.submittedAt - lastT.finishedAt) / 1000) : -1,
      s_last_interrupted: lastT ? +(lastT.outcome !== 'completed') : -1,
      s_last_system: lastT ? +(lastT.trigger === 'system' || lastT.trigger === 'notification') : -1,
      s_age: Math.log1p((t.submittedAt - (sessionFirst.get(t.sessionId) ?? t.submittedAt)) / 60000),
      pr_n: p?.n ?? 0,
      pr_mean: p && p.n ? p.sum / p.n : -1,
      pr_med: p ? med(p.ys.slice(-60)) : -1,
      g_recent: mean(recent.slice(-20)),
      g_recent_n: recent.length,
      a_recent: mean(ar.slice(-20)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidates

export interface Fitted {
  /** Submit-time predictive distribution of active ms (LogMixture is in log space). */
  predict(t: LabTurn): LogMixture;
  /** Optional live estimator: quantiles of remaining active ms at elapsed `obs.elapsedMs`. */
  live?(t: LabTurn, prior: LogMixture, obs: Obs): { p10: number; p50: number; p90: number };
}

export interface Candidate {
  name: string;
  fit(train: LabTurn[], ctx: Ctx): Fitted;
}

export interface Ctx {
  hist: Map<string, Hist>;
  /** All turns (any outcome) — for history lookups inside candidates. */
  all: LabTurn[];
}

// ---------------------------------------------------------------------------
// Submit-time scoring

export interface Row {
  key: string;
  session: string;
  agent: string;
  y: number;
  q10: number;
  q50: number;
  q90: number;
}

const pin = (y: number, q: number, a: number) => (y >= q ? a * (y - q) : (1 - a) * (q - y));

export interface Summary {
  n: number;
  mdae: number;
  mae: number;
  qs: number;
  cov80: number;
  under90: number;
  over10: number;
  width: number;
}

export function rowLoss(r: Row): number {
  return (pin(r.y, r.q10, 0.1) + pin(r.y, r.q50, 0.5) + pin(r.y, r.q90, 0.9)) / 3;
}

export function summarize(rows: Row[]): Summary {
  const errs = rows.map((r) => Math.abs(r.y - r.q50)).sort((a, b) => a - b);
  const n = rows.length;
  let qs = 0, cov = 0, u90 = 0, o10 = 0, width = 0;
  for (const r of rows) {
    qs += rowLoss(r);
    if (r.y >= r.q10 && r.y <= r.q90) cov++;
    if (r.y <= r.q90) u90++;
    if (r.y >= r.q10) o10++;
    width += r.q90 - r.q10;
  }
  return {
    n, mdae: errs[n >> 1] ?? NaN, mae: errs.reduce((a, b) => a + b, 0) / n, qs: qs / n,
    cov80: cov / n, under90: u90 / n, over10: o10 / n, width: width / n,
  };
}

export interface RunResult {
  name: string;
  rows: Row[];
  dists: Map<string, LogMixture>;
  fits: { from: number; fitted: Fitted }[];
}

export interface RunOpts {
  split: 'dev' | 'holdout' | 'all';
  /** Only score these triggers (training still uses every trainable turn). */
  score?: string[];
  /** Simulate a short history: train on at most this many of the most recent turns. */
  maxTrain?: number;
  /** Trainable turns before the first scored one (dev split). */
  minTrain?: number;
  every?: number;
  holdoutFrac?: number;
}

export function splitIndices(trainable: LabTurn[], o: RunOpts): [number, number] {
  const n = trainable.length;
  const devEnd = Math.floor(n * (1 - (o.holdoutFrac ?? 0.2)));
  const minTrain = o.minTrain ?? 150;
  if (o.split === 'dev') return [minTrain, devEnd];
  if (o.split === 'holdout') return [devEnd, n];
  return [minTrain, n];
}

export function runSubmit(c: Candidate, turns: LabTurn[], ctx: Ctx, o: RunOpts): RunResult {
  const trainable = turns.filter((t) => t.trainable);
  const [from, to] = splitIndices(trainable, o);
  const every = o.every ?? 25;
  const rows: Row[] = [];
  const dists = new Map<string, LogMixture>();
  const fits: RunResult['fits'] = [];
  for (let b = from; b < to; b += every) {
    const block = trainable.slice(b, Math.min(to, b + every));
    const cutoff = block[0].submittedAt;
    let train = trainable.filter((t) => t.finishedAt < cutoff);
    if (o.maxTrain) train = train.slice(-o.maxTrain);
    const fitted = c.fit(train, ctx);
    fits.push({ from: b, fitted });
    for (const t of block) {
      if (o.score && !o.score.includes(t.trigger)) continue;
      const d = fitted.predict(t);
      dists.set(t.key, d);
      rows.push({
        key: t.key, session: t.sessionId, agent: t.agent, y: t.y,
        q10: Math.log(d.quantile(0.1)), q50: Math.log(d.quantile(0.5)), q90: Math.log(d.quantile(0.9)),
      });
    }
  }
  return { name: c.name, rows, dists, fits };
}

/** Paired session-block bootstrap of mean(loss_a - loss_b); negative favours a. */
export function compare(a: Row[], b: Row[], loss: (r: Row) => number, iters = 2000, seed = 11): { diff: number; lo: number; hi: number; pBetter: number } {
  const bm = new Map(b.map((r) => [r.key, r]));
  const bySession = new Map<string, number[]>();
  for (const r of a) {
    const o = bm.get(r.key);
    if (!o) continue;
    const d = loss(r) - loss(o);
    (bySession.get(r.session) ?? bySession.set(r.session, []).get(r.session)!).push(d);
  }
  const groups = [...bySession.values()];
  const flat = groups.flat();
  const diff = flat.reduce((s, x) => s + x, 0) / flat.length;
  const rand = mulberry32(seed);
  const boots: number[] = [];
  for (let k = 0; k < iters; k++) {
    let s = 0, n = 0;
    for (let j = 0; j < groups.length; j++) {
      const g = groups[Math.floor(rand() * groups.length)];
      for (const x of g) { s += x; n++; }
    }
    boots.push(s / n);
  }
  boots.sort((x, y) => x - y);
  return { diff, lo: boots[Math.floor(iters * 0.025)], hi: boots[Math.floor(iters * 0.975)], pBetter: boots.filter((x) => x < 0).length / iters };
}

// ---------------------------------------------------------------------------
// Live replay: observations of a turn at given active-elapsed times.

export interface Obs {
  elapsedMs: number;
  toolCalls: number;
  subCalls: number;
  history: ToolCategory[];
  names: string[];
  todo: TodoState | null;
  /** Active ms since the last tool event (start or end), or since submit. */
  sinceEvent: number;
  /** Tools started and not yet ended (main thread). */
  running: number;
  /** Active ms the oldest running tool has been running. */
  runningFor: number;
  compactions: number;
  edits: number;
  waits: number;
  /** Phase label counts so far (from assistant text / shell commands), and the most recent command class. */
  phase: Record<string, number>;
  lastCmd: string | null;
  lastText: string[] | null;
  /** Active ms since the last assistant text message. */
  sinceText: number;
}

export function observe(t: LabTurn, points: number[]): Obs[] {
  const idle = new IdleClock();
  // Merge phase labels into the event stream as pseudo-events.
  // The parser records phase events itself now; older caches only have the research list.
  const hasPhaseEvents = t.events.some((e) => e.kind === 'phase');
  const events = (t.phase?.length && !hasPhaseEvents
    ? [...t.events, ...t.phase.map((p) => ({ ts: p.ts, kind: 'phase' as const, meta: { c: p.c } }))].sort((a, b) => a.ts - b.ts)
    : t.events) as (LabTurn['events'][number] | { ts: number; kind: 'phase'; meta: { c: string[] }; toolName?: undefined })[];
  const phase: Record<string, number> = {};
  let lastCmd: string | null = null;
  let lastText: string[] | null = null;
  let lastTextAt = 0;
  const elapsedAt = (ts: number) => Math.max(0, ts - t.submittedAt - idle.total(ts));
  let ei = 0;
  let toolCalls = 0, subCalls = 0, compactions = 0, edits = 0, waits = 0;
  let lastEvent = 0;
  const history: ToolCategory[] = [];
  const names: string[] = [];
  const open: number[] = [];
  let todo: TodoState | null = null;
  const out: Obs[] = [];
  for (const target of points) {
    while (ei < events.length && elapsedAt(events[ei].ts) <= target) {
      const e = events[ei++];
      const meta = e.meta as any;
      const at = elapsedAt(e.ts);
      switch (e.kind) {
        case 'tool_start':
          if (meta?.subagent) { subCalls++; break; }
          if (idle.waiting && idle.reason !== 'question') idle.endWait(e.ts);
          toolCalls++;
          lastEvent = at;
          history.push(toolCategory(e.toolName));
          names.push(e.toolName ?? '?');
          if (toolCategory(e.toolName) === 'edit') edits++;
          open.push(at);
          if (e.toolName && QUESTION_TOOLS.test(e.toolName)) idle.startWait(e.ts, 'question');
          break;
        case 'tool_end':
          if (idle.waiting) idle.endWait(e.ts);
          lastEvent = elapsedAt(e.ts);
          open.shift();
          break;
        case 'resumed':
          if (idle.waiting) idle.endWait(e.ts);
          break;
        case 'waiting_user':
          waits++;
          idle.startWait(e.ts, meta?.reason ?? 'waiting');
          break;
        case 'compact':
          compactions++;
          break;
        case 'phase': {
          for (const c of meta.c as string[]) phase[c] = (phase[c] ?? 0) + 1;
          const cmd = (meta.c as string[]).find((c) => c.startsWith('cmd:'));
          if (cmd) lastCmd = cmd;
          if ((meta.c as string[]).includes('text')) { lastText = meta.c; lastTextAt = at; }
          break;
        }
        case 'todo_update':
          if (meta && typeof meta.total === 'number') {
            if (!todo) todo = new TodoState();
            const items = Array.from({ length: meta.total }, (_, i) => ({ id: String(i), status: i < meta.done ? 'completed' as const : 'pending' as const }));
            todo.apply({ kind: 'snapshot', items }, at);
          }
          break;
      }
    }
    out.push({
      elapsedMs: target, toolCalls, subCalls, history: [...history], names: [...names], todo,
      sinceEvent: Math.max(0, target - lastEvent), running: open.length, runningFor: open.length ? Math.max(0, target - open[0]) : 0,
      compactions, edits, waits, phase: { ...phase }, lastCmd, lastText, sinceText: Math.max(0, target - lastTextAt),
    });
  }
  return out;
}

export const LIVE_FRACTIONS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

export interface LiveRow {
  key: string;
  session: string;
  /** Mean over fractions of |log((t + R50) / T)|. */
  avg: number;
  at: number[];
  /** Absolute-grid snapshots: [logR, logR10, logR50, logR90]. */
  grid: [number, number, number, number][];
}

export type LiveFn = (t: LabTurn, prior: LogMixture, obs: Obs) => { p10: number; p50: number; p90: number };

export function runLive(turns: LabTurn[], dists: Map<string, LogMixture>, liveFor: (t: LabTurn) => LiveFn, adapt?: { gamma: number }): LiveRow[] {
  const out: LiveRow[] = [];
  // Online quantile tracking: log-space offsets on the live P10/P50/P90, updated from finished turns' snapshots.
  const off = [0, 0, 0];
  const pending: { finishedAt: number; grid: [number, number, number, number][] }[] = [];
  const ordered = [...turns].sort((a, b) => a.submittedAt - b.submittedAt);
  for (const t of ordered) {
    const prior = dists.get(t.key);
    if (!prior) continue;
    if (adapt) {
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].finishedAt >= t.submittedAt) continue;
        const g = pending[i].grid;
        for (const [y, a, b, c] of g) {
          off[0] -= (adapt.gamma / g.length) * ((y < a ? 1 : 0) - 0.1);
          off[1] += (adapt.gamma / g.length) * ((y > b ? 1 : 0) - 0.5);
          off[2] += (adapt.gamma / g.length) * ((y > c ? 1 : 0) - 0.1);
        }
        pending.splice(i, 1);
      }
    }
    const T = Math.max(t.activeMs, 1000);
    const base = liveFor(t);
    const o0 = off[0], o1 = off[1], o2 = off[2];
    const fn: LiveFn = adapt
      ? (tt, pr, ob) => { const e = base(tt, pr, ob); return { p10: e.p10 * Math.exp(o0), p50: e.p50 * Math.exp(o1), p90: e.p90 * Math.exp(o2) }; }
      : base;
    const fr = LIVE_FRACTIONS.map((f) => f * T);
    const at = observe(t, fr).map((o, i) => Math.abs(Math.log((fr[i] + fn(t, prior, o).p50) / T)));
    const grid: number[] = [];
    for (let x = 3000; x < T; x *= 1.5) grid.push(x);
    const g = observe(t, grid).map((o, i): [number, number, number, number] => {
      const e = fn(t, prior, o);
      const lg = (v: number) => Math.log(Math.max(v, 500));
      return [lg(T - grid[i]), lg(e.p10), lg(e.p50), lg(e.p90)];
    });
    out.push({ key: t.key, session: t.sessionId, avg: at.reduce((a, b) => a + b, 0) / at.length, at, grid: g });
    if (adapt && g.length) pending.push({ finishedAt: t.finishedAt, grid: g });
  }
  const order = new Map(turns.map((t, i) => [t.key, i]));
  out.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
  return out;
}

export interface LiveSummary {
  n: number;
  /** Median over turns of the time-averaged total-time miss. */
  avg: number;
  at25: number;
  at50: number;
  at75: number;
  snaps: number;
  c50: number;
  c90: number;
  c10: number;
  qs: number;
}

export function summarizeLive(rows: LiveRow[]): LiveSummary {
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] ?? NaN; };
  let snaps = 0, c50 = 0, c90 = 0, c10 = 0, qs = 0;
  for (const r of rows) for (const [y, a, b, c] of r.grid) {
    snaps++;
    if (y <= b) c50++;
    if (y <= c) c90++;
    if (y >= a) c10++;
    qs += (pin(y, a, 0.1) + pin(y, b, 0.5) + pin(y, c, 0.9)) / 3;
  }
  const idx = (f: number) => LIVE_FRACTIONS.indexOf(f);
  return {
    n: rows.length, avg: med(rows.map((r) => r.avg)),
    at25: med(rows.map((r) => (r.at[idx(0.2)] + r.at[idx(0.3)]) / 2)),
    at50: med(rows.map((r) => r.at[idx(0.5)])),
    at75: med(rows.map((r) => (r.at[idx(0.7)] + r.at[idx(0.8)]) / 2)),
    snaps, c50: c50 / snaps, c90: c90 / snaps, c10: c10 / snaps, qs: qs / snaps,
  };
}

/** Paired bootstrap on per-turn live miss. */
export function compareLive(a: LiveRow[], b: LiveRow[], iters = 2000): { diff: number; lo: number; hi: number } {
  const ra: Row[] = a.map((r) => ({ key: r.key, session: r.session, agent: '', y: r.avg, q10: 0, q50: 0, q90: 0 }));
  const rb: Row[] = b.map((r) => ({ key: r.key, session: r.session, agent: '', y: r.avg, q10: 0, q50: 0, q90: 0 }));
  const c = compare(ra, rb, (r) => r.y, iters);
  return { diff: c.diff, lo: c.lo, hi: c.hi };
}
