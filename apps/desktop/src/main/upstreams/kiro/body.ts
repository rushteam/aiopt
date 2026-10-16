// An OpenAI Chat body → the conversation Kiro's `generateAssistantResponse` takes.
//
// Ported from magpie's Kiro plugin (buildKiro), which reads Anthropic Messages; here the
// driver contract's OpenAI Chat is read instead. Kiro's rules, kept as the plugin keeps them:
//   - The history alternates user / assistant; adjacent turns of one role are merged.
//   - It opens with something the user said and ends with the message being answered.
//   - Every tool call is answered in the user message right after it (an unanswered one gets
//     an "interrupted" error result); a result with no call before it is dropped.
//   - Tool ids and names Kiro takes (64 chars, a fixed alphabet): others are hashed, the same
//     each time, and names are mapped back on the answer.
//   - A tool the history used but the request no longer offers is declared (Kiro rejects it).
//   - Only the latest message's images are sent; the system prompt (and a thinking budget)
//     goes at the head of the first message.
//
// Pure: unit-tested in upstreams/__tests__/kiroBody.test.ts.

import { createHash, randomUUID } from 'node:crypto';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const PROCEED = 'Please proceed with the task.';
const NO_RESULT = 'Tool use was interrupted and did not produce a result.';
const RESULT_LIMIT = 250_000;
const TOOL_ID = /^[a-zA-Z0-9_.:-]{1,64}$/;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const EMPTY_SCHEMA = { type: 'object', properties: {} };

export const kiroToolId = (id: unknown): string => {
  const v = typeof id === 'string' ? id : '';
  return TOOL_ID.test(v) ? v : 't_' + createHash('sha256').update(v).digest('base64url').slice(0, 32);
};

export const kiroToolName = (name: unknown): string => {
  const n = typeof name === 'string' ? name : '';
  if (TOOL_NAME.test(n)) return n;
  const hash = createHash('sha256').update(n).digest('hex').slice(0, 12);
  return n.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64 - 1 - hash.length) + '_' + hash;
};

/** Thinking models: Claude, or Auto. */
export const kiroThinks = (model: string): boolean => /claude/i.test(model) || model === 'auto';

const BUDGETS: Record<string, number> = { medium: 20_000, high: 30_000, xhigh: 50_000, max: 50_000 };

/** The thinking budget a request asks for (`reasoning_effort` above low, a thinking model), or 0. */
export function kiroThinkingBudget(body: Obj, model: string): number {
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase() : '';
  if (!effort || effort === 'low' || effort === 'none' || effort === 'minimal') return 0;
  if (!kiroThinks(model.toLowerCase())) return 0;
  return BUDGETS[effort] ?? 20_000;
}

interface KiroImage {
  format: string;
  source: { bytes: string };
}
interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Obj;
}
interface KiroToolResult {
  toolUseId: string;
  status: 'success' | 'error';
  content: Array<{ text: string }>;
}
interface KiroUser {
  content: string;
  modelId: string;
  origin: 'KIRO_CLI';
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: unknown[] };
}
interface KiroAssistant {
  content: string;
  toolUses?: KiroToolUse[];
}
type Entry = { userInputMessage: KiroUser } | { assistantResponseMessage: KiroAssistant };

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .filter((p) => isObj(p) && (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string')
          .map((p) => (p as { text: string }).text)
          .join('\n\n')
      : '';
const join2 = (a: string, b: string): string => (a && b ? `${a}\n\n${b}` : a + b);

/** An OpenAI `image_url` part with inline bytes (a data: URL); a remote URL has none to send. */
function imageOf(p: Obj): KiroImage | null {
  const iu = p.image_url;
  const url = typeof iu === 'string' ? iu : isObj(iu) && typeof iu.url === 'string' ? iu.url : '';
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/is.exec(url);
  if (!m) return null;
  let f = m[1]!.toLowerCase();
  if (f === 'jpg') f = 'jpeg';
  return { format: f, source: { bytes: m[2]! } };
}

function parseArgs(v: unknown): Obj {
  if (isObj(v)) return v;
  if (typeof v !== 'string' || !v) return {};
  try {
    const o = JSON.parse(v) as unknown;
    return isObj(o) ? o : {};
  } catch {
    return {};
  }
}

/** The names Kiro is sent under another name, mapped back to the caller's. */
export function kiroToolNames(body: Obj): Map<string, string> {
  const names = new Map<string, string>();
  const add = (n: unknown) => {
    if (typeof n !== 'string' || !n) return;
    const k = kiroToolName(n);
    if (k !== n) names.set(k, n);
  };
  for (const t of Array.isArray(body.tools) ? body.tools : []) if (isObj(t) && isObj(t.function)) add(t.function.name);
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObj(m) || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) if (isObj(tc) && isObj(tc.function)) add(tc.function.name);
  }
  return names;
}

