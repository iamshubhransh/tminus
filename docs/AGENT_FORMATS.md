# Agent formats

What tminus reads from each agent, as **observed on a real machine** on 2026-10-20 (Claude Code 2.1.272 – 2.1.304, Codex CLI 0.108 – 0.156.1), cross-checked against the official docs. All samples below are real records with paths, ids and text redacted.

Formats change between versions. The parsers ignore unknown record types and unknown fields, skip corrupt lines, and key everything off a few stable fields. If something here goes stale, the fixture tests in `tests/` are where it will show up first.

---

## Claude Code

### Transcripts (backfill)

`~/.claude/projects/<cwd with / replaced by ->/<session-id>.jsonl`, one JSON object per line. Subagent transcripts live in `<session-id>/subagents/agent-*.jsonl` and are **not** separate turns (their time is inside the parent turn). `CLAUDE_CONFIG_DIR` relocates `~/.claude`.

Record types seen across 252 sessions (count of records): `attachment` 20.7k, `assistant` 14.9k, `user` 8.8k, `atis-latch`, `last-prompt`, `api-request-blob`, `permission-mode`, `mode`, `ai-title`, `api-request`, `frame-link`, `queue-operation`, `system` 1.1k, `file-history-snapshot`, `cost-state`, and others. tminus uses:

| record | fields used | meaning |
|---|---|---|
| `user` (string or text content) | `timestamp`, `promptId`, `origin.kind`, `promptSource`, `permissionMode`, `isMeta`, `isSidechain` | a prompt → **turn starts** |
| `user` (array with `tool_result`) | `tool_use_id`, `permissionDecision.source` | tool finished; `source` starting with `user` means a human approved it |
| `assistant` | `message.model`, `message.content[].tool_use{id,name,input}`, `message.usage`, `message.stop_reason`, `isApiErrorMessage` | activity, tool calls, context size |
| `system` / `turn_duration` | `timestamp`, `durationMs` | Claude Code's own **end of turn** marker |
| `system` / `compact_boundary` | `timestamp` | compaction inside a turn |
| `api-request` | `params.output_config.effort` | effort level (`low`…`max`) |
| `permission-mode` | `permissionMode` | `default`, `auto`, `plan`, … |

```jsonc
// user prompt (2.1.304)
{"type":"user","promptId":"2f9c41d0-…","timestamp":"2026-10-20T07:13:47.430Z","permissionMode":"auto",
 "origin":{"kind":"human"},"promptSource":"typed","turnOrigin":"human","isSidechain":false,
 "message":{"role":"user","content":"<redacted>"},"sessionId":"…","cwd":"/redacted","version":"2.1.304"}

// tool result after a human approved a permission prompt
{"type":"user","timestamp":"…","permissionDecision":{"decision":"accept","source":"user_temporary"},
 "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_…","content":"…"}]}}

// end of turn
{"type":"system","subtype":"turn_duration","durationMs":22608,"messageCount":363,"timestamp":"2026-09-18T13:20:11.194Z"}

// effort
{"type":"api-request","timestamp":"…","querySource":"repl_main_thread",
 "params":{"model":"claude-opus-5-5","output_config":{"effort":"xhigh"},"thinking":{"type":"adaptive"}}}
```

`origin.kind` values seen: `human` (typed or queued), `task-notification` (a background agent finished and woke the session up), `peer` (message from another session), `auto-continuation`, and absent with `promptSource: "sdk"` (headless/SDK runs). `permissionDecision.source` values seen: `config` (auto-approved by rules, mode or classifier), `user_temporary` (human approved). The interrupt marker is a user record whose text starts with `[Request interrupted by user` (also inside a `tool_result` as `[Request interrupted by user for tool use]`).

**Turn reconstruction.** A turn runs from a prompt record to the next `turn_duration` marker, or, in versions without it, to the last assistant/tool-result record before the next prompt. Queued prompts (`promptSource: "queued"`) start a new turn right after the previous `turn_duration`, timed from when the agent picked them up. Messages that wake the agent up arrive as `isMeta` user records with `origin.kind` `peer` (another session's or subagent's hand-back) or `auto-continuation`; they start agent-initiated turns. Other `isMeta` records are injected context and are skipped. Checked against `turn_duration` on 394 turns: median difference 24ms (p5 −110ms, p95 +192ms). Known divergence: Claude Code times an agent-initiated continuation (task notification, peer hand-back) from the last *human* prompt, while tminus times every turn from its own prompt. Those turns are not used for training.

