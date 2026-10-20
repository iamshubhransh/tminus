import { createInterface } from 'node:readline';

const useColor = () => !process.env.NO_COLOR && process.stdout.isTTY;

export const c = {
  dim: (s: string) => (useColor() ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor() ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor() ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor() ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor() ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor() ? `\x1b[36m${s}\x1b[0m` : s),
};

export function table(rows: string[][], align: ('l' | 'r')[] = []): string {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => strip(r[i] ?? '').length)));
  return rows.map((r) => r.map((cell, i) => {
    const pad = widths[i] - strip(cell).length;
    return align[i] === 'r' ? ' '.repeat(pad) + cell : cell + ' '.repeat(pad);
  }).join('  ').trimEnd()).join('\n');
}

/** Ask a yes/no question. Without a terminal there is no one to answer, so it is always "no". */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string | null>((res) => {
    rl.on('close', () => res(null)); // Ctrl-D: no answer
    rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, res);
  });
  rl.close();
  if (answer === null) { process.stdout.write('\n'); return false; }
  const a = answer.trim();
  return a === '' ? defaultYes : /^y(es)?$/i.test(a);
}

/** Minimal line diff (LCS) for showing config changes before applying them. */
export function diffLines(before: string, after: string, context = 3): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', s: a[i++] });
    else ops.push({ t: '+', s: b[j++] });
  }
  while (i < n) ops.push({ t: '-', s: a[i++] });
  while (j < m) ops.push({ t: '+', s: b[j++] });

  const keep = ops.map((o, k) => o.t !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.t !== ' '));
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (!keep[k]) { if (!skipped) out.push(c.dim('  …')); skipped = true; return; }
    skipped = false;
    const line = `${o.t} ${o.s}`;
    out.push(o.t === '+' ? c.green(line) : o.t === '-' ? c.red(line) : c.dim(line));
  });
  return out.join('\n');
}
