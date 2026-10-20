import { describe, expect, test } from 'bun:test';
import {
  BucketPredictor, Engine, openDb, paths, promptFeatures, readState, type NormalizedEvent, type TrainingRow,
} from '@tminus/core';

const T0 = Date.parse('2026-10-20T10:00:00Z');

function setup(history: TrainingRow[] = []) {
  let now = T0;
  const db = openDb(':memory:');
  const engine = new Engine({ db, predictor: BucketPredictor.train(history), now: () => now, writeStates: true });
  let seq = 0;
  const sid = `s-${Math.random().toString(36).slice(2, 8)}`;
  const ev = (kind: NormalizedEvent['kind'], extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    agent: 'claude-code', sessionId: sid, kind, ts: now, promptId: 'p1', toolUseId: `tu${++seq}`, ...extra,
  });
  return {
    db, engine, sid,
    at: (sec: number) => { now = T0 + sec * 1000; },
    send: (kind: NormalizedEvent['kind'], extra: Partial<NormalizedEvent> = {}) => engine.handle(ev(kind, extra)),
    turn: () => db.prepare(`SELECT * FROM turns ORDER BY id DESC LIMIT 1`).get(),
  };
}

const history = (n: number, ms: number): TrainingRow[] => Array.from({ length: n }, (_, i) => ({ model: null, effort: null, intent: 'fix', activeMs: ms * (0.6 + (i % 9) / 10), toolCalls: 12 }));

