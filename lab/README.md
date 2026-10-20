# lab: how the engine is designed and measured

A research harness for tminus's prediction engine. It runs on the transcripts on **your** machine, so you can check any claim in `docs/HOW_IT_WORKS.md` against your own history, or try a new idea.

Nothing here is shipped in the npm package. Prompt text is only ever held in memory: the cache (`$LAB_CACHE`, default `$TMPDIR/tminus-lab`) holds derived numbers and labels.

## Run

```sh
bun lab/data.ts                                   # parse every transcript, build the cache, print a summary
bun run lab -- --split dev v1 v2 production       # submit-time comparison on the dev split
bun run lab -- --split dev --live v2 production   # ... plus the live estimate
bun run lab -- --split dev --score human,command production   # score interactive turns only
```

Splits: `dev` scores trainable turns 150 → 80% (for designing), `holdout` the newest 20% (score it once, at the end), `all` everything after the first 150. `--maxtrain 100` simulates a new user with a short history.

The first candidate is the reference; every other row shows its score difference with a 95% confidence interval from a paired bootstrap over sessions, and the probability that it is better.

## Protocol

Prequential, like production: turns are scored in time order, each by a model trained only on turns that finished before it was submitted, retrained every 25 turns (`--every`). Metrics:

- **QS**: mean pinball loss of P10, P50 and P90 in log space (a proper scoring rule; lower is better)
- **typical**: median factor between P50 and actual; **in80**, **<P90**, **>P10**: coverage
- live: **avg** is the median over turns of the miss of the predicted total, averaged over 10–90% of the turn; **R<P50**, **R<P90**: calibration of the remaining time at log-spaced moments; **QS** on the remaining time

## Candidates (`registry.ts`)

| name | what |
|---|---|
| `global`, `v1`, `v2` | baselines: one distribution for everything, the bucket model, v2 as shipped in 0.2 (`legacy-v2.ts`) |
| `production` | the shipped engine, end to end (`packages/core/src/gbdt.ts`) |
| `gb:<groups>[@opts]` | a bagged booster over feature groups, e.g. `gb:base+session@bag=5,sc=0.5`. Groups: `base`, `agent`, `effort`, `family`, `session`, `project`, `recent`, `text`, `prev`, `own`, `knn`; `-prefix_` drops features. Options: `r` rounds, `lr`, `d` depth, `ml` min leaf, `ss`/`cs` subsampling, `loss=l2`, `hl` recency half-life, `bag`, `sc` heteroscedastic spread, `bw` |
| `ridge:<groups>` | ridge regression with CV-chosen penalty |
| `live:<groups>@...` | the learned live model on top of `gb`: `ph=1` phase labels, `pt=1` per-turn weights, `bl` blend with survival, `lbag`, `step`, `bands` |
| `surv:<groups>` | survival conditioning only (no live signals) |
| `<cand>\|rc:kS=3,aS=3` | session residual correction (`kG/aG`, `kP/aP` add global/project levels) |
| `<cand>\|aci:0.01` | adaptive calibration of the range; `\|la:0.02` online tracking of live quantiles |

## Analyses

- `explore.ts`: rank correlation of every feature with duration
- `ceiling.ts`: in-sample fit vs cross-validated error per feature set (is it bias or variance?)
- `diagnose.ts`: a candidate's errors by agent, model, week, intent, session size, duration
- `autocorr.ts`: do errors carry over between turns of a session / project / overall?
- `hetero.ts`: is the size of the error predictable?
- `effort-effect.ts`: the within-session effect of effort and model on duration
- `live-signal.ts`: how much each kind of live signal says about the remaining time
