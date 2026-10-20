import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { ADAPTERS, type AgentAdapter, type ConfigChange } from '@tminus/adapters';
import { loadConfig, openDb, paths, readInstallManifest, saveConfig, stopCollector, type Config, type NormalizedTurn } from '@tminus/core';
import { flagBool, flagStr, type Args } from '../args.ts';
import { installSelf } from '../self.ts';
import { c, confirm, diffLines } from '../ui.ts';
import { runBackfill } from './data.ts';

function tilde(file: string): string {
  const home = homedir();
  return file.startsWith(home + '/') ? '~' + file.slice(home.length) : file;
}

function showChanges(changes: ConfigChange[]): void {
  for (const ch of changes) {
    console.log(c.bold(`\n${ch.file}`) + (ch.before == null ? c.dim(' (new file)') : ''));
    console.log(diffLines(ch.before ?? '', ch.after));
  }
}

async function selectAdapters(a: Args): Promise<AgentAdapter[]> {
  const only = flagStr(a, 'agents', 'agent')?.split(',').map((s) => s.trim());
  const out: AgentAdapter[] = [];
  for (const ad of ADAPTERS) {
    if (only && !only.includes(ad.id)) continue;
    if (await ad.detect()) out.push(ad);
  }
  return out;
}

export async function cmdInit(a: Args): Promise<number> {
  const yes = flagBool(a, 'yes', 'y');
  const dry = flagBool(a, 'dry-run');
  const full = dry || flagBool(a, 'diff');
  console.log(c.bold('tminus init'));
  const adapters = await selectAdapters(a);
  if (!adapters.length) {
    console.log('No supported agents found (looked for ~/.claude and ~/.codex).');
    return 1;
  }
  console.log(`Agents found: ${adapters.map((x) => x.displayName).join(', ')}`);
  if (!existsSync(paths.config)) saveConfig({});


  if (!flagBool(a, 'no-backfill')) {
    console.log(c.dim('\nImporting history from transcripts on disk…'));
    await runBackfill(a, adapters, true);
  }

  const self = dry ? { command: 'tminus', renderCommand: 'tminus render' } : await installSelf();
  if (!dry) console.log(c.dim(`\nInstalled runtime copy: ${self.command}`));

  const refreshFlag = flagStr(a, 'refresh');
  const refreshInterval = refreshFlag === undefined ? undefined : refreshFlag === '0' ? null : Number(refreshFlag);
  const opts = { tminusCommand: self.command, renderCommand: self.renderCommand, refreshInterval };

  // Show every change first, then ask once.
  const pending: { ad: AgentAdapter; notes: string[] }[] = [];
  for (const ad of adapters) {
    const plan = await ad.install({ ...opts, dryRun: true });
    if (!plan.changes.length) {
      console.log(`\n${ad.displayName}: already set up ${c.green('✓')}`);
      continue;
    }
    if (full || !plan.summary) {
      console.log(`\n${c.bold(ad.displayName)}: the following config changes will be made (a backup is kept):`);
      showChanges(plan.changes);
      for (const n of plan.notes) console.log(c.dim(`  · ${n}`));
    } else {
      const files = plan.changes.map((ch) => tilde(ch.file) + (ch.before == null ? ' (new file)' : '')).join(', ');
      console.log(`\n${c.bold(ad.displayName)} ${c.dim(files)}`);
      for (const s of plan.summary) console.log(`  · ${s}`);
    }
    pending.push({ ad, notes: plan.notes });
  }
  if (pending.length && !full) {
    console.log(c.dim('\nBackups are kept, and `tminus uninstall` restores these files byte for byte. Exact diff: `tminus init --diff`.'));
  }
  if (dry || !pending.length) {
    if (!pending.length) printReady(adapters, []);
    return 0;
  }

  const names = pending.map((p) => p.ad.displayName).join(' and ');
  if (!yes && !(await confirm(`\nApply these changes to ${names}?`, true))) {
    console.log(process.stdin.isTTY
      ? c.yellow('\nNothing was changed.')
      : c.yellow('\nNothing was changed: there is no terminal here to confirm in.') + `\nTo apply the changes above, run: ${c.bold('tminus init --yes')}`);
    return 0;
  }
  for (const { ad, notes } of pending) {
    const res = await ad.install(opts);
    if (full) for (const n of res.notes) if (!notes.includes(n)) console.log(c.dim(`  · ${n}`));
  }
  printReady(adapters, pending.map((p) => p.ad.id));
  return 0;
}

