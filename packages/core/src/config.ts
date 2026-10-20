import { readFileSync } from 'node:fs';
import { paths } from './paths.ts';
import { writeJsonAtomic } from './state.ts';

export interface Formats {
  /** Nothing to estimate (no prompt running). An empty string hides the segment. */
  idle: string;
  running: string;
  waiting: string;
  overrun: string;
  done: string;
}

export interface Config {
  /** Show colors (NO_COLOR always wins). */
  color: boolean;
  formats: Formats;
  /** How long the "✓ done" result stays visible, seconds. */
  doneLingerSec: number;
  /**
   * v2 (default): the GBDT model, used only while `tminus eval` shows it beats
   * v1 on this machine's history, falling back to v1 otherwise. v1: always the bucket model.
   */
  predictor: 'v1' | 'v2';
  /** Count tool calls made inside subagents as work in the activity signal. */
  countSubagentWork: boolean;
  /** Where the tminus segment goes when wrapping another statusline. */
  wrapPosition: 'append-first' | 'append-last' | 'newline';
  separator: string;
}

export const DEFAULT_FORMATS: Formats = {
  idle: 'ETA · idle',
  running: '{status} ETA ~{p50} ({range}) · {todo}',
  waiting: '⏸ ETA paused · waiting on you',
  overrun: '{status} ETA running long · {elapsed} so far',
  done: '✓ done in {actual} · predicted {predicted}',
};

export const DEFAULT_CONFIG: Config = {
  color: true,
  formats: DEFAULT_FORMATS,
  doneLingerSec: 10,
  predictor: 'v2',
  countSubagentWork: true,
  wrapPosition: 'append-first',
  separator: ' │ ',
};

function readRaw(): Partial<Config> {
  try { return JSON.parse(readFileSync(paths.config, 'utf8')); } catch { return {}; }
}

export function loadConfig(): Config {
  const raw = readRaw();
  return { ...DEFAULT_CONFIG, ...raw, formats: { ...DEFAULT_FORMATS, ...(raw.formats ?? {}) } };
}

/** Persist only what the user set explicitly, so improved defaults still reach them later. */
export function saveConfig(patch: Partial<Config>): Config {
  const raw = { ...readRaw(), ...patch };
  writeJsonAtomic(paths.config, raw);
  return loadConfig();
}
