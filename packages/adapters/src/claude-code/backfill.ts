import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFeatures, claudeDir, commandPhase, hashPath, normalizeEffort, normalizeModel, readJsonl, repoInfo, textPhase, tsOf, unionLength,
  type NormalizedTurn, type Outcome, type TodoChange, type TodoStatus, type Trigger, type TurnEvent,
} from '@tminus/core';

/**
 * Claude Code transcript format (observed on 2.1.272 – 2.1.304, see docs/AGENT_FORMATS.md):
 * one JSONL per session under ~/.claude/projects/<cwd-slug>/<session-id>.jsonl. Relevant records:
 *   user        prompt (string/array content) or tool_result (array content); origin.kind, promptId
 *   assistant   message.model, message.content[].tool_use, message.usage, stop_reason, effort / perTurnEffort
 *   system      subtype turn_duration {durationMs} marks the end of a turn
 *   api-request params.output_config.effort (newer versions; assistant records carry it from 2.1.2xx)
 *   permission-mode {permissionMode}
 * Subagents live in <session-id>/subagents/*.jsonl and are not separate turns.
 */

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const AGENT_WAKE_ORIGINS = new Set(['peer', 'auto-continuation', 'task-notification']);
const INTERRUPT_RE = /^\[Request interrupted by user/;
/** User messages that are UI output or `!` shell commands the user ran themselves, not prompts. */
const NON_PROMPT_RE = /^<(local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;

/** Repo size/language for a project directory (cached on disk per repo, refreshed daily). */
export function repoFor(cwd: string | null): { repoFiles: number | null; repoLanguage: string | null } {
  try {
    const r = repoInfo(cwd);
    return { repoFiles: r.files, repoLanguage: r.language };
  } catch {
    return { repoFiles: null, repoLanguage: null };
  }
}

export function listTranscripts(root = join(claudeDir(), 'projects'), since?: Date): string[] {
  if (!existsSync(root)) return [];
  const out: { f: string; m: number }[] = [];
  for (const dir of readdirSync(root)) {
    const d = join(root, dir);
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const f = join(d, e);
      try {
        const st = statSync(f);
        if (!st.isFile()) continue;
        if (since && st.mtimeMs < since.getTime()) continue;
        out.push({ f, m: st.mtimeMs });
      } catch { /* vanished */ }
    }
  }
  return out.sort((a, b) => a.m - b.m).map((x) => x.f);
}

interface PendingTool { name: string; ts: number }

class TurnBuilder {
  events: TurnEvent[] = [];
  pending = new Map<string, PendingTool>();
  idle: [number, number][] = [];
  toolCalls = 0;
  assistantMsgs = 0;
  lastTs: number;
  endTs: number | null = null;
  durationMs: number | null = null;
  interrupted = false;
  errored = false;
  lastStopReason: string | null = null;
  model: string | null = null;
  effort: string | null = null;
  todo = new Map<string, TodoStatus>();
  todoSeen = false;
  taskSeq = 0;
  subagentCalls = 0;
  /** Text of the turn's latest assistant message (research hook only; never stored). */
  lastText: string | null = null;
  /** Research hook only: raw assistant text and Bash commands with timestamps, in order. Never stored. */
  research: { ts: number; kind: 'text' | 'cmd'; text: string }[] = [];

  constructor(
    /** The prompt id as Claude Code wrote it (subagents carry the same id). */
    readonly promptKey: string | null,
    readonly extId: string,
    readonly submittedAt: number,
    readonly trigger: Trigger,
    readonly prompt: string,
    readonly images: number,
    readonly mode: string | null,
  ) {
    this.lastTs = submittedAt;
    this.events.push({ ts: submittedAt, kind: 'prompt_submit' });
  }

  touch(ts: number | null) {
    if (ts && ts > this.lastTs) this.lastTs = ts;
  }

  applyTodo(change: TodoChange, ts: number) {
    this.todoSeen = true;
    if (change.kind === 'snapshot') this.todo = new Map(change.items.map((i) => [i.id, i.status]));
    else this.todo.set(change.id, change.status);
    let done = 0, total = 0;
    for (const s of this.todo.values()) { if (s !== 'deleted') total++; if (s === 'completed') done++; }
    this.events.push({ ts, kind: 'todo_update', meta: { done, total } });
  }

  get todoTotal(): number {
    let n = 0;
    for (const s of this.todo.values()) if (s !== 'deleted') n++;
    return n;
  }
}

function toolLabel(name: unknown): string {
  const n = String(name ?? 'unknown');
  return n.startsWith('mcp__') ? 'mcp' : n;
}

/**
 * Tool calls made by this session's subagents, from <session>/subagents/agent-*.jsonl.
 * Every record in a subagent transcript carries the promptId of the turn that spawned it.
 */
export async function loadSubagentCalls(sessionFile: string): Promise<{ ts: number; promptId: string | null; name: string }[]> {
  const dir = join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')); } catch { return []; }
  const out: { ts: number; promptId: string | null; name: string }[] = [];
  for (const f of files) {
    let promptId: string | null = null;
    const calls: { ts: number; name: string }[] = [];
    for await (const rec of readJsonl(join(dir, f))) {
      if (!promptId && typeof rec?.promptId === 'string') promptId = rec.promptId;
      if (rec?.type !== 'assistant' || !Array.isArray(rec.message?.content)) continue;
      const ts = tsOf(rec.timestamp);
      if (!ts) continue;
      for (const c of rec.message.content) if (c?.type === 'tool_use') calls.push({ ts, name: toolLabel(c.name) });
    }
    for (const c of calls) out.push({ ...c, promptId });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Todo changes from TodoWrite / TaskCreate / TaskUpdate tool inputs. Only ids and statuses are kept. */
export function todoFromToolInput(name: string, input: any, seq?: () => string): TodoChange | null {
  if (!input || typeof input !== 'object') return null;
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    return {
      kind: 'snapshot',
      items: input.todos.map((t: any, i: number) => ({ id: String(t?.id ?? i), status: normStatus(t?.status) })),
    };
  }
  if (name === 'TaskUpdate' && (input.taskId != null || input.task_id != null)) {
    return { kind: 'upsert', id: String(input.taskId ?? input.task_id), status: normStatus(input.status) };
  }
  if (name === 'TaskCreate' && seq) {
    return { kind: 'upsert', id: seq(), status: 'pending' };
  }
  return null;
}

export function normStatus(s: unknown): TodoStatus {
  const v = String(s ?? '').toLowerCase();
  if (v === 'completed' || v === 'done' || v === 'complete') return 'completed';
  if (v === 'in_progress' || v === 'in-progress' || v === 'active') return 'in_progress';
  if (v === 'deleted' || v === 'cancelled' || v === 'canceled') return 'deleted';
  return 'pending';
}

function contentText(content: unknown): { text: string; images: number; toolResults: any[] } {
  if (typeof content === 'string') return { text: content, images: 0, toolResults: [] };
  if (!Array.isArray(content)) return { text: '', images: 0, toolResults: [] };
  let text = '';
  let images = 0;
  const toolResults: any[] = [];
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string') text += (text ? '\n' : '') + c.text;
    else if (c?.type === 'image') images++;
    else if (c?.type === 'tool_result') toolResults.push(c);
  }
  return { text, images, toolResults };
}

function triggerOf(rec: any, text: string): Trigger {
  const kind = rec.origin?.kind;
  if (text.startsWith('<task-notification>') || kind === 'task-notification') return 'notification';
  if (kind === 'peer' || kind === 'auto-continuation' || rec.turnOrigin === 'peer') return 'system';
  if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) return 'command';
  if (rec.promptSource === 'sdk' || kind === 'sdk') return 'sdk';
  return 'human';
}

