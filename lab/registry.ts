import { gb, globalKde, production, ridge, v1, v2, type Group } from './candidates.ts';
import type { BoostOpts } from './gbdt.ts';
import { learnedLive, survivalOnly } from './live.ts';
import type { Candidate } from './protocol.ts';

const G = (s: string) => s.split('+') as Group[];
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Named candidates for lab/run.ts. `gb:<groups>` builds a booster over any feature groups, e.g. gb:base+session. */
export const REGISTRY: Record<string, () => Candidate> = new Proxy({
  global: () => globalKde,
  v1: () => v1,
  v2: () => v2,
  production: () => production(),
} as Record<string, () => Candidate>, {
  get(target, key: string) {
    if (key in target) return target[key];
    // gb:<groups>[@r=60,lr=0.05,d=2,ml=20,ss=0.7,cs=0.7,loss=l2,hl=200]
    if (key.startsWith('gb:')) {
      const [g, o] = key.slice(3).split('@');
      const kv = Object.fromEntries((o ?? '').split(',').filter(Boolean).map((s) => s.split('=')));
      const boost: BoostOpts = {
        rounds: kv.r ? Number(kv.r) : undefined, lr: kv.lr ? Number(kv.lr) : undefined, maxDepth: kv.d ? Number(kv.d) : undefined,
        minLeaf: kv.ml ? Number(kv.ml) : undefined, subsample: kv.ss ? Number(kv.ss) : undefined, colsample: kv.cs ? Number(kv.cs) : undefined,
        loss: kv.loss as BoostOpts['loss'], lambda: kv.lam ? Number(kv.lam) : undefined,
      };
      return () => gb({ groups: G(g), boost: clean(boost), halfLife: kv.hl ? Number(kv.hl) : undefined, name: key, scale: kv.sc !== undefined, scaleShrink: kv.sc ? Number(kv.sc) : undefined, bag: kv.bag ? Number(kv.bag) : undefined, bw: kv.bw ? Number(kv.bw) : undefined });
    }
    // live:<submit groups>[@pt=1,d=4,r=200,ml=20,bands=2.3/4.1]
    if (key.startsWith('live:')) {
      const [g, o] = key.slice(5).split('@');
      const kv = Object.fromEntries((o ?? '').split(',').filter(Boolean).map((s) => s.split('=')));
      const boost: BoostOpts = {
        rounds: kv.r ? Number(kv.r) : undefined, lr: kv.lr ? Number(kv.lr) : undefined, maxDepth: kv.d ? Number(kv.d) : undefined,
        minLeaf: kv.ml ? Number(kv.ml) : undefined, subsample: kv.ss ? Number(kv.ss) : undefined,
      };
      return () => learnedLive({
        submit: { groups: G(g), bag: kv.bag ? Number(kv.bag) : undefined, scale: kv.sc !== undefined, scaleShrink: kv.sc ? Number(kv.sc) : undefined },
        boost: clean(boost), perTurn: kv.pt === '1', bands: kv.bands ? kv.bands.split('/').map(Number) : undefined, name: key,
        phase: kv.ph === '1', blend: kv.bl ? Number(kv.bl) : undefined, liveBag: kv.lbag ? Number(kv.lbag) : undefined, step: kv.step ? Number(kv.step) : undefined,
      });
    }
    if (key.startsWith('surv:')) return () => survivalOnly({ groups: G(key.slice(5)) });
    if (key.startsWith('ridge:')) {
      const [g, o] = key.slice(6).split('@');
      const kv = Object.fromEntries((o ?? '').split(',').filter(Boolean).map((s) => s.split('=')));
      return () => ridge({ groups: G(g), lambda: kv.l ? Number(kv.l) : undefined, halfLife: kv.hl ? Number(kv.hl) : undefined, name: key });
    }
    return undefined;
  },
});
