/**
 * Builds two single-file bundles of the CLI:
 *   packages/cli/dist/tminus.js        target bun  (used by hooks + statusline: fastest startup)
 *   packages/cli/dist/tminus.node.mjs  target node (npx / Node 20+ fallback)
 */
import { rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const out = join(root, 'packages/cli/dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const entry = join(root, 'packages/cli/src/index.ts');
const external = ['better-sqlite3'];

for (const [target, file] of [['bun', 'tminus.js'], ['node', 'tminus.node.mjs']] as const) {
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
