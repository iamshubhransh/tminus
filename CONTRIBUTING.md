# Contributing

Thanks for helping. The most valuable contribution is usually a new **agent adapter**, or a fix when an agent changes its formats.

## Setup

```sh
bun install
bun test
bun run build
```

Tests never touch your real `~/.tminus`, `~/.claude` or `~/.codex`: `tests/setup.ts` points `TMINUS_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` at a temp dir. Do the same when you try things by hand:

```sh
TMINUS_HOME=/tmp/tm CLAUDE_CONFIG_DIR=/tmp/claude bun packages/cli/src/index.ts init --yes
```

## Adding an adapter

An adapter lives in `packages/adapters/src/<agent>/` and implements `AgentAdapter` (`packages/adapters/src/types.ts`):

```ts
interface AgentAdapter {
  id: string;
  detect(): Promise<boolean>;                                      // is the agent on this machine?
  backfill(opts: { since?: Date }): AsyncIterable<NormalizedTurn>; // past turns from transcripts
  install(opts): Promise<InstallResult>;                           // wire hooks (with backup)
  uninstall(): Promise<InstallResult>;                             // restore exactly
  installed(): Promise<{ hooks: boolean; detail: string[] }>;
  parseLiveEvent(raw: unknown, hookEvent?: string): NormalizedEvent | null;
  probe?: TranscriptProbe;                                         // optional: spot interrupts no hook reports
}
```

Steps:

1. **Look at real data first.** Find where the agent stores sessions. Write down every record type you see and what marks the start and end of a turn, tool calls, waits for the user, plans or todos, and interrupts. Add your findings, with redacted samples, to `docs/AGENT_FORMATS.md`.
2. **Backfill.** Turn the transcript into `NormalizedTurn`s: `submittedAt`, `finishedAt`, `idleMs` (time blocked on the human), `outcome` (`completed | interrupted | errored`), `toolCalls`, `todoTotal`, and `events` (for replay-based evaluation). Compute prompt features with `buildFeatures()`/`promptFeatures()` and **never keep the prompt text**. Ignore unknown record types, and skip bad lines rather than failing.
3. **Live.** Either map hook payloads in `parseLiveEvent` (the hook process calls it and spools the result), or follow the session file like `CodexTailer` does and feed events to the engine from the collector. Pick one live source per agent: the engine keeps only the first source that reports a turn for a session.
4. **Install/uninstall.** Back up the file, keep the original bytes in the install manifest, and restore them verbatim when nothing else changed. `tests/install.test.ts` shows the round-trip tests every adapter should pass.
5. **Fixtures.** Redact a real transcript with `bun scripts/redact-fixture.ts <kind> in.jsonl tests/fixtures/<agent>/real-*.jsonl`. It keeps structure only and replaces all text, paths and ids. Read the output before committing it. Add synthetic edge cases to `scripts/make-synthetic-fixtures.ts`.
6. Register the adapter in `packages/adapters/src/index.ts`.

## Ground rules

- Hooks must never break the agent. Exit 0, print nothing, stay under 100ms, and log errors to `~/.tminus/logs/`.
- The status line renderer only reads a state file. Keep it under 30ms (`bun test tests/render.bench.test.ts`, `tminus doctor`).
- Privacy: no prompt text in the DB, spool, state files, logs or fixtures.
- Schema changes go in a new entry in `packages/core/src/schema.ts`. Never edit a shipped migration.
