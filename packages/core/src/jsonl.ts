import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Stream a JSONL file, yielding parsed objects. Corrupt or partial lines are
 * skipped (counted in `stats.bad`), never fatal.
 */
export async function* readJsonl(file: string, stats?: { bad: number; lines: number }): AsyncGenerator<any> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (stats) stats.lines++;
    if (!line || line.charCodeAt(0) !== 123 /* { */) {
      if (line.trim() && stats) stats.bad++;
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch {
      if (stats) stats.bad++;
    }
  }
}

export function tsOf(v: unknown): number | null {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
