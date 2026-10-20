import {
  hashPath, normalizeEffort, normalizeModel, promptFeatures, tsOf,
  type NormalizedEvent, type TodoChange, type Trigger,
} from '@tminus/core';
import { normStatus } from '../claude-code/backfill.ts';

/**
 * Codex rollout format (observed on codex-cli 0.108 – 0.156, see docs/AGENT_FORMATS.md):
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl, one {timestamp, type, payload} per line.
 *   session_meta                 payload.id (thread id), cwd, source (cli|exec|vscode), cli_version
 *   turn_context                 payload.turn_id, model, effort | collaboration_mode.settings.reasoning_effort
 *   event_msg task_started       payload.turn_id                               -> turn begins
 *   event_msg user_message       payload.message (older)                       -> prompt
 *   event_msg item_completed     payload.item.type == UserMessage (newer)      -> prompt
 *   response_item function_call | custom_tool_call {name, call_id, arguments}  -> tool start
 *   response_item *_output {call_id}                                           -> tool end
 *   event_msg *_approval_request                                               -> waiting on user
 *   event_msg task_complete      payload.duration_ms (newer)                   -> turn completed
 *   event_msg turn_aborted       payload.reason                                -> interrupted
 *   event_msg token_count        info.last_token_usage, model_context_window   -> context %
 */

export const QUESTION_TOOL = /^request_user_input/;

export interface CodexParserState {
  sessionId: string | null;
  /** Set for subagent threads: their work is reported against the parent thread. */
  parentThreadId: string | null;
  subagent: boolean;
  cwd: string | null;
  source: string | null;
  model: string | null;
  effort: string | null;
  mode: string | null;
  contextPct: number | null;
  turnId: string | null;
  /** task_started seen, waiting for the user message to attach features. */
  pendingStart: NormalizedEvent | null;
  calls: Map<string, string>;
}

export function newCodexState(): CodexParserState {
  return {
    sessionId: null, parentThreadId: null, subagent: false, cwd: null, source: null, model: null, effort: null, mode: null, contextPct: null,
    turnId: null, pendingStart: null, calls: new Map(),
  };
}

export function userMessageText(payload: any): { text: string; images: number } | null {
  if (payload?.type === 'user_message') {
    const imgs = (payload.images?.length ?? 0) + (payload.local_images?.length ?? 0);
    return { text: String(payload.message ?? ''), images: imgs };
  }
  if (payload?.type === 'item_completed' && payload.item?.type === 'UserMessage') {
    const content = payload.item.content;
    if (typeof content === 'string') return { text: content, images: 0 };
    let text = '';
    let images = 0;
    for (const c of Array.isArray(content) ? content : []) {
      if (typeof c?.text === 'string') text += (text ? '\n' : '') + c.text;
      else if (/image/.test(String(c?.type))) images++;
    }
    return { text, images };
  }
  return null;
}

export function todoFromPlan(args: unknown): TodoChange | null {
  let a: any = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return null; } }
  if (!Array.isArray(a?.plan)) return null;
  return { kind: 'snapshot', items: a.plan.map((p: any, i: number) => ({ id: String(i), status: normStatus(p?.status) })) };
}

/**
 * Feed one rollout record; returns the normalized events it implies (0..n).
 * Used both by backfill and by the live file tailer, so they agree exactly.
 */
export function codexRecordToEvents(st: CodexParserState, rec: any): NormalizedEvent[] {
  const out = recordToEvents(st, rec);
  return st.subagent ? asSubagentWork(st, out) : out;
}

/** Threads a subagent runs in: thread_source "subagent", or a parent thread that isn't a user fork. */
export function isSubagentMeta(p: any): boolean {
  const source = p?.thread_source ?? p?.threadSource ?? null;
  const parent = p?.parent_thread_id ?? p?.parentThreadId ?? null;
  return source === 'subagent' || (!!parent && source !== 'user');
}

/**
 * A subagent thread's own turn boundaries are not the user's turn. Keep only
 * its tool activity (and waits for approval), reported against the parent
 * thread so it counts toward the turn the user is waiting on.
 */
function asSubagentWork(st: CodexParserState, events: NormalizedEvent[]): NormalizedEvent[] {
  if (!st.parentThreadId) return [];
  return events
    .filter((e) => e.kind === 'tool_start' || e.kind === 'tool_end' || e.kind === 'waiting_user')
    .map((e) => ({ ...e, sessionId: st.parentThreadId!, subagentId: st.sessionId ?? 'subagent', promptId: null, todo: null }));
}

