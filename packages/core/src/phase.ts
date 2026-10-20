/**
 * Phase labels: which stage of the work an agent is in, judged from what it
 * says ("let me start by exploring…", "now I'll implement…") and the shell
 * commands it runs (tests, builds, commits). Only the labels are kept; the
 * text and commands never leave memory. Shared by hooks, the transcript
 * tail, the Codex parser and backfill, so every path labels identically.
 */

const CMD_CLASSES: [string, RegExp][] = [
  ['test', /\b(test|tests|jest|vitest|pytest|playwright|cypress|xctest|go test|cargo test|swift test|spec)\b/],
  ['build', /\b(build|tsc|compile|webpack|esbuild|rollup|swift build|cargo build|xcodebuild|make|typecheck|lint|eslint)\b/],
  ['commit', /\bgit (commit|add)\b/],
  ['push', /\b(git push|gh pr (create|merge)|gh release|npm publish|vercel( --prod)?|deploy)\b/],
  ['install', /\b(npm|bun|pnpm|yarn|pip3?|brew|cargo) (i|install|add)\b/],
  ['read', /^\s*(cd [^&;]+(&&|;)\s*)?(ls|cat|head|tail|grep|rg|find|sed -n|wc|tree|git (status|log|diff|show|branch)|which|echo|pwd)\b/],
  ['run', /\b(node|bun|python3?|deno|curl|open|npx|bunx)\b/],
];

const TEXT_CLASSES: [string, RegExp][] = [
  ['early', /\b(let me (start|first|look|explore|check|read|understand|investigate|examine|see|find|search)|i'?ll (start|begin|first|look|explore|investigate)|first,? (let me|i'?ll)|let's (start|look|see))\b/],
  ['middle', /\b(now (let me|i'?ll|i need)|next,? (let me|i'?ll)|let me (now )?(implement|write|create|add|update|fix|build|wire|refactor|change|edit)|i'?ll (now )?(implement|write|create|add|update|fix|build))\b/],
  ['late', /\b(let me (verify|test|run (the )?tests|double[- ]check|confirm|commit|push)|(all|the) tests (pass|are passing)|now (commit|push)|finally|final step|to summari[sz]e|in summary|wrap(ping)? up|everything (is|looks) (good|done|working)|all (done|set|green)|is (now )?(live|published|deployed|done))\b/],
  ['ask', /\?\s*$/],
];

/** Labels for a shell command the agent ran, e.g. ['cmd:test']. */
export function commandPhase(command: string): string[] {
  const s = command.toLowerCase();
  const hit = CMD_CLASSES.filter(([, re]) => re.test(s)).map(([c]) => `cmd:${c}`);
  return hit.length ? hit : ['cmd:other'];
}

/** Labels for a message the agent wrote, e.g. ['text', 'text:early']. */
export function textPhase(text: string): string[] {
  const s = text.toLowerCase().slice(-1500);
  const hit = TEXT_CLASSES.filter(([, re]) => re.test(s)).map(([c]) => `text:${c}`);
  return ['text', ...hit, ...(text.length > 1500 ? ['text:long'] : [])];
}

/** Command text from a Codex shell tool call's arguments, whatever shape this version uses. */
export function codexCommand(name: string, args: unknown): string | null {
  if (!/^(exec_command|shell|local_shell_call|exec|container\.exec)$/.test(name)) return null;
  let a: any = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return name === 'exec' ? a : null; }
  }
  const cmd = a?.cmd ?? a?.command ?? a?.action?.command;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) return cmd.map(String).join(' ');
  return null;
}
