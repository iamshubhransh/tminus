import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { normalizeEffort, promptFeatures, tsOf, type NormalizedEvent, type TodoChange, type Trigger } from '@tminus/core';
import { todoFromToolInput } from './backfill.ts';

/** Notification types that mean "the agent is blocked on the human". */
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const RESUMED_NOTIFICATIONS = new Set(['elicitation_complete', 'elicitation_response']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function promptTrigger(prompt: string): Trigger {
  if (prompt.startsWith('<task-notification>')) return 'notification';
  if (prompt.startsWith('/') || prompt.startsWith('<command-name>')) return 'command';
  return 'human';
}

/** Task id from a TaskCreate tool response, whatever shape this Claude Code version uses. */
export function taskIdFromResponse(resp: unknown): string | null {
  if (resp == null) return null;
  if (typeof resp === 'object') {
    const r = resp as any;
    const id = r.task?.id ?? r.taskId ?? r.task_id ?? r.id;
    if (id != null) return String(id);
  }
  const m = (typeof resp === 'string' ? resp : JSON.stringify(resp)).match(/Task #?(\w+)/i);
  return m ? m[1] : null;
}

/**
 * Hook payload -> NormalizedEvent. Field names follow the Claude Code hooks
 * reference (session_id, prompt_id, transcript_path, cwd, permission_mode,
 * effort, hook_event_name, tool_name, tool_input, tool_response, duration_ms,
 * notification_type, agent_id). Unknown events return null.
 */
export function parseClaudeHook(raw: unknown, hookEvent?: string, now = Date.now()): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, any>;
  const name = str(p.hook_event_name) ?? hookEvent;
  const sessionId = str(p.session_id);
  if (!name || !sessionId) return null;

  const base: NormalizedEvent = {
    agent: 'claude-code',
    sessionId,
    kind: 'tool_start',
    ts: tsOf(p.timestamp) ?? now,
    promptId: str(p.prompt_id),
    cwd: str(p.cwd),
    transcriptPath: str(p.transcript_path),
    mode: str(p.permission_mode),
    effort: normalizeEffort(typeof p.effort === 'object' ? p.effort?.level : p.effort),
    model: str(typeof p.model === 'object' ? p.model?.id : p.model),
    subagentId: str(p.agent_id),
  };
  const toolName = str(p.tool_name);
  const tool = { toolName: toolName?.startsWith('mcp__') ? 'mcp' : toolName, toolUseId: str(p.tool_use_id) };

  switch (name) {
    case 'SessionStart':
      return { ...base, kind: 'session_start', reason: str(p.source) };
    case 'UserPromptSubmit': {
      const prompt = typeof p.prompt === 'string' ? p.prompt : '';
      // Features are derived here, inside the hook; the prompt text goes no further.
      return { ...base, kind: 'prompt_submit', promptFeatures: promptFeatures(prompt), trigger: promptTrigger(prompt) };
    }
    case 'PreToolUse': {
      let todo: TodoChange | null = null;
      if (toolName === 'TodoWrite' || toolName === 'TaskUpdate') todo = todoFromToolInput(toolName, p.tool_input);
      return { ...base, kind: 'tool_start', ...tool, todo };
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      let todo: TodoChange | null = null;
      if (toolName === 'TaskCreate' && name === 'PostToolUse') {
        const id = taskIdFromResponse(p.tool_response) ?? tool.toolUseId;
        if (id) todo = { kind: 'upsert', id, status: 'pending' };
      }
      const durationMs = typeof p.duration_ms === 'number' ? p.duration_ms : null;
      return { ...base, kind: 'tool_end', ...tool, durationMs, todo, reason: name === 'PostToolUseFailure' ? 'failed' : null };
    }
    case 'PermissionRequest':
      return { ...base, kind: 'waiting_user', ...tool, reason: 'permission' };
    case 'PermissionDenied':
      return { ...base, kind: 'resumed', ...tool, reason: 'denied' };
    case 'Notification': {
      const type = str(p.notification_type);
      if (type && WAITING_NOTIFICATIONS.has(type)) return { ...base, kind: 'waiting_user', reason: type };
      if (type && RESUMED_NOTIFICATIONS.has(type)) return { ...base, kind: 'resumed', reason: type };
      return null; // idle_prompt fires after the turn ended; auth/quota notices are irrelevant
    }
    case 'Elicitation':
      return { ...base, kind: 'waiting_user', reason: 'elicitation' };
    case 'ElicitationResult':
      return { ...base, kind: 'resumed', reason: 'elicitation' };
    case 'SubagentStart':
      return { ...base, kind: 'subagent_start', subagentId: null };
    case 'SubagentStop':
      return { ...base, kind: 'subagent_stop', subagentId: null };
    case 'PreCompact':
    case 'PostCompact':
      return { ...base, kind: 'compact' };
    case 'Stop':
      return { ...base, kind: 'stop' };
    case 'StopFailure':
      return { ...base, kind: 'error', reason: str(p.error) ?? str(p.reason) ?? 'error' };
    case 'SessionEnd':
      return { ...base, kind: 'session_end', reason: str(p.reason) };
    default:
      return null;
  }
}

/**
 * Pressing Esc in Claude Code fires no hook. The transcript gets an
 * "[Request interrupted by user]" record, so the collector tails new bytes.
 */
export function probeTranscript(path: string, fromOffset: number): { offset: number; interruptedAt: number | null } {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return { offset: fromOffset, interruptedAt: null }; }
  try {
    const size = fstatSync(fd).size;
    if (fromOffset > size) fromOffset = 0; // rewritten
    if (size === fromOffset) return { offset: size, interruptedAt: null };
    const len = Math.min(size - fromOffset, 4 * 1024 * 1024);
    const start = size - len;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return { offset: fromOffset, interruptedAt: null };
    let interruptedAt: number | null = null;
    for (const line of text.slice(0, lastNl).split('\n')) {
      if (!line.includes('[Request interrupted by user')) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'user' && !rec.isSidechain) interruptedAt = tsOf(rec.timestamp) ?? Date.now();
      } catch { /* partial */ }
    }
    return { offset: start + Buffer.byteLength(text.slice(0, lastNl + 1)), interruptedAt };
  } finally {
    closeSync(fd);
  }
}
