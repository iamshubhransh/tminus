import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ADAPTERS } from '@tminus/adapters';
import {
  collectorPid, ensureCollector, fmtPrecise, fmtRange, fmtShort, loadConfig, openDb, paths, predictorStatus, readState,
  schemaVersion, SCHEMA_VERSION, selfCommand, type LiveState,
} from '@tminus/core';
import { renderSegment, renderStatusline, renderTmux } from '@tminus/render';
import { flagBool, flagStr, type Args } from '../args.ts';
import { installedSelf } from '../self.ts';
import { c, table } from '../ui.ts';

export async function cmdRender(a: Args): Promise<number> {
  const format = flagStr(a, 'format');
  const color = flagBool(a, 'no-color') ? false : undefined;
  if (flagBool(a, 'tmux')) {
    // tmux polls us on its own interval, so this is also a good place to keep the collector alive.
    ensureCollector();
    process.stdout.write(renderTmux({ format, color }));
    return 0;
  }
  const out = await renderStatusline({ wrap: flagBool(a, 'wrap'), format, color });
  process.stdout.write(out);
  return 0;
}

function pickState(a: Args): LiveState | null {
  const sid = flagStr(a, 'session');
  return readState(sid ? paths.sessionState(sid) : paths.current);
}

export async function cmdStatus(a: Args): Promise<number> {
  const s = pickState(a);
  if (flagBool(a, 'json')) { console.log(JSON.stringify(s, null, 2)); return 0; }
  const pid = collectorPid();
  if (!s) {
    console.log('No session state yet. Submit a prompt in Claude Code (or Codex) after `tminus init`.');
    console.log(c.dim(`collector: ${pid ? `running (pid ${pid})` : 'not running'}`));
    return 0;
  }
  const now = Date.now();
  const seg = renderSegment(s, now, loadConfig(), 'none').text;
  console.log(`${c.bold(s.agent)} ${c.dim(s.sessionId.slice(0, 8))}${s.project ? c.dim(` · ${s.project}`) : ''} · ${s.status}${seg ? `  ${seg}` : ''}`);
  const t = s.turn;
  if (t) {
    const rows = [
      ['intent', t.intent],
      ['elapsed (active)', `${fmtPrecise(t.elapsedMs)}${t.idleMs > 0 ? c.dim(` (+${fmtPrecise(t.idleMs)} waiting on you, excluded)`) : ''}`],
      ['remaining', `~${fmtShort(t.p50RemainingMs)} (P50) · range ${fmtRange(t.p10RemainingMs, t.p90RemainingMs)} (P10–P90)`],
      ['predicted at submit', `~${fmtShort(t.p50TotalMs)} total, P90 ${fmtShort(t.p90TotalMs)}${t.overrun ? c.yellow(' · running long') : ''}`],
      ['prior bucket', `${t.bucket.level} (n=${t.bucket.n})`],
      ['tool calls', `${t.toolCalls}${t.subagentToolCalls ? ` (+${t.subagentToolCalls} in subagents)` : ''}`],
      ['todo', t.todo ? `${t.todo.done}/${t.todo.total} done` : '–'],
      ['signal weights', t.weights.learned != null
        ? `learned live model ${pct(t.weights.learned)} · survival prior ${pct(t.weights.prior)}`
        : `prior ${pct(t.weights.prior)} · todo ${pct(t.weights.todo)} · activity ${pct(t.weights.activity)}`],
    ];
    if (t.waitingSince) rows.push(['waiting since', `${fmtPrecise(now - t.waitingSince)} (${t.waitingReason ?? 'user'})`]);
    console.log(table(rows.map(([k, v]) => [c.dim(k), v])));
  } else if (s.last) {
    console.log(`last turn: ${fmtPrecise(s.last.actualMs)} (${s.last.outcome}), predicted ~${s.last.p50Ms ? fmtShort(s.last.p50Ms) : '?'}`);
  }
  console.log(c.dim(`updated ${fmtPrecise(now - s.updatedAt)} ago · collector ${pid ? `pid ${pid}` : 'not running'}`));
  return 0;
}

function pct(x: number): string { return `${Math.round(x * 100)}%`; }

