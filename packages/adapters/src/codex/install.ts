import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  backupFile, codexDir, jsonEqual, readInstallManifest, readText, stringifyLike, writeFilePreserving, writeInstallManifest,
} from '@tminus/core';
import { isTminusHook, stripTminusHooks } from '../claude-code/install.ts';
import type { ConfigChange, InstallOptions, InstallResult } from '../types.ts';

export function codexHooksPath(): string {
  return join(codexDir(), 'hooks.json');
}

/** Hooks only wake the collector; the rollout tailer does the tracking. */
const EVENTS = ['SessionStart', 'UserPromptSubmit'];

export const CODEX_TRUST_NOTE =
  'Codex skips new hooks until you trust them: open Codex and run /hooks to review and trust the two tminus entries. ' +
  'They only start the tminus collector; live tracking itself reads the session file, so it also works whenever the ' +
  'collector is already running (Claude Code hooks, `tminus render --tmux`, the menubar app, or `tminus watch`).';

function parse(text: string | null): any {
  if (text == null || !text.trim()) return {};
  try { return JSON.parse(text); } catch {
    throw new Error(`${codexHooksPath()} is not valid JSON; refusing to edit it.`);
  }
}

export function planCodexInstall(opts: InstallOptions): { file: string; before: string | null; after: string } {
  const file = codexHooksPath();
  const before = readText(file);
  const cur = parse(before);
  const hooks = stripTminusHooks(cur.hooks) ?? {};
  for (const ev of EVENTS) {
    const group = { hooks: [{ type: 'command', command: `${opts.tminusCommand} hook --agent codex ${ev}`, timeout: 5, async: true }] };
    hooks[ev] = [...(Array.isArray(hooks[ev]) ? hooks[ev] : []), group];
  }
  // hooks.json only allows `description` and `hooks` at the top level.
  const next = { ...cur, hooks };
  return { file, before, after: stringifyLike(before, next) };
}

export async function installCodex(opts: InstallOptions): Promise<InstallResult> {
  const plan = planCodexInstall(opts);
  const changes: ConfigChange[] = plan.before === plan.after ? [] : [{ file: plan.file, before: plan.before, after: plan.after }];
  const notes = [CODEX_TRUST_NOTE];
  const summary = [`${EVENTS.length} background hooks (${EVENTS.join(', ')}) that wake the tminus collector; trust them once with /hooks inside Codex`];
  if (opts.dryRun || !changes.length) return { changes, notes, summary };
  const manifest = readInstallManifest();
  const prev = manifest.codex;
  const backup = backupFile(plan.file, 'codex-hooks');
  mkdirSync(dirname(plan.file), { recursive: true });
  writeFilePreserving(plan.file, plan.after);
  manifest.codex = {
    agent: 'codex', file: plan.file, installedAt: prev?.installedAt ?? new Date().toISOString(),
    original: prev ? prev.original : plan.before, backup: prev?.backup ?? backup, detail: { events: EVENTS },
  };
  writeInstallManifest(manifest);
  return { changes, notes, summary };
}

export async function uninstallCodex(opts: { dryRun?: boolean } = {}): Promise<InstallResult> {
  const rec = readInstallManifest().codex;
  const file = rec?.file ?? codexHooksPath();
  const before = readText(file);
  if (before == null) return { changes: [], notes: ['No Codex hooks.json; nothing to undo.'] };
  const cur = parse(before);
  const next: any = { ...cur };
  const hooks = stripTminusHooks(cur.hooks);
  if (hooks && Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;

  let after: string | null;
  let exact = false;
  const original = rec ? rec.original : undefined;
  if (original === null && (!next.hooks || !Object.keys(next.hooks).length) && Object.keys(next).length === 0) {
    after = null; // we created the file; remove it
    exact = true;
  } else if (original != null && jsonEqual(next, parse(original))) {
    after = original;
    exact = true;
  } else {
    after = stringifyLike(before, next);
  }
  const changes: ConfigChange[] = before === after ? [] : [{ file, before, after: after ?? '' }];
  if (!opts.dryRun) {
    if (after === null) rmSync(file, { force: true });
    else if (after !== before) writeFilePreserving(file, after);
    const manifest = readInstallManifest();
    delete manifest.codex;
    writeInstallManifest(manifest);
  }
  return { changes, notes: [exact ? 'Restored Codex hooks.json exactly.' : 'Removed tminus hooks from Codex hooks.json.'] };
}

export function codexInstalled(): { hooks: boolean; detail: string[] } {
  const text = readText(codexHooksPath());
  if (text == null) return { hooks: false, detail: ['hooks.json not found'] };
  let cur: any = {};
  try { cur = JSON.parse(text); } catch { return { hooks: false, detail: ['hooks.json is not valid JSON'] }; }
  const events = Object.entries(cur.hooks ?? {}).filter(([, gs]) => Array.isArray(gs) && gs.some((g: any) => g?.hooks?.some(isTminusHook))).map(([e]) => e);
  return { hooks: events.length > 0, detail: [`hooks: ${events.join(', ') || 'none'} (must be trusted via /hooks in Codex)`] };
}

export function codexDetected(): boolean {
  return existsSync(codexDir());
}