function recordToEvents(st: CodexParserState, rec: any): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  if (!rec || typeof rec !== 'object') return out;
  const ts = tsOf(rec.timestamp) ?? Date.now();
  const p = rec.payload ?? {};
  const base = (): NormalizedEvent => ({
    agent: 'codex', sessionId: st.sessionId ?? 'unknown', kind: 'tool_start', ts,
    promptId: st.turnId, cwd: st.cwd, model: st.model, effort: st.effort, mode: st.mode,
  });
  const flushStart = (text = '', images = 0) => {
    if (!st.pendingStart) return;
    const ev = st.pendingStart;
    st.pendingStart = null;
    // turn_context usually lands between task_started and the user message; pick it up.
    ev.model = st.model; ev.effort = st.effort; ev.mode = st.mode;
    ev.promptFeatures = promptFeatures(text, images);
    out.push(ev);
  };

  switch (rec.type) {
    case 'session_meta':
      st.sessionId = p.id ?? p.session_id ?? st.sessionId;
      st.cwd = p.cwd ?? st.cwd;
      st.source = p.source ?? st.source;
      st.parentThreadId = p.parent_thread_id ?? p.parentThreadId ?? st.parentThreadId;
      st.subagent = isSubagentMeta(p);
      return out;
    case 'turn_context':
      st.model = normalizeModel(p.model ?? p.collaboration_mode?.settings?.model ?? null) ?? st.model;
      st.effort = normalizeEffort(p.effort ?? p.collaboration_mode?.settings?.reasoning_effort) ?? st.effort;
      st.mode = p.collaboration_mode?.mode ?? p.approval_policy ?? st.mode;
      if (p.cwd) st.cwd = p.cwd;
      return out;
    case 'event_msg': {
      const um = userMessageText(p);
      if (um) { flushStart(um.text, um.images); return out; }
      switch (p.type) {
        case 'task_started': {
          flushStart();
          st.turnId = p.turn_id ?? `t${ts}`;
          st.calls.clear();
          const trigger: Trigger = st.source === 'exec' ? 'sdk' : 'human';
          st.pendingStart = { ...base(), kind: 'prompt_submit', promptId: st.turnId, trigger, contextPct: st.contextPct };
          return out;
        }
        case 'task_complete':
          flushStart();
          out.push({ ...base(), kind: 'stop', durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : null });
          st.turnId = null;
          return out;
        case 'turn_aborted':
          flushStart();
          out.push({ ...base(), kind: 'error', reason: p.reason === 'interrupted' || !p.reason ? 'interrupted' : String(p.reason) });
          st.turnId = null;
          return out;
        case 'token_count': {
          const info = p.info;
          const used = info?.last_token_usage?.input_tokens;
          const win = info?.model_context_window;
          if (typeof used === 'number' && typeof win === 'number' && win > 0) st.contextPct = Math.min(1, used / win);
          return out;
        }
        case 'context_compacted':
          flushStart();
          out.push({ ...base(), kind: 'compact' });
          return out;
        default:
          if (typeof p.type === 'string' && /approval_request$|^request_permissions/.test(p.type)) {
            flushStart();
            out.push({ ...base(), kind: 'waiting_user', reason: 'permission' });
          }
          return out;
      }
    }
    case 'response_item': {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'web_search_call' || p.type === 'local_shell_call') {
        flushStart();
        const name = String(p.name ?? p.type);
        if (p.call_id) st.calls.set(p.call_id, name);
        const todo = name === 'update_plan' ? todoFromPlan(p.arguments ?? p.input) : null;
        out.push({ ...base(), kind: 'tool_start', toolName: name.startsWith('mcp__') ? 'mcp' : name, toolUseId: p.call_id ?? null, todo });
        if (p.type === 'web_search_call') out.push({ ...base(), kind: 'tool_end', toolName: name });
      } else if (/_call_output$/.test(String(p.type))) {
        const name = st.calls.get(p.call_id) ?? null;
        out.push({ ...base(), kind: 'tool_end', toolName: name?.startsWith('mcp__') ? 'mcp' : name, toolUseId: p.call_id ?? null });
      }
      return out;
    }
    case 'compacted':
      out.push({ ...base(), kind: 'compact' });
      return out;
    default:
      return out;
  }
}

export function codexProjectHash(st: CodexParserState): string | null {
  return hashPath(st.cwd);
}
