#!/usr/bin/env node
// npm entry point. Prefer Bun (faster startup keeps the statusline under 30ms);
// fall back to the Node 20+ bundle when Bun isn't installed.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const args = process.argv.slice(2);

if (typeof globalThis.Bun !== 'undefined') {
  await import(join(dist, 'tminus.js'));
} else {
  const probe = process.env.TMINUS_NO_BUN ? null : spawnSync('bun', ['--version'], { stdio: 'ignore' });
  if (probe && probe.status === 0) {
    const r = spawnSync('bun', [join(dist, 'tminus.js'), ...args], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  } else {
    await import(join(dist, 'tminus.node.mjs'));
  }
}
