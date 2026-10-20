import { oofPredict, predictBooster, trainBooster, type Booster, type BoostOpts } from './boost.ts';
import { LogMixture } from './dist.ts';
import { replayObs, type Obs, type ReplayEvent } from './observe.ts';
import { toolCategory } from './live.ts';
import { INTENTS, type Features } from './types.ts';

/**
 * Predictor v2 (model format 3). Recipe and evidence: docs/HOW_IT_WORKS.md and
 * lab/ (prequential evaluation on real history, with a held-out final 20%).
 *
 * Submit time: five median gradient-boosted models (bagged, different seeds)
 * of log(active ms) give the location; the spread is their out-of-fold
 * residuals (a conformal step). The location is then shifted by the errors
 * this model made on the session's last few finished turns (partial pooling),
 * because errors persist within a session.
 *
 * While running: a second boosted model predicts log(remaining active time)
 * from what is observable (elapsed time, the submit prediction, tool activity
 * and its timing, phase labels), trained on snapshots of past turns; its
 * estimate is blended 50/50 in log space with the survival-conditioned prior.
 */

const MODES = ['default', 'plan', 'auto', 'acceptEdits', 'bypassPermissions'];
const EFFORT_ORD: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
export const FAMILIES = ['opus', 'fable', 'sonnet', 'haiku', 'gpt-codex', 'gpt'] as const;

/** Model family from a model id, so a new release of a known family is not a stranger. */
export function modelFamily(model: string | null): string {
  if (!model) return '?';
  if (/opus/.test(model)) return 'opus';
  if (/sonnet/.test(model)) return 'sonnet';
  if (/haiku/.test(model)) return 'haiku';
  if (/fable/.test(model)) return 'fable';
  if (/codex/.test(model)) return 'gpt-codex';
  if (/gpt|\bo\d/.test(model)) return 'gpt';
  return 'other';
}

export function effortOrdinal(effort: string | null | undefined): number {
  return effort ? EFFORT_ORD[effort] ?? -1 : -1;
}

export const SUBMIT_FEATURES = [
  'log_chars', 'log_words', 'lines', 'refs', 'scope', 'code_block', 'question', 'urls', 'images',
  'context_pct', 'log_turn_index', 'log_recent_median', 'log_repo_files', 'hour', 'weekday',
  ...INTENTS.map((i) => `intent_${i}`), ...MODES.map((m) => `mode_${m}`), 'effort_ord', ...FAMILIES.map((f) => `fam_${f}`),
];

export function submitVector(f: Features): number[] {
  const p = f.prompt;
  const s = f.session;
  const fam = modelFamily(s.model);
  return [
    Math.log1p(p.chars), Math.log1p(p.words), Math.min(p.lines, 200), Math.min(p.refs, 50), +p.scope, +p.codeBlock, +p.question,
    Math.min(p.urls, 10), Math.min(p.images, 20),
    s.contextPct ?? -1, Math.log1p(s.turnIndex), s.recentMedianMs ? Math.log(s.recentMedianMs) : -1,
    f.repo.files ? Math.log1p(f.repo.files) : -1, f.time.hour, f.time.weekday,
    ...INTENTS.map((i) => +(p.intent === i)), ...MODES.map((m) => +(s.mode === m)),
    effortOrdinal(s.effort), ...FAMILIES.map((x) => +(fam === x)),
  ];
}

// ---------------------------------------------------------------------------
// Live features

const KINDS = ['Bash', 'exec', 'edit', 'read', 'Agent', 'mcp', 'web', 'other'] as const;

function kindOf(name: string | null | undefined): (typeof KINDS)[number] {
  if (!name) return 'other';
  if (name === 'Bash' || name === 'exec_command' || name === 'local_shell_call' || name === 'write_stdin') return 'Bash';
  if (name === 'exec') return 'exec';
  if (/^(Agent|Task|SendMessage|spawn_agent)$/.test(name)) return 'Agent';
  if (name === 'mcp') return 'mcp';
  if (/^(WebFetch|WebSearch|web_search_call)$/.test(name)) return 'web';
  const c = toolCategory(name);
  return c === 'edit' ? 'edit' : c === 'read' ? 'read' : 'other';
}

const PHASE_COUNTS = ['text', 'text:early', 'text:middle', 'cmd:read', 'cmd:test', 'cmd:build', 'cmd:commit', 'cmd:push', 'cmd:run', 'cmd:install'];
const CMD_LAST = ['cmd:read', 'cmd:test', 'cmd:build', 'cmd:commit', 'cmd:push', 'cmd:run', 'cmd:install', 'cmd:other'];

