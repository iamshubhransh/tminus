/**
 * Learned live model: predicts log(remaining active time) from what is
 * observable while a turn runs (elapsed time, the submit-time prediction,
 * tool activity and its timing). Trained on snapshots of past turns taken at
 * log-spaced elapsed times, using the submit model's out-of-fold predictions
 * so the training prior is as honest as the one seen live.
 */
import { LogMixture, toolCategory } from '@tminus/core';
import type { LabTurn } from './data.ts';
import { featureSet, gb, residualDist, type GbOpts } from './candidates.ts';
import { oofPredict, predictBooster, trainBooster, type BoostOpts, type Booster } from './gbdt.ts';
import { observe, type Candidate, type Ctx, type Fitted, type Obs } from './protocol.ts';

const EFFORT_ORD: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
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

export interface PriorQ { l10: number; l50: number; l90: number }

export const LIVE_NAMES = [
  'log_t', 'p_l10', 'p_l50', 'p_l90', 'p_rem50', 'p_rem90', 't_over_p50', 't_over_p90',
  'log_calls', 'log_sub', 'rate', 'log_edits', 'edit_share', 'recent_edit_share', 'distinct',
  'log_since', 'running', 'log_running_for', 'since_over_t', ...KINDS.map((k) => `last_${k}`),
  'compactions', 'waits', 'is_codex', 'is_sdk', 'effort_ord', 'log_chars',
];

const PHASE_COUNTS = ['text', 'text:early', 'text:middle', 'cmd:read', 'cmd:test', 'cmd:build', 'cmd:commit', 'cmd:push', 'cmd:run', 'cmd:install'];
const CMD_LAST = ['cmd:read', 'cmd:test', 'cmd:build', 'cmd:commit', 'cmd:push', 'cmd:run', 'cmd:install', 'cmd:other'];
export const PHASE_NAMES = [...PHASE_COUNTS.map((c) => `n_${c}`), ...CMD_LAST.map((c) => `last_${c}`), 'last_text_early', 'last_text_middle', 'log_since_text', 'shipped', 'read_share'];

export function phaseVec(o: Obs): number[] {
  const n = (k: string) => o.phase[k] ?? 0;
  const cmds = CMD_LAST.reduce((a, c) => a + n(c), 0);
  return [
    ...PHASE_COUNTS.map((c) => Math.log1p(n(c))),
    ...CMD_LAST.map((c) => +(o.lastCmd === c)),
    o.lastText ? +o.lastText.includes('text:early') : -1,
    o.lastText ? +o.lastText.includes('text:middle') : -1,
    Math.log1p(o.sinceText / 1000),
    +(n('cmd:commit') + n('cmd:push') > 0),
    cmds ? n('cmd:read') / cmds : -1,
  ];
}

/** Survival-conditioned remaining quantiles of a log-normal summary of the prior (closed form, cheap). */
function priorRemaining(q: PriorQ, t: number): [number, number] {
  // Log-normal with median l50 and P90 l90; conditional remaining quantiles via the survival function.
  const mu = q.l50, sd = Math.max(0.2, (q.l90 - q.l50) / 1.2816);
  const lt = Math.log(Math.max(t, 1));
  const z = (lt - mu) / sd;
  const sf = 0.5 * erfc(z / Math.SQRT2);
  const at = (p: number) => {
    const target = sf * (1 - p);
    const zz = Math.SQRT2 * erfcinv(2 * target);
    return Math.log(Math.max(1000, Math.exp(mu + sd * Math.max(zz, z)) - t));
  };
  return [at(0.5), at(0.9)];
}

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

function erfcinv(y: number): number {
  // Newton on erfc; y in (0, 2).
  y = Math.min(Math.max(y, 1e-300), 2 - 1e-16);
  let x = 0;
  for (let i = 0; i < 60; i++) {
    const e = erfc(x) - y;
    const d = (-2 / Math.sqrt(Math.PI)) * Math.exp(-x * x);
    const step = e / d;
    x -= step;
    if (Math.abs(step) < 1e-10) break;
  }
  return x;
}

