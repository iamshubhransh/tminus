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
export async function installSelf(): Promise<{ command: string; runtime: string; script: string }> {
  mkdirSync(paths.binDir, { recursive: true });
  const here = fileURLToPath(import.meta.url);
  const bun = (globalThis as any).Bun ? process.execPath : which('bun');
  const runtime = bun ?? process.execPath;
  const target = join(paths.binDir, bun ? 'tminus.js' : 'tminus.mjs');

  if (here.endsWith('.js') || here.endsWith('.mjs')) {
    // Running from a built bundle: copy the matching bundle next to it.
    const dir = dirname(here);
    const want = join(dir, bun ? 'tminus.js' : 'tminus.node.mjs');
    copyFileSync(existsSync(want) ? want : here, target);
  } else if ((globalThis as any).Bun) {
    // Running from source: bundle on the fly.
    const entry = resolve(dirname(here), 'index.ts');
    const res = await (globalThis as any).Bun.build({
      entrypoints: [entry], target: 'bun', format: 'esm', minify: false,
      external: ['better-sqlite3'],
    });
    if (!res.success) throw new Error('bundle failed: ' + res.logs.map(String).join('\n'));
    await (globalThis as any).Bun.write(target, await res.outputs[0].text());
  } else {
    throw new Error('Run `bun run build` first, or install tminus from npm.');
  }
  try { chmodSync(target, 0o755); } catch { /* fine */ }
  return { command: `${shq(runtime)} ${shq(target)}`, runtime, script: target };
}

export function installedSelf(): { script: string; size: number } | null {
  for (const f of ['tminus.js', 'tminus.mjs']) {
    const p = join(paths.binDir, f);
    try { return { script: p, size: statSync(p).size }; } catch { /* next */ }
  }
  return null;
}
