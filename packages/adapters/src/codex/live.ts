import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codexDir, normalizeEffort, promptFeatures, tsOf, type NormalizedEvent } from '@tminus/core';
import { codexRecordToEvents, newCodexState, todoFromPlan, type CodexParserState } from './parse.ts';

const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const MAX_READ = 8 * 1024 * 1024;

interface Tail { offset: number; st: CodexParserState }

function pad(n: number) { return String(n).padStart(2, '0'); }

/** Codex names session directories by local date; look at today and yesterday. */
function recentDirs(root: string, now: number): string[] {
  const dirs = new Set<string>();
  for (const back of [0, 1]) {
    const d = new Date(now - back * 86_400_000);
    dirs.add(join(root, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
  }
  return [...dirs].filter((d) => existsSync(d));
}

function readFrom(file: string, offset: number): { text: string; end: number } {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (offset > size) offset = 0;
    const len = Math.min(size - offset, MAX_READ);
    if (len <= 0) return { text: '', end: offset };
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const s = buf.toString('utf8');
    const nl = s.lastIndexOf('\n');
    if (nl < 0) return { text: '', end: offset };
    const text = s.slice(0, nl + 1);
    return { text, end: offset + Buffer.byteLength(text) };
  } finally {
    closeSync(fd);
  }
}

function parseLines(st: CodexParserState, text: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    out.push(...codexRecordToEvents(st, rec));
  }
  return out;
}

/**
 * Live Codex tracking by tailing the active rollout file. This needs no hook
 * trust and sees everything (plans, approvals, aborts) with exact timestamps,
 * so it is the single live source for Codex; Codex hooks only wake the collector.
 */
export class CodexTailer {
  private tails = new Map<string, Tail>();
  constructor(private emit: (ev: NormalizedEvent) => void, private root = codexDir()) {}

  poll(now = Date.now()): void {
    for (const dir of recentDirs(this.root, now)) {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const e of entries) {
        if (!e.startsWith('rollout-') || !e.endsWith('.jsonl')) continue;
        const file = join(dir, e);
        let mtime = 0;
        try { mtime = statSync(file).mtimeMs; } catch { continue; }
        const tail = this.tails.get(file);
        if (!tail) {
          if (now - mtime > ACTIVE_WINDOW_MS) continue;
          this.attach(file);
        } else if (mtime > now - ACTIVE_WINDOW_MS) {
          const { text, end } = readFrom(file, tail.offset);
          tail.offset = end;
          if (text) for (const ev of parseLines(tail.st, text)) this.emit(ev);
        }
      }
    }
  }

  /** First sight of a file: replay it silently, then emit only the still-open turn. */
  private attach(file: string): void {
    const st = newCodexState();
    const { text, end } = readFrom(file, 0);
    const events = parseLines(st, text);
    let lastStart = -1;
    for (let i = 0; i < events.length; i++) {
      if (events[i].kind === 'prompt_submit') lastStart = i;
      else if (events[i].kind === 'stop' || events[i].kind === 'error') lastStart = -1;
    }
    if (lastStart >= 0) for (const ev of events.slice(lastStart)) this.emit(ev);
    // A task_started whose prompt isn't written yet stays pending in `st` and is emitted on the next poll.
    this.tails.set(file, { offset: end, st });
  }
}

/**
 * Codex hook payload -> NormalizedEvent (codex-cli >= 0.15x hooks schema:
 * session_id, turn_id, transcript_path, cwd, hook_event_name, model, tool_name,
 * tool_use_id, tool_input). Not used for live tracking by default (the tailer
 * is), but kept so hook-only setups can forward events.
 */
export function parseCodexHook(raw: unknown, hookEvent?: string, now = Date.now()): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, any>;
  const name = (typeof p.hook_event_name === 'string' && p.hook_event_name) || hookEvent;
  if (!name || typeof p.session_id !== 'string') return null;
  const base: NormalizedEvent = {
    agent: 'codex', sessionId: p.session_id, kind: 'tool_start', ts: tsOf(p.timestamp) ?? now,
    promptId: p.turn_id ?? null, cwd: p.cwd ?? null, transcriptPath: p.transcript_path ?? null,
    model: typeof p.model === 'string' ? p.model : null, mode: p.permission_mode ?? null,
    effort: normalizeEffort(p.effort), subagentId: p.agent_id ?? null,
  };
  const toolName = typeof p.tool_name === 'string' ? (p.tool_name.startsWith('mcp__') ? 'mcp' : p.tool_name) : null;
  switch (name) {
    case 'SessionStart': return { ...base, kind: 'session_start', reason: p.source ?? null };
    case 'UserPromptSubmit': return { ...base, kind: 'prompt_submit', promptFeatures: promptFeatures(String(p.prompt ?? '')), trigger: 'human' };
    case 'PreToolUse': return { ...base, kind: 'tool_start', toolName, toolUseId: p.tool_use_id ?? null, todo: toolName === 'update_plan' ? todoFromPlan(p.tool_input) : null };
    case 'PostToolUse': return { ...base, kind: 'tool_end', toolName, toolUseId: p.tool_use_id ?? null };
    case 'PermissionRequest': return { ...base, kind: 'waiting_user', toolName, reason: 'permission' };
    case 'PreCompact': case 'PostCompact': return { ...base, kind: 'compact' };
    case 'SubagentStart': return { ...base, kind: 'subagent_start', subagentId: null };
    case 'SubagentStop': return { ...base, kind: 'subagent_stop', subagentId: null };
    case 'Stop': return { ...base, kind: 'stop' };
    case 'Interrupt': return { ...base, kind: 'error', reason: 'interrupted' };
    case 'SessionEnd': return { ...base, kind: 'session_end', reason: p.reason ?? null };
    default: return null;
  }
}