/** Foreground view that keeps the collector alive; handy for Codex without trusted hooks. */
export async function cmdWatch(a: Args): Promise<number> {
  const cfg = loadConfig();
  const tty = process.stdout.isTTY;
  for (;;) {
    ensureCollector();
    const s = pickState(a);
    const seg = renderSegment(s, Date.now(), cfg, tty && !process.env.NO_COLOR ? 'ansi' : 'none').text || c.dim('idle');
    if (tty) process.stdout.write(`\r\x1b[2K${seg}`);
    else console.log(seg);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function timeCommand(argv: string[], input: string, runs: number, env: NodeJS.ProcessEnv = process.env): number[] {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    spawnSync(argv[0], argv.slice(1), { input, env, stdio: ['pipe', 'ignore', 'ignore'] });
    out.push(performance.now() - t0);
  }
  return out.sort((x, y) => x - y);
}

export async function cmdDoctor(a: Args): Promise<number> {
  let failures = 0;
  const ok = (msg: string) => console.log(`${c.green('✓')} ${msg}`);
  const warn = (msg: string) => console.log(`${c.yellow('!')} ${msg}`);
  const bad = (msg: string) => { failures++; console.log(`${c.red('✗')} ${msg}`); };

  console.log(c.bold('tminus doctor'));
  // Database.
  try {
    const db = openDb();
    const v = schemaVersion(db);
    const integrity = db.prepare('PRAGMA quick_check').get();
    const n = db.prepare('SELECT COUNT(*) n FROM turns').get().n;
    const live = db.prepare(`SELECT COUNT(*) n FROM turns WHERE source = 'live'`).get().n;
    (v === SCHEMA_VERSION && Object.values(integrity)[0] === 'ok' ? ok : bad)(`database ${paths.db} (schema v${v}, ${db.driver}, ${n} turns, ${live} live)`);
    const ps = predictorStatus(db, loadConfig());
    ok(`predictor: ${ps.active} (${ps.reason})`);
    db.close();
  } catch (e: any) {
    bad(`database: ${e.message}`);
  }

  // Agents.
  for (const ad of ADAPTERS) {
    if (!(await ad.detect())) { console.log(c.dim(`- ${ad.displayName}: not found`)); continue; }
    const st = await ad.installed();
    (st.hooks ? ok : warn)(`${ad.displayName}: ${st.detail.join('; ')}`);
  }

  const pid = collectorPid();
  (pid ? ok : warn)(`collector: ${pid ? `running (pid ${pid})` : 'not running (starts on the next hook event)'}`);
  if (existsSync(paths.spoolDir)) {
    const backlog = readdirSync(paths.spoolDir).filter((f) => f.endsWith('.json')).length;
    (backlog < 50 ? ok : warn)(`spool backlog: ${backlog} events`);
  }

  // Render latency, end to end (process start -> exit), through the exact entry the statusline uses.
  const inst = installedSelf();
  const [runtime, script] = selfCommand();
  const builtRender = join(dirname(script), (globalThis as any).Bun ? 'tminus-render.js' : 'tminus-render.node.mjs');
  const target = inst?.script ?? (existsSync(builtRender) ? builtRender : script);
  const runner = target.endsWith('.js') && !(globalThis as any).Bun ? 'bun' : runtime;
  const sample = JSON.stringify({ session_id: 'doctor-probe', model: { id: 'claude-opus-5-5' }, context_window: { used_percentage: 12 } });
  const runs = Number(flagStr(a, 'runs') ?? 15);
  timeCommand([runner, target, 'render', '--statusline'], sample, 2); // warm the file cache
  const times = timeCommand([runner, target, 'render', '--statusline'], sample, runs);
  const p50 = times[Math.floor(times.length / 2)];
  const p90 = times[Math.floor(times.length * 0.9)];
  (p50 < 30 ? ok : bad)(`statusline render: p50 ${p50.toFixed(1)}ms, p90 ${p90.toFixed(1)}ms over ${runs} runs (budget 30ms) via ${runner.split('/').pop()}`);
  const cli = inst ? inst.script.replace('tminus-render', 'tminus') : script;
  const hookTimes = timeCommand([runner, cli, 'hook', 'DoctorProbe'], '{}', Math.min(runs, 8));
  const h50 = hookTimes[Math.floor(hookTimes.length / 2)];
  (h50 < 100 ? ok : bad)(`hook: p50 ${h50.toFixed(1)}ms (budget 100ms)`);
  if (!(globalThis as any).Bun && runner !== 'bun') warn('running under Node: install Bun for the fastest statusline.');

  console.log(failures ? c.red(`\n${failures} problem(s) found.`) : c.green('\nAll good.'));
  return failures ? 1 : 0;
}