**Subagents.** Each subagent writes `<session-id>/subagents/agent-<id>.jsonl` (plus `agent-<id>.meta.json` with `agentType`, `toolUseId`, `requestShape`). Every record carries `isSidechain: true`, `agentId`, and the **`promptId` of the turn that spawned it**. That gives an exact link: tminus counts a subagent's tool calls toward that turn while it is running. Of 2,850 subagent tool calls on the test machine, 778 ran inside a human turn, 1,143 inside agent-initiated turns (peer/auto-continuation), and 929 after their parent turn had already ended (background agents still working after the user got their answer; not counted). Older versions wrote subagent records inline in the main transcript (`isSidechain: true`); those are counted the same way.

**Idle in backfill.** `AskUserQuestion` / `ExitPlanMode` tool_use → tool_result, and any tool whose result carries `permissionDecision.source` starting with `user` (the gap includes the tool's own run time; transcripts don't separate the two).

### Hooks (live)

Registered in `~/.claude/settings.json` as `{"type":"command","command":"… hook <Event>","timeout":10,"async":true}`. `async` means Claude Code never waits on tminus. Common fields on every payload: `session_id`, `transcript_path`, `cwd`, `hook_event_name`; most also carry `prompt_id`, `permission_mode` and `effort` (an **object**, `{"level":"xhigh"}`). **No hook payload carries the model**: tminus gets it from the statusline input, or from the transcript tail.

Captured from a real `claude -p` run (2.1.304):

```jsonc
// SessionStart
{"session_id":"6b1e07aa-…","transcript_path":"/redacted/….jsonl","cwd":"/redacted","hook_event_name":"SessionStart","source":"startup"}
// UserPromptSubmit (no effort field on this one)
{"session_id":"…","transcript_path":"…","cwd":"…","prompt_id":"2f9c41d0-…","permission_mode":"auto","hook_event_name":"UserPromptSubmit","prompt":"<redacted>"}
// PreToolUse
{"session_id":"…","prompt_id":"2f9c41d0-…","permission_mode":"auto","effort":{"level":"xhigh"},"hook_event_name":"PreToolUse",
 "tool_name":"Bash","tool_input":{"command":"ls","description":"…"},"tool_use_id":"toolu_01Ab…"}
// PostToolUse (duration_ms = tool run time)
{"…":"…","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{…},"tool_response":{"stderr":"","interrupted":false,…},
 "tool_use_id":"toolu_01Ab…","duration_ms":4156}
// Stop
{"…":"…","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"<redacted>","background_tasks":[],"session_crons":[]}
// SessionEnd
{"session_id":"…","prompt_id":"…","hook_event_name":"SessionEnd","reason":"other"}
```

The hook `prompt_id` equals the transcript's `promptId`, so a live turn and its later backfill share one row (`turns.ext_id`).

Mapping to tminus events:

| hook | tminus event |
|---|---|
| `SessionStart` | `session_start` (closes a dangling turn, e.g. after `/clear`) |
| `UserPromptSubmit` | `prompt_submit` (features computed in the hook; prompt text dropped there) |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `tool_start` / `tool_end` (TodoWrite, TaskCreate, TaskUpdate → todo changes) |
| `PermissionRequest`, `Notification` with `permission_prompt` / `elicitation_dialog` / `agent_needs_input` | `waiting_user` |
| `PermissionDenied`, `Notification` `elicitation_complete` | `resumed` |
| `SubagentStart` / `SubagentStop`, `PreCompact` | bookkeeping only |
| `Stop` / `StopFailure` / `SessionEnd` | `stop` / `error` / `session_end` |

Docs-only (not observed in this run, parsed defensively): `PermissionRequest`, `Notification.notification_type`, `StopFailure`, `PostToolUseFailure`. Pressing Esc fires **no** hook; the collector notices the `[Request interrupted by user` record by tailing the transcript.

Hook stdout from `UserPromptSubmit`/`SessionStart` is injected into the model's context, so `tminus hook` never prints anything.

### Statusline