export const LIVE_FEATURES = [
  'log_t', 'p_l10', 'p_l50', 'p_l90', 'p_rem50', 'p_rem90', 't_over_p50', 't_over_p90',
  'log_calls', 'log_sub', 'rate', 'log_edits', 'edit_share', 'recent_edit_share', 'distinct',
  'log_since', 'running', 'log_running_for', 'since_over_t', ...KINDS.map((k) => `last_${k}`),
  'compactions', 'waits', 'is_codex', 'is_sdk', 'effort_ord', 'log_chars',
  ...PHASE_COUNTS.map((c) => `n_${c}`), ...CMD_LAST.map((c) => `last_${c}`), 'last_text_early', 'last_text_middle', 'log_since_text', 'shipped', 'read_share',
];

/** Fixed facts about a turn the live model conditions on. */
export interface TurnInfo { agent: string; trigger: string; effort: string | null; chars: number }

export function turnInfo(agent: string, f: Features): TurnInfo {
  return { agent, trigger: f.trigger, effort: f.session.effort, chars: f.prompt.chars };
}

/** Submit-time prediction summarised as log quantiles. */
export interface PriorQ { l10: number; l50: number; l90: number }

export function priorQ(d: LogMixture): PriorQ {
  return { l10: Math.log(d.quantile(0.1)), l50: Math.log(d.quantile(0.5)), l90: Math.log(d.quantile(0.9)) };
}

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

function erfcinv(y: number): number {
  y = Math.min(Math.max(y, 1e-300), 2 - 1e-16);
  let x = 0;
  for (let i = 0; i < 60; i++) {
    const step = (erfc(x) - y) / ((-2 / Math.sqrt(Math.PI)) * Math.exp(-x * x));
    x -= step;
    if (Math.abs(step) < 1e-10) break;
  }
  return x;
}

/** Remaining-time median and P90 (log ms) of a log-normal summary of the prior, conditioned on having run `t` ms. */
function priorRemaining(q: PriorQ, t: number): [number, number] {
  const mu = q.l50, sd = Math.max(0.2, (q.l90 - q.l50) / 1.2816);
  const z = (Math.log(Math.max(t, 1)) - mu) / sd;
  const sf = 0.5 * erfc(z / Math.SQRT2);
  const at = (p: number) => {
    const zz = Math.SQRT2 * erfcinv(2 * sf * (1 - p));
    return Math.log(Math.max(1000, Math.exp(mu + sd * Math.max(zz, z)) - t));
  };
  return [at(0.5), at(0.9)];
}

export function liveVector(info: TurnInfo, q: PriorQ, o: Obs): number[] {
  const el = Math.max(o.elapsedMs, 1);
  const [rem50, rem90] = priorRemaining(q, el);
  const mins = el / 60000;
  const share = (xs: string[]) => (xs.length ? xs.filter((c) => c === 'edit').length / xs.length : 0);
  const last = o.lastTool ? kindOf(o.lastTool) : null;
  const n = (k: string) => o.phase[k] ?? 0;
  const cmds = CMD_LAST.reduce((a, c) => a + n(c), 0);
  return [
    Math.log(el), q.l10, q.l50, q.l90, rem50, rem90, Math.log(el) - q.l50, Math.log(el) - q.l90,
    Math.log1p(o.toolCalls), Math.log1p(o.subCalls), o.toolCalls / Math.max(mins, 0.25), Math.log1p(o.edits),
    share(o.history), share(o.history.slice(-8)), o.distinctTools,
    Math.log1p(o.sinceEvent / 1000), o.running ? 1 : 0, Math.log1p(o.runningFor / 1000), o.sinceEvent / el,
    ...KINDS.map((k) => +(last === k)),
    o.compactions, o.waits, +(info.agent === 'codex'), +(info.trigger === 'sdk'), effortOrdinal(info.effort), Math.log1p(info.chars),
    ...PHASE_COUNTS.map((c) => Math.log1p(n(c))), ...CMD_LAST.map((c) => +(o.lastCmd === c)),
    o.lastText ? +o.lastText.includes('text:early') : -1, o.lastText ? +o.lastText.includes('text:middle') : -1,
    Math.log1p(o.sinceText / 1000), +(n('cmd:commit') + n('cmd:push') > 0), cmds ? n('cmd:read') / cmds : -1,
  ];
}

// ---------------------------------------------------------------------------
// Model

