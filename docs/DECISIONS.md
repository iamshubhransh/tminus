# Decisions

Choices made while building tminus, with the reason for each. Newest last.

1. **Package name `@iamshubhransh/tminus`, command `tminus`.** `tminus` was unclaimed on npm on 2026-10-20, but the registry refused it on publish as too similar to the existing `t-minus`, so the package is scoped to the author. The binary is still `tminus`. Internal workspaces are `@tminus/core`, `@tminus/adapters`, `@tminus/render` (private).

2. **SQLite driver: `bun:sqlite`, else `node:sqlite`.** Both are built in, so tminus has no dependencies and no native module. 0.1–0.2.0 also carried `better-sqlite3` as an optional dependency for Node 20. It was dropped in 0.2.1: Node 20 reached end of life in April 2026, and on every npm install it added 38 packages and a `prebuild-install` deprecation warning, the first line new users saw. Node needs 22.13+, where `node:sqlite` works without a flag. Its ExperimentalWarning is filtered so it can't leak into hooks or the statusline.

3. **Hooks spool, a collector computes.** `tminus hook` parses the payload, derives prompt features, writes one small JSON file into `~/.tminus/spool/` (atomic rename) and makes sure the collector runs. It takes about 17ms and prints nothing. A single background collector (pid lock) drains the spool, ticks every second while a turn runs, writes state files, and exits after 30 idle minutes. One file per event avoids append races between concurrent async hooks.

4. **Claude Code hooks are `async: true`.** The agent never waits on tminus, so even a slow disk can't add latency to tool calls. Events are timestamped inside the hook at spawn time.

5. **The prompt never leaves the hook process.** Features (length, words, intent, refs, scope words, …) are computed in the hook. Spool files, the DB and state files contain no prompt text. Backfill reads prompts in memory and keeps only features. The intent classifier is deterministic keyword rules.

6. **Install copies tminus to `~/.tminus/bin/tminus.js`.** Hooks then don't depend on where the repo or an npx cache lives. The command uses absolute paths to Bun (preferred) or Node.

7. **The statusline wraps, never replaces.** If a statusline exists, it is stored in `~/.tminus/install.json`. The new command runs it in parallel with the same stdin and appends the tminus segment to its first line (configurable: `append-first`, `append-last`, `newline`). When idle, the user's line is shown unchanged.

8. **`refreshInterval`.** Claude Code supports a statusline `refreshInterval` (seconds). When tminus owns the statusline alone, init sets it to `1` for a ticking countdown. When wrapping, the user's own setting is kept, because a 1s refresh would also run their command every second. `tminus init --refresh N` overrides this. tmux and the menubar app always tick.

9. **Uninstall is byte-exact when it can be.** The bytes from before the first install are saved. On uninstall, tminus removes its entries; if the result equals the original JSON, it writes the original bytes back verbatim. If the user changed other settings since then, only tminus's entries are removed and their edits are kept, with indentation preserved.

10. **Codex live = rollout tailer; Codex hooks only wake the collector.** Codex skips new hooks until the user trusts them via `/hooks`, and writing trust hashes into `config.toml` ourselves would be fragile. The rollout file has everything with exact timestamps. Using one live source per agent also avoids double counting. The tailer works whenever the collector runs (Claude Code hooks, `tminus render --tmux`, the menubar app, or `tminus watch`).

11. **Turn boundaries.** A turn is prompt → agent stops, matching how a person waits. Agent-initiated turns (`task-notification`, peer messages, auto-continuation) are tracked and shown, but excluded from training, since their durations follow a different pattern. `command` (slash commands) and `sdk` (headless) turns are trained on.

12. **Interrupts.** No hook fires on Esc in Claude Code. A new prompt while a turn is open closes it as `interrupted` at its last activity, and the collector also tails the transcript for the interrupt marker so the status line stops counting right away. Interrupted turns are stored, never trained on.

13. **Training filter.** Completed turns with `active_ms ≥ 1s`. Durations are capped at 2h for training only; the DB keeps the raw value. Each bucket remembers its 240 most recent samples, which keeps the model current and fast.

14. **Displayed range = P10–P90 (an 80% interval).** The spec asks for P50 and P90 and a range. A range needs a lower bound, so tminus also computes P10. `tminus stats` reports both "under P90" (target ~90%) and "inside the range" (target ~80%).

15. **Mixture-of-Gaussians in log space.** One representation covers both the fitted log-normal (small n) and a kernel-smoothed empirical distribution (n ≥ 20, Silverman bandwidth). Shrinkage toward the parent bucket is a weighted mixture. Survival conditioning is solved in log-survival space, which stays stable far into the tail.

