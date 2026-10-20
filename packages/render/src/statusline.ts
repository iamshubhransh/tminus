import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  contextFile, loadConfig, paths, readInstallManifest, readState, writeJsonAtomic,
  type Config, type SessionContextFile,
} from '@tminus/core';
import { colorEnabled, renderSegment } from './segment.ts';

export interface StatuslineInput {
  session_id?: string;
  model?: { id?: string; display_name?: string };
  effort?: { level?: string };
  context_window?: { used_percentage?: number };
  [k: string]: unknown;
}

export function readStdin(): string {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Leave model/effort/context% where the collector can find them at the next prompt. */
export function noteContext(input: StatuslineInput, now = Date.now()): void {
  const sid = input.session_id;
  if (!sid) return;
  const next: SessionContextFile = {
    ts: now,
    model: input.model?.id ?? null,
    effort: input.effort?.level ?? null,
    contextPct: typeof input.context_window?.used_percentage === 'number' ? input.context_window.used_percentage / 100 : null,
  };
  const file = contextFile(sid);
  try {
    const prev = JSON.parse(readFileSync(file, 'utf8')) as SessionContextFile;
    // Only rewrite when something changed (or hourly, to keep `ts` fresh).
    if (prev.model === next.model && prev.effort === next.effort && prev.contextPct === next.contextPct && now - prev.ts < 3_600_000) return;
  } catch { /* first write */ }
  try { writeJsonAtomic(file, next); } catch { /* best effort */ }
}

function runWrapped(command: string, stdin: string): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(out); } };
    try {
      const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', finish);
      child.on('error', finish);
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
      setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(); }, 5_000).unref();
    } catch {
      finish();
    }
  });
}

export function combine(wrapped: string, segment: string, cfg: Config): string {
  const lines = wrapped.replace(/\n+$/, '').split('\n');
  if (!segment) return wrapped.replace(/\n+$/, '');
  if (!wrapped.trim()) return segment;
  if (cfg.wrapPosition === 'newline') return [...lines, segment].join('\n');
  const i = cfg.wrapPosition === 'append-last' ? lines.length - 1 : 0;
  lines[i] = `${lines[i]}${cfg.separator}${segment}`;
  return lines.join('\n');
}

export interface StatuslineOptions {
  wrap?: boolean;
  format?: string;
  color?: boolean;
  stdin?: string;
  now?: number;
}

/**
 * Claude Code statusline entry. Reads one precomputed state file; all
 * prediction work happened in the collector. When wrapping, the user's own
 * statusline command runs in parallel and the segment is appended to it.
 */
export async function renderStatusline(opts: StatuslineOptions = {}): Promise<string> {
  const cfg = loadConfig();
  const raw = opts.stdin ?? readStdin();
  let input: StatuslineInput = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch { /* not JSON: render nothing of ours */ }

  let wrappedP: Promise<string> | null = null;
  if (opts.wrap) {
    const wrapped = readInstallManifest()['claude-code']?.detail?.wrapped as { command?: string } | undefined;
    if (wrapped?.command) wrappedP = runWrapped(wrapped.command, raw);
  }

  noteContext(input);
  const state = input.session_id ? readState(paths.sessionState(input.session_id)) : null;
  const palette = colorEnabled(cfg, opts.color) ? 'ansi' : 'none';
  const seg = renderSegment(state, opts.now ?? Date.now(), cfg, palette, opts.format).text;
  const wrappedOut = wrappedP ? await wrappedP : '';
  return wrappedP ? combine(wrappedOut, seg, cfg) : seg;
}

/** tmux status-right entry: most recently active session, tmux color syntax. */
export function renderTmux(opts: { format?: string; color?: boolean; now?: number } = {}): string {
  const cfg = loadConfig();
  const state = readState(paths.current);
  const palette = colorEnabled(cfg, opts.color) ? 'tmux' : 'none';
  return renderSegment(state, opts.now ?? Date.now(), cfg, palette, opts.format).text;
}
