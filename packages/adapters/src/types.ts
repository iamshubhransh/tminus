import type { NormalizedEvent, NormalizedTurn, TranscriptProbe } from '@tminus/core';

export interface ConfigChange {
  file: string;
  /** File content before (null = file did not exist). */
  before: string | null;
  after: string;
}

export interface InstallResult {
  changes: ConfigChange[];
  notes: string[];
  /** What the change does, in a line or two each, for people who don't want to read a JSON diff. */
  summary?: string[];
}

export interface InstallOptions {
  /** Command prefix that runs tminus, e.g. `"/Users/me/.bun/bin/bun" "/Users/me/.tminus/bin/tminus.js"`. */
  tminusCommand: string;
  /** Command for the statusline-only entry, ending in `render`. Defaults to `<tminusCommand> render`. */
  renderCommand?: string;
  /** Compute the change but don't write it. */
  dryRun?: boolean;
  /** Statusline refresh interval to request, seconds (Claude Code only). */
  refreshInterval?: number | null;
}

export interface AgentAdapter {
  id: 'claude-code' | 'codex' | (string & {});
  displayName: string;
  /** Is this agent installed / has it left data on this machine? */
  detect(): Promise<boolean>;
  /** Re-import past turns from on-disk transcripts. */
  backfill(opts: { since?: Date; onFile?: (file: string) => void }): AsyncIterable<NormalizedTurn>;
  /** Wire hooks / statusline config (backing up whatever is there). */
  install(opts: InstallOptions): Promise<InstallResult>;
  /** Restore the user's previous config exactly. */
  uninstall(opts?: { dryRun?: boolean }): Promise<InstallResult>;
  /** Is tminus currently wired into this agent? */
  installed(): Promise<{ hooks: boolean; statusline?: boolean; detail: string[] }>;
  /** Turn one raw hook payload into a normalized event (null = ignore). */
  parseLiveEvent(raw: unknown, hookEvent?: string): NormalizedEvent | null;
  /** Cheap check of the live transcript tail for interrupts that no hook reports. */
  probe?: TranscriptProbe;
}