16. **Backfill predictions are prequential.** Each imported turn is scored with a model trained only on turns before it. So `tminus stats` on day one shows honest out-of-sample calibration. The first 20 (cold start) are excluded from stats.

17. **Live-update metric: the checkpoint error has a floor, so tminus also reports still-running calibration.** Replaying 567 real turns showed the survival-conditioned estimate is calibrated given survival (47% of still-running turns finished within the shown P50, 90% within P90). Yet the error at 75% of a turn is higher than at 50%. That is structural: without progress information, "has run t" can't separate a turn that is 75% done from one that is 25% done. A GBDT on hook-visible activity features (tool rate, edit share, time since last tool) did not beat the prior, and reweighting the activity signal didn't either. Todo lists are where real progress information comes from. `tminus stats` shows both numbers.

18. **v2 GBDT: on by default, but only while it wins on your own history.** (Revised; see 22 and 23.) `predictor: "v2"` is the default. It means: use v2 once `tminus eval` has shown it beats v1 on *this machine's* turns, otherwise v1. `tminus init` runs the evaluation after importing history. The collector re-runs it in a detached process after every 25 new finished turns, so v2 is retrained as history grows and switched off automatically if it ever stops winning. `predictor: "v1"` pins the bucket model.

19. **Model id normalisation.** `claude-opus-5-5[1m]` and dated ids collapse to one bucket. Model and effort learned after submit (hooks don't carry the model, and `UserPromptSubmit` has no effort) are written back to the turn at close.

20. **Context % in backfill is approximate.** Transcripts don't record the context window size. tminus assumes 1M if the session ever went above 200k tokens, otherwise 200k. Live turns use the statusline's exact `context_window.used_percentage`, which the renderer leaves in a small side file for the collector.

21. **Menubar app.** SwiftUI `MenuBarExtra` (macOS 13+) watching the `state/` directory. The collector replaces `current.json` atomically, so watching the file alone would miss updates. It counts down locally between writes.

22. **Evaluation is rolling-origin, and scores what production uses.** A single 80/20 split could flatter either model. `tminus eval` uses 5 consecutive time folds, each trained only on earlier turns (minimum 200). v2 must pass all five checks:
    - lower pooled typical miss
    - a lower miss on most folds
    - P90 pinball loss no worse
    - under-P90 calibration no more than 3 points further from 90%
    - live still-running P90 calibration no more than 3 points further from 90%

    The first version scored the GBDT's raw quantiles while the live engine used a log-normal built from them. Both now use the exact same distribution.

23. **v2's spread comes from its own out-of-fold residuals, not from α = 0.1/0.9 models.** On the author's history, the directly trained α = 0.1 model sat too high: 22–23% of turns finished below its P10 (target 10%), so the range covered only 65% (target 80%). The fix is conformal: the α = 0.5 GBDT gives the location, and the distribution of its 5-fold out-of-fold log residuals, kernel-smoothed (bandwidth 0.15), gives the shape. Same folds, 398 held-out turns:

    | | typical miss | under P90 | in range | below P10 | live at 25/50/75% | live P50/P90 cal |
    |---|---|---|---|---|---|---|
    | v1 | ×3.6 | 86% | 70% | 16% | ×2.2/×2.2/×2.6 | 50%/87% |
    | v2, log-normal from α = 0.5/0.9 | ×2.3 | 87% | 65% | 23% | ×1.9/×1.6/×1.8 | 51%/85% |
    | **v2, residual-calibrated** | **×2.1** | 95% | **82%** | 12% | **×1.8/×1.5/×1.8** | 51%/94% |

    v1's bucket shape re-centred on v2's median over-covered (96% under P90). The residual-calibrated version is slightly conservative at P90 and right on target elsewhere. Model files from the earlier layout are rejected (`format: 2`), and v1 is used until `tminus eval` retrains.

24. **Subagent work counts toward the activity signal.** Claude Code subagent transcripts (`<session>/subagents/agent-*.jsonl`) carry the `promptId` of the turn that spawned them. Their tool calls are attributed to that turn while it is running (`turns.subagent_tool_calls`, schema v3), in backfill, live, and replay alike. Background subagents still working after their parent turn ended are not counted: the user already had their answer. Codex subagent threads (`thread_source: "subagent"`, `parent_thread_id`) are attributed to the parent thread. That path is tested on synthetic data only, because the author's Codex history has none.

    Measured honestly: on the 16 human turns in the author's history that spawned subagents, counting them changed the live error from ×1.56/×1.20/×1.50 to ×1.82/×1.36/×1.33 (at 25/50/75%). Worse early, better late. It made no difference across all ~600 turns. Neither a discounted count nor a "wait for running foreground subagents" floor did better: every subagent in that history was background-style. Neither did switching the prior once a subagent spawns. With 16 turns, none of these differences is significant. Counting stays on because it was requested and is consistent everywhere. `countSubagentWork: false` turns it off, and `tminus stats` shows the effect as history grows. The real issue with these turns is that they run much longer than predicted (only 20% finish within the shown P50); more history will tell whether that can be learned.

25. **Agent wake-up messages are turns.** When another session hands back a message (`origin.kind: "peer"`) or Claude Code auto-continues, it writes an `isMeta` user record and starts a new agent turn. The parser used to skip all `isMeta` records, which left 57 agent-initiated turns out of the author's history. In versions without `turn_duration`, it could also have merged their activity into the previous human turn. They are now `system` turns: tracked and shown, never trained on.

26. **The statusline runs a render-only entry.** `tminus-render.js` (16KB) is installed next to the CLI bundle (176KB) and contains only state reading and formatting. Every redraw used to parse the whole CLI. End-to-end statusline time on the author's Mac went from 18.9ms to 15.0ms on Bun and from 29.3ms to 25.8ms on Node. A script that only reads stdin already costs ~13ms in Bun, so this is close to the floor.

27. **CI enforces function on every runner, and the 30ms budget on real hardware.** GitHub's shared VMs start processes much more slowly: the same bundle took 31.8ms on a macOS runner. The end-to-end spawn benchmark therefore gets `TMINUS_RENDER_BUDGET_MS=60` in CI, while the in-process render benchmark (<5ms) stays strict. The 30ms budget is enforced by the test suite's default and by `tminus doctor` on the user's own machine. The npm-package smoke test checks behaviour (hooks recognised, wrapped statusline output, byte-exact uninstall), not timing.

28. **The segment is always visible, labelled, and asks once.** Users who had just installed tminus saw nothing until their first prompt and couldn't tell whether it worked, and `⏳ ~2m` alone didn't say what the number was. The segment now shows a gray `ETA · idle` whenever nothing is running (before the first prompt, after the 10-second result) and a bold, colored `⏳ ETA ~2m (1–5m)` while a prompt runs. Claude Code reloads `settings.json` in open sessions and redraws the status line when its command changes, so `ETA · idle` appears right after `init`. `formats.idle: ""` restores the old hide-when-idle behaviour. `init` now shows all changes and asks a single `[Y/n]`. Without a terminal it changes nothing and prints `tminus init --yes`. That case covers scripts, an AI agent installing it for you, and `!` inside Claude Code. The README one-liner is therefore `npm install -g @iamshubhransh/tminus && tminus init --yes`: typing that line is the consent, the change is summarised in plain words (`--diff` for the exact diff), and `tminus uninstall` restores the files byte for byte. Auto-running setup from an npm `postinstall` script was rejected: Bun and pnpm skip install scripts by default, security tooling and agents flag packages that edit config on install, and a postinstall can't ask for consent.

### The 0.3 engine (October 2026)

Measured with the lab (`lab/`, method in HOW_IT_WORKS §7) on the author's 621 trainable turns: prequential replay retraining every 25 turns, the newest 20% held out until the end, paired session-block bootstrap for every comparison. "Score" below is the average pinball loss of P10/P50/P90 in log space (lower is better); "typical miss" is the median factor between P50 and actual.

29. **Effort comes from every assistant record.** Claude Code writes `effort` / `perTurnEffort` on each assistant record; the importer only read `api-request` records, which newer versions write, so 255 Claude Code turns had no effort. All have it now. The importer also skips `!` shell commands (`<bash-input>`): they are the user's own commands, not agent work, and one ran for two minutes.

30. **Model and effort are encoded compactly, and turned out not to matter on this history.** Raw medians differ about 5× by effort (medium 38s, high 128s, xhigh 200s), but with prompt and session features present, removing the model and effort features left the score unchanged (dropping the per-model one-hots even improved it slightly, 99% likely). A within-session regression puts one effort level at ×1.17 (95% CI ×0.92–×1.98), identified by only 5 sessions where effort changed. People pick effort to fit the task, and the prompt already shows the task. The engine keeps effort as one ordered number and the model as a family one-hot: equally accurate here, and it generalises to new model ids and to people whose effort varies independently of the task.

31. **Bagging, not more features.** Every feature group added on top of the shipped set (project history, recent global durations, previous-assistant-message cues, richer prompt statistics, separating pasted text from the user's own words) tied or lost; cross-validated error stayed at 0.85 whatever was added, against 0.6 in-sample. With a few hundred turns the problem is variance. Averaging five boosted models trained on different 70% subsamples was the one location change that helped.

32. **Session correction from honest errors.** A turn's error correlates 0.30 with the mean error of the previous three turns in the same session (0.27 within a project, 0.18 globally). Shifting the prediction by `sum(last ≤ 3 session errors) / (k + 3)` improved the score with 95–99% confidence; adding project or global terms made it worse. Production uses each training turn's out-of-fold prediction for these errors: in-sample errors are about 30% smaller and would silently weaken the correction. Together with bagging and the compact model/effort encoding: score 0.2816 → 0.2675 (−5%) on interactive dev turns (0.2665 for the production code path).

33. **Rejected: similar-prompt matching.** The mean duration of the most similar earlier prompts (Jaccard over hashed words and bigrams) helped (score −0.004, 97% likely) only with a fine hash space (16,384 buckets). Storing per-turn word fingerprints that fine would make prompts partly recoverable by dictionary attack, which breaks the promise that prompt text is never stored. At 1,024 buckets, where each bucket holds dozens of words, the gain disappeared. Not worth 1.5%.

34. **Rejected: ridge regression, recency weighting, error-size models, a tuned booster.** Ridge on log duration lost to the trees (non-linearity matters). Weighting recent turns (half-lives 50–400 turns) hurt or tied. Predicting each turn's error size (normalised conformal) was neutral once bagged. No booster depth, leaf size, round count or loss beat the defaults beyond noise.

35. **A learned live model, with phase labels.** Snapshots of past turns (3s, 4.5s, … into each turn, weighted per turn) train a boosted model of log remaining time. Tool counts and timing alone barely beat survival conditioning (cross-validated error 1.089 → 1.051); phase labels from the agent's messages and shell commands moved it further (1.042) and, blended 50/50 with the survival-conditioned prior, gave the first significant live gain: live score 0.311 → 0.300, average miss ×1.59 → ×1.52, and ×1.73 → ×1.51 at 75% of the turn. Phase labels are derived in memory (commands inside the hook, messages from the transcript tail the collector already read for interrupts) and only labels are stored. Rejected on the way: per-band residual pools, other blend weights (0.3–0.7 tie), a bagged live model and a denser snapshot grid (both tie), and online tracking of live quantiles (better average miss, worse score on the holdout).

36. **Adaptive calibration of the shown range.** The held-out period (the author building tminus itself: long, unusual turns) showed both engines miscalibrated: 63–69% of turns inside the 80% range. Adaptive conformal calibration (Gibbs & Candès 2021, step 0.01, chosen on dev only) moves the quantile levels used for the shown P10/P90 after each finished turn. On dev it took coverage from 87% to 81% with narrower ranges; on the holdout it improved coverage from 63% to 70%. It changes the submit-time range (and the "running long" threshold), not the live model.

37. **Upgrades enrich history instead of rebuilding it.** Phase labels and effort are new per-turn data. `backfill --rebuild` would delete every backfilled turn, including those whose transcripts the agent has since cleaned up (Claude Code keeps about 30 days). Instead, re-importing an existing turn fills missing model/effort and adds phase events if it has none (`enrichTurn`). The database records a data version; a collector that finds an older one runs that enrichment once in the background and retrains. `init` also stops a collector left from a previous version, so new code takes over at the next hook.

38. **Result.** Same data, same protocol (`tminus eval`, five rolling folds, 423 test turns): typical miss ×2.35 → ×2.18, pinball@0.5 0.484 → 0.453, pinball@0.9 0.215 → 0.198, live ×1.9/×1.6/×1.9 → ×1.8/×1.6/×1.8 at 25/50/75%. On the untouched holdout: score −7.7% at submit, −6.8% live. The production code path was checked against the lab's implementation of the same recipe (scores 0.2665 vs 0.2675 at submit, 0.300 vs 0.300 live).

## Open decisions
- **The submit-time ceiling.** Decisions 30–34: with a few hundred turns, nothing beyond the current features helps. Prompt semantics are the obvious next source, but anything that captures them (embeddings, fine word fingerprints) conflicts with not storing prompt text. A local embedding computed in the hook and stored only as a coarse cluster id might be acceptable; untested.
- **Displayed range width.** Typical agent turns have σ ≈ 1.4 in log space, so an honest 80% interval at submit is wide ("15s–21m" for a vague prompt). A P25–P75 option would look tighter but cover only half the turns.
- **Turns that spawn subagents are under-predicted.** Only 20% finish within the shown P50. Counting their tool calls doesn't fix that (see 24). A feature that predicts "this prompt will fan out to subagents" at submit time might.