describe('live engine', () => {
  test('permission waits are excluded from active time', () => {
    const h = setup(history(40, 60_000));
    h.at(0); h.send('prompt_submit', { promptFeatures: promptFeatures('fix the login bug'), trigger: 'human' });
    h.at(5); h.send('tool_start', { toolName: 'Read' });
    h.at(6); h.send('tool_end', { toolName: 'Read', durationMs: 900 });
    h.at(10); h.send('waiting_user', { reason: 'permission', toolName: 'Bash' });
    expect(h.engine.snapshot(h.sid)!.status).toBe('waiting');
    h.at(70); h.send('tool_end', { toolName: 'Bash', durationMs: 2_000 });
    h.at(90); h.send('stop');
    const t = h.turn();
    // Wait was 10s..68s (the tool ran for the last 2s after approval).
    expect(t.idle_ms).toBe(58_000);
    expect(t.active_ms).toBe(90_000 - 58_000);
    expect(t.outcome).toBe('completed');
    expect(t.tool_calls).toBe(1);
    expect(t.source).toBe('live');
    expect(t.predicted_p50_ms).toBeGreaterThan(0);
  });

  test('questions to the user (AskUserQuestion) count as idle', () => {
    const h = setup();
    h.at(0); h.send('prompt_submit', { promptFeatures: promptFeatures('set up the database') });
    h.at(10); h.send('tool_start', { toolName: 'AskUserQuestion' });
    h.at(50); h.send('tool_end', { toolName: 'AskUserQuestion' });
    h.at(60); h.send('stop');
    expect(h.turn().idle_ms).toBe(40_000);
  });

  test('a new prompt while a turn is open marks it interrupted', () => {
    const h = setup();
    h.at(0); h.send('prompt_submit', { promptId: 'p1', promptFeatures: promptFeatures('refactor everything') });
    h.at(20); h.send('tool_start', { promptId: 'p1', toolName: 'Edit' });
    h.at(100); h.send('prompt_submit', { promptId: 'p2', promptFeatures: promptFeatures('stop, explain instead') });
    const rows = h.db.prepare(`SELECT * FROM turns ORDER BY id`).all();
    expect(rows[0].outcome).toBe('interrupted');
    expect(rows[0].finished_at).toBe(T0 + 20_000); // last activity, not the next prompt
    expect(rows[1].finished_at).toBeNull();
  });

  test('remaining time grows (does not freeze) when a turn overruns', () => {
    const h = setup(history(60, 60_000));
    h.at(0); h.send('prompt_submit', { promptFeatures: promptFeatures('fix the flaky test') });
    const p90 = h.engine.snapshot(h.sid)!.turn!.p90TotalMs;
    const remaining: number[] = [];
    for (const sec of [p90 / 1000 * 1.2, p90 / 1000 * 2, p90 / 1000 * 4, p90 / 1000 * 8]) {
      h.at(sec);
      h.engine.tick();
      const s = h.engine.snapshot(h.sid)!;
      expect(s.turn!.overrun).toBe(true);
      remaining.push(s.turn!.p50RemainingMs);
    }
    for (let i = 1; i < remaining.length; i++) expect(remaining[i]).toBeGreaterThan(remaining[i - 1]);
  });

  test('estimate updates on tool events and todo changes; state file is written atomically', () => {
    const h = setup(history(40, 120_000));
    h.at(0); h.send('prompt_submit', { promptFeatures: promptFeatures('build the settings page') });
    h.at(5); h.send('tool_start', { toolName: 'TodoWrite', todo: { kind: 'snapshot', items: [1, 2, 3, 4].map((i) => ({ id: String(i), status: 'pending' as const })) } });
    const s1 = readState(paths.sessionState(h.sid))!;
    expect(s1.turn!.todo).toEqual({ done: 0, total: 4 });
    h.at(60); h.send('tool_start', { toolName: 'TodoWrite', todo: { kind: 'snapshot', items: [1, 2, 3, 4].map((i) => ({ id: String(i), status: i <= 2 ? 'completed' as const : 'pending' as const })) } });
    const s2 = readState(paths.sessionState(h.sid))!;
    expect(s2.turn!.todo).toEqual({ done: 2, total: 4 });
    expect(s2.turn!.weights.todo).toBeGreaterThan(s1.turn!.weights.todo);
    expect(readState(paths.current)!.sessionId).toBe(h.sid);
    const preds = h.db.prepare(`SELECT COUNT(*) n FROM predictions`).get().n;
    expect(preds).toBeGreaterThanOrEqual(3);
  });

  test('a stop-hook continuation reopens the same turn', () => {
    const h = setup();
    h.at(0); h.send('prompt_submit', { promptFeatures: promptFeatures('write docs') });
    h.at(30); h.send('stop');
    h.at(31); h.send('tool_start', { toolName: 'Edit' });
    h.at(50); h.send('stop');
    const rows = h.db.prepare(`SELECT * FROM turns`).all();
    expect(rows.length).toBe(1);
    expect(rows[0].active_ms).toBe(50_000);
  });

  test('subagent events after the turn ended do not open a turn', () => {
    const h = setup();
    h.at(0); h.send('prompt_submit', { promptFeatures: promptFeatures('research the api') });
    h.at(10); h.send('stop');
    h.at(200); h.send('tool_start', { toolName: 'Grep', subagentId: 'agent-1' });
    h.at(201); h.send('subagent_stop');
    expect(h.db.prepare(`SELECT COUNT(*) n FROM turns`).get().n).toBe(1);
  });

  test('agent-initiated turns (no prompt hook) are tracked but not trained on', () => {
    const h = setup();
    h.at(0); h.send('prompt_submit', { promptFeatures: promptFeatures('kick off a background job') });
    h.at(10); h.send('stop');
    h.at(600); h.send('tool_start', { promptId: 'p-notify', toolName: 'Read' });
    h.at(640); h.send('stop', { promptId: 'p-notify' });
    const t = h.turn();
    expect(t.trigger).toBe('notification');
    expect(t.active_ms).toBe(40_000);
    expect(h.engine.predictor.size).toBe(1);
  });

  test('restore() rebuilds an open turn after a collector restart', () => {
    const h = setup(history(30, 60_000));
    h.at(0); h.send('prompt_submit', { promptFeatures: promptFeatures('fix it') });
    h.at(10); h.send('waiting_user', { reason: 'permission' });
    h.at(40); h.send('tool_end', { toolName: 'Bash' });
    const engine2 = new Engine({ db: h.db, predictor: BucketPredictor.train(history(30, 60_000)), now: () => T0 + 50_000, writeStates: false });
    expect(engine2.restore()).toBe(1);
    const s = engine2.snapshot(h.sid)!;
    expect(s.status).toBe('running');
    expect(s.turn!.idleMs).toBe(30_000);
    expect(s.turn!.elapsedMs).toBe(20_000);
  });
});

