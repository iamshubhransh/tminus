/**
 * Statusline hot path: a separate, tiny entry point (no database, adapters or
 * models) so every redraw parses ~16KB instead of the whole CLI bundle.
 * Usage: tminus-render.js render --statusline [--wrap] [--format "..."] [--no-color]
 * It never fails: any error renders nothing (the wrapped statusline still shows).
 */
import { renderStatusline } from './statusline.ts';

const argv = process.argv.slice(2);
const at = argv.indexOf('--format');
try {
  process.stdout.write(await renderStatusline({
    wrap: argv.includes('--wrap'),
    format: at >= 0 ? argv[at + 1] : undefined,
    color: argv.includes('--no-color') ? false : undefined,
  }));
} catch { /* never break the statusline */ }
