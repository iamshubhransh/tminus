import { createHash } from 'node:crypto';
import {
  FEATURE_VERSION, type Features, type Intent, type PromptFeatures, type Trigger,
} from './types.ts';

/**
 * Rule-based intent classifier. Each intent has weighted patterns; the highest
 * score wins and ties are broken by the order of INTENT_PRIORITY. Deliberately
 * simple and deterministic so the same prompt always lands in the same bucket.
 */
const RULES: Record<Exclude<Intent, 'other'>, [RegExp, number][]> = {
  review: [
    [/\b(code[- ]?review|review|audit|critique|proofread)\b/, 3],
    [/\b(look over|sanity[- ]check|second opinion|feedback on)\b/, 2],
    [/^\/(code-review|review|security-review)\b/, 5],
    [/\b(pr|pull request|diff|changes)\b.*\b(look|check|ok|good)\b/, 1],
  ],
  explain: [
    [/\b(explain|walk me through|help me understand|what does|how does|why does|why is|what is the purpose)\b/, 3],
    [/\b(describe|summari[sz]e|overview of|tell me about|eli5|how .* works?)\b/, 2],
  ],
  test: [
    [/\b(unit|integration|e2e|end[- ]to[- ]end|snapshot|regression)[- ]tests?\b/, 3],
    [/\b(write|add|run|fix|update|increase)\b[^.\n]{0,30}\b(tests?|specs?|coverage)\b/, 3],
    [/\b(jest|vitest|pytest|playwright|cypress|xctest|test suite|test cases?)\b/, 2],
    [/\btests? (fail|pass|are failing|is failing)\b/, 1],
  ],
  refactor: [
    [/\b(refactor|restructure|re-?architect|reorgani[sz]e|clean ?up|decouple|modulari[sz]e|deduplicate|dedupe|overhaul|revamp|redesign|rewrite)\b/, 3],
    [/\b(migrate|port|convert|upgrade)\b[^.\n]{0,40}\b(to|from)\b/, 2],
    [/\b(extract|split|consolidate|simplify)\b/, 1.5],
  ],
  fix: [
    [/\b(fix|bug|broken|crash(es|ing)?|regression|debug|stack ?trace|traceback|exception)\b/, 3],
    [/\b(error|errors|fails?|failing|failed|not working|doesn'?t work|isn'?t working|wrong|issue|problem|glitch)\b/, 2],
    [/\b(unable to|can'?t (see|find|open|access|load)|not (able|showing|loading|visible|rendering)|being cut|cut off|getting this|still (see|seeing|showing)|weird|blank|missing)\b/, 2],
    [/\b(why (is|does|am)|what'?s wrong)\b/, 1],
  ],
  build_feature: [
    [/\b(implement|scaffold|create|develop|bootstrap|set ?up|integrate|wire( up)?|ship)\b/, 2.5],
    // "build" the verb, not "the build is failing".
    [/(?<!\b(the|my|our|ci|a|this) )\bbuild\b(?! (is|was|fails?|failing|failed|broke|broken|errors?|passes|step|script|output|times?)\b)/, 2.5],
    [/\b(install|configure|connect)\b/, 2],
    [/\b(add|make|generate|design)\b[^.\n]{0,25}\b(feature|page|screen|component|endpoint|api|app|cli|command|tool|system|service|integration|dashboard|flow|module|support)\b/, 3],
    [/\b(new|from scratch|end[- ]to[- ]end|mvp|prototype)\b/, 1],
  ],
  small_edit: [
    [/\b(change|update|tweak|rename|replace|remove|delete|adjust|move|bump|swap|reword|edit|set|add|use|reduce|increase|extend|shrink|shorten|align|center|hide|show)\b/, 2],
    [/\b(colou?r|padding|margin|font|typo|copy|text|label|spacing|size|width|height|icon|title|border|radius|weight|bold|wrap|background|shadow|opacity|gap|line|lines|alignment|center|left|right|full[- ]width)\b/, 1],
    [/\bmake (it|this|that|these|those|them|the)\b/, 1],
  ],
  question: [
    [/^(what|how|why|when|where|which|who|can|could|is|are|does|do|should|would|will|did|have you|has)\b/, 2],
    [/\?\s*$/, 2],
    [/^(give|tell|show|list|find|get|fetch|gather|draft|write me|summari[sz]e)\b/, 2],
  ],
};

const INTENT_PRIORITY: Intent[] = [
  'review', 'test', 'refactor', 'fix', 'build_feature', 'small_edit', 'explain', 'question', 'other',
];

const EDIT_VERBS = /\b(add|change|update|fix|build|implement|create|remove|write|make|refactor|rename)\b/;

export function classifyIntent(prompt: string): Intent {
  const text = prompt.toLowerCase().slice(0, 4000).trim();
  if (!text) return 'other';
  const words = text.split(/\s+/).length;
  const scores = new Map<Intent, number>();
  for (const intent of INTENT_PRIORITY) {
    if (intent === 'other') continue;
    let s = 0;
    for (const [re, w] of RULES[intent]) if (re.test(text)) s += w;
    scores.set(intent, s);
  }
  // A question that asks for an edit is an edit; a pure question stays a question.
  if (EDIT_VERBS.test(text)) scores.set('question', (scores.get('question') ?? 0) - 3);
  // Long prompts asking for edits are rarely "small".
  if (words > 60) scores.set('small_edit', (scores.get('small_edit') ?? 0) - 1.5);
  if (words > 60) scores.set('build_feature', (scores.get('build_feature') ?? 0) + 0.5);

  let best: Intent = 'other';
  let bestScore = 1.5; // minimum evidence to leave 'other'
  for (const intent of INTENT_PRIORITY) {
    const s = scores.get(intent) ?? 0;
    if (s > bestScore) { best = intent; bestScore = s; }
  }
  return best;
}

const PATH_RE = /(?:^|[\s`'"(\[])(?:\.{0,2}\/|~\/)?[\w@.-]+(?:\/[\w@.-]+)+/g;
const FILE_RE = /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|swift|kt|java|rb|php|cs|cpp|cc|c|h|hpp|m|mm|vue|svelte|astro|md|mdx|json|ya?ml|toml|css|scss|html|sql|sh|zsh|lua|dart|ex|exs|tf)\b/g;
const TICK_RE = /`[^`\n]{1,80}`/g;
const URL_RE = /\bhttps?:\/\/\S+/g;
const SCOPE_RE = /\b(all|every|entire|across|whole|everywhere|throughout|each|codebase[- ]wide|repo[- ]wide)\b/;
const IMAGE_RE = /\[Image #\d+\]/g;

export function promptFeatures(prompt: string, images = 0): PromptFeatures {
  const text = prompt ?? '';
  const noUrls = text.replace(URL_RE, ' ');
  const paths = new Set<string>();
  for (const m of noUrls.matchAll(PATH_RE)) paths.add(m[0].trim().replace(/^[`'"(\[]/, ''));
  for (const m of noUrls.matchAll(FILE_RE)) paths.add(m[0]);
  const ticks = text.match(TICK_RE)?.length ?? 0;
  const trimmed = text.trim();
  return {
    chars: text.length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    lines: trimmed ? trimmed.split('\n').length : 0,
    intent: classifyIntent(text),
    refs: paths.size + ticks,
    scope: SCOPE_RE.test(text.toLowerCase()),
    codeBlock: text.includes('```'),
    question: /\?\s*$/.test(trimmed),
    urls: text.match(URL_RE)?.length ?? 0,
    images: images + (text.match(IMAGE_RE)?.length ?? 0),
  };
}

export interface SessionContext {
  model?: string | null;
  effort?: string | null;
  mode?: string | null;
  contextPct?: number | null;
  turnIndex?: number;
  recentActiveMs?: number[];
  repoFiles?: number | null;
  repoLanguage?: string | null;
}

export function buildFeatures(
  prompt: string,
  at: number,
  trigger: Trigger,
  ctx: SessionContext = {},
  images = 0,
): Features {
  const d = new Date(at);
  return {
    v: FEATURE_VERSION,
    trigger,
    prompt: promptFeatures(prompt, images),
    session: {
      model: normalizeModel(ctx.model ?? null),
      effort: ctx.effort ?? null,
      mode: ctx.mode ?? null,
      contextPct: ctx.contextPct ?? null,
      turnIndex: ctx.turnIndex ?? 0,
      recentMedianMs: rollingMedian(ctx.recentActiveMs ?? []),
    },
    repo: { files: ctx.repoFiles ?? null, language: ctx.repoLanguage ?? null },
    time: { hour: d.getHours(), weekday: d.getDay() },
  };
}

export function rollingMedian(values: number[], n = 3): number | null {
  const last = values.filter((v) => Number.isFinite(v) && v > 0).slice(-n);
  if (!last.length) return null;
  const s = [...last].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Strip context-window suffixes and dates so buckets don't fragment: claude-opus-5-5[1m] -> claude-opus-5-5. */
export function normalizeModel(model: string | null): string | null {
  if (!model) return null;
  return model.toLowerCase().replace(/\[.*?\]$/, '').replace(/-\d{8}$/, '').trim() || null;
}

export function normalizeEffort(effort: unknown): string | null {
  if (typeof effort !== 'string' || !effort) return null;
  return effort.toLowerCase();
}

export function hashPath(p: string | null | undefined): string | null {
  if (!p) return null;
  return createHash('sha256').update(p).digest('hex').slice(0, 16);
}
