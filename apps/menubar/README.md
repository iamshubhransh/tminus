# tminus menubar

A small macOS menu bar app that shows how long your AI coding agent has left. It's the
menu bar version of the `tminus` statusline segment. It reads the same state file the
collector writes, so the two always show the same numbers.

```
◔ 2:14          running: P50 remaining, counting down every second (ring = todos done/total)
⏸               waiting on you
running long 9m past the P90 estimate (shows elapsed time)
✓ 4m12s         just finished (shown for 10 s after a completed turn)
T–              nothing running
```

Hover the status item to see the range (`1–5m remaining (P10–P90)`). Click it to open a
panel with:

- **The current turn:** project, intent, a large countdown with its likely range, elapsed
  time, the prediction made at submit time, tool calls and the todo ring. While the agent
  is waiting on you, the panel shows that instead, with how long it has been waiting.
- **Last 10 turns: predicted vs actual:** the intent, predicted P50 and actual time for
  each turn, plus a small track showing where the actual time fell against the predicted
  P10–P90 band. A dot inside the band means the prediction held. Orange means slower than
  P90 and teal means faster than P10. A hollow dot is off the scale.

It needs macOS 13 or later and has no dependencies. It follows the system's light/dark
appearance and accent colours, and all numbers use SF Mono so they don't jitter.

## Build

```sh
cd apps/menubar
swift build -c release      # → .build/release/TMinusMenubar
swift test                  # model, formatting and countdown logic
scripts/bundle.sh           # → build/TMinus.app (LSUIElement, ad-hoc signed)
```

Drag `build/TMinus.app` into `/Applications` and open it. It has no Dock icon. To start it
at login, add it under System Settings → General → Login Items.
`scripts/bundle.sh --universal` builds an arm64 + x86_64 binary (this needs full Xcode).

## Run

```sh
open build/TMinus.app                       # normal use
.build/release/TMinusMenubar                # straight from the build (also menubar-only)
TMINUS_HOME=/tmp/tm .build/release/TMinusMenubar   # read /tmp/tm/state/current.json instead
```

The app reads `$TMINUS_HOME/state/current.json`, or `~/.tminus/state/current.json` when
`TMINUS_HOME` isn't set. The collector replaces that file every second or so with an
atomic rename, so the app watches the `state/` directory instead of the file (a watch on
the file would stay attached to the replaced copy). A 1-second poll backs up the watcher
and re-arms it if `state/` is created later or recreated.

### Headless checks

```sh
# Print the menu bar title, tooltip, current turn and history rows as text, then exit.
.build/release/TMinusMenubar --selftest ~/.tminus/state/current.json
.build/release/TMinusMenubar --selftest some-state.json --now 1760961604000   # fixed clock

# Render the status item and panel to PNGs (light and dark) to review the design.
.build/release/TMinusMenubar --snapshot some-state.json /tmp/tminus-shots

# Log file activity (watch/poll reloads) to stderr.
TMINUS_MENUBAR_DEBUG=1 .build/release/TMinusMenubar
```

`--selftest` exits with 1 when the file exists but can't be used (bad JSON, or a `v` other
than 1). A missing file counts as idle.

## How the numbers are derived

All of this logic lives in `Sources/TMinusCore`, which is pure Swift and unit-tested.

- **Countdown between writes:** while `status == "running"` and the state is less than
  30 s old, the app keeps counting locally: elapsed = `elapsedMs + (now − updatedAt)` and
  remaining = `max(1s, p50RemainingMs − (now − updatedAt))`. If the state is older than
  that, the collector has probably stopped. The values freeze, the status item dims and
  the panel says so.
- **Waiting:** the clock doesn't advance, because time spent waiting on you doesn't count
  as active time.
- **Running long:** shown when elapsed exceeds `p90TotalMs`, or when the collector set
  `overrun`.
- **Done:** shown for 10 s after `last.finishedAt`, and only when `last.outcome` is
  `"completed"`.
- **History band:** history entries have P50 and P90 but no P10. Predictions are
  log-normal, so P10 is mirrored around P50 in log space (`p10 = p50² / p90`). On a log
  axis, the P10–P90 band is then always the middle half of the track with P50 at the
  centre, and only the dot moves.
- **Decoding** is lenient. Unknown fields are ignored, a mistyped field falls back to a
  default, and a malformed history entry is skipped. Only a document whose `v` isn't 1 is
  rejected.

## Layout

```
Package.swift
Sources/TMinusCore/       LiveState (decoding), TimeFormat, LiveDisplay (countdown rules),
                          HistoryRow (band placement), StateFile (paths, loading), SelfTest
Sources/TMinusMenubar/    main.swift (CLI flags), TMinusApp (MenuBarExtra), StateStore
                          (watcher + ticks), MenuBarLabel, PopoverView, Snapshot
Tests/TMinusCoreTests/    decoding, formatting, countdown/overrun/done-linger, history placement
scripts/bundle.sh         release build → build/TMinus.app
```

The status item is drawn into a template image. `MenuBarExtra` labels drop custom fonts
and shapes, and drawing them into an image keeps the SF Mono digits and the ring, while
macOS still tints the image for light, dark and highlighted states.
