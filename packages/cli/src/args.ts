/** Tiny argv parser: positionals, --flag, --key value, --key=value, -n 20. */
export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN = new Set(['yes', 'y', 'json', 'tmux', 'statusline', 'wrap', 'purge', 'no-color', 'color', 'no-backfill', 'foreground', 'help', 'h', 'dry-run', 'quiet', 'all', 'rebuild', 'version', 'v', 'diff']);

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN.has(key) && next !== undefined && !next.startsWith('-')) { out.flags[key] = next; i++; }
      else out.flags[key] = true;
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (!BOOLEAN.has(key) && next !== undefined && !next.startsWith('-')) { out.flags[key] = next; i++; }
      else out.flags[key] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function flagStr(a: Args, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = a.flags[n];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

export function flagBool(a: Args, ...names: string[]): boolean {
  return names.some((n) => a.flags[n] === true || a.flags[n] === 'true');
}
