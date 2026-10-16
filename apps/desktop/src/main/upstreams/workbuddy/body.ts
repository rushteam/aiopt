// The request body WorkBuddy's chat endpoint takes, made from an OpenAI Chat body.
//
// Ported from magpie's WorkBuddy plugin (@magpie-community/opencode-workbuddy-auth):
//   - withSystem: a leading system message (WorkBuddy's app always sends one), `developer`
//     as `system`, `max_completion_tokens` as `max_tokens`, and FLAGGED's words rewritten —
//     WorkBuddy refuses chats carrying some agents' fixed prompt lines ("unapproved channel").
//   - fitTools: tool names WorkBuddy takes (A-Z a-z 0-9 _ -) and parameter schemas every model
//     behind it takes (11133 otherwise); the renames are mapped back on the answer.
//   - normalizeToolChoice: WorkBuddy's string form of `tool_choice`.
//
// Pure (mutates only its own clone): unit-tested in upstreams/__tests__/workbuddyBody.test.ts.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- prompt words ------------------------------------------------------------------------

const FLAGGED: Array<[RegExp, string]> = [
  [/x-anthropic-billing-header:[^\n]*\n?/gi, ''],
  [/You are Claude Code, Anthropic['’]s official CLI for Claude/gi, "You are Claude Code, Anthropic's CLI for Claude"],
  [/Main branch \(you will usually use this for PRs\)/gi, 'Main branch (usually the base for PRs)'],
  [/(?<!the )Codex CLI is an open source project led by OpenAI\./gi, 'The Codex CLI is an open source project led by OpenAI.'],
];

export function unflagged(text: string): string {
  let t = text;
  for (const [re, to] of FLAGGED) t = t.replace(re, to);
  return t;
}

function unflag(messages: unknown[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isObj(m)) continue;
    if (typeof m.content === 'string') {
      const t = unflagged(m.content);
      if (t === m.content) continue;
      if (t.trim() || m.role !== 'system') m.content = t;
      else messages.splice(i, 1);
    } else if (Array.isArray(m.content)) {
      const parts: unknown[] = [];
      let here = false;
      for (const p of m.content) {
        const text = isObj(p) && typeof p.text === 'string' ? p.text : null;
        const t = text === null ? null : unflagged(text);
        if (t === null || t === text) {
          parts.push(p);
          continue;
        }
        here = true;
        if (t.trim()) parts.push({ ...(p as Obj), text: t });
      }
      if (!here) continue;
      if (parts.length || m.role !== 'system') m.content = parts;
      else messages.splice(i, 1);
    }
  }
}

function withSystem(b: Obj): void {
  if (!Array.isArray(b.messages) || b.messages.length === 0) return;
  unflag(b.messages);
  if (b.max_completion_tokens !== undefined) {
    if (b.max_tokens === undefined) b.max_tokens = b.max_completion_tokens;
    delete b.max_completion_tokens;
  }
  for (const m of b.messages) if (isObj(m) && m.role === 'developer') m.role = 'system';
  const first = b.messages[0];
  if (!isObj(first) || first.role !== 'system') b.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
}

// ---- tool_choice -------------------------------------------------------------------------

function normalizeToolChoice(b: Obj): void {
  if (!('tool_choice' in b)) return;
  const choice = b.tool_choice;
  const dropTools = () => {
    delete b.tool_choice;
    delete b.tools;
    delete b.functions;
  };
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') dropTools();
    return;
  }
  if (!isObj(choice)) {
    delete b.tool_choice;
    return;
  }
  const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : '';
  if (type === 'none') dropTools();
  else if (type === 'auto' || type === 'required') b.tool_choice = type;
  else if (type === 'function') {
    const fn = isObj(choice.function) ? choice.function : undefined;
    const name = typeof fn?.name === 'string' ? fn.name.trim() : '';
    b.tool_choice = name || 'auto';
  } else delete b.tool_choice;
}

// ---- tool schemas ------------------------------------------------------------------------

const NAME_OK = /^[A-Za-z0-9_-]+$/;

