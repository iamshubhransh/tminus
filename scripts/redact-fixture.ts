/**
 * Turn a real transcript into a committable fixture: keep only the structure
 * tminus parses (types, timestamps, ids, tool names, usage, statuses) and
 * replace every piece of prompt, response, tool input/output and path text.
 *
 *   bun scripts/redact-fixture.ts claude <in.jsonl> <out.jsonl>
 *   bun scripts/redact-fixture.ts codex  <in.jsonl> <out.jsonl>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [kind, input, output] = process.argv.slice(2);
if (!kind || !input || !output) {
  console.error('usage: redact-fixture.ts <claude|codex> <in> <out>');
  process.exit(1);
}

const idMap = new Map<string, string>();
/** Stable pseudonymous ids (same input id -> same fake id within the file). */
function fakeId(id: unknown): unknown {
  if (typeof id !== 'string') return id;
  if (!idMap.has(id)) idMap.set(id, createHash('sha256').update('tminus-fixture:' + id).digest('hex').slice(0, 8) + '-' + String(idMap.size).padStart(4, '0'));
  return idMap.get(id);
}

const SYSTEM_PREFIXES = ['[Request interrupted by user for tool use]', '[Request interrupted by user]'];
function redactText(t: unknown): string {
  if (typeof t !== 'string') return '';
  for (const p of SYSTEM_PREFIXES) if (t.startsWith(p)) return p;
  const prefix = t.match(/^<(task-notification|command-name|command-message|local-command-stdout|local-command-caveat)>/)?.[0] ?? '';
  const words = t.trim() ? t.trim().split(/\s+/).length : 0;
  return `${prefix}redacted ${'word '.repeat(Math.max(0, Math.min(words, 400) - 1)).trim()}`.trim();
}

function pick(o: any, keys: string[]): any {
  const out: any = {};
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
}

function claude(rec: any): any | null {
  const keep = pick(rec, ['type', 'subtype', 'timestamp', 'isSidechain', 'isMeta', 'promptSource', 'turnOrigin', 'permissionMode',
    'version', 'durationMs', 'messageCount', 'isApiErrorMessage', 'level', 'userType', 'entrypoint']);
  if (rec.uuid) keep.uuid = fakeId(rec.uuid);
  if (rec.parentUuid) keep.parentUuid = fakeId(rec.parentUuid);
  if (rec.promptId) keep.promptId = fakeId(rec.promptId);
  if (rec.sessionId) keep.sessionId = 'fixture-session';
  if (rec.cwd) keep.cwd = '/redacted/project';
  if (rec.origin) keep.origin = pick(rec.origin, ['kind']);
  if (rec.permissionDecision) keep.permissionDecision = pick(rec.permissionDecision, ['decision', 'source', 'reasonType']);
  if (rec.type === 'api-request') keep.params = { model: rec.params?.model, output_config: pick(rec.params?.output_config ?? {}, ['effort']) };
  if (rec.type === 'permission-mode') keep.permissionMode = rec.permissionMode;
  if (rec.type === 'attachment') return null;
  if (!['user', 'assistant', 'system', 'api-request', 'permission-mode'].includes(rec.type)) return null;
  if (rec.message) {
    const m = rec.message;
    const msg: any = pick(m, ['role', 'model', 'stop_reason', 'type']);
    if (m.usage) msg.usage = pick(m.usage, ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']);
    if (typeof m.content === 'string') msg.content = redactText(m.content);
    else if (Array.isArray(m.content)) {
      msg.content = m.content.map((c: any) => {
        if (c?.type === 'text') return { type: 'text', text: redactText(c.text) };
        if (c?.type === 'image') return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } };
        if (c?.type === 'thinking') return { type: 'thinking', thinking: '' };
        if (c?.type === 'tool_use') {
          const input: any = {};
          if (Array.isArray(c.input?.todos)) input.todos = c.input.todos.map((t: any) => ({ content: 'redacted', status: t?.status }));
          if (c.input?.taskId != null) input.taskId = c.input.taskId;
          if (c.input?.status) input.status = c.input.status;
          return { type: 'tool_use', id: fakeId(c.id), name: String(c.name).startsWith('mcp__') ? 'mcp__redacted__tool' : c.name, input };
        }
        if (c?.type === 'tool_result') {
          const text = Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? '').join('') : String(c.content ?? '');
          const interrupted = SYSTEM_PREFIXES.find((p) => text.includes(p));
          return { type: 'tool_result', tool_use_id: fakeId(c.tool_use_id), content: interrupted ?? 'redacted' };
        }
        return { type: c?.type ?? 'unknown' };
      });
    }
    keep.message = msg;
  }
  return keep;
}