`settings.json` → `"statusLine": {"type":"command","command":"…","padding":0,"refreshInterval":N}`. stdin carries `session_id`, `model.id`, `effort.level`, `context_window.used_percentage`, `cost`, `workspace`, …. Claude Code redraws on new assistant messages, permission-mode changes and so on (debounced 300ms), plus every `refreshInterval` seconds if set (min 1). The status line is hidden while a permission prompt is open.

---

## Codex CLI

### Rollouts (backfill and live)

`~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl` (also `~/.codex/archived_sessions/`). `CODEX_HOME` relocates `~/.codex`. Each line is `{timestamp, type, payload}` (0.15x adds `ordinal`).

| record | fields used |
|---|---|
| `session_meta` | `payload.id` (thread id), `cwd`, `source` (`cli`, `exec`, `vscode`), `cli_version` |
| `turn_context` | `turn_id`, `model`, `effort` (or `collaboration_mode.settings.reasoning_effort`), `collaboration_mode.mode` |
| `event_msg` `task_started` | `turn_id` → **turn starts** |
| `event_msg` `user_message` (≤ 0.118) / `item_completed` with `item.type = UserMessage` (0.15x) | the prompt |
| `response_item` `function_call` / `custom_tool_call` | `name`, `call_id`; `update_plan` arguments carry the plan statuses |
| `response_item` `*_call_output` | `call_id` → tool end |
| `event_msg` `*_approval_request` | waiting on the user |
| `event_msg` `task_complete` | **turn ends**; 0.15x adds `duration_ms`, `started_at`, `completed_at` |
| `event_msg` `turn_aborted` | `reason: "interrupted"` |
| `event_msg` `token_count` | `info.last_token_usage.input_tokens / info.model_context_window` |

```jsonc
{"timestamp":"2026-09-23T14:27:12.933Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"01a0aaaa-…","model_context_window":258400}}
{"timestamp":"…","type":"turn_context","payload":{"turn_id":"01a0aaaa-…","model":"gpt-6-astra","effort":"high","approval_policy":"on-request","collaboration_mode":{"mode":"default"}}}
{"timestamp":"…","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"<redacted>"}]}}}
{"timestamp":"…","type":"response_item","payload":{"type":"function_call","name":"update_plan","call_id":"call_…","arguments":"{\"plan\":[{\"step\":\"…\",\"status\":\"in_progress\"},…]}"}}
{"timestamp":"…","type":"event_msg","payload":{"type":"task_complete","turn_id":"01a0bbbb-…","started_at":1790153674,"completed_at":1790154335,"duration_ms":660755,"time_to_first_token_ms":11399}}
{"timestamp":"…","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"019dcccc-…","reason":"interrupted"}}
```

Checked against `duration_ms` on 17 turns: within ±31ms except one (+27s, a turn whose `task_complete` came well after the last activity).

The user's question tool `request_user_input` counts as idle until its output arrives.

**Subagent threads.** Codex records thread metadata `thread_source` (`user`, `subagent`), `parent_thread_id`, `agent_role` and `agent_nickname` (field names from the 0.156 binary's thread schema; no subagent threads exist in the test machine's history, so this path is covered by synthetic tests only). A subagent thread's own turn markers are ignored. Its tool calls and approval waits are reported against the parent thread, in backfill (by time window) and live (the tailer re-keys the events onto the parent session).

### Hooks

Codex 0.156 has stable hooks (`codex features list` → `hooks stable true`) configured in `~/.codex/hooks.json` (`{"hooks": {"<Event>": [{"matcher"?, "hooks": [{"type":"command","command","timeout","async"}]}]}}`, top-level keys limited to `description` and `hooks`). Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, `SessionEnd`. Payloads carry `session_id`, `turn_id`, `transcript_path` (the rollout), `cwd`, `model`.

**Codex skips any new or changed hook until the user trusts it with `/hooks`** (trust is recorded against a hash of the hook definition in `config.toml`). tminus does not write trust entries itself.

So for Codex, live tracking **tails the active rollout file** (exact timestamps, plans, approvals, aborts; no trust needed). The two Codex hooks tminus installs (`SessionStart`, `UserPromptSubmit`) only wake the collector. Verified live with a real `codex exec` run: the tailer recorded the turn (model, effort, tool calls, 9.4s active).
