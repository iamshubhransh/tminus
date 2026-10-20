import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseClaudeHook, parseClaudeTranscript, probeTranscript, taskIdFromResponse, todoFromToolInput } from '@tminus/adapters';
import type { NormalizedTurn } from '@tminus/core';

const FX = join(import.meta.dir, 'fixtures', 'claude-code');

async function turns(file: string, stats?: { bad: number; lines: number }): Promise<NormalizedTurn[]> {
  const out: NormalizedTurn[] = [];
  for await (const t of parseClaudeTranscript(join(FX, file), stats)) out.push(t);
  return out;
}
const active = (t: NormalizedTurn) => t.finishedAt - t.submittedAt - t.idleMs;

describe('Claude Code backfill', () => {
  test('redacted real session: human turns match Claude Code\'s own turn_duration', async () => {
    const ts = await turns('real-session.jsonl');
    expect(ts.length).toBe(12);
    for (const t of ts) {
      expect(t.outcome).toBe('completed');
      expect(t.agentDurationMs).not.toBeNull();
      expect(t.model).toMatch(/^claude-/);
      const matches = Math.abs(t.finishedAt - t.submittedAt - t.agentDurationMs!) < 1000;
      // Claude Code times an agent-initiated continuation (task notification, peer hand-back) from the
      // last *human* prompt; tminus times every turn from its own prompt (docs/AGENT_FORMATS.md).
      if (t.features.trigger === 'human') expect(matches).toBe(true);
    }
    expect(ts.filter((t) => t.features.trigger !== 'human').length).toBe(3);
    // 70 in human turns + 15 in the agent-initiated turn at 18:27 (invisible before peer wake-ups were turns).
    expect(ts.reduce((s, t) => s + t.toolCalls, 0)).toBe(85);
  });

  test('interrupted turn is detected and kept, neighbours are unaffected', async () => {
    const ts = await turns('synthetic-interrupt.jsonl');
    expect(ts.map((t) => t.outcome)).toEqual(['completed', 'interrupted', 'completed']);
    expect(active(ts[0])).toBe(20_010);
    expect(ts[1].finishedAt - ts[1].submittedAt).toBe(35_100);
    expect(ts[0].effort).toBe('high');
    expect(ts.map((t) => t.features.prompt.intent)).toEqual(['fix', 'refactor', 'explain']);
  });

  test('permission prompts and questions are idle, not active', async () => {
    const [t] = await turns('synthetic-permission.jsonl');
    expect(t.idleMs).toBe(75_000);
    expect(active(t)).toBe(45_010);
    expect(t.events.filter((e) => e.kind === 'waiting_user').length).toBe(2);
  });

  test('inline subagent (sidechain) records are not separate turns; their tool calls count as subagent work', async () => {
    const ts = await turns('synthetic-subagent.jsonl');
    expect(ts.length).toBe(1);
    expect(ts[0].toolCalls).toBe(1);
    expect(ts[0].subagentToolCalls).toBe(1);
    expect(active(ts[0])).toBe(45_010);
  });

  test('subagent transcripts (subagents/*.jsonl) are attributed by promptId within the turn window', async () => {
    const ts = await turns('synthetic-subagent-files.jsonl');
    expect(ts.map((t) => t.extId)).toEqual(['p1', 'p2']);
    // p1: 4 + 3 calls while it ran; a1's later calls and a3 (still running during p2) are excluded.
    expect(ts[0].toolCalls).toBe(2);
    expect(ts[0].subagentToolCalls).toBe(7);
    expect(ts[0].events.filter((e) => e.meta?.subagent).length).toBe(7);
    // p2 spawned nothing; a3's activity belongs to p1's prompt, not p2.
    expect(ts[1].subagentToolCalls).toBe(0);
  });

  test('todo list growing mid-run', async () => {
    const [t] = await turns('synthetic-todo-growth.jsonl');
    expect(t.todoTotal).toBe(5);
    const updates = t.events.filter((e) => e.kind === 'todo_update').map((e) => e.meta);
    expect(updates).toEqual([{ done: 0, total: 3 }, { done: 2, total: 5 }, { done: 5, total: 5 }]);
  });

  test('a peer hand-back starts an agent-initiated turn instead of being skipped', async () => {
    const ts = await turns('synthetic-peer-wake.jsonl');
    expect(ts.map((t) => [t.extId, t.features.trigger])).toEqual([['p1', 'human'], ['p2', 'system']]);
    expect(ts[0].finishedAt - ts[0].submittedAt).toBe(10_010);
    expect(ts[1].toolCalls).toBe(1);
  });

  test('corrupted lines are skipped, not fatal', async () => {
    const stats = { bad: 0, lines: 0 };
    const ts = await turns('synthetic-corrupt.jsonl', stats);
    expect(stats.bad).toBe(2);
    expect(ts.length).toBe(1);
    expect(ts[0].outcome).toBe('completed');
  });

  test('effort from assistant records; phase labels from what the agent says and runs; `!` shell commands are not turns', async () => {
    const ts = await turns('synthetic-phases.jsonl');
    expect(ts.length).toBe(1);
    const t = ts[0];
    expect(t.effort).toBe('medium');
    expect(t.features.session.effort).toBe('medium');
    const phases = t.events.filter((e) => e.kind === 'phase').map((e) => (e.meta as any).c as string[]);
    expect(phases).toEqual([['text', 'text:early'], ['cmd:test', 'cmd:run'], ['cmd:commit'], ['text', 'text:late']]);
    // Labels only: neither the agent's words nor the commands are kept.
    const json = JSON.stringify(t);
    expect(json).not.toContain('secret-file');
    expect(json).not.toContain('flaky clock');
    expect(json).not.toContain('test setup');
  });

  test('no prompt text survives into features', async () => {
    const ts = await turns('synthetic-interrupt.jsonl');
    expect(JSON.stringify(ts)).not.toContain('auth module');
  });
});

