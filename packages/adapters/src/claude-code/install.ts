import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  backupFile, claudeDir, jsonEqual, readInstallManifest, readText, stringifyLike, writeFilePreserving, writeInstallManifest,
} from '@tminus/core';
import type { ConfigChange, InstallOptions, InstallResult } from '../types.ts';

export function claudeSettingsPath(): string {
  return join(claudeDir(), 'settings.json');
}

/** Hook events tminus listens to. Events added in newer Claude Code versions are gated on version. */
const CORE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'PreCompact', 'Stop', 'SessionEnd'];
const MODERN_EVENTS = ['PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'SubagentStart', 'SubagentStop', 'StopFailure'];

// Matches the installed runtime copy under any name we write (tminus.js for Bun, tminus.mjs for Node)
// or a `tminus` binary on PATH.
const HOOK_MARK = /tminus(?:\.m?js)?["']?\s+hook\s/;
const RENDER_MARK = /tminus(?:\.m?js)?["']?\s+render\b/;

export function isTminusHook(h: any): boolean {
  return typeof h?.command === 'string' && HOOK_MARK.test(h.command);
}
export function isTminusStatusline(sl: any): boolean {
  return typeof sl?.command === 'string' && RENDER_MARK.test(sl.command);
}

export function claudeVersion(): string | null {
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return r.stdout?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch { return null; }
}

function versionAtLeast(v: string | null, min: string): boolean {
  if (!v) return true; // unknown: assume current
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

export function hookEvents(version: string | null): string[] {
  return versionAtLeast(version, '2.1.0') ? [...CORE_EVENTS, ...MODERN_EVENTS] : CORE_EVENTS;
}

/** Remove every tminus hook handler, dropping matcher groups / event keys that become empty. */
export function stripTminusHooks(hooks: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!hooks || typeof hooks !== 'object') return hooks;
  const out: Record<string, any> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { out[event] = groups; continue; }
    const kept = groups
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isTminusHook(h)) } : g))
      .filter((g, i) => !(Array.isArray(g?.hooks) && g.hooks.length === 0 && groups[i].hooks.length > 0));
    if (kept.length) out[event] = kept;
  }
  return out;
}

export interface ClaudeInstallPlan {
  file: string;
  before: string | null;
  after: string;
  wrapped: any | null;
  events: string[];
}

export function planClaudeInstall(opts: InstallOptions, version = claudeVersion()): ClaudeInstallPlan {
  const file = claudeSettingsPath();
  const before = readText(file);
  let settings: any = {};
  if (before != null && before.trim()) {
    try { settings = JSON.parse(before); } catch {
      throw new Error(`${file} is not valid JSON; refusing to edit it. Fix it and re-run.`);
    }
  }
  const manifest = readInstallManifest()['claude-code'];
  const events = hookEvents(version);

  const next: any = { ...settings };
  const hooks = stripTminusHooks(settings.hooks) ?? {};
  for (const ev of events) {
    const group = { hooks: [{ type: 'command', command: `${opts.tminusCommand} hook ${ev}`, timeout: 10, async: true }] };
    hooks[ev] = [...(Array.isArray(hooks[ev]) ? hooks[ev] : []), group];
  }
  next.hooks = hooks;

  // Statusline: wrap whatever the user already has instead of replacing it.
  let wrapped: any | null = null;
  const existing = settings.statusLine;
  if (isTminusStatusline(existing)) wrapped = (manifest?.detail?.wrapped as any) ?? null;
  else if (existing && typeof existing === 'object' && existing.command) wrapped = existing;
  const sl: any = {
    type: 'command',
    command: `${opts.tminusCommand} render --statusline${wrapped ? ' --wrap' : ''}`,
    padding: wrapped?.padding ?? existing?.padding ?? 0,
  };
  const refresh = opts.refreshInterval !== undefined ? opts.refreshInterval : wrapped ? wrapped.refreshInterval ?? null : 1;
  if (refresh) sl.refreshInterval = refresh;
  next.statusLine = sl;

  return { file, before, after: stringifyLike(before, next), wrapped, events };
}