export interface LiveModel {
  featureNames: string[];
  booster: Booster;
  /** Out-of-fold residual quantiles (0.1, 0.5, 0.9) of log remaining time. */
  q: [number, number, number];
  /** Weight of the learned estimate vs the survival-conditioned prior, in log space. */
  blend: number;
  /** Snapshots it was trained on. */
  n: number;
}

export interface GbdtModel {
  version: 'v2';
  /** Bumped when the layout changes; older files are ignored. */
  format: 3;
  trainedAt: string;
  n: number;
  featureNames: string[];
  bags: Booster[];
  /** Sorted out-of-fold residuals, log(actual) - log(predicted median). */
  residuals: number[];
  /** Kernel width (log space) used to smooth the residuals into a distribution. */
  bandwidth: number;
  /** Session correction: shift by sum(last k session residuals) / (count + kappa). */
  session: { k: number; kappa: number };
  /**
   * Out-of-fold location (log ms) of each training turn, by turn id. The session
   * correction needs honest errors: a turn the model was trained on would
   * otherwise look better predicted than it was.
   */
  oof: Record<string, number>;
  live: LiveModel | null;
}

export function isGbdtModel(m: unknown): m is GbdtModel {
  const x = m as GbdtModel;
  return !!x && x.version === 'v2' && x.format === 3 && Array.isArray(x.bags) && x.bags.length > 0
    && Array.isArray(x.residuals) && x.residuals.length > 0 && Array.isArray(x.featureNames) && x.featureNames.length === SUBMIT_FEATURES.length;
}

export interface TrainTurn {
  /** Database turn id (keys the out-of-fold locations). */
  id?: number | string;
  features: Features;
  activeMs: number;
  agent: string;
  submittedAt: number;
  /** Stored events (with phase labels) for training the live model. */
  events?: ReplayEvent[] | null;
}

const MAX_RESIDUALS = 300;
const CAP_MS = 2 * 60 * 60 * 1000;

function pool(resid: number[], max = MAX_RESIDUALS): number[] {
  const r = resid.filter(Number.isFinite).sort((a, b) => a - b);
  return r.length <= max ? r : Array.from({ length: max }, (_, i) => r[Math.floor(((i + 0.5) / max) * r.length)]);
}

/** Log-spaced snapshot times strictly inside a turn. */
export function snapshotTimes(activeMs: number): number[] {
  const out: number[] = [];
  for (let x = 3000; x < activeMs; x *= 1.5) out.push(x);
  return out;
}

export interface TrainOpts {
  bags?: number;
  rounds?: number;
  /** Train the live model (needs events with phase labels). */
  live?: boolean;
}

export function trainGbdt(turns: TrainTurn[], opts: TrainOpts = {}): GbdtModel {
  const X = turns.map((t) => submitVector(t.features));
  const y = turns.map((t) => Math.log(Math.min(Math.max(t.activeMs, 1000), CAP_MS)));
  const nBags = opts.bags ?? 5;
  const bo = (k: number): BoostOpts => ({ loss: 'quantile', alpha: 0.5, rounds: opts.rounds ?? 150, seed: 7 + k * 101, subsample: nBags > 1 ? 0.7 : 0.8 });
  const bags = Array.from({ length: nBags }, (_, k) => trainBooster(X, y, bo(k)));
  // Out-of-fold locations: each turn predicted by models that never saw it.
  const oofs = Array.from({ length: nBags }, (_, k) => oofPredict(X, y, bo(k), 5));
  const oof = y.map((_, i) => oofs.reduce((s, a) => s + a[i], 0) / nBags);
  const residuals = pool(y.map((v, i) => v - oof[i]));
  const oofById: Record<string, number> = {};
  turns.forEach((t, i) => { if (t.id != null && Number.isFinite(oof[i])) oofById[String(t.id)] = Math.round(oof[i] * 1e4) / 1e4; });
  const model: GbdtModel = {
    version: 'v2', format: 3, trainedAt: new Date().toISOString(), n: y.length, featureNames: SUBMIT_FEATURES,
    bags, residuals, bandwidth: 0.15, session: { k: 3, kappa: 3 }, oof: oofById, live: null,
  };
  if (opts.live !== false) model.live = trainLive(turns, oof, residuals, opts.rounds);
  return model;
}