describe('late session context', () => {
  test('effort/model learned after submit are recorded on the turn', () => {
    const h = setup();
    h.at(0); h.send('prompt_submit', { promptFeatures: promptFeatures('fix it'), effort: null, model: null });
    h.at(5); h.send('tool_start', { toolName: 'Bash', effort: 'xhigh', model: 'claude-opus-5-5' });
    h.at(9); h.send('stop');
    const t = h.turn();
    expect(t.effort).toBe('xhigh');
    expect(t.model).toBe('claude-opus-5-5');
    expect(JSON.parse(t.features_json).session.effort).toBe('xhigh');
  });
});

describe('subagent work', () => {
  test('subagent tool calls count toward the activity signal and are stored separately', () => {
    const h = setup(history(40, 120_000));
    h.at(0); h.send('prompt_submit', { promptId: 'p1', promptFeatures: promptFeatures('audit the api') });
    h.at(2); h.send('tool_start', { promptId: 'p1', toolName: 'Agent' });
    for (let i = 0; i < 12; i++) { h.at(5 + i); h.send('tool_start', { promptId: 'p1', toolName: 'Read', subagentId: 'a1' }); }
    // A background subagent left over from an earlier prompt is not this turn's work.
    h.at(20); h.send('tool_start', { promptId: 'p0', toolName: 'Read', subagentId: 'old' });
    const s = h.engine.snapshot(h.sid)!;
    expect(s.turn!.toolCalls).toBe(1);
    expect(s.turn!.subagentToolCalls).toBe(12);
    expect(s.turn!.weights.activity).toBeGreaterThan(0);
    h.at(40); h.send('stop', { promptId: 'p1' });
    const t = h.turn();
    expect(t.tool_calls).toBe(1);
    expect(t.subagent_tool_calls).toBe(12);
    const recorded = h.db.prepare(`SELECT COUNT(*) n FROM events WHERE turn_id = ? AND meta_json LIKE '%subagent%'`).get(t.id).n;
    expect(recorded).toBe(12);
  });

  test('a subagent waiting on a permission prompt is idle until that subagent moves again', () => {
    const h = setup();
    h.at(0); h.send('prompt_submit', { promptId: 'p1', promptFeatures: promptFeatures('fix it') });
    h.at(10); h.send('waiting_user', { promptId: 'p1', reason: 'permission', subagentId: 'a1' });
    h.at(15); h.send('tool_start', { promptId: 'p1', toolName: 'Read' }); // main thread keeps going; wait stays open
    h.at(40); h.send('tool_end', { promptId: 'p1', toolName: 'Bash', subagentId: 'a1' });
    h.at(50); h.send('stop', { promptId: 'p1' });
    expect(h.turn().idle_ms).toBe(30_000);
  });
});

describe('countSubagentWork = false', () => {
  test('subagent calls are still stored but not fed to the activity signal', () => {
    let now = T0;
    const db = openDb(':memory:');
    const engine = new Engine({ db, predictor: BucketPredictor.train(history(40, 120_000)), now: () => now, countSubagentWork: false });
    const ev = (kind: NormalizedEvent['kind'], extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({ agent: 'claude-code', sessionId: 'off', kind, ts: now, promptId: 'p1', ...extra });
    engine.handle(ev('prompt_submit', { promptFeatures: promptFeatures('audit the api') }));
    for (let i = 0; i < 12; i++) { now += 1000; engine.handle(ev('tool_start', { toolName: 'Read', subagentId: 'a1' })); }
    const s = engine.snapshot('off')!;
    expect(s.turn!.subagentToolCalls).toBe(12);
    expect(s.turn!.weights.activity).toBe(0); // no main-thread calls, so no activity signal
  });
});
