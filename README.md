# tminus

[![CI](https://github.com/iamshubhransh/tminus/actions/workflows/ci.yml/badge.svg)](https://github.com/iamshubhransh/tminus/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@iamshubhransh/tminus)](https://www.npmjs.com/package/@iamshubhransh/tminus)
[![license](https://img.shields.io/npm/l/tminus)](LICENSE)

**A live ETA for AI coding agents, in your terminal status line.**

```
user@repo main ✓ │ ⏳ ~2m · 1–5m · 3/7
```

tminus predicts how long Claude Code (or Codex CLI) will take to finish your prompt. It shows a range the moment you hit enter and tightens it while the agent works. It learns from your own history, imported from the transcripts already on your machine, so it is useful on day one.

<!-- GIF: statusline countdown during a Claude Code turn -->
> _demo GIF placeholder: `docs/demo.gif`_

## Install

```sh
npm install -g @iamshubhransh/tminus   # or: bun add -g @iamshubhransh/tminus
tminus init
```

To try it without installing: `npx @iamshubhransh/tminus init`. The command is `tminus` either way.

`init` finds your agents, imports your history, then shows a diff of every config change and asks before applying it (`--yes` skips the prompt). Your existing status line is kept and the estimate is appended to it. `tminus uninstall` puts your config back byte for byte.

Bun is recommended: the status line renders in about 18ms under Bun (about 27ms under Node). Node 20+ works too.

## What you'll see

| state | status line |
|---|---|
| running | `⏳ ~2m · 1–5m · 3/7` (median remaining · P10–P90 range · todo progress) |
| waiting on you | `⏸ waiting on you` |
| past its P90 | `⏳ running long · 9m` |
| just finished | `✓ 4m12s · predicted 3m` (for 10 seconds) |

Claude Code redraws its status line on agent events. When tminus owns the status line, it sets `refreshInterval: 1` so it ticks every second. When it wraps your existing one, it keeps your refresh setting. For a smooth countdown anywhere:

- **tmux**: `set -g status-right '#(tminus render --tmux)'` and `set -g status-interval 1`
- **macOS menubar**: `apps/menubar` (SwiftUI). A ticking countdown, a progress ring and your last 10 turns, predicted vs actual.
- **any terminal**: `tminus watch`

## How the estimate works

1. **At submit**, tminus classifies the prompt (fix, refactor, question, build a feature, …) and looks up how similar turns went for you, by model, effort and intent. A bucket with little data borrows strength from broader ones. You get the median and an 80% range.
2. **While the agent works**, three signals update the remaining time:
   - **elapsed time**: a turn that keeps running is probably a long one, so the estimate grows instead of freezing
   - **the agent's todo list**: items done × time per item
   - **tool activity**, including work done by subagents the agent spawned
3. **Time waiting on you** (permission prompts, questions) doesn't count.
4. **Every finished turn** is added to your history.

The full math is in [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

**Honest framing:** agent work is non-deterministic, so tminus shows ranges, not promises. Short, vague prompts ("continue", "fix it") are the least predictable. `tminus stats` tells you how well calibrated it is on your data:

```
tminus stats · 567 finished turns with a prediction made before they started
          turns  typical miss  under P90  in range
backfill    567          ×2.8        88%       79%
```

## Privacy

- Everything stays on your machine, in `~/.tminus/`. Nothing is sent anywhere.
- **Prompt text is never stored.** The hook derives a handful of features (length, word count, intent class, number of file references, scope words) and drops the text right there. Transcripts are read during import and only the same features are kept.
- Project paths are stored hashed. `tminus export` produces an anonymized CSV of features and durations, which contains no prompts because there are none to export.

## Supported agents

| agent | history import | live |
|---|---|---|
| Claude Code (2.1.x) | `~/.claude/projects/**/*.jsonl` | hooks (async, so they never slow the agent) + status line |
| Codex CLI (0.108–0.156) | `~/.codex/sessions/**/rollout-*.jsonl` | follows the active session file. Optional hooks wake tminus; Codex asks you to trust them once via `/hooks`. |

Formats were verified against real transcripts and live hook payloads; see [docs/AGENT_FORMATS.md](docs/AGENT_FORMATS.md). Want another agent? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

```
tminus init [--yes] [--no-backfill] [--refresh <sec>]   set everything up (idempotent)
tminus status                                           current estimate, with signal weights
tminus stats                                            accuracy and calibration on your history
tminus history [-n 20]                                  recent turns: predicted vs actual
tminus backfill [--since 2026-10-01]                    re-import transcripts
tminus render --statusline | --tmux [--format "..."]    renderers
tminus watch                                            live countdown in this terminal
tminus doctor                                           hooks, database, render latency
tminus eval                                             v1 vs v2 on rolling time folds of your history
tminus export [--out turns.csv]                         anonymized features + durations
tminus config set <key> <value>                         configuration
tminus uninstall [--purge]                              restore configs exactly
```

## Configuration

`~/.tminus/config.json` (or `tminus config set …`):

| key | default | |
|---|---|---|
| `formats.running` | `{status} ~{p50} · {range} · {todo}` | tokens: `{status} {p50} {range} {todo} {elapsed}` |
| `formats.waiting` | `⏸ waiting on you` | |
| `formats.overrun` | `{status} running long · {elapsed}` | |
| `formats.done` | `✓ {actual} · predicted {predicted}` | |
| `color` | `true` | `NO_COLOR` always wins |
| `doneLingerSec` | `10` | how long the result stays visible |
| `wrapPosition` | `append-first` | `append-last`, `newline` |
| `predictor` | `v2` | v2 is used while it beats v1 on your own history (`tminus eval`, rechecked every 25 turns); `v1` pins the bucket model |
| `countSubagentWork` | `true` | count tool calls inside subagents as work in the activity signal |

Empty tokens take their separators with them, so `{todo}` disappears cleanly when there's no todo list.

## Development

```sh
bun install
bun test          # 105 tests: features, shrinkage, survival, blending, idle time, subagents, fixtures, install round-trip, v2 gating, render benchmark
bun run build     # packages/cli/dist/tminus.js (Bun) + tminus.node.mjs (Node)
bun run eval      # v1 vs v2 on rolling time folds of your history
bun run tminus -- status
```

Layout: `packages/core` (schema, db, features, predictor, live engine), `packages/adapters` (claude-code, codex), `packages/render` (statusline, tmux), `packages/cli`, `apps/menubar` (SwiftUI). Design decisions are in [docs/DECISIONS.md](docs/DECISIONS.md).

## License

MIT
