import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.ts';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * Append a line to ~/.tminus/logs/<name>.log. Never throws: logging must not be
 * able to break a hook or the statusline.
 */
export function logLine(name: string, msg: string, extra?: unknown): void {
  try {
    mkdirSync(paths.logsDir, { recursive: true });
    const file = join(paths.logsDir, `${name}.log`);
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + '.1');
    } catch { /* first write */ }
    let line = `${new Date().toISOString()} ${msg}`;
    if (extra !== undefined) {
      line += ' ' + (extra instanceof Error ? `${extra.message}\n${extra.stack ?? ''}` : safeJson(extra));
    }
    appendFileSync(file, line + '\n');
  } catch { /* swallow */ }
}

export function logError(name: string, msg: string, err?: unknown): void {
  logLine(name, `ERROR ${msg}`, err);
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
