import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch } from 'node:fs';
import { join } from 'node:path';
import { CodexTailer, probeTranscript } from '@tminus/adapters';
import {
  acquireCollectorLock, DATA_VERSION, Engine, getMeta, loadConfig, loadPredictor, logError, logLine, openDb, paths, predictorStatus, releaseCollectorLock,
  selfCommand, setMeta, trainableCount,
  type NormalizedEvent,
} from '@tminus/core';

const IDLE_EXIT_MS = 30 * 60 * 1000;
const TICK_MS = 1000;
/** Re-run the v1-vs-v2 evaluation after this many new finished turns. */
const REEVAL_EVERY = 25;
const REEVAL_CHECK_MS = 60_000;

/**
 * The background collector: drains hook events from the spool, tails Codex
 * rollouts, ticks every second while a turn is running, and writes state
 * files. One instance per machine (pid lock); exits after 30 idle minutes.
 */
export async function runCollector(opts: { foreground?: boolean } = {}): Promise<void> {
  if (!acquireCollectorLock()) {
    if (opts.foreground) console.error('tminus: a collector is already running');
    return;
  }
  const shutdown = (code = 0) => { releaseCollectorLock(); process.exit(code); };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('uncaughtException', (e) => { logError('collector', 'uncaught', e); shutdown(1); });
  process.on('exit', () => releaseCollectorLock());

  let db;
  try {
    db = openDb();
  } catch (e) {
    logError('collector', 'cannot open db', e);
    shutdown(1);
    return;
  }
  const cfg = loadConfig();
  let modelStamp = getMeta(db, 'model_updated_at');
  const engine = new Engine({
    db, predictor: loadPredictor(db, cfg), probes: { 'claude-code': probeTranscript }, countSubagentWork: cfg.countSubagentWork,
  });
  const restored = engine.restore();
  logLine('collector', `started pid=${process.pid} predictor=${engine.predictor.version} n=${engine.predictor.size} restored=${restored} driver=${db.driver}`);

  // A database imported by an older version lacks what the current model learns from
  // (phase labels, effort on older turns): enrich it once in the background; that run retrains.
  if (Number(getMeta(db, 'data_version') ?? 0) < DATA_VERSION && getMeta(db, 'data_upgrade') !== String(DATA_VERSION)) {
    setMeta(db, 'data_upgrade', String(DATA_VERSION));
    try {
      const [runtime, script] = selfCommand();
      spawn(runtime, [script, 'backfill', '--quiet'], { detached: true, stdio: 'ignore', env: process.env }).unref();
      logLine('collector', `upgrading imported history to data version ${DATA_VERSION}`);
    } catch (e) { logError('collector', 'data upgrade failed to start', e); }
  } else if (cfg.predictor === 'v2' && getMeta(db, 'v2_eligible') === '1' && predictorStatus(db, cfg).active === 'v1') {
    // A model file from an older version is ignored (v1 is used meanwhile): retrain at the next quiet moment.
    setMeta(db, 'v2_evaluated_n', '0');
  }

  let lastActivity = Date.now();
  let lastEvalCheck = 0;
  /**
   * Keep v2 honest as history grows: re-evaluate in a separate process (so a
   * slow training run never delays an estimate) while no turn is running.
   */
  const maybeReevaluate = () => {
    const now = Date.now();
    if (engine.activeTurns > 0 || now - lastEvalCheck < REEVAL_CHECK_MS) return;
    lastEvalCheck = now;
    const n = trainableCount(db);
    const last = Number(getMeta(db, 'v2_evaluated_n') ?? 0);
    if (n - last < REEVAL_EVERY) return;
    setMeta(db, 'v2_evaluated_n', String(n));
    const [runtime, script] = selfCommand();
    spawn(runtime, [script, 'eval', '--quiet'], { detached: true, stdio: 'ignore', env: process.env }).unref();
    logLine('collector', `re-evaluating v1 vs v2 at ${n} turns`);
  };
  const handle = (ev: NormalizedEvent, source: string) => {
    lastActivity = Date.now();
    try { engine.handle(ev, source); } catch (e) { logError('collector', `handle ${ev.kind} failed`, e); }
  };
  const tailer = new CodexTailer((ev) => handle(ev, 'tail'));

  mkdirSync(paths.spoolDir, { recursive: true });
  let draining = false;
  const drain = () => {
    if (draining) return;
    draining = true;
    try {
      const files = readdirSync(paths.spoolDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
      for (const f of files) {
        const file = join(paths.spoolDir, f);
        let ev: NormalizedEvent | null = null;
        try { ev = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
          logError('collector', `bad spool file ${f}`, e);
          try { mkdirSync(join(paths.spoolDir, 'bad'), { recursive: true }); renameSync(file, join(paths.spoolDir, 'bad', f)); } catch { /* ignore */ }
          continue;
        }
        try { unlinkSync(file); } catch { /* raced with another drain */ continue; }
        if (ev) handle(ev, 'hook');
      }
    } catch (e) {
      logError('collector', 'drain failed', e);
    } finally {
      draining = false;
    }
  };

  try {
    watch(paths.spoolDir, () => drain());
  } catch (e) {
    logError('collector', 'fs.watch unavailable; polling', e);
  }
  drain();

  setInterval(() => {
    drain();
    try { tailer.poll(); } catch (e) { logError('collector', 'codex tail failed', e); }
    try { engine.tick(); } catch (e) { logError('collector', 'tick failed', e); }
    if (engine.activeTurns > 0) lastActivity = Date.now();
    try { maybeReevaluate(); } catch (e) { logError('collector', 're-evaluation failed to start', e); }
    // Pick up a retrained model after `tminus backfill` / `tminus eval`.
    try {
      const stamp = getMeta(db, 'model_updated_at');
      if (stamp !== modelStamp) {
        modelStamp = stamp;
        engine.predictor = loadPredictor(db, loadConfig());
        logLine('collector', `reloaded predictor n=${engine.predictor.size}`);
      }
    } catch (e) { logError('collector', 'reload failed', e); }
    if (Date.now() - lastActivity > IDLE_EXIT_MS) {
      logLine('collector', 'idle; exiting');
      shutdown(0);
    }
  }, TICK_MS);
  // Keep the process alive.
  await new Promise(() => {});
}