function safeName(name: string, taken: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`;
  taken.add(n);
  return n;
}

const NUL_ESCAPE = /\\\\|\\0(?![0-9])/g;

/** A regex's `\0` as `\u0000` (DeepSeek's validator refuses it); a tuple's items as one schema. */
function fitSchema(s: unknown, depth = 0): void {
  if (!s || typeof s !== 'object' || depth > 64) return;
  if (Array.isArray(s)) {
    for (const v of s) fitSchema(v, depth + 1);
    return;
  }
  const o = s as Obj;
  if (typeof o.pattern === 'string' && o.pattern.includes('\\0')) {
    o.pattern = o.pattern.replace(NUL_ESCAPE, (m) => (m === '\\\\' ? m : '\\u0000'));
  }
  if (Array.isArray(o.items)) {
    const list = o.items.filter((v) => v && typeof v === 'object');
    o.items = list.length === 0 ? {} : list.length === 1 ? list[0] : { anyOf: list };
    delete o.additionalItems;
  }
  for (const v of Object.values(o)) fitSchema(v, depth + 1);
}

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const SUB_ONE = ['items', 'additionalItems', 'unevaluatedItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'additionalProperties', 'unevaluatedProperties'];
const SUB_LIST = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const SUB_MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const BOOL_OK = new Set(['additionalProperties', 'unevaluatedProperties']);

function valueType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Give an enum the type its values have (Kimi refuses an untyped or mixed enum). */
function fitEnum(s: Obj): void {
  if (!('enum' in s)) return;
  if (!Array.isArray(s.enum) || s.enum.length === 0) {
    delete s.enum;
    return;
  }
  const listed = Array.isArray(s.type) ? s.type : typeof s.type === 'string' ? [s.type] : [];
  if (listed.filter((t) => t !== 'null').length === 1) return;
  const byType = new Map<string, unknown[]>();
  for (const v of s.enum) {
    const t = valueType(v);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(v);
  }
  if (byType.has('integer') && byType.has('number')) {
    byType.get('number')!.push(...byType.get('integer')!);
    byType.delete('integer');
  }
  const hasNull = byType.delete('null');
  if (byType.size <= 1) {
    const [t] = byType.keys();
    s.type = t === undefined ? 'null' : hasNull ? [t, 'null'] : t;
    return;
  }
  const split: Obj[] = [...byType].map(([t, vs]) => ({ type: t, enum: vs }));
  if (hasNull) split.push({ type: 'null' });
  delete s.enum;
  delete s.type;
  if (Array.isArray(s.anyOf)) s.allOf = [...(Array.isArray(s.allOf) ? s.allOf : []), { anyOf: split }];
  else s.anyOf = split;
}

const subSchema = (v: unknown, key: string): unknown =>
  typeof v !== 'boolean' || BOOL_OK.has(key) ? v : v ? {} : { not: {} };

function fitShape(s: unknown, depth = 0): void {
  if (!isObj(s) || depth > 64) return;
  if ('type' in s) {
    const list = (Array.isArray(s.type) ? s.type : [s.type])
      .map((t) => (typeof t === 'string' ? t.toLowerCase() : t))
      .filter((t): t is string => typeof t === 'string' && TYPES.has(t));
    const uniq = [...new Set(list)];
    if (uniq.length === 0) delete s.type;
    else s.type = uniq.length === 1 ? uniq[0] : uniq;
  }
  if ('required' in s && !Array.isArray(s.required)) delete s.required;
  else if (Array.isArray(s.required)) s.required = s.required.filter((k) => typeof k === 'string');
  fitEnum(s);
  for (const k of SUB_ONE) {
    if (!(k in s)) continue;
    s[k] = subSchema(s[k], k);
    fitShape(s[k], depth + 1);
  }
  for (const k of SUB_LIST) {
    const list = s[k];
    if (!Array.isArray(list)) continue;
    list.forEach((v0, i) => {
      list[i] = subSchema(v0, k);
      fitShape(list[i], depth + 1);
    });
  }
  for (const k of SUB_MAP) {
    const m = s[k];
    if (!isObj(m)) continue;
    for (const [name, v0] of Object.entries(m)) {
      m[name] = subSchema(v0, k);
      fitShape(m[name], depth + 1);
    }
  }
}

function localRef(root: Obj, s: unknown): unknown {
  const ref = isObj(s) ? s.$ref : undefined;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return s;
  let at: unknown = root;
  for (const k of ref.slice(2).split('/')) at = isObj(at) ? at[k.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
  return isObj(at) ? at : s;
}

const hasUnion = (b: Obj): boolean => ['allOf', 'anyOf', 'oneOf'].some((k) => Array.isArray(b[k]));

/** Make a tool's parameters an object at the root (unions merged), as magpie does. */
function objectRoot(ps: Obj, root: Obj = ps, depth = 0): void {
  const unions = ['allOf', 'anyOf', 'oneOf'].filter((k) => Array.isArray(ps[k]));
  if (ps.type === 'object' && unions.length === 0) return;
  const props: Obj = isObj(ps.properties) ? ps.properties : {};
  const required: unknown[] = Array.isArray(ps.required) ? [...ps.required] : [];
  const resolve = (b0: unknown): Obj | null => {
    let b = localRef(root, b0);
    if (!isObj(b)) return null;
    if (depth < 8 && hasUnion(b)) {
      b = structuredClone(b);
      objectRoot(b as Obj, root, depth + 1);
    }
    return b as Obj;
  };
  for (const b0 of (ps.allOf as unknown[] | undefined) ?? []) {
    const b = resolve(b0);
    if (!b) continue;
    for (const [k, v] of Object.entries(isObj(b.properties) ? b.properties : {})) if (!(k in props)) props[k] = v;
    if (Array.isArray(b.required)) required.push(...b.required);
  }
  const branches: Obj[] = [];
  for (const key of ['anyOf', 'oneOf']) {
    for (const b0 of (ps[key] as unknown[] | undefined) ?? []) {
      const b = resolve(b0);
      if (!b || (b.type !== 'object' && !b.properties)) continue;
      branches.push(b);
    }
  }
  const from = new Map<string, unknown[]>();
  for (const b of branches) {
    for (const [k, v] of Object.entries(isObj(b.properties) ? b.properties : {})) {
      if (k in props) continue;
      const seen = from.get(k) ?? [];
      if (!seen.some((x) => JSON.stringify(x) === JSON.stringify(v))) seen.push(v);
      from.set(k, seen);
    }
  }
  for (const [k, list] of from) props[k] = list.length === 1 ? list[0] : { anyOf: list };
  if (branches.length) {
    for (const k of Object.keys(isObj(branches[0]!.properties) ? branches[0]!.properties : {})) {
      if (branches.every((b) => Array.isArray(b.required) && b.required.includes(k))) required.push(k);
    }
  }
  for (const k of unions) delete ps[k];
  ps.type = 'object';
  ps.properties = props;
  const req = [...new Set(required)].filter((k): k is string => typeof k === 'string' && k in props);
  if (req.length) ps.required = req;
  else delete ps.required;
}

/** Mend tools in place; returns safe name → the client's own name, for the renamed ones. */
function fitTools(b: Obj): Map<string, string> {
  const names = new Map<string, string>();
  if (!Array.isArray(b.tools) || b.tools.length === 0) return names;
  const taken = new Set<string>();
  for (const t of b.tools) {
    const n = isObj(t) && isObj(t.function) ? t.function.name : undefined;
    if (typeof n === 'string' && NAME_OK.test(n)) taken.add(n);
  }
  const theirs = new Map<string, string>();
  for (const t of b.tools) {
    if (!isObj(t) || !isObj(t.function)) continue;
    const fn = t.function;
    if (typeof fn.name === 'string' && !NAME_OK.test(fn.name)) {
      const safe = safeName(fn.name, taken);
      names.set(safe, fn.name);
      theirs.set(fn.name, safe);
      fn.name = safe;
    }
    if (fn.parameters === undefined) continue;
    if (!isObj(fn.parameters)) {
      fn.parameters = { type: 'object', properties: {} };
      continue;
    }
    fitSchema(fn.parameters);
    fitShape(fn.parameters);
    objectRoot(fn.parameters);
  }
  if (theirs.size && Array.isArray(b.messages)) {
    for (const m of b.messages) {
      if (!isObj(m)) continue;
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!isObj(c) || !isObj(c.function)) continue;
        const safe = typeof c.function.name === 'string' ? theirs.get(c.function.name) : undefined;
        if (safe) c.function.name = safe;
      }
      if (m.role === 'tool' && typeof m.name === 'string' && theirs.has(m.name)) m.name = theirs.get(m.name);
    }
  }
  const choice = isObj(b.tool_choice) && isObj(b.tool_choice.function) ? b.tool_choice.function : null;
  if (choice && typeof choice.name === 'string' && theirs.has(choice.name)) choice.name = theirs.get(choice.name);
  return names;
}

// ---- the whole body ----------------------------------------------------------------------

export interface WorkBuddyBody {
  body: Obj;
  /** Safe tool name → the client's own, to name the model's calls back. */
  names: Map<string, string>;
}

/**
 * The body to POST: always streamed (WorkBuddy serves chat streamed only), usage asked for,
 * and mended as above. `textOnly` drops image parts (models WorkBuddy serves text-only).
 */
export function workbuddyBody(input: Obj, opts: { textOnly?: boolean } = {}): WorkBuddyBody {
  const b = structuredClone(input);
  withSystem(b);
  const names = fitTools(b);
  normalizeToolChoice(b);
  if (opts.textOnly && Array.isArray(b.messages)) {
    for (const m of b.messages) {
      if (isObj(m) && Array.isArray(m.content)) m.content = m.content.filter((p) => !isObj(p) || p.type !== 'image_url');
    }
  }
  b.stream = true;
  b.stream_options = { ...(isObj(b.stream_options) ? b.stream_options : {}), include_usage: true };
  return { body: b, names };
}

/**
 * An empty assistant reply between trailing tool results and the user's message(s), for the
 * models that refuse that shape (code 11153). Null when the chat doesn't end that way.
 */
export function replyAfterTools(b: Obj): Obj | null {
  const msgs = b.messages;
  if (!Array.isArray(msgs)) return null;
  let i = msgs.length - 1;
  while (i >= 0 && isObj(msgs[i]) && (msgs[i] as Obj).role === 'user') i--;
  if (i === msgs.length - 1 || i < 0 || !isObj(msgs[i]) || (msgs[i] as Obj).role !== 'tool') return null;
  const out = structuredClone(b);
  (out.messages as unknown[]).splice(i + 1, 0, { role: 'assistant', content: '' });
  return out;
}
