// OpenAI Chat Completions → Cursor `AgentRunRequest`.
//
// Cursor's agent API does not take a chat transcript; it takes a conversation STATE whose
// messages are content-addressed blobs (AI SDK message JSON, keyed by sha256) that the
// server asks for over the same stream, plus the user's last words as the turn. The
// caller's tools are offered as MCP tools under one "aiopt" namespace and come back as
// `CallDynamicTool` calls. Ported from @magpie-community/opencode-cursor-auth (index.mjs
// `conversation` / `buildRun` / `toolsOf`).
//
// Pure module (apart from uuid/sha256): unit-tested in upstreams/__tests__/cursorConversation.test.ts.

import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { pb, pbValue, type PB } from './protobuf';

/** The MCP namespace / provider the caller's tools are listed under. */
export const TOOL_NS = 'aiopt';
/** How the model calls an MCP tool. */
export const CALL = 'CallDynamicTool';
const NO_RESULT = 'Tool use was interrupted and did not produce a result.';

export interface CursorTool {
  name: string;
  description: string;
  schema: unknown;
  schemaText: string;
}

/** Loose OpenAI chat request shape (only what we read). */
export interface ChatRequest {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  reasoning_effort?: unknown;
  service_tier?: unknown;
  prompt_cache_key?: unknown;
}

type Msg = Record<string, unknown> & {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
};

interface ToolCall {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : asArray<{ type?: unknown; text?: unknown }>(c)
        .filter((p) => p?.type === 'text')
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('');

const reasoningOf = (m: Msg): string =>
  [m.reasoning_content, m.reasoning].find((s): s is string => typeof s === 'string' && s.trim() !== '') ?? '';

const callsOf = (m: Msg | undefined): ToolCall[] => asArray<ToolCall>(m?.tool_calls);

/**
 * Join an assistant message onto the one before it when that one made tool calls: an agent
 * may split one turn's parallel calls over two assistant messages, answered together after.
 */
export function joinSplitCalls(msgs: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (m?.role === 'assistant' && prev?.role === 'assistant' && callsOf(prev).length > 0) {
      const content = [textOf(prev.content), textOf(m.content)].filter(Boolean).join('\n\n');
      const reasoning_content = [reasoningOf(prev), reasoningOf(m)].filter(Boolean).join('\n\n');
      out[out.length - 1] = { ...prev, content, reasoning_content, tool_calls: [...callsOf(prev), ...callsOf(m)] };
      continue;
    }
    out.push(m);
  }
  return out;
}

