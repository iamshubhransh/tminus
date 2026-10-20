import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexTailer, codex as codexAdapter, parseCodexHook, parseCodexRollout } from '@tminus/adapters';
import type { NormalizedEvent, NormalizedTurn } from '@tminus/core';

const FX = join(import.meta.dir, 'fixtures', 'codex');

async function turns(file: string): Promise<NormalizedTurn[]> {
  const out: NormalizedTurn[] = [];
  for await (const t of parseCodexRollout(join(FX, file))) out.push(t);
  return out;
}

describe('Codex backfill', () => {
  test('modern rollout (0.15x): turns, aborts and duration_ms agree', async () => {
    const ts = await turns('real-modern.jsonl');
    expect(ts.length).toBe(7);
    expect(ts.filter((t) => t.outcome === 'interrupted').length).toBe(2);
    for (const t of ts.filter((x) => x.agentDurationMs)) {
      // tminus measures from task_started to task_complete; Codex reports its own duration.
      expect(Math.abs(t.finishedAt - t.submittedAt - t.agentDurationMs!) / t.agentDurationMs!).toBeLessThan(0.02);
    }
    expect(new Set(ts.map((t) => t.model))).toEqual(new Set(['gpt-5.6-sol', 'gpt-6-astra']));
    expect(ts[0].effort).toBeTruthy();
  });

  test('codex exec sessions are tagged sdk', async () => {
    const ts = await turns('real-exec.jsonl');
    expect(ts.length).toBe(1);
    expect(ts[0].features.trigger).toBe('sdk');
    expect(ts[0].toolCalls).toBeGreaterThan(10);
  });
});

describe('Codex live tailer', () => {
  test('emits only the open turn on attach, then new events as the file grows', () => {
    const root = join(process.env.TMINUS_TEST_ROOT!, 'codex-tail');
    const d = new Date();
    const dir = join(root, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-2026-10-20T10-00-00-abc.jsonl');
    const iso = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
    const line = (o: object) => JSON.stringify(o) + '\n';
    writeFileSync(file,
      line({ timestamp: iso(0), type: 'session_meta', payload: { id: 'thread-1', cwd: '/w', source: 'cli' } }) +
      // A finished turn: must not be replayed.
      line({ timestamp: iso(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 'old' } }) +
      line({ timestamp: iso(2), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old' } }) +
      // The running turn.
      line({ timestamp: iso(10), type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } }) +
      line({ timestamp: iso(10), type: 'turn_context', payload: { turn_id: 't2', model: 'gpt-6-astra', effort: 'high' } }) +
      line({ timestamp: iso(11), type: 'event_msg', payload: { type: 'user_message', message: 'fix the failing build' } }));
    const got: NormalizedEvent[] = [];
    const tailer = new CodexTailer((ev) => got.push(ev), root);
    tailer.poll();
    expect(got.map((e) => e.kind)).toEqual(['prompt_submit']);
    expect(got[0]).toMatchObject({ sessionId: 'thread-1', promptId: 't2', model: 'gpt-6-astra', effort: 'high' });
    expect(got[0].promptFeatures!.intent).toBe('fix');

    appendFileSync(file,
      line({ timestamp: iso(20), type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'c1', arguments: JSON.stringify({ plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }] }) } }) +
      line({ timestamp: iso(21), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } }) +
      line({ timestamp: iso(22), type: 'event_msg', payload: { type: 'exec_approval_request' } }) +
      line({ timestamp: iso(40), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2', duration_ms: 30000 } }) +
      '{"timestamp": "partial line without newline');
    tailer.poll();
    expect(got.map((e) => e.kind)).toEqual(['prompt_submit', 'tool_start', 'tool_end', 'waiting_user', 'stop']);
    expect(got[1].todo).toEqual({ kind: 'snapshot', items: [{ id: '0', status: 'completed' }, { id: '1', status: 'in_progress' }] });
    expect(readFileSync(file, 'utf8')).toContain('partial');
  });
});