export async function installClaude(opts: InstallOptions): Promise<InstallResult> {
  const plan = planClaudeInstall(opts);
  const notes: string[] = [];
  if (plan.wrapped) notes.push(`Existing statusline kept and wrapped: ${plan.wrapped.command}`);
  const changes: ConfigChange[] = plan.before === plan.after ? [] : [{ file: plan.file, before: plan.before, after: plan.after }];
  if (opts.dryRun || !changes.length) return { changes, notes };

  const manifest = readInstallManifest();
  const prev = manifest['claude-code'];
  const backup = backupFile(plan.file, 'claude-settings');
  mkdirSync(dirname(plan.file), { recursive: true });
  writeFilePreserving(plan.file, plan.after);
  manifest['claude-code'] = {
    agent: 'claude-code',
    file: plan.file,
    installedAt: prev?.installedAt ?? new Date().toISOString(),
    // Keep the bytes from before the *first* install so uninstall restores the true original.
    original: prev ? prev.original : plan.before,
    backup: prev?.backup ?? backup,
    detail: { wrapped: plan.wrapped, events: plan.events },
  };
  writeInstallManifest(manifest);
  if (backup) notes.push(`Backup: ${backup}`);
  return { changes, notes };
}

export function planClaudeUninstall(): { file: string; before: string | null; after: string | null; exact: boolean } | null {
  const rec = readInstallManifest()['claude-code'];
  const file = rec?.file ?? claudeSettingsPath();
  const before = readText(file);
  if (before == null) return null;
  let settings: any;
  try { settings = JSON.parse(before); } catch { return null; }
  const original = rec ? rec.original : undefined;
  const origJson = original != null && original.trim() ? safeParse(original) : rec ? {} : undefined;
  const next: any = { ...settings };
  const hooks = stripTminusHooks(settings.hooks);
  if (hooks && Object.keys(hooks).length) next.hooks = hooks;
  else if (origJson && typeof origJson === 'object' && 'hooks' in origJson) next.hooks = hooks ?? {};
  else delete next.hooks;
  if (isTminusStatusline(settings.statusLine)) {
    const wrapped = rec?.detail?.wrapped;
    if (wrapped) next.statusLine = wrapped; else delete next.statusLine;
  }
  if (rec) {
    // Nothing else changed since install: put the original bytes back verbatim.
    if (origJson !== undefined && jsonEqual(next, origJson)) return { file, before, after: original ?? null, exact: true };
    return { file, before, after: stringifyLike(original ?? before, next), exact: false };
  }
  return { file, before, after: stringifyLike(before, next), exact: false };
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

export async function uninstallClaude(opts: { dryRun?: boolean } = {}): Promise<InstallResult> {
  const plan = planClaudeUninstall();
  if (!plan) return { changes: [], notes: ['Claude Code settings not found; nothing to undo.'] };
  const notes: string[] = [];
  const changes: ConfigChange[] = plan.before === plan.after ? [] : [{ file: plan.file, before: plan.before, after: plan.after ?? '' }];
  if (opts.dryRun) return { changes, notes };
  if (plan.after === null) rmSync(plan.file, { force: true });
  else if (plan.before !== plan.after) writeFilePreserving(plan.file, plan.after);
  notes.push(plan.exact ? 'Restored settings.json byte-for-byte.' : 'Removed tminus entries; other edits made since install were kept.');
  const manifest = readInstallManifest();
  delete manifest['claude-code'];
  writeInstallManifest(manifest);
  return { changes, notes };
}

export function claudeInstalled(): { hooks: boolean; statusline: boolean; detail: string[] } {
  const text = readText(claudeSettingsPath());
  const detail: string[] = [];
  if (text == null) return { hooks: false, statusline: false, detail: ['settings.json not found'] };
  const s = safeParse(text) ?? {};
  const events = Object.entries(s.hooks ?? {}).filter(([, gs]) => Array.isArray(gs) && gs.some((g: any) => g?.hooks?.some(isTminusHook))).map(([e]) => e);
  const hooks = events.includes('UserPromptSubmit') && events.includes('Stop');
  detail.push(`hooks: ${events.length ? events.join(', ') : 'none'}`);
  const statusline = isTminusStatusline(s.statusLine);
  detail.push(`statusline: ${statusline ? s.statusLine.command : s.statusLine?.command ?? 'none'}`);
  return { hooks, statusline, detail };
}

export function claudeDetected(): boolean {
  return existsSync(claudeDir());
}
