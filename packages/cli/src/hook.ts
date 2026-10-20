import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adapterFor } from '@tminus/adapters';
import { ensureCollector, logError, logLine, paths, type NormalizedEvent } from '@tminus/core';
import { readStdin } from '@tminus/render';

/** Drop one event into the spool directory for the collector (atomic rename). */
export function spool(ev: NormalizedEvent): void {
  mkdirSync(paths.spoolDir, { recursive: true });
  const name = `${String(ev.ts).padStart(15, '0')}-${String(process.pid).padStart(7, '0')}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = join(paths.spoolDir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(ev));
  renameSync(tmp, join(paths.spoolDir, name));
}

/**
 * `tminus hook <Event>`: called by the agent for every hook. Must be fast,
 * must never fail and must print nothing (stdout from some hooks is fed to
 * the model). Heavy work belongs to the collector.
 */
export function runHook(event: string | undefined, agent = 'claude-code'): void {
  const t0 = Date.now();
  try {
    const raw = readStdin();
    const adapter = adapterFor(agent);
    if (adapter && agent !== 'codex' && raw) {
      // Codex hooks only wake the collector: its rollout tailer is the live source.
      let payload: unknown = null;
      try { payload = JSON.parse(raw); } catch { /* not JSON */ }
      const ev = payload ? adapter.parseLiveEvent(payload, event) : null;
      if (ev) {
        ev.ts = Math.min(ev.ts, t0);
        spool(ev);
      }
    }
    ensureCollector();
  } catch (e) {
    logError('hook', `hook ${event ?? '?'} failed`, e);
  }
  const dt = Date.now() - t0;
  if (dt > 100) logLine('hook', `slow hook ${event}: ${dt}ms`);
}
