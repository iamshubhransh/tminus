import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { paths } from './paths.ts';
import { logError } from './log.ts';

/** The command that runs this very tminus build: [runtime, script]. */
export function selfCommand(): [string, string] {
  return [process.execPath, process.argv[1]];
}

export function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

export function collectorPid(): number | null {
  try {
    const pid = Number(readFileSync(paths.collectorLock, 'utf8').trim().split(/\s+/)[0]);
    return isAlive(pid) ? pid : null;
  } catch { return null; }
}

/**
 * Make sure a collector is running. Cheap when it is (one small read and a
 * signal-0), and never blocks: a missing collector is spawned detached.
 */
export function ensureCollector(): boolean {
  if (collectorPid()) return false;
  try {
    const [runtime, script] = selfCommand();
    const child = spawn(runtime, [script, 'collector'], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    return true;
  } catch (e) {
    logError('hook', 'failed to start collector', e);
    return false;
  }
}

/** Single-instance lock for the collector. Returns false if another live collector holds it. */
export function acquireCollectorLock(): boolean {
  mkdirSync(paths.home, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.collectorLock, 'wx');
      writeSync(fd, `${process.pid} ${Date.now()}\n`);
      closeSync(fd);
      return true;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      if (collectorPid()) return false;
      try { unlinkSync(paths.collectorLock); } catch { /* raced */ }
    }
  }
  return false;
}

export function releaseCollectorLock(): void {
  try {
    const pid = Number(readFileSync(paths.collectorLock, 'utf8').trim().split(/\s+/)[0]);
    if (pid === process.pid) unlinkSync(paths.collectorLock);
  } catch { /* already gone */ }
}

export function stopCollector(): boolean {
  const pid = collectorPid();
  if (!pid) return false;
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}