describe('Codex hooks', () => {
  test('payloads map to events; prompt text is not kept', () => {
    const c = { session_id: 's', turn_id: 't', transcript_path: '/r.jsonl', cwd: '/w', model: 'gpt-6-astra', permission_mode: 'default' };
    const p = parseCodexHook({ ...c, hook_event_name: 'UserPromptSubmit', prompt: 'add tests for the parser' })!;
    expect(p).toMatchObject({ kind: 'prompt_submit', promptId: 't', model: 'gpt-6-astra' });
    expect(p.promptFeatures!.intent).toBe('test');
    expect(JSON.stringify(p)).not.toContain('parser');
    expect(parseCodexHook({ ...c, hook_event_name: 'PermissionRequest', tool_name: 'Bash' })!.kind).toBe('waiting_user');
    expect(parseCodexHook({ ...c, hook_event_name: 'Interrupt' })).toMatchObject({ kind: 'error', reason: 'interrupted' });
    expect(parseCodexHook({ ...c, hook_event_name: 'Nope' })).toBeNull();
  });
});

describe('Codex subagent threads', () => {
  const line = (o: object) => JSON.stringify(o) + '\n';
  const at = (s: number) => new Date(Date.parse('2026-10-01T10:00:00Z') + s * 1000).toISOString();
  const parent = [
    line({ timestamp: at(0), type: 'session_meta', payload: { id: 'parent-1', cwd: '/w', source: 'cli', thread_source: 'user' } }),
    line({ timestamp: at(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
    line({ timestamp: at(1), type: 'event_msg', payload: { type: 'user_message', message: 'audit every endpoint' } }),
    line({ timestamp: at(2), type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'c1', arguments: '{}' } }),
    line({ timestamp: at(50), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } }),
    line({ timestamp: at(60), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', duration_ms: 59000 } }),
  ].join('');
  const child = [
    line({ timestamp: at(3), type: 'session_meta', payload: { id: 'child-1', cwd: '/w', source: 'cli', thread_source: 'subagent', parent_thread_id: 'parent-1', agent_role: 'explorer' } }),
    line({ timestamp: at(3), type: 'event_msg', payload: { type: 'task_started', turn_id: 'ct1' } }),
    line({ timestamp: at(3), type: 'event_msg', payload: { type: 'user_message', message: 'look at the routes' } }),
    ...[5, 10, 20].map((t, i) => line({ timestamp: at(t), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: `s${i}`, arguments: '{}' } })),
    line({ timestamp: at(45), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'ct1' } }),
  ].join('');

  test('backfill attributes child-thread tool calls to the parent turn and yields no child turns', async () => {
    const root = join(process.env.TMINUS_TEST_ROOT!, 'codex-sub');
    const dir = join(root, 'sessions', '2026', '10', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rollout-2026-10-01T10-00-00-parent-1.jsonl'), parent);
    writeFileSync(join(dir, 'rollout-2026-10-01T10-00-03-child-1.jsonl'), child);
    process.env.CODEX_HOME = root;
    const out: NormalizedTurn[] = [];
    try { for await (const t of codexAdapter.backfill({})) out.push(t); } finally { process.env.CODEX_HOME = join(process.env.TMINUS_TEST_ROOT!, 'codex'); }
    expect(out.length).toBe(1);
    expect(out[0].sessionId).toBe('parent-1');
    expect(out[0].toolCalls).toBe(1);
    expect(out[0].subagentToolCalls).toBe(3);
  });

  test('the live tailer reports child-thread work against the parent session', () => {
    const root = join(process.env.TMINUS_TEST_ROOT!, 'codex-sub-live');
    const d = new Date();
    const dir = join(root, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-child.jsonl');
    writeFileSync(file, line({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'child-2', thread_source: 'subagent', parent_thread_id: 'parent-2' } }));
    const got: NormalizedEvent[] = [];
    const tailer = new CodexTailer((ev) => got.push(ev), root);
    tailer.poll();
    appendFileSync(file,
      line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'x' } }) +
      line({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'k1', arguments: '{}' } }) +
      line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'x' } }));
    tailer.poll();
    expect(got.map((e) => e.kind)).toEqual(['tool_start']);
    expect(got[0]).toMatchObject({ sessionId: 'parent-2', subagentId: 'child-2', promptId: null });
  });
});
