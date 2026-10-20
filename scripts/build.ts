/**
 * Builds single-file bundles:
 *   packages/cli/dist/tminus.js               CLI, target bun (hooks, collector, commands)
 *   packages/cli/dist/tminus.node.mjs         CLI, target node (npx / Node fallback)
 *   packages/cli/dist/tminus-render.js        statusline-only entry, target bun (~16KB, parsed on every redraw)
 *   packages/cli/dist/tminus-render.node.mjs  statusline-only entry, target node
 */
import { rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const out = join(root, 'packages/cli/dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const cli = join(root, 'packages/cli/src/index.ts');
const render = join(root, 'packages/render/src/bin.ts');
const external = ['better-sqlite3'];

const outputs = [
  [cli, 'bun', 'tminus.js'],
  [cli, 'node', 'tminus.node.mjs'],
  [render, 'bun', 'tminus-render.js'],
  [render, 'node', 'tminus-render.node.mjs'],
] as const;

for (const [entry, target, file] of outputs) {
  const res = await Bun.build({ entrypoints: [entry], target, format: 'esm', external, minify: { syntax: true, whitespace: false, identifiers: false } });
  if (!res.success) {
    console.error(res.logs.join('\n'));
    process.exit(1);
  }
  let code = await res.outputs[0].text();
  code = code.replace(/^#!.*\n/, '');
  const shebang = target === 'bun' ? '#!/usr/bin/env bun\n' : '#!/usr/bin/env node\n';
  await Bun.write(join(out, file), shebang + code);
  chmodSync(join(out, file), 0o755);
  console.log(`built ${file} (${(code.length / 1024).toFixed(0)} KB, target ${target})`);
}
