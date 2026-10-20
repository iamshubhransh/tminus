#!/usr/bin/env bun
import { parseArgs, flagBool, flagStr } from './args.ts';
import pkg from '../package.json' with { type: 'json' };

const VERSION: string = pkg.version;

const HELP = `tminus ${VERSION} — live ETA for AI coding agents

Usage:
  tminus init [--yes] [--no-backfill] [--refresh <sec>] [--agents claude-code,codex]
                             detect agents, import history, install hooks + statusline (shows a diff first)
  tminus backfill [--since <date>] [--agent <id>] [--rebuild]
                             re-import transcripts (idempotent; --rebuild re-derives backfilled turns)
  tminus status [--session <id>] [--json]
                             current estimate in detail, with signal weights
  tminus stats [--json]      accuracy + calibration report
  tminus history [-n 20]     recent turns: predicted vs actual
  tminus render [--statusline|--tmux] [--wrap] [--format "..."] [--no-color]
  tminus watch               live countdown in this terminal (keeps the collector running)
  tminus doctor              check hooks, database, render latency
  tminus eval [--quiet]      v1 vs v2 on rolling time folds; v2 is used only while it wins
  tminus export [--out file.csv]
                             anonymized features + durations (never prompt text)
  tminus config [get|set <key> <value>]
  tminus uninstall [--purge] [--yes]
                             restore original configs exactly

Format tokens: {status} {p50} {range} {todo} {elapsed} (done: {actual} {predicted})
`;

// node:sqlite prints an ExperimentalWarning on Node; it must not leak into hooks or the statusline.
const emit = process.emitWarning.bind(process);
(process as any).emitWarning = (w: any, ...rest: any[]) => {
  if (String(w?.message ?? w).includes('SQLite')) return;
  return emit(w, ...rest);
};

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const cmd = a._[0] ?? (flagBool(a, 'version', 'v') ? 'version' : undefined);
  switch (cmd) {
    // Hot paths first, with only the imports they need.
    case 'hook': {
      const { runHook } = await import('./hook.ts');
      runHook(a._[1], flagStr(a, 'agent') ?? 'claude-code');
      return 0;
    }
    case 'render': {
      try {
        const { cmdRender } = await import('./commands/live.ts');
        return await cmdRender(a);
      } catch { return 0; } // never break the statusline
    }
    case 'collector': {
      const { runCollector } = await import('./collector.ts');
      await runCollector({ foreground: flagBool(a, 'foreground') });
      return 0;
    }
    case 'init': return (await import('./commands/setup.ts')).cmdInit(a);
    case 'uninstall': return (await import('./commands/setup.ts')).cmdUninstall(a);
    case 'config': return (await import('./commands/setup.ts')).cmdConfig(a);
    case 'backfill': return (await import('./commands/data.ts')).runBackfill(a);
    case 'stats': return (await import('./commands/data.ts')).cmdStats(a);
    case 'history': return (await import('./commands/data.ts')).cmdHistory(a);
    case 'export': return (await import('./commands/data.ts')).cmdExport(a);
    case 'eval': return (await import('./commands/data.ts')).cmdEval(a);
    case 'status': return (await import('./commands/live.ts')).cmdStatus(a);
    case 'watch': return (await import('./commands/live.ts')).cmdWatch(a);
    case 'doctor': return (await import('./commands/live.ts')).cmdDoctor(a);
    case 'version': case '--version': case '-v':
      console.log(VERSION);
      return 0;
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      if (flagBool(a, 'help', 'h')) { process.stdout.write(HELP); return 0; }
      console.error(`tminus: unknown command "${cmd}"\n`);
      process.stdout.write(HELP);
      return 1;
  }
}

const isHook = process.argv[2] === 'hook';
main(process.argv.slice(2)).then(
  (code) => {
    // The collector keeps running on its own; everything else exits promptly.
    if (process.argv[2] !== 'collector' && process.argv[2] !== 'watch') process.exit(isHook ? 0 : code);
  },
  (err) => {
    if (isHook || process.argv[2] === 'render') process.exit(0); // hooks and the statusline must never fail
    console.error(`tminus: ${err?.message ?? err}`);
    process.exit(1);
  },
);