function codex(rec: any): any | null {
  const p = rec.payload ?? {};
  const out: any = { timestamp: rec.timestamp, type: rec.type };
  switch (rec.type) {
    case 'session_meta': out.payload = { id: 'fixture-thread', cwd: '/redacted/project', source: p.source, cli_version: p.cli_version, originator: p.originator }; break;
    case 'turn_context': out.payload = { turn_id: fakeId(p.turn_id), model: p.model, effort: p.effort, cwd: '/redacted/project', approval_policy: p.approval_policy,
      collaboration_mode: p.collaboration_mode ? { mode: p.collaboration_mode.mode, settings: pick(p.collaboration_mode.settings ?? {}, ['model', 'reasoning_effort']) } : undefined }; break;
    case 'compacted': out.payload = {}; break;
    case 'event_msg':
      switch (p.type) {
        case 'task_started': out.payload = { type: p.type, turn_id: fakeId(p.turn_id), model_context_window: p.model_context_window }; break;
        case 'task_complete': out.payload = pick(p, ['type', 'duration_ms', 'started_at', 'completed_at']); out.payload.turn_id = fakeId(p.turn_id); break;
        case 'turn_aborted': out.payload = { type: p.type, reason: p.reason, turn_id: fakeId(p.turn_id) }; break;
        case 'user_message': out.payload = { type: p.type, message: redactText(p.message), images: [], local_images: [] }; break;
        case 'token_count': out.payload = { type: p.type, info: p.info ? { last_token_usage: pick(p.info.last_token_usage ?? {}, ['input_tokens', 'output_tokens']), model_context_window: p.info.model_context_window } : null }; break;
        case 'item_completed':
          if (p.item?.type !== 'UserMessage') return null;
          out.payload = { type: p.type, item: { type: 'UserMessage', content: [{ type: 'text', text: redactText((p.item.content ?? []).map((c: any) => c?.text ?? '').join(' ')) }] } };
          break;
        case 'context_compacted': out.payload = { type: p.type }; break;
        default:
          if (/approval_request$/.test(p.type ?? '')) { out.payload = { type: p.type }; break; }
          return null;
      }
      break;
    case 'response_item':
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let args = '{}';
        if (p.name === 'update_plan') {
          try { args = JSON.stringify({ plan: JSON.parse(p.arguments).plan.map((s: any) => ({ step: 'redacted', status: s.status })) }); } catch { /* keep {} */ }
        }
        out.payload = { type: p.type, name: String(p.name).startsWith('mcp__') ? 'mcp__redacted__tool' : p.name, call_id: fakeId(p.call_id), arguments: args };
      } else if (/_call_output$/.test(p.type ?? '')) {
        out.payload = { type: p.type, call_id: fakeId(p.call_id), output: 'redacted' };
      } else if (p.type === 'web_search_call') {
        out.payload = { type: p.type };
      } else return null;
      break;
    default:
      return null;
  }
  return out;
}

const lines = readFileSync(input, 'utf8').split('\n').filter(Boolean);
const out: string[] = [];
for (const line of lines) {
  let rec: any;
  try { rec = JSON.parse(line); } catch { continue; }
  const r = kind === 'claude' ? claude(rec) : codex(rec);
  if (r) out.push(JSON.stringify(r));
}
writeFileSync(output, out.join('\n') + '\n');
console.log(`${input} -> ${output}: ${lines.length} lines in, ${out.length} out`);
