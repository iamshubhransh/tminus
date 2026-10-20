/** How much can the features explain at all? In-sample fit vs honest cross-validation, per feature set. */
import { loadTurns } from './data.ts';
import { buildHistory } from './protocol.ts';
import { featureSet, cvRidge, fitRidge, predictLinear, type Group } from './candidates.ts';
import { oofPredict, predictBooster, trainBooster } from './gbdt.ts';

const turns = await loadTurns();
const hist = buildHistory(turns);
const tr = turns.filter((t) => t.trainable);
const y = tr.map((t) => t.y);
const mean = y.reduce((a, b) => a + b, 0) / y.length;
const mad = (p: number[]) => p.reduce((s, v, i) => s + Math.abs(y[i] - v), 0) / y.length;
console.log(`n=${tr.length}; predicting the overall mean: MAE ${mad(y.map(() => mean)).toFixed(3)}`);
const sets: Group[][] = [['base'], ['base', 'agent'], ['base', 'agent', 'effort', 'family', 'session', 'project', 'text', 'prev', 'own']];
for (const g of sets) {
  const fs = featureSet(g, tr, hist);
  const X = tr.map(fs.vec);
  const m = trainBooster(X, y, { loss: 'quantile', alpha: 0.5 });
  const inGb = mad(X.map((x) => predictBooster(m, x)));
  const cvGb = mad(oofPredict(X, y, { loss: 'quantile', alpha: 0.5 }, 5));
  const deep = trainBooster(X, y, { loss: 'quantile', alpha: 0.5, rounds: 600, maxDepth: 6, minLeaf: 2 });
  const inDeep = mad(X.map((x) => predictBooster(deep, x)));
  const cv = cvRidge(X, y);
  const lin = fitRidge(X, y, cv.lambda);
  console.log(`${g.join('+').padEnd(60)} d=${String(fs.names.length).padEnd(3)} GBDT in-sample ${inGb.toFixed(3)} / 5-fold ${cvGb.toFixed(3)} | deep in-sample ${inDeep.toFixed(3)} | ridge in-sample ${mad(X.map((x) => predictLinear(lin, x))).toFixed(3)} / 5-fold ${mad(cv.oof).toFixed(3)} (λ=${cv.lambda})`);
}
