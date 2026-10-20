# How tminus estimates time

AI agent turns are non-deterministic. The same prompt can take 40 seconds or 12 minutes, depending on what the agent finds. So tminus never shows a single number as if it were certain. It shows a **median** and a **range**, and keeps updating both while the agent works.

This page explains the method in plain language. Every number here was measured on real history with the protocol in section 7; the experiments are in [`lab/`](../lab).

## 1. What is being predicted

**Active time**: from the moment you submit a prompt to the moment the agent stops, minus the time it spent waiting on you (permission prompts, questions it asked you). Waiting time is excluded because tminus can't predict how quickly you'll respond.

```
active_ms = finished_at − submitted_at − idle_ms
```

Everything happens in **log space**, `log(active_ms)`. Durations are multiplicative: a turn that "takes twice as long" is the same kind of surprise at 30s and at 10min. In log space, turn durations look roughly bell-shaped.

There are two predictors. **v2**, a learned model, is used once it beats **v1**, a simple bucket model, on your own history (section 6). Until then, and as the fallback, v1 is used.

## 2. At submit time (v2)

When you submit a prompt, the hook derives features from it and drops the text: length, line count, file references, scope words ("all", "every"), an intent class (`explain`, `question`, `fix`, `small_edit`, `refactor`, `build_feature`, `test`, `review`, `other`), images, URLs. To these it adds the session context (turn index, the last few turns' durations, context window %), the repo size, the time of day, the permission mode, the **effort level** (low → max, as one ordered number) and the **model family** (Opus, Sonnet, Haiku, Fable, GPT-Codex, …), so a new release of a family you already use isn't a stranger.

- **Location.** Five gradient-boosted tree models, each trained on a different random 70% of your turns, predict the median of `log(active_ms)`; their average is the location. Averaging (bagging) steadies a model that only has a few hundred turns to learn from.
- **Spread.** The model's own *out-of-fold* errors: each training turn is predicted by models that never saw it, and the smoothed distribution of those errors is placed around the new prediction. This conformal step is what makes the range honest; directly trained P10/P90 models were too narrow on held-out data.
- **Session correction.** Errors persist within a session: when the last few turns of a session ran longer than predicted, the next one probably will too (the correlation is about 0.3 in the author's history). So the prediction is shifted by the errors the model made on the session's last 3 turns, shrunk toward zero:

  ```
  shift = sum(errors on the last k ≤ 3 turns of this session) / (k + 3)
  ```

  One turn that ran 2× long moves the next prediction by ×1.19; three in a row by ×1.41. The errors used are honest ones: for turns the model was trained on, their out-of-fold predictions.
- **Adaptive calibration.** The range shown at submit uses quantile levels that adapt online (Gibbs & Candès, 2021): when a turn runs past the shown P90, the level used for P90 moves up a little; when turns keep finishing inside, it drifts back. If your work changes (a new kind of project, a new model), the range widens instead of quietly becoming wrong.

From this distribution come the numbers you see at submit time:

- **P50**: half of similar turns finished faster ("~2m")
- **P10–P90**: 80% of turns like this finish inside this range ("1–5m")

## 3. While the agent works (v2)

Every hook event, the agent's messages (read from the transcript as it is written) and a 1-second tick update the estimate of the **remaining** time. Two estimates are blended, half each, in log space:

### a. Survival-conditioned prior

If a turn has already run for `t` minutes, the turns that finished before `t` are no longer possible outcomes. tminus conditions the submit-time distribution on survival:

```
remaining P50 = the median of (T − t | T > t)
remaining P90 = the 90th percentile of (T − t | T > t)
```

Agent durations have a heavy tail (most turns are short, some run very long). So a turn that keeps running pushes this estimate **up**, not down. tminus never shows a frozen "1 min left" for a turn that is clearly running long. Once elapsed time passes the original P90, the display switches to `⏳ ETA running long · 9m so far`.

### b. The learned live model

A second boosted model predicts the remaining time from what can be observed at this moment:

- elapsed time and the submit-time prediction
- tool activity: calls so far (including subagents), their rate, edits, distinct tools, which tool ran last
- timing: how long since the last tool event, whether a tool is running right now and for how long
- **phase labels**: what stage the work is in, judged from what the agent says ("let me start by exploring…" is early, "now I'll implement…" is the middle) and the shell commands it runs (tests, builds, commits, pushes come late)

Phase labels are the strongest of these: in the author's history, "let me start" messages come at a median 9% of the way through a turn, implementation messages at 52%, test and build commands at 62–66%, commits and pushes at 70–72%. Only the labels are kept: commands are classified inside the hook, the agent's messages are classified in memory as the transcript is read, and neither text is stored (`packages/core/src/phase.ts`).

The model is trained on snapshots of your past turns taken at log-spaced moments (3s, 4.5s, 6.75s, …), each turn weighted equally, with the submit-time prediction it would have had (out-of-fold). Its spread is its own out-of-fold error.

Until v2 has won on your history, v1's hand-tuned blend is used instead: the survival-conditioned prior, todo-list progress (items done × time per item, when the agent keeps a todo list), and the tool-call rate against similar turns, blended with weights that shift toward the evidence as it arrives. Current Claude Code versions don't write todo lists, so in practice that blend is mostly elapsed time.

## 4. v1: buckets (the fallback)

Past turns are grouped into buckets, from specific to general:

```
(model, effort, intent)  →  (model, intent)  →  (intent)  →  everything
```

tminus picks the most specific bucket with at least 8 past turns, **shrunk toward its parent** with weight `w = n / (n + 8)`. With 20 or more turns, the bucket's distribution is its actual history, lightly smoothed (a kernel density estimate in log space); below that, a fitted log-normal whose spread is also shrunk toward the parent's.

## 5. What actually predicts how long a turn takes

From the author's history (621 turns, Claude Code and Codex), with the protocol in section 7:

- **The prompt and the session carry most of the signal.** Prompt length alone has a rank correlation of 0.55 with duration; the last turns in the same session and project about 0.42.
- **Model and effort mostly reflect the task you chose them for.** Raw medians differ about 5× by effort (medium 38s, high 128s, xhigh 200s), but once the prompt and session are known, effort and model add no accuracy: within the same session and prompt shape, one effort level is worth about ×1.17 (95% CI ×0.92–×1.98; effort changed mid-session in only 5 sessions). The engine still uses both, in a compact form, and learns their effect when your history separates them from the task.
- **There is a ceiling.** With a few hundred turns, every additional feature (project history, recent durations, richer prompt statistics, a text model) either matched or lost to the simpler set: cross-validated error stayed at 0.85 in log space whatever was added, while the models fit the turns they had seen far better (0.6, and 0.13 for a deep model). Most of the remaining uncertainty is what the agent decides to do once it starts, which is why the live estimate matters more than the submit-time one. More history raises the ceiling, and the model is retrained as it grows.

## 6. How good is it? (`tminus stats`, `tminus eval`)

All predictions are scored **out of sample**. Live turns keep the prediction made at submit. Backfilled turns are scored with a model trained only on turns that happened before them.

- **Typical miss**: median of `|log(predicted P50 / actual)|`, shown as a factor. "×1.6" means the median was typically off by 60% in one direction or the other.
- **Under P90**: should be about 90%.
- **In range**: share of turns that finished inside the displayed P10–P90 range. Should be about 80%.
- **Live-update quality**: replays each past turn and asks what the predicted total was at 25%, 50% and 75% of the way through.
- **Still-running calibration**: across replayed moments, the share of turns that finished within the remaining P50 (target 50%) and P90 (target 90%) shown at that moment. This is the honest test of a live estimate.

`tminus eval` replays your turns in five consecutive time folds, each predicted by models trained only on earlier turns, exactly as the collector would have predicted them (session correction and live model included). v2 is used only while it wins on error, on most folds, on P90 loss, and on both submit-time and live calibration. `init` runs this once, and the collector repeats it every 25 new turns in the background.

On the author's history (same data, same protocol, `tminus eval`):

| | typical miss | pinball @0.5 | pinball @0.9 | live at 25% / 50% / 75% |
|---|---|---|---|---|
| v1 buckets | ×3.72 | 0.678 | 0.276 | ×2.2 / ×2.2 / ×2.6 |
| v2 as shipped in 0.2 | ×2.35 | 0.484 | 0.215 | ×1.9 / ×1.6 / ×1.9 |
| **v2 in 0.3** | **×2.18** | **0.453** | **0.198** | **×1.8 / ×1.6 / ×1.8** |

On the most recent 20% of turns, which were held out of every design decision until the end, the 0.3 engine's quantile score improved 7.7% over 0.2's at submit and 6.8% while running.

## 7. How the engine was designed (the lab)

`lab/` holds the experiment harness. It parses every transcript on the machine with the production parsers, adds research features computed from text in memory (only derived numbers are cached), and replays history **prequentially**: each turn is predicted by a model trained only on turns that finished before it, retrained every 25 turns like the collector. The newest 20% of turns was a holdout, scored only once at the end. Differences between candidates are reported with a paired bootstrap over sessions, because turns in one session aren't independent. Candidates were compared on a proper scoring rule (the average pinball loss of P10, P50 and P90 in log space), on the typical miss, and on calibration. `docs/DECISIONS.md` lists what was tried, what won, and what was rejected.

## 8. Why ranges are wide

Short, vague prompts ("continue", "fix it", "yes, go ahead") are genuinely unpredictable at submit: the agent decides how much to do. The live estimate narrows as the agent shows what it is doing. Specific prompts in a familiar repo narrow the range over time, because tminus learns from **your** history. Day one comes from your existing transcripts.