function parseArgs(s: unknown): Record<string, unknown> {
  if (s && typeof s === 'object') return s as Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(typeof s === 'string' && s !== '' ? s : '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The caller's tools the model may call: none for tool_choice "none", the one named when one is. */
export function toolsOf(chat: ChatRequest): CursorTool[] {
  const choice = chat.tool_choice;
  if (choice === 'none') return [];
  const only =
    choice && typeof choice === 'object'
      ? String((choice as { function?: { name?: unknown } }).function?.name ?? '')
      : '';
  return asArray<{ type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } }>(
    chat.tools,
  )
    .filter((t) => t?.type === 'function' && typeof t.function?.name === 'string' && t.function.name !== '')
    .filter((t) => !only || t.function!.name === only)
    .map((t) => {
      const schema = t.function!.parameters ?? { type: 'object', properties: {} };
      return {
        name: String(t.function!.name),
        description: typeof t.function!.description === 'string' ? t.function!.description : '',
        schema,
        schemaText: JSON.stringify(schema),
      };
    });
}

/**
 * The tool catalog appended to the system prompt. The model sees MCP tools only through
 * Cursor's own prompt, which this conversation goes without; without the list it says it
 * has no such tool. Each entry is the CallDynamicTool call itself.
 */
export function catalog(tools: CursorTool[]): string {
  if (tools.length === 0) return '';
  let s = `\n\n<dynamic_tool_catalog>\nThe MCP namespace "${TOOL_NS}" has the tools below. They are reached only through \`${CALL}\`, never as tools of their own. Each entry is the exact call to make; its arguments must match the schema given. The schemas are complete, so there is no need to call \`GetDynamicTools\` first.\n`;
  for (const t of tools) {
    s += `<call>${CALL}({"namespace":"${TOOL_NS}","toolName":"${t.name}","arguments":{...}})\n${t.description}\narguments schema: ${t.schemaText}\n</call>\n`;
  }
  return s + '</dynamic_tool_catalog>';
}

/** A call's id as Cursor gave it, before its newline was sent to the caller as `__`. */
const callID = (id: string): string => (id.startsWith('call_') ? id.replace('__fc_', '\nfc_') : id);

function result(id: string, text: string, isError: boolean): Record<string, unknown> {
  let res: unknown = text;
  try {
    res = JSON.parse(text);
  } catch {
    // plain text result
  }
  return {
    type: 'tool-result',
    toolCallId: callID(id),
    toolName: CALL,
    result: res,
    experimental_content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

export interface Conversation {
  /** AI SDK message JSON blobs, in order. */
  msgs: Buffer[];
  /** The user's last words (the Run's turn). */
  last: string;
  /** A guess at the prompt's size in tokens (used when Cursor reports none). */
  estimate: number;
}

/**
 * The conversation as AI SDK messages: the system prompt with the caller's tools listed,
 * then each turn. A tool result answers a call of the reply before it; a call left
 * unanswered is answered for, as the API wants every call to have its result.
 */
export function conversation(chat: ChatRequest, tools: CursorTool[]): Conversation {
  const out: Buffer[] = [];
  const add = (m: unknown): void => {
    out.push(Buffer.from(JSON.stringify(m)));
  };
  const messages = asArray<Msg>(chat.messages);
  let size = 0;
  let last = '.';
  const system: string[] = [];
  for (const m of messages) {
    if (m?.role === 'system' || m?.role === 'developer') system.push(textOf(m.content));
  }
  const sys = system.filter(Boolean).join('\n\n') + catalog(tools);
  size += sys.length;
  if (sys) add({ role: 'system', content: sys });

  let pending: string[] = [];
  let results: Record<string, unknown>[] = [];
  const answer = (): void => {
    for (const id of pending) results.push(result(id, NO_RESULT, true));
    pending = [];
    if (results.length) add({ role: 'tool', content: results });
    results = [];
  };

  for (const m of joinSplitCalls(messages)) {
    if (!m || m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') {
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
      const i = pending.indexOf(id);
      if (i >= 0) {
        pending.splice(i, 1);
        const text = textOf(m.content);
        size += text.length;
        results.push(result(id, text, false));
      }
      continue;
    }
    if (m.role === 'assistant') {
      answer();
      const content: Record<string, unknown>[] = [];
      const reasoning = reasoningOf(m);
      if (reasoning) content.push({ type: 'reasoning', text: reasoning });
      const text = textOf(m.content);
      if (text) content.push({ type: 'text', text });
      size += reasoning.length + text.length;
      for (const c of callsOf(m)) {
        if (c?.type && c.type !== 'function') continue;
        const id = typeof c.id === 'string' ? c.id : '';
        const name = typeof c.function?.name === 'string' ? c.function.name : '';
        const rawArgs = typeof c.function?.arguments === 'string' ? c.function.arguments : '';
        size += rawArgs.length + name.length;
        content.push({
          type: 'tool-call',
          toolCallId: callID(id),
          toolName: CALL,
          args: { namespace: TOOL_NS, toolName: name, arguments: parseArgs(c.function?.arguments) },
        });
        pending.push(id);
      }
      if (content.length) add({ role: 'assistant', content });
      continue;
    }
    // the user's
    const content: Record<string, unknown>[] = [];
    const parts =
      typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : asArray<Record<string, unknown>>(m.content);
    let first = '';
    for (const p of parts) {
      if (p?.type === 'text' && typeof p.text === 'string' && p.text) {
        content.push({ type: 'text', text: p.text });
        size += p.text.length;
        first ||= p.text;
      } else if (p?.type === 'image_url') {
        const iu = p.image_url as unknown;
        const u =
          typeof iu === 'string' ? iu : String((iu as { url?: unknown } | undefined)?.url ?? '');
        const d = /^data:([^;,]+);base64,(.*)$/s.exec(u);
        if (d) {
          content.push({
            type: 'image',
            mimeType: d[1],
            image: { __type: 'Uint8Array', hex: Buffer.from(d[2]!, 'base64').toString('hex') },
          });
        } else {
          content.push({ type: 'text', text: `[attachment image: ${u}]` });
        }
      } else if (p?.type === 'file') {
        const fname = (p.file as { filename?: unknown } | undefined)?.filename;
        content.push({ type: 'text', text: `[attachment ${typeof fname === 'string' ? fname : 'file'}]` });
      }
    }
    answer();
    if (first) last = first;
    if (content.length) add({ role: 'user', content });
  }
  answer();
  for (const t of tools) size += t.name.length + t.description.length + t.schemaText.length;
  return { msgs: out, last, estimate: Math.floor(size / 4) };
}

/** An McpToolDefinition. */
export function toolDef(t: CursorTool): Buffer {
  const d = pb().str(1, t.name);
  if (t.description) d.str(2, t.description);
  d.bytes(3, pbValue(t.schema));
  return d.str(4, TOOL_NS).str(5, t.name).str(6, t.schemaText).done();
}

const GOOS = process.platform === 'win32' ? 'windows' : process.platform;

/** The RequestContext env: OS, a scratch dir, UTC. Never the user's real cwd. */
export const env = (): PB => pb().str(1, GOOS).str(2, os.tmpdir()).str(10, 'UTC');

/** A version 4 UUID made of a hash's first 16 bytes. */
export function uuidOf(hash: Buffer): string {
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * A stable conversation_id for a conversation (so Cursor keeps routing it to the machine
 * that has its prompt cached), made from the client's prompt_cache_key and the first user
 * message. "" (a fresh id per Run) when nothing names the session.
 */
export function conversationID(chat: ChatRequest): string {
  const key = typeof chat.prompt_cache_key === 'string' ? chat.prompt_cache_key.trim() : '';
  if (!key) return '';
  const msgs = asArray<Msg>(chat.messages);
  const first = msgs.find((m) => m?.role === 'user') ?? msgs[0];
  const sum = createHash('sha256')
    .update('cursor conversation\0' + key + '\0' + (first === undefined ? '' : JSON.stringify(first)))
    .digest();
  return uuidOf(sum);
}

export interface RunParam {
  id: string;
  value: string;
}

/**
 * The Run's first message (an AgentClientMessage with its run_request) and the blobs it
 * names, keyed by sha256 hex. `conv` is the conversation_id (a fresh one when "").
 */
export function buildRun(
  conv: Conversation,
  tools: CursorTool[],
  model: string,
  convId = '',
  opts: { maxMode?: boolean; params?: RunParam[] } = {},
): { first: Buffer; blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>();
  const put = (b: Buffer): Buffer => {
    const id = createHash('sha256').update(b).digest();
    blobs.set(id.toString('hex'), b);
    return id;
  };
  const state = pb();
  for (const m of conv.msgs) state.bytes(1, put(m));
  const mid = randomUUID();
  const user = pb().str(1, conv.last).str(2, mid).varint(4, 1).done(); // mode: agent
  const turn = pb().bytes(1, pb().bytes(1, put(user)).str(10, mid)).done();
  state.bytes(8, put(turn)).varint(10, 1).str(22, 'cli');
  const defs = tools.map(toolDef);
  const rc = pb().bytes(4, env());
  const mcp = pb();
  for (const d of defs) {
    rc.bytes(7, d);
    mcp.bytes(1, d);
  }
  const action = pb().bytes(2, pb().bytes(2, rc)); // resume_action
  // ModelDetails: model_id, display_model_id, display_name, max_mode (7);
  // RequestedModel: model_id, max_mode (2), parameters (3)
  const details = pb().str(1, model).str(3, model).str(4, model);
  const requested = pb().str(1, model);
  if (opts.maxMode) {
    details.varint(7, 1);
    requested.varint(2, 1);
  }
  for (const p of opts.params ?? []) requested.bytes(3, pb().str(1, p.id).str(2, p.value));
  const rr = pb()
    .bytes(1, state)
    .bytes(2, action)
    .bytes(3, details)
    .bytes(4, mcp)
    .str(5, convId || randomUUID())
    .bytes(9, requested)
    .varint(19, 1); // inline images
  return { first: pb().bytes(1, rr).done(), blobs };
}
