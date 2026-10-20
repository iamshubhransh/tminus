/**
 * Lab runner: bun lab/run.ts [--split dev|holdout|all] [--live] [--ref name] cand1 cand2 ...
 * Candidates are looked up in lab/registry.ts.
 */
import { BucketPredictor, estimateRemaining } from '@tminus/core';
import { loadTurns, type LabTurn } from './data.ts';
import { trainingRow } from './candidates.ts';
import {
  buildHistory, compare, compareLive, rowLoss, runLive, runSubmit, splitIndices, summarize, summarizeLive,
  type Candidate, type Ctx, type LiveFn, type LiveRow, type RunOpts, type RunResult,
} from './protocol.ts';
import { REGISTRY } from './registry.ts';
import { adaptiveConformal, residualCorrect, type CorrectOpts } from './post.ts';

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const split = (flag('split') ?? 'dev') as RunOpts['split'];
const live = args.includes('--live');
const names = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && ['split', 'ref', 'every', 'score', 'maxtrain'].includes(args[i - 1].slice(2))));
const ref = flag('ref') ?? names[0];
const every = Number(flag('every') ?? 25);

const turns = await loadTurns();
const ctx: Ctx = { hist: buildHistory(turns), all: turns };
const scoreOnly = flag('score');
const opts: RunOpts = { split, every, score: scoreOnly ? scoreOnly.split(',') : undefined, maxTrain: flag('maxtrain') ? Number(flag('maxtrain')) : undefined };
const trainable = turns.filter((t) => t.trainable);
const [from, to] = splitIndices(trainable, opts);
console.log(`split=${split}: scoring trainable turns ${from}..${to - 1} of ${trainable.length} (${new Date(trainable[from].submittedAt).toISOString().slice(0, 10)} → ${new Date(trainable[to - 1].submittedAt).toISOString().slice(0, 10)}), retrain every ${every}`);

const results: RunResult[] = [];
const lives = new Map<string, LiveRow[]>();
const baseCache = new Map<string, RunResult>();
for (const name of names) {
  // name|rc:kG=10,aG=10,kP=5,aP=5,kS=5,aS=3 applies residual correction on top of a base candidate.
  const [baseName, post] = name.split('|');
  const make = REGISTRY[baseName];
  if (!make) { console.error(`unknown candidate ${baseName}`); process.exit(1); }
  const t0 = performance.now();
  let r: RunResult;
  if (post?.startsWith('rc')) {
    const kv = Object.fromEntries(post.slice(3).split(',').filter(Boolean).map((s) => s.split('=').map((x, i) => (i ? Number(x) : x))));
    const co: CorrectOpts = { kG: kv.kG, kappaG: kv.aG, kP: kv.kP, kappaP: kv.aP, kS: kv.kS, kappaS: kv.aS, name };
    let full = baseCache.get(baseName);
    if (!full) { full = runSubmit(make(), turns, ctx, { ...opts, split: 'all' }); baseCache.set(baseName, full); }
    let corrected = residualCorrect(full, turns, co);
    // |rc:...|aci:0.01 adds adaptive conformal calibration of the range on top.
    const aci = name.split('|').find((p) => p.startsWith('aci:'));
    if (aci) corrected = { ...adaptiveConformal(corrected, turns, { gamma: Number(aci.slice(4)) }), name };
    const keep = new Set(trainable.slice(from, to).filter((t) => !opts.score || opts.score.includes(t.trigger)).map((t) => t.key));
    r = { ...corrected, rows: corrected.rows.filter((x) => keep.has(x.key)) };
  } else {
    const c: Candidate = make();
    r = runSubmit(c, turns, ctx, opts);
    r.name = name;
  }
  results.push(r);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (live) {
    // Live estimator: the candidate's own, else production's blend driven by this prior.
    const scored = new Set(r.rows.map((x) => x.key));
    const test = trainable.filter((t) => scored.has(t.key));
    const helpers = new Map<string, { fitted: (typeof r.fits)[number]['fitted']; v1: BucketPredictor }>();
    for (let i = 0; i < r.fits.length; i++) {
      const b0 = r.fits[i].from;
      const cutoff = trainable[b0].submittedAt;
      const v1p = BucketPredictor.train(trainable.filter((t) => t.finishedAt < cutoff).map(trainingRow));
      const end = i + 1 < r.fits.length ? r.fits[i + 1].from : to;
      for (const t of trainable.slice(b0, end)) helpers.set(t.key, { fitted: r.fits[i].fitted, v1: v1p });
    }
    const liveFor = (t: LabTurn): LiveFn => {
      const h = helpers.get(t.key)!;
      if (h.fitted.live) return h.fitted.live.bind(h.fitted);
      const pr = h.v1.prior({ model: t.model, effort: t.effort, intent: t.features.prompt.intent });
      return (_t, prior, o) => {
        const e = estimateRemaining({
          elapsedMs: o.elapsedMs, prior, toolCalls: o.toolCalls + o.subCalls, toolHistory: o.history, todo: o.todo,
          perTaskPriorMs: pr.perTaskMs, bucketCalls: pr.calls,
        });
        return { p10: e.p10RemainingMs, p50: e.p50RemainingMs, p90: e.p90RemainingMs };
      };
    };
    const la = name.split('|').find((p) => p.startsWith('la:'));
    lives.set(r.name, runLive(test, r.dists, liveFor, la ? { gamma: Number(la.slice(3)) } : undefined));
  }
  console.error(`  ${name}: ${secs}s`);
}

