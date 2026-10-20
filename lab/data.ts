/**
 * Lab dataset: every turn on this machine, parsed with the production parsers,
 * plus research-only features derived from prompt text in memory. Raw text is
 * never written anywhere; the cache holds derived numbers only.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRollouts, listTranscripts, parseClaudeTranscript, codexRecordToEvents, newCodexState } from '@tminus/adapters';
import { backfillCodex } from '../packages/adapters/src/codex/backfill.ts';
import { userMessageText } from '../packages/adapters/src/codex/parse.ts';
import { readJsonl, TRAIN_CAP_MS, MIN_ACTIVE_MS, TRAINABLE_TRIGGERS, type Features, type NormalizedTurn, type TurnEvent } from '@tminus/core';

export interface LabTurn {
  key: string;
  agent: 'claude-code' | 'codex';
  sessionId: string;
  extId: string;
  project: string | null;
  submittedAt: number;
  finishedAt: number;
  activeMs: number;
  idleMs: number;
  outcome: string;
  trigger: string;
  model: string | null;
  effort: string | null;
  mode: string | null;
  contextPct: number | null;
  features: Features;
  /** Research features derived from the prompt and the previous assistant message. */
  text: Record<string, number>;
  /** Salted hashed word unigrams/bigrams of the prompt (derived; for text-model experiments). */
  tokens: number[];
  toolCalls: number;
  subagentToolCalls: number;
  events: TurnEvent[];
  /** Phase labels derived from assistant text and shell commands during the turn (labels only). */
  phase: { ts: number; c: string[] }[];
  trainable: boolean;
  /** log(min(active, cap)) for trainable turns. */
  y: number;
}

const CACHE_DIR = process.env.LAB_CACHE ?? join(process.env.TMPDIR ?? '/tmp', 'tminus-lab');
const CACHE_VERSION = 7;

// ---------------------------------------------------------------------------
// Research text features. Counts and flags only.