function toolResultText(tr: any): string {
  if (typeof tr?.content === 'string') return tr.content;
  if (Array.isArray(tr?.content)) return tr.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/**
 * Reconstruct turns from one session transcript: user prompt -> final assistant
 * message (or the turn_duration marker Claude Code writes when a turn ends).
 */
export interface TurnText {
  prompt: string;
  /** The previous turn's last assistant message in this session. */
  prevAssistant: string | null;
  /** Assistant text and shell commands during the turn, with timestamps. */
  during: { ts: number; kind: 'text' | 'cmd'; text: string }[];
}

export async function* parseClaudeTranscript(
  file: string,
  stats?: { bad: number; lines: number },
  opts: {
    skipOpenTail?: boolean;
    /** Research only (lab/): receives each turn's raw text in memory. Nothing passed here is ever stored. */
    onText?: (turn: NormalizedTurn, text: TurnText) => void;
  } = {},
): AsyncGenerator<NormalizedTurn> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let sessionStart: number | null = null;
  let mode: string | null = null;
  let effort: string | null = null;
  let model: string | null = null;
  let contextTokens: number | null = null;
  let maxContextTokens = 0;
  let cur: TurnBuilder | null = null;
  let turnIndex = 0;
  const recent: number[] = [];
  let prevAssistant: string | null = null;
  // Per-turn context snapshot taken at submit time.
  let curContext: number | null = null;
  // Claude Code can reuse a promptId for a later turn in the same session; number the repeats.
  const promptSeen = new Map<string, number>();
  const extIdFor = (id: string) => {
    const n = (promptSeen.get(id) ?? 0) + 1;
    promptSeen.set(id, n);
    return n === 1 ? id : `${id}#${n}`;
  };

  const finish = (b: TurnBuilder): NormalizedTurn | null => {
    if (b.assistantMsgs === 0 && !b.durationMs) return null; // nothing ran (e.g. empty prompt, command output)
    const finishedAt = Math.max(b.submittedAt, b.endTs ?? b.lastTs);
    // Work done by subagents this turn spawned, while the turn was still running.
    for (const c of subCalls) {
      if (c.promptId !== b.promptKey || c.ts < b.submittedAt || c.ts > finishedAt) continue;
      b.subagentCalls++;
      b.events.push({ ts: c.ts, kind: 'tool_start', toolName: c.name, meta: { subagent: true } });
    }
    const idleMs = unionLength(b.idle.map(([a, z]) => [Math.max(a, b.submittedAt), Math.min(z, finishedAt)] as [number, number]));
    let outcome: Outcome = 'completed';
    if (b.errored) outcome = 'errored';
    if (b.interrupted) outcome = 'interrupted';
    else if (!b.endTs && b.lastStopReason === 'tool_use' && b.pending.size > 0) outcome = 'interrupted';
    b.events.push({ ts: finishedAt, kind: 'stop', meta: { outcome } });
    const window = maxContextTokens > 200_000 ? 1_000_000 : 200_000;
    const features = buildFeatures(b.prompt, b.submittedAt, b.trigger, {
      model: b.model ?? model,
      effort: b.effort ?? effort,
      mode: b.mode,
      contextPct: curContext != null ? Math.min(1, curContext / window) : null,
      turnIndex,
      recentActiveMs: recent,
      ...repoFor(cwd),
    }, b.images);
    const active = Math.max(0, finishedAt - b.submittedAt - idleMs);
    turnIndex++;
    recent.push(active);
    if (recent.length > 3) recent.shift();
    const turn: NormalizedTurn = {
      agent: 'claude-code',
      sessionId: sessionId!,
      extId: b.extId,
      projectHash: hashPath(cwd),
      sessionStartedAt: sessionStart ?? b.submittedAt,
      submittedAt: b.submittedAt,
      finishedAt,
      idleMs,
      outcome,
      model: features.session.model,
      effort: features.session.effort,
      mode: b.mode,
      contextPct: features.session.contextPct,
      features,
      toolCalls: b.toolCalls,
      subagentToolCalls: b.subagentCalls,
      todoTotal: b.todoTotal,
      agentDurationMs: b.durationMs,
      events: b.events.sort((x, y) => x.ts - y.ts),
    };
    opts.onText?.(turn, { prompt: b.prompt, prevAssistant, during: b.research });
    if (b.lastText) prevAssistant = b.lastText;
    return turn;
  };

  const subCalls = await loadSubagentCalls(file);

  for await (const rec of readJsonl(file, stats)) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.isSidechain) {
      // Older versions kept subagent records inline; count their tool calls as subagent work.
      const ts = tsOf(rec.timestamp);
      if (cur && ts && rec.type === 'assistant' && Array.isArray(rec.message?.content)) {
        for (const c of rec.message.content) {
          if (c?.type !== 'tool_use') continue;
          cur.subagentCalls++;
          cur.events.push({ ts, kind: 'tool_start', toolName: toolLabel(c.name), meta: { subagent: true } });
        }
      }
      continue;
    }
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId;
    if (rec.cwd && !cwd) cwd = rec.cwd;
    const ts = tsOf(rec.timestamp);
    if (ts && (sessionStart === null || ts < sessionStart)) sessionStart = ts;

    switch (rec.type) {
      case 'permission-mode':
        if (typeof rec.permissionMode === 'string') mode = rec.permissionMode;
        break;
      case 'api-request': {
        const e = normalizeEffort(rec.params?.output_config?.effort ?? rec.params?.effort);
        if (e) {
          effort = e;
          if (cur && !cur.effort) cur.effort = e;
        }
        break;
      }
      case 'user': {
        if (!ts) break;
        if (typeof rec.permissionMode === 'string') mode = rec.permissionMode;
        const { text, images, toolResults } = contentText(rec.message?.content);
        if (toolResults.length) {
          if (!cur) break;
          cur.touch(ts);
          for (const tr of toolResults) {
            const p = cur.pending.get(tr.tool_use_id);
            const decision = rec.permissionDecision?.source;
            if (p) {
              cur.pending.delete(tr.tool_use_id);
              // Time the human spent answering: questions, and permission prompts the user approved/denied.
              if (QUESTION_TOOLS.has(p.name) || (typeof decision === 'string' && decision.startsWith('user'))) {
                cur.idle.push([p.ts, ts]);
                cur.events.push({ ts: p.ts, kind: 'waiting_user', toolName: p.name, meta: { reason: QUESTION_TOOLS.has(p.name) ? 'question' : 'permission' } });
                cur.events.push({ ts, kind: 'resumed' });
              }
              cur.events.push({ ts, kind: 'tool_end', toolName: p.name });
              if (p.name === 'TaskCreate') {
                // The created task id comes back in the result; the TaskCreate input already counted it.
              }
            }
            if (INTERRUPT_RE.test(toolResultText(tr))) cur.interrupted = true;
          }
          break;
        }
        // Meta records are injected context, except messages that wake the agent up
        // (another session's hand-back, auto-continuation): those start agent-initiated turns.
        if (rec.isMeta && !AGENT_WAKE_ORIGINS.has(rec.origin?.kind)) break;
        if (INTERRUPT_RE.test(text)) {
          if (cur) { cur.interrupted = true; cur.touch(ts); }
          break;
        }
        if (NON_PROMPT_RE.test(text)) break;
        if (!text.trim() && !images) break;
        // A new prompt closes the previous turn.
        if (cur) { const t = finish(cur); if (t) yield t; }
        curContext = contextTokens;
        cur = new TurnBuilder(rec.promptId ?? null, extIdFor(String(rec.promptId ?? rec.uuid ?? `${ts}`)), ts, triggerOf(rec, text), text, images, mode);
        break;
      }
      case 'assistant': {
        const msg = rec.message;
        if (msg?.usage) {
          const u = msg.usage;
          const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          if (tokens > 0) { contextTokens = tokens; maxContextTokens = Math.max(maxContextTokens, tokens); }
        }
        const m = typeof msg?.model === 'string' && !msg.model.startsWith('<') ? normalizeModel(msg.model) : null;
        if (m) model = m;
        // Effort used for this request; older transcripts only have it on api-request records.
        const e = m ? normalizeEffort(rec.effort ?? rec.perTurnEffort) : null;
        if (e) effort = e;
        if (!cur || !ts) break;
        cur.touch(ts);
        cur.assistantMsgs++;
        if (m && !cur.model) cur.model = m;
        if (e && !cur.effort) cur.effort = e;
        if (rec.isApiErrorMessage) cur.errored = true;
        if (msg?.stop_reason) cur.lastStopReason = msg.stop_reason;
        if (Array.isArray(msg?.content)) {
          // Phase labels from what the agent says and runs; the text itself is not kept.
          const text = msg.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n');
          if (text.trim()) {
            cur.events.push({ ts, kind: 'phase', meta: { c: textPhase(text) } });
            if (opts.onText) { cur.lastText = text; cur.research.push({ ts, kind: 'text', text }); }
          }
          for (const c of msg.content) {
            if (c?.type !== 'tool_use') continue;
            const name = String(c.name ?? 'unknown');
            cur.toolCalls++;
            cur.pending.set(c.id, { name, ts });
            cur.events.push({ ts, kind: 'tool_start', toolName: toolLabel(name) });
            if (name === 'Bash' && typeof c.input?.command === 'string') {
              cur.events.push({ ts, kind: 'phase', meta: { c: commandPhase(c.input.command) } });
              if (opts.onText) cur.research.push({ ts, kind: 'cmd', text: c.input.command });
            }
            const todo = todoFromToolInput(name, c.input, () => `t${++cur!.taskSeq}`);
            if (todo) cur.applyTodo(todo, ts);
          }
        }
        break;
      }
      case 'system': {
        if (!cur || !ts) break;
        if (rec.subtype === 'turn_duration') {
          cur.endTs = ts;
          cur.durationMs = typeof rec.durationMs === 'number' ? rec.durationMs : null;
          const t = finish(cur);
          cur = null;
          if (t) yield t;
        } else if (rec.subtype === 'compact_boundary') {
          cur.touch(ts);
          cur.events.push({ ts, kind: 'compact' });
        }
        break;
      }
      default:
        break; // attachments, snapshots, titles, unknown future types: ignored
    }
  }
  // A trailing turn with no end marker in a live session is still running; leave it for the next import.
  if (cur && !(opts.skipOpenTail && !cur.endTs)) {
    const t = finish(cur);
    if (t) yield t;
  }
}

const OPEN_TAIL_MS = 30 * 60 * 1000;

export async function* backfillClaude(opts: { since?: Date; root?: string; onFile?: (f: string) => void } = {}): AsyncGenerator<NormalizedTurn> {
  for (const file of listTranscripts(opts.root, opts.since)) {
    opts.onFile?.(file);
    let recent = false;
    try { recent = Date.now() - statSync(file).mtimeMs < OPEN_TAIL_MS; } catch { /* vanished */ }
    for await (const turn of parseClaudeTranscript(file, undefined, { skipOpenTail: recent })) {
      if (opts.since && turn.submittedAt < opts.since.getTime()) continue;
      yield turn;
    }
  }
}
