import type { AgentAdapter } from './types.ts';
import { backfillClaude } from './claude-code/backfill.ts';
import { claudeDetected, claudeInstalled, installClaude, uninstallClaude } from './claude-code/install.ts';
import { parseClaudeHook, probeTranscript } from './claude-code/live.ts';
import { backfillCodex } from './codex/backfill.ts';
import { codexDetected, codexInstalled, installCodex, uninstallCodex } from './codex/install.ts';
import { parseCodexHook } from './codex/live.ts';

export const claudeCode: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  detect: async () => claudeDetected(),
  backfill: (opts) => backfillClaude(opts),
  install: (opts) => installClaude(opts),
  uninstall: (opts) => uninstallClaude(opts),
  installed: async () => claudeInstalled(),
  parseLiveEvent: (raw, ev) => parseClaudeHook(raw, ev),
  probe: probeTranscript,
};

export const codex: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  detect: async () => codexDetected(),
  backfill: (opts) => backfillCodex(opts),
  install: (opts) => installCodex(opts),
  uninstall: (opts) => uninstallCodex(opts),
  installed: async () => codexInstalled(),
  parseLiveEvent: (raw, ev) => parseCodexHook(raw, ev),
};

export const ADAPTERS: AgentAdapter[] = [claudeCode, codex];

export function adapterFor(id: string): AgentAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

export * from './types.ts';
export { parseClaudeTranscript, listTranscripts, todoFromToolInput } from './claude-code/backfill.ts';
export { parseClaudeHook, probeTranscript, taskIdFromResponse } from './claude-code/live.ts';
export { planClaudeInstall, planClaudeUninstall, claudeSettingsPath, isTminusHook, isTminusStatusline, stripTminusHooks } from './claude-code/install.ts';
export { parseCodexRollout, listRollouts } from './codex/backfill.ts';
export { CodexTailer, parseCodexHook } from './codex/live.ts';
export { codexHooksPath, CODEX_TRUST_NOTE } from './codex/install.ts';
export { codexRecordToEvents, newCodexState } from './codex/parse.ts';
