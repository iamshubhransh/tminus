import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFeatures, codexDir, readJsonl, unionLength,
  type NormalizedEvent, type NormalizedTurn, type Outcome, type TodoStatus, type TurnEvent,
} from '@tminus/core';
import { codexProjectHash, codexRecordToEvents, isSubagentMeta, newCodexState, QUESTION_TOOL } from './parse.ts';
import { repoFor } from '../claude-code/backfill.ts';

export function listRollouts(root = codexDir(), since?: Date): string[] {
  const out: { f: string; m: number }[] = [];
  const walk = (d: string, depth: number) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      if (e.endsWith('.jsonl') && e.startsWith('rollout-')) {
        try {
          const st = statSync(p);
          if (!since || st.mtimeMs >= since.getTime()) out.push({ f: p, m: st.mtimeMs });
        } catch { /* vanished */ }
      } else if (depth < 4 && !e.includes('.')) {
        walk(p, depth + 1);
      }
    }
  };
  for (const sub of ['sessions', 'archived_sessions']) {
    const d = join(root, sub);
    if (existsSync(d)) walk(d, 0);
  }
  return out.sort((a, b) => a.m - b.m).map((x) => x.f);
}

interface Builder {
  ev: NormalizedEvent;
  subagentCalls: number;
  events: TurnEvent[];
  idle: [number, number][];
  waitStart: number | null;
  waitReason: string | null;
  toolCalls: number;
  lastTs: number;
  todo: Map<string, TodoStatus>;
}

const OPEN_TAIL_MS = 30 * 60 * 1000;

export interface SubagentCall { ts: number; name: string | null }

export async function* parseCodexRollout(
  file: string,
  opts: { skipOpenTail?: boolean; subagentCalls?: SubagentCall[] } = {},
): AsyncGenerator<NormalizedTurn> {
  const st = newCodexState();
  let cur: Builder | null = null;
  let sessionStart: number | null = null;
  let turnIndex = 0;
  const recent: number[] = [];

  const finish = (b: Builder, outcome: Outcome, at: number, durationMs: number | null): NormalizedTurn => {
    if (b.waitStart !== null) b.idle.push([b.waitStart, at]);
    const finishedAt = Math.max(at, b.ev.ts);
    // Work done in subagent threads spawned from this thread while the turn ran.
    for (const c of opts.subagentCalls ?? []) {
      if (c.ts < b.ev.ts || c.ts > finishedAt) continue;
      b.subagentCalls++;
      b.events.push({ ts: c.ts, kind: 'tool_start', toolName: c.name, meta: { subagent: true } });
    }
    b.events.sort((x, y) => x.ts - y.ts);
    const idleMs = unionLength(b.idle);
    const features = buildFeatures('', b.ev.ts, b.ev.trigger ?? 'human', {
      model: b.ev.model, effort: b.ev.effort, mode: b.ev.mode, contextPct: b.ev.contextPct ?? null, turnIndex, recentActiveMs: recent,
      ...repoFor(st.cwd),
    });
    if (b.ev.promptFeatures) features.prompt = b.ev.promptFeatures;
    b.events.push({ ts: finishedAt, kind: 'stop', meta: { outcome } });
    const active = Math.max(0, finishedAt - b.ev.ts - idleMs);
    turnIndex++;
    recent.push(active);
    if (recent.length > 3) recent.shift();
    let todoTotal = 0;
    for (const s of b.todo.values()) if (s !== 'deleted') todoTotal++;
    return {
      agent: 'codex', sessionId: st.sessionId ?? file, extId: b.ev.promptId ?? String(b.ev.ts),
      projectHash: codexProjectHash(st), sessionStartedAt: sessionStart ?? b.ev.ts,
      submittedAt: b.ev.ts, finishedAt, idleMs, outcome,
      model: features.session.model, effort: features.session.effort, mode: features.session.mode,
      contextPct: features.session.contextPct, features, toolCalls: b.toolCalls, subagentToolCalls: b.subagentCalls, todoTotal,
      agentDurationMs: durationMs, events: b.events,
    };
  };

  for await (const rec of readJsonl(file)) {
    const t = Date.parse(rec?.timestamp);
    if (Number.isFinite(t) && (sessionStart === null || t < sessionStart)) sessionStart = t;
    for (const ev of codexRecordToEvents(st, rec)) {
      if (ev.kind === 'prompt_submit') {
        if (cur) yield finish(cur, 'interrupted', cur.lastTs, null);
        cur = { ev, subagentCalls: 0, events: [{ ts: ev.ts, kind: 'prompt_submit' }], idle: [], waitStart: null, waitReason: null, toolCalls: 0, lastTs: ev.ts, todo: new Map() };
        continue;
      }
      if (!cur) continue;
      cur.lastTs = Math.max(cur.lastTs, ev.ts);
      switch (ev.kind) {
        case 'tool_start':
          if (cur.waitStart !== null && cur.waitReason !== 'question') { cur.idle.push([cur.waitStart, ev.ts]); cur.waitStart = null; cur.events.push({ ts: ev.ts, kind: 'resumed' }); }
          cur.toolCalls++;
          cur.events.push({ ts: ev.ts, kind: 'tool_start', toolName: ev.toolName });
          if (ev.toolName && QUESTION_TOOL.test(ev.toolName)) {
            cur.waitStart = ev.ts; cur.waitReason = 'question';
            cur.events.push({ ts: ev.ts, kind: 'waiting_user', toolName: ev.toolName, meta: { reason: 'question' } });
          }
          if (ev.todo?.kind === 'snapshot') {
            cur.todo = new Map(ev.todo.items.map((i) => [i.id, i.status]));
            let done = 0;
            for (const s of cur.todo.values()) if (s === 'completed') done++;
            cur.events.push({ ts: ev.ts, kind: 'todo_update', meta: { done, total: cur.todo.size } });
          }
          break;
        case 'tool_end':
          if (cur.waitStart !== null) { cur.idle.push([cur.waitStart, ev.ts]); cur.waitStart = null; cur.events.push({ ts: ev.ts, kind: 'resumed' }); }
          cur.events.push({ ts: ev.ts, kind: 'tool_end', toolName: ev.toolName });
          break;
        case 'waiting_user':
          if (cur.waitStart === null) { cur.waitStart = ev.ts; cur.waitReason = ev.reason ?? 'permission'; }
          cur.events.push({ ts: ev.ts, kind: 'waiting_user', meta: { reason: ev.reason ?? 'permission' } });
          break;
        case 'compact':
          cur.events.push({ ts: ev.ts, kind: 'compact' });
          break;
        case 'stop':
          yield finish(cur, 'completed', ev.ts, ev.durationMs ?? null);
          cur = null;
          break;
        case 'error':
          yield finish(cur, ev.reason === 'interrupted' ? 'interrupted' : 'errored', ev.ts, null);
          cur = null;
          break;
        default:
          break;
      }
    }
  }
  if (cur && !opts.skipOpenTail) yield finish(cur, 'interrupted', cur.lastTs, null);
}