describe('Claude Code hooks', () => {
  const common = { session_id: 's1', prompt_id: 'p1', transcript_path: '/tmp/t.jsonl', cwd: '/w', permission_mode: 'default', effort: 'high' };

  test('UserPromptSubmit derives features and drops the prompt', () => {
    const ev = parseClaudeHook({ ...common, hook_event_name: 'UserPromptSubmit', prompt: 'refactor the auth module in src/auth.ts' })!;
    expect(ev.kind).toBe('prompt_submit');
    expect(ev.promptFeatures!.intent).toBe('refactor');
    expect(ev.promptFeatures!.refs).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toContain('auth module');
    expect(ev.effort).toBe('high');
    expect(ev.promptId).toBe('p1');
  });

  test('tool, permission, notification and stop events', () => {
    expect(parseClaudeHook({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'x' })!.kind).toBe('tool_start');
    const post = parseClaudeHook({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'x', duration_ms: 1234 })!;
    expect(post).toMatchObject({ kind: 'tool_end', durationMs: 1234 });
    expect(parseClaudeHook({ ...common, hook_event_name: 'PermissionRequest', tool_name: 'Bash' })!.kind).toBe('waiting_user');
    expect(parseClaudeHook({ ...common, hook_event_name: 'Notification', notification_type: 'permission_prompt' })!.kind).toBe('waiting_user');
    expect(parseClaudeHook({ ...common, hook_event_name: 'Notification', notification_type: 'idle_prompt' })).toBeNull();
    expect(parseClaudeHook({ ...common, hook_event_name: 'Stop' })!.kind).toBe('stop');
    expect(parseClaudeHook({ ...common, hook_event_name: 'StopFailure', error: 'rate_limit' })).toMatchObject({ kind: 'error', reason: 'rate_limit' });
    expect(parseClaudeHook({ ...common, hook_event_name: 'PreToolUse', tool_name: 'mcp__figma__get', agent_id: 'a1' })).toMatchObject({ toolName: 'mcp', subagentId: 'a1' });
  });

  test('unknown or malformed payloads are ignored', () => {
    expect(parseClaudeHook({ ...common, hook_event_name: 'SomeFutureEvent' })).toBeNull();
    expect(parseClaudeHook({ hook_event_name: 'Stop' })).toBeNull();
    expect(parseClaudeHook('nope')).toBeNull();
    expect(parseClaudeHook(null)).toBeNull();
  });

  test('Bash commands are classified inside the hook; the command itself goes no further', () => {
    const ev = parseClaudeHook({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test -- --grep "customer 4411"' } })!;
    expect(ev.phase).toEqual(['cmd:test']);
    expect(JSON.stringify(ev)).not.toContain('4411');
    expect(parseClaudeHook({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } })!.phase).toBeNull();
  });

  test('todo tools carry only ids and statuses', () => {
    const ev = parseClaudeHook({ ...common, hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'secret plan', status: 'completed' }, { content: 'x', status: 'in_progress' }] } })!;
    expect(ev.todo).toEqual({ kind: 'snapshot', items: [{ id: '0', status: 'completed' }, { id: '1', status: 'in_progress' }] });
    expect(JSON.stringify(ev)).not.toContain('secret plan');
    expect(todoFromToolInput('TaskUpdate', { taskId: 3, status: 'completed' })).toEqual({ kind: 'upsert', id: '3', status: 'completed' });
    expect(taskIdFromResponse({ task: { id: '7', subject: 's' } })).toBe('7');
    expect(taskIdFromResponse('Task #12 created successfully')).toBe('12');
  });

  test('interrupt probe finds the marker in newly appended transcript bytes', () => {
    const dir = join(process.env.TMINUS_TEST_ROOT!, 'probe');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 't.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', timestamp: '2026-10-20T10:00:00Z', message: { content: 'go' } }) + '\n');
    let r = probeTranscript(file, 0);
    expect(r.interruptedAt).toBeNull();
    appendFileSync(file, JSON.stringify({ type: 'user', timestamp: '2026-10-20T10:01:00Z', message: { content: '[Request interrupted by user]' } }) + '\n');
    r = probeTranscript(file, r.offset);
    expect(r.interruptedAt).toBe(Date.parse('2026-10-20T10:01:00Z'));
    expect(probeTranscript(join(dir, 'missing.jsonl'), 0).interruptedAt).toBeNull();
  });

  test('the probe reports phase labels for new assistant messages (not subagents)', () => {
    const dir = join(process.env.TMINUS_TEST_ROOT!, 'probe2');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 't.jsonl');
    writeFileSync(file, '');
    appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T10:00:05Z', message: { content: [{ type: 'text', text: 'Now let me implement the parser.' }] } }) + '\n');
    appendFileSync(file, JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: '2026-10-20T10:00:06Z', message: { content: [{ type: 'text', text: 'Let me start exploring.' }] } }) + '\n');
    const r = probeTranscript(file, 0);
    expect(r.phases).toEqual([{ ts: Date.parse('2026-10-20T10:00:05Z'), labels: ['text', 'text:middle'] }]);
  });
});
