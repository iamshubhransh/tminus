export type AgentId = 'claude-code' | 'codex' | (string & {});

export const INTENTS = [
  'explain', 'question', 'fix', 'small_edit', 'refactor', 'build_feature', 'test', 'review', 'other',
] as const;
export type Intent = (typeof INTENTS)[number];

export type Outcome = 'completed' | 'interrupted' | 'errored';

/**
 * What started the turn. Only `human`, `command` and `sdk` turns are used for
 * training: notification/system turns are the agent waking itself up and have a
 * different duration profile.
 */
export type Trigger = 'human' | 'command' | 'sdk' | 'notification' | 'system';
export const TRAINABLE_TRIGGERS: Trigger[] = ['human', 'command', 'sdk'];

export const FEATURE_VERSION = 1;

export interface PromptFeatures {
  chars: number;
  words: number;
  lines: number;
  intent: Intent;
  /** File paths or backticked identifiers mentioned. */
  refs: number;
  /** "all", "every", "entire", "across", ... */
  scope: boolean;
  codeBlock: boolean;
  question: boolean;
  urls: number;
  images: number;
}

export interface Features {
  v: number;
  trigger: Trigger;
  prompt: PromptFeatures;
  session: {
    model: string | null;
    effort: string | null;
    mode: string | null;
    contextPct: number | null;
    turnIndex: number;
    /** Rolling median of the previous 3 turns' active_ms in this session. */
    recentMedianMs: number | null;
  };
  repo: { files: number | null; language: string | null };
  time: { hour: number; weekday: number };
}

/** Todo/plan state as reported by the agent. Only ids + statuses, never content. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
export type TodoChange =
  | { kind: 'snapshot'; items: { id: string; status: TodoStatus }[] }
  | { kind: 'upsert'; id: string; status: TodoStatus };

export type EventKind =
  | 'session_start'
  | 'prompt_submit'
  | 'tool_start'
  | 'tool_end'
  | 'todo_update'
  | 'waiting_user'
  | 'resumed'
  | 'subagent_start'
  | 'subagent_stop'
  | 'compact'
  | 'stop'
  | 'error'
  | 'session_end';

export interface NormalizedEvent {
  agent: AgentId;
  sessionId: string;
  kind: EventKind;
  /** Epoch ms. */
  ts: number;
  promptId?: string | null;
  toolName?: string | null;
  toolUseId?: string | null;
  /** Tool execution time when the agent reports it. */
  durationMs?: number | null;
  todo?: TodoChange | null;
  /**
   * prompt_submit only: features derived from the prompt inside the hook
   * process. The prompt text itself never leaves the hook.
   */
  promptFeatures?: PromptFeatures | null;
  trigger?: Trigger | null;
  /** Working directory; used for repo features and the display name, stored hashed. */
  cwd?: string | null;
  model?: string | null;
  effort?: string | null;
  mode?: string | null;
  /** Why we are waiting (permission_prompt, question, ...) or why the turn stopped. */
  reason?: string | null;
  /** Transcript path, kept in memory only to detect interrupts. */
  transcriptPath?: string | null;
  /** Context window usage (0..1) when the agent reports it in-band (Codex). */
  contextPct?: number | null;
  /** Set when the event comes from a subagent rather than the main thread. */
  subagentId?: string | null;
}

export interface TurnEvent {
  ts: number;
  kind: EventKind;
  toolName?: string | null;
  meta?: Record<string, unknown> | null;
}

/** A completed (or abandoned) turn reconstructed from a transcript. */
export interface NormalizedTurn {
  agent: AgentId;
  sessionId: string;
  /** Stable id within the session (prompt uuid / turn id) for idempotent re-import. */
  extId: string;
  projectHash: string | null;
  sessionStartedAt: number;
  submittedAt: number;
  finishedAt: number;
  idleMs: number;
  outcome: Outcome;
  model: string | null;
  effort: string | null;
  mode: string | null;
  contextPct: number | null;
  features: Features;
  /** Tool calls on the main thread. */
  toolCalls: number;
  /** Tool calls made by subagents the turn spawned, while the turn was running. */
  subagentToolCalls: number;
  todoTotal: number;
  /** Duration the agent itself recorded for the turn (wall clock), for cross-checking. */
  agentDurationMs: number | null;
  events: TurnEvent[];
}

export interface Prediction {
  p10: number;
  p50: number;
  p90: number;
}

export interface BucketKey {
  model: string | null;
  effort: string | null;
  intent: Intent;
}