function trainLive(turns: TrainTurn[], oof: number[], residuals: number[], rounds?: number): LiveModel | null {
  const rq = (p: number) => residuals[Math.min(residuals.length - 1, Math.floor(p * residuals.length))];
  const LX: number[][] = [], LY: number[] = [], LW: number[] = [], LG: number[] = [];
  turns.forEach((t, i) => {
    // Only turns whose events carry phase labels (imported by a parser that records them).
    if (!t.events?.some((e) => e.kind === 'phase') || !Number.isFinite(oof[i])) return;
    const T = Math.min(t.activeMs, CAP_MS);
    const times = snapshotTimes(T);
    if (!times.length) return;
    const q: PriorQ = { l10: oof[i] + rq(0.1), l50: oof[i] + rq(0.5), l90: oof[i] + rq(0.9) };
    const info = turnInfo(t.agent, t.features);
    replayObs(t.events, t.submittedAt, times).forEach((o, j) => {
      LX.push(liveVector(info, q, o));
      LY.push(Math.log(Math.max(T - times[j], 500)));
      LW.push(1 / times.length);
      LG.push(i);
    });
  });
  if (new Set(LG).size < 40) return null;
  const o: BoostOpts = { loss: 'quantile', alpha: 0.5, rounds: rounds ? Math.round(rounds * 4 / 3) : 200, lr: 0.06, maxDepth: 4, minLeaf: 20, weights: LW };
  const booster = trainBooster(LX, LY, o);
  const loof = oofPredict(LX, LY, o, 5, LG);
  const r = LY.map((v, i) => v - loof[i]).filter(Number.isFinite).sort((a, b) => a - b);
  const at = (a: number) => r[Math.min(r.length - 1, Math.floor(a * r.length))];
  return { featureNames: LIVE_FEATURES, booster, q: [at(0.1), at(0.5), at(0.9)], blend: 0.5, n: LY.length };
}

/** Bagged median location, log ms. */
export function locate(m: GbdtModel, f: Features): number {
  const x = submitVector(f);
  return m.bags.reduce((s, b) => s + predictBooster(b, x), 0) / m.bags.length;
}

/** Recently finished turns in the same session (most recent last). */
export interface PastTurn { id?: number | string; features: Features; activeMs: number }

/** Partially pooled shift toward the errors this model made on the session's last k turns. */
export function sessionShift(m: GbdtModel, past: PastTurn[]): number {
  const recent = past.slice(-m.session.k);
  if (!recent.length) return 0;
  let sum = 0;
  for (const p of recent) {
    const loc = (p.id != null ? m.oof?.[String(p.id)] : undefined) ?? locate(m, p.features);
    sum += Math.log(Math.min(Math.max(p.activeMs, 1000), CAP_MS)) - loc;
  }
  return sum / (recent.length + m.session.kappa);
}

/** Predictive distribution for one turn: bagged location + session shift + smoothed out-of-fold residuals. */
export function gbdtDistribution(m: GbdtModel, f: Features, past: PastTurn[] = []): LogMixture {
  const loc = locate(m, f) + sessionShift(m, past);
  return new LogMixture(m.residuals.map((r) => ({ w: 1, mu: loc + r, sd: m.bandwidth })));
}

/** Predict P10/P50/P90 in ms. */
export function predictGbdt(m: GbdtModel, f: Features, past: PastTurn[] = []): { p10: number; p50: number; p90: number } {
  const d = gbdtDistribution(m, f, past);
  return { p10: d.quantile(0.1), p50: d.quantile(0.5), p90: d.quantile(0.9) };
}

export interface LiveQuantiles { p10: number; p50: number; p90: number }

/** Remaining-time quantiles (ms) from the live model, blended with the survival-conditioned prior. */
export function liveEstimate(lm: LiveModel, info: TurnInfo, prior: LogMixture, q: PriorQ, o: Obs): { learned: LiveQuantiles; survival: LiveQuantiles; blended: LiveQuantiles } {
  const loc = predictBooster(lm.booster, liveVector(info, q, o));
  const learned = { p10: Math.exp(loc + lm.q[0]), p50: Math.exp(loc + lm.q[1]), p90: Math.exp(loc + lm.q[2]) };
  const survival = {
    p10: prior.remainingQuantile(o.elapsedMs, 0.1), p50: prior.remainingQuantile(o.elapsedMs, 0.5), p90: prior.remainingQuantile(o.elapsedMs, 0.9),
  };
  const w = lm.blend;
  const mix = (a: number, b: number) => Math.exp(w * Math.log(Math.max(a, 500)) + (1 - w) * Math.log(Math.max(b, 500)));
  return { learned, survival, blended: { p10: mix(learned.p10, survival.p10), p50: mix(learned.p50, survival.p50), p90: mix(learned.p90, survival.p90) } };
}
