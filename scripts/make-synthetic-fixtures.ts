/**
 * Generates the synthetic transcript fixtures in tests/fixtures. Each file
 * exercises one edge case; expected values are asserted in tests/adapters.*.test.ts.
 *   bun scripts/make-synthetic-fixtures.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..', 'tests', 'fixtures');
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let uid = 0;
const id = () => `u${++uid}`;

type Rec = Record<string, unknown>;
const base = (sessionId: string): Rec => ({ sessionId, cwd: '/redacted/project', version: '2.1.304', userType: 'external' });

function prompt(sid: string, s: number, text: string, promptId: string, extra: Rec = {}): Rec {
  return { ...base(sid), type: 'user', uuid: id(), promptId, timestamp: at(s), origin: { kind: 'human' }, promptSource: 'typed', permissionMode: 'default', message: { role: 'user', content: text }, ...extra };
}
function toolUse(sid: string, s: number, tools: { id: string; name: string; input?: Rec }[], extra: Rec = {}): Rec {
  return { ...base(sid), type: 'assistant', uuid: id(), timestamp: at(s), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000, output_tokens: 300 }, content: tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input ?? {} })) }, ...extra };
}
function toolResult(sid: string, s: number, toolUseId: string, content = 'ok', extra: Rec = {}): Rec {
  return { ...base(sid), type: 'user', uuid: id(), timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] }, permissionDecision: { decision: 'accept', source: 'config' }, ...extra };
}
function reply(sid: string, s: number, extra: Rec = {}): Rec {
  return { ...base(sid), type: 'assistant', uuid: id(), timestamp: at(s), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 5, cache_read_input_tokens: 42000, output_tokens: 200 }, content: [{ type: 'text', text: 'done' }] }, ...extra };
}
function turnDuration(sid: string, s: number, durationMs: number): Rec {
  return { ...base(sid), type: 'system', subtype: 'turn_duration', uuid: id(), timestamp: at(s), durationMs };
}
function effort(sid: string, s: number, level: string): Rec {
  return { type: 'api-request', sessionId: sid, timestamp: at(s), params: { model: 'claude-opus-5-5', output_config: { effort: level } } };
}
const todos = (...st: string[]) => ({ todos: st.map((status, i) => ({ content: `step ${i}`, status, activeForm: `step ${i}` })) });

function write(name: string, recs: (Rec | string)[]) {
  mkdirSync(join(dir, 'claude-code'), { recursive: true });
  writeFileSync(join(dir, 'claude-code', name), recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

// 1. Interrupted turn between two normal ones.
{
  const s = 'syn-interrupt';
  write('synthetic-interrupt.jsonl', [
    { type: 'permission-mode', permissionMode: 'default', sessionId: s },
    prompt(s, 0, 'fix the failing build in src/app.ts', 'p1'),
    effort(s, 0.1, 'high'),
    toolUse(s, 5, [{ id: 'a1', name: 'Read' }]),
    toolResult(s, 6, 'a1'),
    reply(s, 20),
    turnDuration(s, 20.01, 20010),
    prompt(s, 60, 'now refactor the whole auth module', 'p2'),
    toolUse(s, 70, [{ id: 'b1', name: 'Bash' }]),
    toolResult(s, 95, 'b1', '[Request interrupted by user for tool use]'),
    prompt(s, 95.1, '[Request interrupted by user for tool use]', 'p2'),
    prompt(s, 120, 'just explain what the auth module does?', 'p3'),
    reply(s, 150),
    turnDuration(s, 150.02, 30020),
  ]);
}

// 2. Permission prompt approved by the user (45s) + an AskUserQuestion (30s): 75s idle.
{
  const s = 'syn-permission';
  write('synthetic-permission.jsonl', [
    prompt(s, 0, 'delete the old migrations and update the schema', 'p1'),
    toolUse(s, 10, [{ id: 'q1', name: 'AskUserQuestion' }]),
    toolResult(s, 40, 'q1'),
    toolUse(s, 50, [{ id: 'b1', name: 'Bash' }]),
    toolResult(s, 95, 'b1', 'ok', { permissionDecision: { decision: 'accept', source: 'user_temporary' } }),
    toolUse(s, 100, [{ id: 'e1', name: 'Edit' }]),
    toolResult(s, 101, 'e1'),
    reply(s, 120),
    turnDuration(s, 120.01, 120010),
  ]);
}

// 3. Subagent records inside the main transcript (older versions) are ignored.
{
  const s = 'syn-subagent';
  write('synthetic-subagent.jsonl', [
    prompt(s, 0, 'review the PR and audit the security of the API', 'p1'),
    toolUse(s, 3, [{ id: 'ag1', name: 'Agent' }]),
    { ...prompt(s, 4, 'subagent task prompt', 'sp1'), isSidechain: true },
    { ...toolUse(s, 5, [{ id: 'sa1', name: 'Grep' }]), isSidechain: true },
    { ...toolResult(s, 6, 'sa1'), isSidechain: true },
    { ...reply(s, 30), isSidechain: true },
    toolResult(s, 31, 'ag1'),
    reply(s, 45),
    turnDuration(s, 45.01, 45010),
  ]);
}

// 4. Todo list that grows mid-run: 3 items, then 5 with 2 done, then all done.
{
  const s = 'syn-todo';
  write('synthetic-todo-growth.jsonl', [
    prompt(s, 0, 'build a settings page with a form, validation and tests', 'p1'),
    toolUse(s, 5, [{ id: 't1', name: 'TodoWrite', input: todos('in_progress', 'pending', 'pending') }]),
    toolResult(s, 5.1, 't1'),
    toolUse(s, 30, [{ id: 'w1', name: 'Write' }]),
    toolResult(s, 31, 'w1'),
    toolUse(s, 60, [{ id: 't2', name: 'TodoWrite', input: todos('completed', 'completed', 'in_progress', 'pending', 'pending') }]),
    toolResult(s, 60.1, 't2'),
    toolUse(s, 120, [{ id: 't3', name: 'TodoWrite', input: todos('completed', 'completed', 'completed', 'completed', 'completed') }]),
    toolResult(s, 120.1, 't3'),
    reply(s, 140),
    turnDuration(s, 140.01, 140010),
  ]);
}

// 5. Corrupted and partial lines mixed in.
{
  const s = 'syn-corrupt';
  write('synthetic-corrupt.jsonl', [
    prompt(s, 0, 'add a dark mode toggle', 'p1'),
    '{"type":"assistant","timestamp":"2026-10-01T10:00:0',
    'not json at all',
    toolUse(s, 4, [{ id: 'e1', name: 'Edit' }]),
    toolResult(s, 5, 'e1'),
    '{"type": "future-record-type", "payload": {"x": 1}}',
    reply(s, 12),
    turnDuration(s, 12.01, 12010),
  ]);
}
// 6. Subagent transcripts in <session>/subagents/: their tool calls count toward the turn that
//    spawned them (same promptId), but only while that turn is running.
{
  const s = 'syn-subagent-files';
  write('synthetic-subagent-files.jsonl', [
    prompt(s, 0, 'investigate the flaky checkout tests across all services', 'p1'),
    toolUse(s, 2, [{ id: 'ag1', name: 'Agent' }, { id: 'ag2', name: 'Agent' }]),
    toolResult(s, 60, 'ag1'),
    toolResult(s, 61, 'ag2'),
    reply(s, 80),
    turnDuration(s, 80.01, 80010),
    prompt(s, 200, 'now summarize what you found', 'p2'),
    reply(s, 215),
    turnDuration(s, 215.01, 15010),
  ]);
  const sub = (agentId: string, promptId: string, calls: number[], extra: number[] = []) => [
    { ...prompt(s, calls[0] - 0.5, 'subagent task', promptId), isSidechain: true, agentId },
    ...[...calls, ...extra].map((t, i) => ({ ...toolUse(s, t, [{ id: `${agentId}-${i}`, name: i % 2 ? 'Grep' : 'Read' }]), isSidechain: true, agentId, promptId })),
    { ...reply(s, Math.max(...calls, ...extra) + 1), isSidechain: true, agentId },
  ];
  const subDir = join(dir, 'claude-code', 'synthetic-subagent-files', 'subagents');
  mkdirSync(subDir, { recursive: true });
  // a1: 4 calls during p1, plus 2 after p1 ended (background work; not counted).
  writeFileSync(join(subDir, 'agent-a1.jsonl'), sub('a1', 'p1', [5, 10, 20, 40], [100, 120]).map((r) => JSON.stringify(r)).join('\n') + '\n');
  // a2: 3 calls during p1.
  writeFileSync(join(subDir, 'agent-a2.jsonl'), sub('a2', 'p1', [6, 30, 55]).map((r) => JSON.stringify(r)).join('\n') + '\n');
  // a3: spawned by p1 but still running during p2: its calls belong to p1, not p2.
  writeFileSync(join(subDir, 'agent-a3.jsonl'), sub('a3', 'p1', [205, 210]).map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(subDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'ag1' }));
}
console.log('fixtures written to', dir);

// 7. A peer hand-back (isMeta user record, origin peer) starts its own agent-initiated turn.
{
  const s = 'syn-peer';
  write('synthetic-peer-wake.jsonl', [
    prompt(s, 0, 'kick off the research agents', 'p1'),
    toolUse(s, 2, [{ id: 'ag1', name: 'Agent' }]),
    toolResult(s, 3, 'ag1'),
    reply(s, 10),
    turnDuration(s, 10.01, 10010),
    { ...prompt(s, 300, 'subagent report: findings attached', 'p2'), isMeta: true, origin: { kind: 'peer' }, promptSource: 'system' },
    toolUse(s, 305, [{ id: 'r1', name: 'Read' }]),
    toolResult(s, 306, 'r1'),
    reply(s, 330),
    turnDuration(s, 330.01, 30010),
    // Ordinary meta context (no wake origin) is not a turn.
    { ...prompt(s, 400, 'caveat: local command output follows', 'p3'), isMeta: true, origin: undefined },
  ]);
}