export function liveVec(t: LabTurn, q: PriorQ, o: Obs, withPhase = false): number[] {
  const el = Math.max(o.elapsedMs, 1);
  const [rem50, rem90] = priorRemaining(q, el);
  const mins = el / 60000;
  const hist = o.history;
  const recent = hist.slice(-8);
  const share = (xs: typeof hist) => xs.length ? xs.filter((c) => c === 'edit').length / xs.length : 0;
  const last = kindOf(o.names[o.names.length - 1]);
  return [
    Math.log(el), q.l10, q.l50, q.l90, rem50, rem90, Math.log(el) - q.l50, Math.log(el) - q.l90,
    Math.log1p(o.toolCalls), Math.log1p(o.subCalls), o.toolCalls / Math.max(mins, 0.25), Math.log1p(o.edits), share(hist), share(recent),
    new Set(o.names).size,
    Math.log1p(o.sinceEvent / 1000), o.running ? 1 : 0, Math.log1p(o.runningFor / 1000), o.sinceEvent / el,
    ...KINDS.map((k) => (o.names.length && last === k ? 1 : 0)),
    o.compactions, o.waits, +(t.agent === 'codex'), +(t.trigger === 'sdk'), t.effort ? EFFORT_ORD[t.effort] ?? -1 : -1,
    Math.log1p(t.features.prompt.chars),
    ...(withPhase ? phaseVec(o) : []),
  ];
}

/** Log-spaced snapshot times strictly inside the turn. */
export function snapshotTimes(activeMs: number, start = 3000, step = 1.5): number[] {
  const out: number[] = [];
  for (let x = start; x < activeMs; x *= step) out.push(x);
  return out;
}

export interface LiveOpts {
  submit: GbOpts;
  boost?: BoostOpts;
  /** Equal total weight per turn instead of per snapshot. */
  perTurn?: boolean;
  name?: string;
  /** Residual pools per elapsed band (log-seconds edges) instead of one global pool. */
  bands?: number[];
  /** Use phase features (assistant text / shell command classes). */
  phase?: boolean;
  /** Blend the learned estimate with the survival-conditioned prior in log space (weight on learned). */
  blend?: number;
  /** Average this many live boosters (different seeds, subsample 0.7). */
  liveBag?: number;
  /** Snapshot grid multiplier (default 1.5). */
  step?: number;
}