/** The session_meta payload (first record) of a rollout, without reading the whole file. */
export function rolloutMeta(file: string): any | null {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const first = buf.toString('utf8', 0, n).split('\n')[0];
      const rec = JSON.parse(first);
      return rec?.type === 'session_meta' ? rec.payload ?? null : null;
    } finally { closeSync(fd); }
  } catch { return null; }
}

export async function* backfillCodex(opts: { since?: Date; root?: string; onFile?: (f: string) => void } = {}): AsyncGenerator<NormalizedTurn> {
  // Pass 1: subagent threads, collected per parent thread.
  const files = listRollouts(opts.root, opts.since);
  const subByParent = new Map<string, SubagentCall[]>();
  const mains: { file: string; thread: string | null }[] = [];
  for (const file of files) {
    const meta = rolloutMeta(file);
    if (!meta || !isSubagentMeta(meta)) { mains.push({ file, thread: meta?.id ?? null }); continue; }
    const parent = meta.parent_thread_id ?? meta.parentThreadId;
    if (!parent) continue;
    const st = newCodexState();
    const calls = subByParent.get(parent) ?? [];
    for await (const rec of readJsonl(file)) {
      for (const ev of codexRecordToEvents(st, rec)) if (ev.kind === 'tool_start') calls.push({ ts: ev.ts, name: ev.toolName ?? null });
    }
    subByParent.set(parent, calls);
  }
  // Pass 2: the user's threads, with their subagents' work attached.
  for (const { file, thread } of mains) {
    opts.onFile?.(file);
    let recent = false;
    try { recent = Date.now() - statSync(file).mtimeMs < OPEN_TAIL_MS; } catch { /* vanished */ }
    for await (const turn of parseCodexRollout(file, { skipOpenTail: recent, subagentCalls: thread ? subByParent.get(thread) : undefined })) {
      if (opts.since && turn.submittedAt < opts.since.getTime()) continue;
      yield turn;
    }
  }
}