const x = (v: number) => `×${Math.exp(v).toFixed(2)}`;
const pc = (v: number) => `${Math.round(v * 100)}%`;
const base = results.find((r) => r.name === ref) ?? results[0];
const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\n${pad('candidate', 34)} ${pad('typical', 8)} ${pad('MAE', 6)} ${pad('QS', 6)} ${pad('in80', 5)} ${pad('<P90', 5)} ${pad('>P10', 5)} ${pad('width', 6)} ΔQS vs ${base.name} [95% CI]  P(better)`);
for (const r of results) {
  const s = summarize(r.rows);
  let cmp = '';
  if (r !== base) {
    const c = compare(r.rows, base.rows, rowLoss);
    cmp = `${c.diff >= 0 ? '+' : ''}${c.diff.toFixed(4)} [${c.lo.toFixed(4)}, ${c.hi.toFixed(4)}]  ${pc(c.pBetter)}`;
  }
  console.log(`${pad(r.name, 34)} ${pad(x(s.mdae), 8)} ${pad(s.mae.toFixed(3), 6)} ${pad(s.qs.toFixed(4), 6)} ${pad(pc(s.cov80), 5)} ${pad(pc(s.under90), 5)} ${pad(pc(s.over10), 5)} ${pad(s.width.toFixed(2), 6)} ${cmp}`);
}
if (live) {
  console.log(`\n${pad('live (est. driven by candidate)', 34)} ${pad('avg', 7)} ${pad('@25%', 7)} ${pad('@50%', 7)} ${pad('@75%', 7)} ${pad('R<P50', 6)} ${pad('R<P90', 6)} ${pad('R>P10', 6)} ${pad('QS', 6)} Δavg vs ${base.name}`);
  const lb = lives.get(base.name)!;
  for (const r of results) {
    const l = lives.get(r.name)!;
    const s = summarizeLive(l);
    let cmp = '';
    if (r !== base) { const c = compareLive(l, lb); cmp = `${c.diff >= 0 ? '+' : ''}${c.diff.toFixed(4)} [${c.lo.toFixed(4)}, ${c.hi.toFixed(4)}]`; }
    console.log(`${pad(r.name, 34)} ${pad(x(s.avg), 7)} ${pad(x(s.at25), 7)} ${pad(x(s.at50), 7)} ${pad(x(s.at75), 7)} ${pad(pc(s.c50), 6)} ${pad(pc(s.c90), 6)} ${pad(pc(s.c10), 6)} ${pad(s.qs.toFixed(3), 6)} ${cmp}`);
  }
}