export function learnedLive(o: LiveOpts): Candidate {
  const submit = gb(o.submit);
  return {
    name: o.name ?? `live[${o.submit.groups.join('+')}]`,
    fit(train: LabTurn[], ctx: Ctx): Fitted {
      const sub = submit.fit(train, ctx);
      // Out-of-fold submit-time quantiles for the training turns (same recipe as gb()).
      const fs = featureSet(o.submit.groups, train, ctx.hist);
      const X = train.map(fs.vec);
      const y = train.map((t) => t.y);
      const bo: BoostOpts = { loss: 'quantile', alpha: 0.5, ...o.submit.boost };
      const oof = oofPredict(X, y, bo, 5);
      const resid = residualDist(y.map((v, i) => v - oof[i]));
      const rq = (p: number) => resid[Math.min(resid.length - 1, Math.floor(p * resid.length))];
      const priorOf = (loc: number): PriorQ => ({ l10: loc + rq(0.1), l50: loc + rq(0.5), l90: loc + rq(0.9) });

      const LX: number[][] = [], LY: number[] = [], LW: number[] = [], LG: number[] = [], LT: number[] = [];
      train.forEach((t, i) => {
        if (!Number.isFinite(oof[i])) return;
        const T = Math.min(t.activeMs, 2 * 3600_000);
        const times = snapshotTimes(T, 3000, o.step ?? 1.5);
        if (!times.length) return;
        const obs = observe(t, times);
        const q = priorOf(oof[i]);
        obs.forEach((ob, j) => {
          LX.push(liveVec(t, q, ob, o.phase));
          LY.push(Math.log(Math.max(T - times[j], 500)));
          LW.push(o.perTurn ? 1 / times.length : 1);
          LG.push(i);
          LT.push(Math.log(times[j] / 1000));
        });
      });
      const lbo: BoostOpts = { loss: 'quantile', alpha: 0.5, rounds: 200, lr: 0.06, maxDepth: 4, minLeaf: 20, ...o.boost, weights: LW };
      const nb = o.liveBag ?? 1;
      const models: Booster[] = Array.from({ length: nb }, (_, k) => trainBooster(LX, LY, { ...lbo, seed: 7 + 101 * k, subsample: nb > 1 ? 0.7 : lbo.subsample }));
      const model = { predict: (x: number[]) => models.reduce((s, m) => s + predictBooster(m, x), 0) / nb };
      const loofs = Array.from({ length: nb }, (_, k) => oofPredict(LX, LY, { ...lbo, seed: 7 + 101 * k, subsample: nb > 1 ? 0.7 : lbo.subsample }, 5, LG));
      const loof = LY.map((_, i) => loofs.reduce((s, a) => s + a[i], 0) / nb);
      const bands = o.bands ?? [];
      const pools: number[][] = Array.from({ length: bands.length + 1 }, () => []);
      const bandOf = (lt: number) => { let b = 0; while (b < bands.length && lt >= bands[b]) b++; return b; };
      LY.forEach((v, i) => { if (Number.isFinite(loof[i])) pools[bandOf(LT[i])].push(v - loof[i]); });
      const qs = pools.map((p) => {
        const s = p.sort((a, b) => a - b);
        const at = (a: number) => s.length ? s[Math.min(s.length - 1, Math.floor(a * s.length))] : 0;
        return [at(0.1), at(0.5), at(0.9)];
      });
      return {
        predict: (t) => sub.predict(t),
        live: (t, prior: LogMixture, ob: Obs) => {
          const q: PriorQ = { l10: Math.log(prior.quantile(0.1)), l50: Math.log(prior.quantile(0.5)), l90: Math.log(prior.quantile(0.9)) };
          const loc = model.predict(liveVec(t, q, ob, o.phase));
          const [a, b, c] = qs[bandOf(Math.log(Math.max(ob.elapsedMs, 1) / 1000))];
          const learned = { p10: Math.exp(loc + a), p50: Math.exp(loc + b), p90: Math.exp(loc + c) };
          if (o.blend === undefined || o.blend >= 1) return learned;
          const w = o.blend;
          const surv = { p10: prior.remainingQuantile(ob.elapsedMs, 0.1), p50: prior.remainingQuantile(ob.elapsedMs, 0.5), p90: prior.remainingQuantile(ob.elapsedMs, 0.9) };
          const mix = (x: number, y: number) => Math.exp(w * Math.log(Math.max(x, 500)) + (1 - w) * Math.log(Math.max(y, 500)));
          return { p10: mix(learned.p10, surv.p10), p50: mix(learned.p50, surv.p50), p90: mix(learned.p90, surv.p90) };
        },
      };
    },
  };
}

/** Survival-conditioning only (no activity signals), for reference. */
export function survivalOnly(base: GbOpts): Candidate {
  const c = gb(base);
  return {
    name: `surv[${base.groups.join('+')}]`,
    fit(train, ctx) {
      const f = c.fit(train, ctx);
      return {
        predict: f.predict,
        live: (_t, prior, ob) => ({ p10: prior.remainingQuantile(ob.elapsedMs, 0.1), p50: prior.remainingQuantile(ob.elapsedMs, 0.5), p90: prior.remainingQuantile(ob.elapsedMs, 0.9) }),
      };
    },
  };
}