export interface KiroRequest {
  body: string;
  names: Map<string, string>;
  budget: number;
}

/** The body of a generateAssistantResponse call for an OpenAI Chat request. */
export function kiroBody(chat: Obj, profile: string, conversationId: string = randomUUID()): KiroRequest {
  const model = typeof chat.model === 'string' && chat.model ? chat.model : 'auto';
  const budget = kiroThinkingBudget(chat, model);
  const user = (): KiroUser => ({ content: '', modelId: model, origin: 'KIRO_CLI', images: [] });
  const entries: Entry[] = [];
  const systems: string[] = [];
  const lastUser = (): KiroUser | null => {
    const e = entries.at(-1);
    return e && 'userInputMessage' in e ? e.userInputMessage : null;
  };
  const lastAssistant = (): KiroAssistant | null => {
    const e = entries.at(-1);
    return e && 'assistantResponseMessage' in e ? e.assistantResponseMessage : null;
  };
  const addUser = (u: KiroUser) => {
    const prev = lastUser();
    if (!prev) {
      entries.push({ userInputMessage: u });
      return;
    }
    prev.content = join2(prev.content, u.content);
    prev.images!.push(...(u.images ?? []));
    const rs = u.userInputMessageContext?.toolResults ?? [];
    if (rs.length) ((prev.userInputMessageContext ??= {}).toolResults ??= []).push(...rs);
  };

  for (const m of Array.isArray(chat.messages) ? chat.messages : []) {
    if (!isObj(m)) continue;
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      const t = textOf(m.content);
      if (t) systems.push(t);
      continue;
    }
    if (role === 'assistant') {
      const a: KiroAssistant = { content: textOf(m.content), toolUses: [] };
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!isObj(tc) || !isObj(tc.function)) continue;
        a.toolUses!.push({ name: kiroToolName(tc.function.name), toolUseId: kiroToolId(tc.id), input: parseArgs(tc.function.arguments) });
      }
      if (!a.content && !a.toolUses!.length) continue; // a turn that only thought
      const prev = lastAssistant();
      if (prev) {
        prev.content = join2(prev.content, a.content);
        prev.toolUses!.push(...a.toolUses!);
      } else entries.push({ assistantResponseMessage: a });
      continue;
    }
    if (role === 'tool') {
      let out = textOf(m.content);
      if (out.length > RESULT_LIMIT) out = out.slice(0, RESULT_LIMIT) + '\n… (cut)';
      const u = user();
      u.userInputMessageContext = {
        toolResults: [{ toolUseId: kiroToolId(m.tool_call_id), status: 'success', content: [{ text: out || '(no output)' }] }],
      };
      if (Array.isArray(m.content)) for (const p of m.content) if (isObj(p) && p.type === 'image_url') {
        const img = imageOf(p);
        if (img) u.images!.push(img);
      }
      addUser(u);
      continue;
    }
    if (role !== 'user') continue;
    const u = user();
    const texts: string[] = [];
    if (typeof m.content === 'string') {
      if (m.content) texts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!isObj(p)) continue;
        if ((p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string' && p.text) texts.push(p.text);
        else if (p.type === 'image_url') {
          const img = imageOf(p);
          if (img) u.images!.push(img);
        }
      }
    }
    u.content = texts.join('\n\n');
    addUser(u);
  }

  // Open with something the user said.
  while (entries.length) {
    const first = entries[0]!;
    if ('userInputMessage' in first) {
      const u = first.userInputMessage;
      if (u.userInputMessageContext && !u.content && !u.images!.length) {
        entries.shift();
        continue;
      }
      delete u.userInputMessageContext;
      break;
    }
    entries.shift();
  }
  // End with the message being answered.
  if (!lastUser()) entries.push({ userInputMessage: user() });
  // Each call answered in the message after it, and only calls.
  entries.forEach((e, i) => {
    if (!('userInputMessage' in e)) return;
    const u = e.userInputMessage;
    const before = entries[i - 1];
    const calls = before && 'assistantResponseMessage' in before ? (before.assistantResponseMessage.toolUses ?? []) : [];
    const results = u.userInputMessageContext?.toolResults ?? [];
    const answered = new Set<string>();
    const kept: KiroToolResult[] = [];
    for (const r of results) {
      if (!answered.has(r.toolUseId) && calls.some((c) => c.toolUseId === r.toolUseId)) {
        answered.add(r.toolUseId);
        kept.push(r);
      }
    }
    for (const c of calls) {
      if (answered.has(c.toolUseId)) continue;
      answered.add(c.toolUseId);
      kept.push({ toolUseId: c.toolUseId, status: 'error', content: [{ text: NO_RESULT }] });
    }
    delete u.userInputMessageContext;
    if (kept.length) u.userInputMessageContext = { toolResults: kept };
    if (!u.content && !u.userInputMessageContext) u.content = PROCEED;
  });
  // Only the latest images are sent again.
  let latest = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if ('userInputMessage' in e && e.userInputMessage.images!.length) {
      latest = i;
      break;
    }
  }
  entries.forEach((e, i) => {
    if ('userInputMessage' in e && (i !== latest || !e.userInputMessage.images!.length)) delete e.userInputMessage.images;
    if ('assistantResponseMessage' in e && !e.assistantResponseMessage.toolUses!.length) delete e.assistantResponseMessage.toolUses;
  });
  // The instructions go at the head of the first message.
  let system = systems.join('\n\n');
  if (budget) system = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>` + (system ? '\n' + system : '');
  const first = entries[0] as { userInputMessage: KiroUser };
  if (system) first.userInputMessage.content = `${system}\n\n${first.userInputMessage.content}`;

  // The caller's tools, and any the history used that it no longer offers.
  const current = (entries.at(-1) as { userInputMessage: KiroUser }).userInputMessage;
  const tools: unknown[] = [];
  const offered = new Set<string>();
  for (const t of Array.isArray(chat.tools) ? chat.tools : []) {
    if (!isObj(t) || !isObj(t.function) || typeof t.function.name !== 'string' || !t.function.name) continue;
    const name = kiroToolName(t.function.name);
    if (offered.has(name)) continue;
    offered.add(name);
    const desc = typeof t.function.description === 'string' && t.function.description ? t.function.description : t.function.name;
    tools.push({ toolSpecification: { name, description: desc, inputSchema: { json: isObj(t.function.parameters) ? t.function.parameters : EMPTY_SCHEMA } } });
  }
  for (const e of entries) {
    if (!('assistantResponseMessage' in e)) continue;
    for (const c of e.assistantResponseMessage.toolUses ?? []) {
      if (offered.has(c.name)) continue;
      offered.add(c.name);
      tools.push({ toolSpecification: { name: c.name, description: 'Tool', inputSchema: { json: EMPTY_SCHEMA } } });
    }
  }
  if (tools.length) (current.userInputMessageContext ??= {}).tools = tools;

  const state: Obj = {
    chatTriggerType: 'MANUAL',
    agentTaskType: 'vibe',
    conversationId,
    currentMessage: { userInputMessage: current },
  };
  if (entries.length > 1) state.history = entries.slice(0, -1);
  const out: Obj = { conversationState: state, agentMode: 'vibe' };
  if (profile) out.profileArn = profile;
  return { body: JSON.stringify(out), names: kiroToolNames(chat), budget };
}
