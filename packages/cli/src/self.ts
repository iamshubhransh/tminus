import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '@tminus/core';

/** Absolute path of a binary on PATH. */
export function which(bin: string): string | null {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  const p = r.stdout?.trim();
  return r.status === 0 && p ? p : null;
}

function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Install a self-contained copy of tminus into ~/.tminus/bin so agent hooks
 * don't depend on where the package or an npx cache lives. Prefers Bun as the
 * runtime (fast startup keeps the statusline under 30ms).
 */
export interface InstalledSelf {
  /** Runs the CLI (hooks, commands). */
  command: string;
  /** Runs the statusline-only entry, e.g. `bun ~/.tminus/bin/tminus-render.js render`. */
  renderCommand: string;
  runtime: string;
  script: string;
}

export async function installSelf(): Promise<InstalledSelf> {
  mkdirSync(paths.binDir, { recursive: true });
  const here = fileURLToPath(import.meta.url);
  const bun = (globalThis as any).Bun ? process.execPath : which('bun');
  const runtime = bun ?? process.execPath;
  const ext = bun ? '.js' : '.mjs';
  const target = join(paths.binDir, `tminus${ext}`);
  const renderTarget = join(paths.binDir, `tminus-render${ext}`);

  if (here.endsWith('.js') || here.endsWith('.mjs')) {
    // Running from a built bundle: copy the matching bundles next to it.
    const dir = dirname(here);
    const want = join(dir, bun ? 'tminus.js' : 'tminus.node.mjs');
    copyFileSync(existsSync(want) ? want : here, target);
    const wantRender = join(dir, bun ? 'tminus-render.js' : 'tminus-render.node.mjs');
    if (existsSync(wantRender)) copyFileSync(wantRender, renderTarget);
  } else if ((globalThis as any).Bun) {
    // Running from source: bundle on the fly.
    const B = (globalThis as any).Bun;
    const build = async (entry: string, out: string) => {
      const res = await B.build({ entrypoints: [entry], target: 'bun', format: 'esm', minify: false, external: ['better-sqlite3'] });
      if (!res.success) throw new Error('bundle failed: ' + res.logs.map(String).join('\n'));
      await B.write(out, await res.outputs[0].text());
    };
    await build(resolve(dirname(here), 'index.ts'), target);
    await build(resolve(dirname(here), '../../render/src/bin.ts'), renderTarget);
  } else {
    throw new Error('Run `bun run build` first, or install tminus from npm.');
  }
  for (const f of [target, renderTarget]) { try { chmodSync(f, 0o755); } catch { /* fine */ } }
  const command = `${shq(runtime)} ${shq(target)}`;
  // Fall back to the full CLI if the render-only bundle is missing (older builds).
  const renderCommand = existsSync(renderTarget) ? `${shq(runtime)} ${shq(renderTarget)} render` : `${command} render`;
  return { command, renderCommand, runtime, script: target };
}

export function installedSelf(): { script: string; size: number } | null {
  for (const f of ['tminus-render.js', 'tminus-render.mjs', 'tminus.js', 'tminus.mjs']) {
    const p = join(paths.binDir, f);
    try { return { script: p, size: statSync(p).size }; } catch { /* next */ }
  }
  return null;
}