const WORD_RE = /[a-z0-9][a-z0-9'_-]*/g;
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
const has = (s: string, re: RegExp) => (re.test(s) ? 1 : 0);

const ACTION = /\b(add|change|update|fix|build|implement|create|remove|delete|write|make|refactor|rename|test|run|deploy|publish|commit|push|install|setup|set up|investigate|research|check|review|explain|find|look|move|replace|migrate|improve|optimi[sz]e|clean|debug|design|draft|generate|convert|port|upgrade|wire|hook up|integrate)\b/g;
const CONTINUE = /^\s*(yes|yep|yeah|yup|ok|okay|k|sure|go ahead|go on|do it|do that|proceed|continue|carry on|please do|sounds good|lgtm|ship it|go for it|try again|again|perfect|great|nice|cool|thanks|thank you|y)\b/;
const SMALL = /\b(just|quick|quickly|small|simple|minor|tiny|only|slight|little)\b/g;
const BIG = /\b(entire|whole|all|every|complete|completely|full|fully|end to end|end-to-end|thorough|thoroughly|deep|deeply|comprehensive|everything|production|from scratch|robust)\b/g;
const RESEARCH = /\b(research|investigate|analy[sz]e|explore|compare|evaluate|benchmark|deep dive|audit|figure out|understand)\b/g;
const SHIP = /\b(publish|release|deploy|commit|push|merge|pr|pull request|tag|npm|github)\b/g;
const TESTS = /\b(test|tests|testing|spec|specs|coverage|ci|e2e)\b/g;
const UI = /\b(ui|ux|button|page|screen|css|style|styling|layout|design|colou?r|font|icon|modal|component|frontend|landing)\b/g;
const ITERATE = /\b(keep (on )?(iterating|going|working)|until|iterate|loop|repeat|again and again|as long as)\b/g;
const AGENTS = /\b(agents?|subagents?|parallel|workflow|fan out|orchestrat\w*)\b/g;
const ERRORISH = /\b(error|exception|traceback|stack trace|failed|failing|fails|panic|undefined|null pointer|segfault|cannot|can't|unable)\b/g;
const ASK_BACK = /(want me to|should i|shall i|do you want|would you like|let me know|which (one|option)|ready to|go ahead\?|proceed\?)/;
const DONE = /\b(done|complete|completed|finished|all set|pushed|published|merged|deployed|fixed|shipped|passes|passing)\b/g;

const PASTED_RE = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/g;
const COMPACT_RE = /^\s*This session is being continued from a previous conversation/;

/** The user's own words: pasted blocks, image markers and wrappers removed. */
export function ownText(prompt: string): { own: string; pastedChars: number; pastedBlocks: number } {
  let pastedChars = 0, pastedBlocks = 0;
  const own = prompt.replace(PASTED_RE, (m) => { pastedChars += m.length; pastedBlocks++; return ' '; })
    .replace(/\[Image #\d+\]/g, ' ')
    .replace(/<\/?(command-name|command-message|command-args)>/g, ' ');
  return { own, pastedChars, pastedBlocks };
}

export function textFeatures(prompt: string, prevAssistant: string | null): Record<string, number> {
  const { own, pastedChars, pastedBlocks } = ownText(prompt);
  const compact = COMPACT_RE.test(prompt);
  const ownTrim = compact ? '' : own.trim();
  const ownWords = ownTrim ? ownTrim.split(/\s+/).length : 0;
  const p = prompt.toLowerCase();
  const words = p.match(WORD_RE) ?? [];
  const lines = prompt.split('\n');
  const a = (prevAssistant ?? '').toLowerCase();
  return {
    o_log_chars: Math.log1p(ownTrim.length),
    o_log_words: Math.log1p(ownWords),
    o_lines: ownTrim ? Math.min(ownTrim.split('\n').length, 200) : 0,
    o_log_pasted: Math.log1p(pastedChars),
    o_pasted_blocks: pastedBlocks,
    o_compact: compact ? 1 : 0,
    o_bash_input: /^\s*<bash-input>/.test(prompt) ? 1 : 0,
    p_sentences: count(prompt, /[.!?](\s|$)/g),
    p_bullets: lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length,
    p_actions: count(p, ACTION),
    p_conj: count(p, /\b(and|also|then|plus|additionally|as well)\b/g),
    p_continue: words.length <= 8 && CONTINUE.test(p) ? 1 : 0,
    p_slash: has(p, /^\s*\//),
    p_long_lines: lines.filter((l) => l.length > 200).length,
    p_paste: lines.length > 20 || prompt.length > 3000 ? 1 : 0,
    p_errorish: count(p, ERRORISH),
    p_qmarks: count(prompt, /\?/g),
    p_small: count(p, SMALL),
    p_big: count(p, BIG),
    p_research: count(p, RESEARCH),
    p_ship: count(p, SHIP),
    p_tests: count(p, TESTS),
    p_ui: count(p, UI),
    p_iterate: count(p, ITERATE),
    p_agents: count(p, AGENTS),
    p_numbers: count(p, /\b\d+\b/g),
    p_caps_words: count(prompt, /\b[A-Z]{3,}\b/g),
    p_unique_ratio: words.length ? new Set(words).size / words.length : 0,
    a_present: prevAssistant ? 1 : 0,
    a_log_chars: prevAssistant ? Math.log1p(prevAssistant.length) : -1,
    a_asks: prevAssistant ? has(a.slice(-600), ASK_BACK) || has(a.trimEnd(), /\?$/) : -1,
    a_done: prevAssistant ? Math.min(count(a, DONE), 10) : -1,
    a_bullets: prevAssistant ? prevAssistant.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length : -1,
    a_code: prevAssistant ? has(prevAssistant, /```/) : -1,
    a_plan: prevAssistant ? has(a, /\b(plan|steps|phase|approach|here'?s what i'?ll do|i'?ll (now )?(start|begin))\b/) : -1,
  };
}

/** FNV-1a with a salt, folded into 2^LAB_HASH_BITS buckets (default 14). */
const HASH_MASK = (1 << Number(process.env.LAB_HASH_BITS ?? 14)) - 1;
function hashToken(s: string, salt: number): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) & HASH_MASK;
}

export function hashedTokens(prompt: string, salt = 0x5eed): number[] {
  const words = (prompt.toLowerCase().match(WORD_RE) ?? []).slice(0, 400);
  const out = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    out.add(hashToken(words[i], salt));
    if (i > 0) out.add(hashToken(`${words[i - 1]} ${words[i]}`, salt));
  }
  return [...out];
}

// Phase labels for live experiments.

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

export function phaseLabels(kind: 'text' | 'cmd', text: string): string[] {
  const s = text.toLowerCase();
  if (kind === 'cmd') {
    const hit = CMD_CLASSES.filter(([, re]) => re.test(s)).map(([c]) => `cmd:${c}`);
    return hit.length ? hit : ['cmd:other'];
  }
  const hit = TEXT_CLASSES.filter(([, re]) => re.test(s.slice(-1500))).map(([c]) => `text:${c}`);
  return ['text', ...hit, ...(text.length > 1500 ? ['text:long'] : [])];
}

// ---------------------------------------------------------------------------

function toLab(t: NormalizedTurn, text: { prompt: string; prevAssistant: string | null; during?: { ts: number; kind: 'text' | 'cmd'; text: string }[] } | undefined): LabTurn {
  const activeMs = Math.max(0, t.finishedAt - t.submittedAt - t.idleMs);
  const trainable = t.outcome === 'completed' && activeMs >= MIN_ACTIVE_MS && (TRAINABLE_TRIGGERS as string[]).includes(t.features.trigger);
  return {
    key: `${t.agent}|${t.sessionId}|${t.extId}`,
    agent: t.agent as LabTurn['agent'],
    sessionId: t.sessionId,
    extId: t.extId,
    project: t.projectHash ?? null,
    submittedAt: t.submittedAt,
    finishedAt: t.finishedAt,
    activeMs,
    idleMs: t.idleMs,
    outcome: t.outcome,
    trigger: t.features.trigger,
    model: t.model,
    effort: t.effort,
    mode: t.mode,
    contextPct: t.contextPct,
    features: t.features,
    text: text ? textFeatures(text.prompt, text.prevAssistant) : {},
    tokens: text ? hashedTokens(text.prompt) : [],
    toolCalls: t.toolCalls,
    subagentToolCalls: t.subagentToolCalls ?? 0,
    events: t.events,
    phase: (text?.during ?? []).map((d) => ({ ts: d.ts, c: phaseLabels(d.kind, d.text) })),
    trainable,
    y: Math.log(Math.min(Math.max(activeMs, 1000), TRAIN_CAP_MS)),
  };
}

/** Prompt and previous-assistant text per Codex turn, keyed like backfillCodex keys turns. */
async function codexTexts(): Promise<Map<string, { prompt: string; prevAssistant: string | null }>> {
  const out = new Map<string, { prompt: string; prevAssistant: string | null }>();
  for (const file of listRollouts()) {
    const st = newCodexState();
    let lastAssistant: string | null = null;
    let prevForTurn: string | null = null;
    for await (const rec of readJsonl(file)) {
      const p = rec?.payload ?? {};
      const um = rec?.type === 'event_msg' ? userMessageText(p) : null;
      if (rec?.type === 'event_msg' && p.type === 'task_started') prevForTurn = lastAssistant;
      if (rec?.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim()) lastAssistant = p.message;
      if (rec?.type === 'response_item' && p.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
        const t = p.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
        if (t.trim()) lastAssistant = t;
      }
      for (const ev of codexRecordToEvents(st, rec)) {
        if (ev.kind !== 'prompt_submit') continue;
        const key = `codex|${st.sessionId ?? file}|${ev.promptId ?? String(ev.ts)}`;
        out.set(key, { prompt: um?.text ?? '', prevAssistant: prevForTurn });
      }
    }
  }
  return out;
}

async function parseAll(): Promise<LabTurn[]> {
  const turns: LabTurn[] = [];
  const recentMs = 30 * 60 * 1000;
  for (const file of listTranscripts()) {
    let open = false;
    try { open = Date.now() - statSync(file).mtimeMs < recentMs; } catch { /* vanished */ }
    const texts = new Map<string, { prompt: string; prevAssistant: string | null; during: { ts: number; kind: 'text' | 'cmd'; text: string }[] }>();
    const gen = parseClaudeTranscript(file, undefined, {
      skipOpenTail: open,
      onText: (t, x) => texts.set(t.extId, x),
    });
    for await (const t of gen) turns.push(toLab(t, texts.get(t.extId)));
  }
  const ctexts = await codexTexts();
  for await (const t of backfillCodex()) turns.push(toLab(t, ctexts.get(`codex|${t.sessionId}|${t.extId}`)));
  // De-duplicate (a session file can be listed twice across moves) and order by submit time.
  const seen = new Set<string>();
  return turns
    .filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)))
    .sort((a, b) => a.submittedAt - b.submittedAt || a.key.localeCompare(b.key));
}

/** Load (or rebuild) the lab dataset. The cache holds derived features only. */
export async function loadTurns(opts: { rebuild?: boolean } = {}): Promise<LabTurn[]> {
  const file = join(CACHE_DIR, `turns.v${CACHE_VERSION}.h${process.env.LAB_HASH_BITS ?? 14}.json`);
  if (!opts.rebuild && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const turns = await parseAll();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(turns));
  return turns;
}

if (import.meta.main) {
  const turns = await loadTurns({ rebuild: true });
  const tr = turns.filter((t) => t.trainable);
  const by = (f: (t: LabTurn) => string) => {
    const m = new Map<string, number>();
    for (const t of tr) m.set(f(t), (m.get(f(t)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ');
  };
  console.log(`${turns.length} turns, ${tr.length} trainable, cache in ${CACHE_DIR}`);
  console.log('agent/model/effort:', by((t) => `${t.agent}/${t.model}/${t.effort}`));
  console.log('trigger:', by((t) => t.trigger));
  console.log('with text features:', tr.filter((t) => Object.keys(t.text).length).length, ' with project:', tr.filter((t) => t.project).length);
  console.log('projects:', new Set(tr.map((t) => t.project)).size, ' sessions:', new Set(tr.map((t) => t.sessionId)).size);
}