function printReady(adapters: AgentAdapter[], changed: string[]): void {
  console.log(c.bold(`\n${c.green('✓')} tminus is set up.`));
  if (adapters.some((ad) => ad.id === 'claude-code')) {
    console.log(`\nClaude Code: your status line now shows ${c.dim('ETA · idle')}. Open sessions pick it up automatically.`);
    console.log(`Send a prompt and it switches to a live estimate: ${c.cyan(c.bold('⏳ ETA ~2m (1–5m) · 3/7'))}`);
    console.log(c.dim('  (typical time left · likely range · todo progress)'));
  }
  if (changed.includes('codex')) console.log(`\nCodex: open Codex and run ${c.bold('/hooks')} to trust the two tminus entries.`);
  console.log(c.dim('\nHow accurate it has been: `tminus stats` · health check: `tminus doctor` · undo: `tminus uninstall`'));
}

export async function cmdUninstall(a: Args): Promise<number> {
  const yes = flagBool(a, 'yes', 'y');
  const manifest = readInstallManifest();
  let rc = 0;
  for (const ad of ADAPTERS) {
    const plan = await ad.uninstall({ dryRun: true });
    if (!plan.changes.length && !manifest[ad.id]) continue;
    console.log(c.bold(`\n${ad.displayName}`));
    if (plan.changes.length) showChanges(plan.changes);
    if (!yes && !(await confirm(`Restore ${ad.displayName} config?`))) { rc = 1; continue; }
    const res = await ad.uninstall();
    for (const n of res.notes) console.log(c.green(`  ✓ ${n}`));
  }
  if (stopCollector()) console.log(c.dim('Stopped the collector.'));
  if (flagBool(a, 'purge')) {
    if (yes || (await confirm(`Delete all tminus data in ${paths.home}?`))) {
      rmSync(paths.home, { recursive: true, force: true });
      console.log(c.green(`Removed ${paths.home}`));
    }
  } else {
    console.log(c.dim(`History kept in ${paths.home} (use --purge to delete it).`));
  }
  return rc;
}

/** Only the format strings the user set explicitly (defaults stay unpinned). */
function readFormats(): Partial<Config['formats']> {
  try { return JSON.parse(readFileSync(paths.config, 'utf8')).formats ?? {}; } catch { return {}; }
}

export async function cmdConfig(a: Args): Promise<number> {
  const [, action, key, ...rest] = a._;
  const cfg = loadConfig() as any;
  if (!action || action === 'get') {
    console.log(JSON.stringify(key ? cfg[key] ?? cfg.formats?.[key] : cfg, null, 2));
    return 0;
  }
  if (action === 'set' && key) {
    const raw = rest.join(' ');
    let value: unknown = raw;
    if (raw === 'true' || raw === 'false') value = raw === 'true';
    else if (raw !== '' && !Number.isNaN(Number(raw))) value = Number(raw);
    if (key.startsWith('formats.')) saveConfig({ formats: { ...readFormats(), [key.slice(8)]: raw } as Config['formats'] });
    else saveConfig({ [key]: value } as any);
    console.log(c.green(`set ${key} = ${JSON.stringify(value)}`));
    return 0;
  }
  console.log('usage: tminus config [get [key] | set <key> <value>]');
  return 1;
}

export async function collectTurns(adapters: AgentAdapter[], since?: Date, onFile?: (f: string) => void): Promise<NormalizedTurn[]> {
  const out: NormalizedTurn[] = [];
  for (const ad of adapters) for await (const t of ad.backfill({ since, onFile })) out.push(t);
  return out;
}

export { openDb };
