import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of all tminus data. Override with TMINUS_HOME (used by tests). */
export function tminusHome(): string {
  return process.env.TMINUS_HOME || join(homedir(), '.tminus');
}

export const paths = {
  get home() { return tminusHome(); },
  get db() { return join(tminusHome(), 'tminus.db'); },
  get stateDir() { return join(tminusHome(), 'state'); },
  get current() { return join(tminusHome(), 'state', 'current.json'); },
  get spoolDir() { return join(tminusHome(), 'spool'); },
  get logsDir() { return join(tminusHome(), 'logs'); },
  get backupsDir() { return join(tminusHome(), 'backups'); },
  get binDir() { return join(tminusHome(), 'bin'); },
  get config() { return join(tminusHome(), 'config.json'); },
  get install() { return join(tminusHome(), 'install.json'); },
  get collectorLock() { return join(tminusHome(), 'collector.pid'); },
  get repoCache() { return join(tminusHome(), 'repo-cache.json'); },
  get modelV2() { return join(tminusHome(), 'model-v2.json'); },
  sessionState(sessionId: string) { return join(tminusHome(), 'state', `${safeId(sessionId)}.json`); },
};

/** Session ids come from agents; keep them filesystem-safe. */
export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

/** Directory holding Claude Code config. CLAUDE_CONFIG_DIR is honoured like Claude Code itself does. */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function codexDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}
