# How tminus estimates time

AI agent turns are non-deterministic. The same prompt can take 40 seconds or 12 minutes, depending on what the agent finds. So tminus never shows a single number as if it were certain. It shows a **median** and a **range**, and keeps updating both while the agent works.

This page explains the math in plain language.

## 1. What is being predicted

**Active time**: from the moment you submit a prompt to the moment the agent stops, minus the time it spent waiting on you (permission prompts, questions it asked you). Waiting time is excluded because tminus can't predict how quickly you'll respond.

```
active_ms = finished_at − submitted_at − idle_ms
```

Everything happens in **log space**, `log(active_ms)`. Durations are multiplicative: a turn that "takes twice as long" is the same kind of surprise at 30s and at 10min. In log space, turn durations look roughly bell-shaped.

## 2. The prior: what usually happens for prompts like this

When you submit a prompt, tminus extracts a few features (never the text itself): length, an **intent** class (`explain`, `question`, `fix`, `small_edit`, `refactor`, `build_feature`, `test`, `review`, `other`), the model, the effort level, and more.

Past turns are grouped into buckets, from specific to general:

```
(model, effort, intent)  →  (model, intent)  →  (intent)  →  everything
```

tminus picks the most specific bucket with at least 8 past turns. A bucket with few turns is noisy, so its estimate is **shrunk toward its parent** with weight

```
w = n / (n + 8)
```

8 turns → half its own data, half the parent's. 80 turns → 91% its own. With 20 or more turns, the bucket's distribution is its actual history, lightly smoothed (a kernel density estimate in log space). Below that, it's a fitted log-normal whose spread is also shrunk toward the parent's.

From this distribution come the numbers you see at submit time:

- **P50**: half of similar turns finished faster ("~2m")
- **P10–P90**: 80% of similar turns finished inside this range ("1–5m")

## 3. Live updates: what the agent has done so far

Every hook event (tool calls, todo-list changes, waits) and a 1-second tick update three estimates of the **remaining** time.

### a. Survival-conditioned prior

If a turn has already run for `t` minutes, the turns that finished before `t` are no longer possible outcomes. tminus conditions the prior on survival:

```
remaining P50 = the median of (T − t | T > t)
remaining P90 = the 90th percentile of (T − t | T > t)
```

Agent durations have a heavy tail (most turns are short, some run very long). So a turn that keeps running pushes this estimate **up**, not down. tminus never shows a frozen "1 min left" for a turn that is clearly running long. Once elapsed time passes the original P90, the display switches to `⏳ ETA running long · 9m so far`.

### b. Todo progress

When the agent writes a todo list (Claude Code `TodoWrite` or tasks, Codex `update_plan`), tminus has real progress information:

```
remaining ≈ (total − done) × time per task
```

Time per task starts from your history (median active time per todo item) and moves toward the pace measured in this turn as items complete. The current task is itself survival-conditioned, so the estimate keeps moving between check-offs. Items added mid-run raise the total, and the estimate rises with it.

### c. Activity rate

Tool calls so far are compared with the bucket's typical total, which gives a rough "fraction done". Work done inside **subagents** the turn spawned counts too, matched to the turn by prompt id and only while the turn is running. Background agents that outlive the turn don't count. The fraction is nudged later when the main agent's recent mix shifts from reading files to editing them (editing tends to come late). This is a weak signal, and it gets a small weight. Set `countSubagentWork: false` to count main-thread calls only.

### Blending

```
w_prior    = 1 / (1 + 0.4·done + 0.03·tool_calls)      decays as evidence arrives
w_todo     = 1.5 · (done + 0.3) / (done + 1.3)          0 if there is no todo list
w_activity = up to 0.35, ramping in over the first 12 tool calls
```

Weights are normalised. The P50s are averaged in log space (a weighted geometric mean). P90 is the weighted log-average of the P90s, **inflated by how much the signals disagree**: when the todo list says 1 minute and the prior says 10, you should see a wide range.

## 4. How good is it? (`tminus stats`)

All predictions are scored **out of sample**. Live turns keep the prediction made at submit. Backfilled turns are scored with a model trained only on turns that happened before them.

- **Typical miss**: median of `|log(predicted P50 / actual)|`, shown as a factor. "×1.6" means the median was typically off by 60% in one direction or the other.
- **Under P90**: should be about 90%.
- **In range**: share of turns that finished inside the displayed P10–P90 range. Should be about 80%.
- **Live-update quality**: replays each past turn and asks what the predicted total was at 0%, 25%, 50% and 75% of the way through. It should improve from 0% to 50%.
- **Still-running calibration**: across replayed moments, the share of turns that finished within the remaining P50 (target 50%) and P90 (target 90%) shown at that moment. This is the honest test of a live estimate.

One caveat about the checkpoint numbers: the error at 75% can be *higher* than at 50%. When all tminus knows is "this turn has run for 5 minutes", a turn that's nearly done and one that's a third done look the same, and a calibrated estimate has to allow for both. Only progress information (todo lists) breaks that tie. Still-running calibration is the number that says whether the live estimate is honest.

## 5. Predictor v2 (default once it wins on your data)

v2 replaces the bucket lookup at submit time with gradient-boosted trees that use every feature: prompt shape, session context (turn index, the last few turns' durations, context %), repo size, and time of day.

- **Location:** a quantile model (α = 0.5, pinball loss) predicts the median.
- **Spread:** the model's own *out-of-fold* errors. Each training turn is predicted by a model that never saw it, and the smoothed distribution of those errors is placed around the new prediction. This conformal step is what makes the range honest. Directly trained P10/P90 models were too narrow on held-out data.

v2 is used only while it beats v1 on your history. `tminus eval` replays your turns in five consecutive time folds, each predicted by models trained only on earlier turns. v2 has to win on error, on most folds, on P90 loss, and on both submit-time and live calibration. `init` runs this once, and the collector repeats it every 25 new turns in the background. The resulting distribution is survival-conditioned during the turn exactly like v1's.

## 6. Why ranges are wide

Short, vague prompts ("continue", "fix it") are genuinely unpredictable: the agent decides how much to do. Specific prompts in a familiar repo narrow the range over time, because tminus learns from **your** history. Day one comes from your existing transcripts.
