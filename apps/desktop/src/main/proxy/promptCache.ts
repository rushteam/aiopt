// Automatic prompt-cache breakpoints for an Anthropic-format upstream.
//
// WHY: Anthropic only caches a prefix when the request marks where it ends with a
// `cache_control: { type: 'ephemeral' }` breakpoint. Claude Code sets its own, but a body
// built by one of the translators (an OpenAI Chat / Responses client → Anthropic provider)
// carries none, so every turn of a long agent conversation is billed at the full input rate.
// This pass adds breakpoints on the stable parts of the prompt so later turns read them back
// from the cache.
//
// RULES:
//   - Only touches a body that has NO `cache_control` anywhere. If the client already placed
//     breakpoints, it knows its prompt better than we do, so the body is left alone.
//   - Never more than {@link MAX_CACHE_BREAKPOINTS} (the API's limit).
//   - Placement, most stable prefix first: the last tool definition, the last system block,
//     and the last content block of the final two user turns. A cached prefix covers every
//     block before its breakpoint, so these points cover tools + system + history.
//   - It only adds a marker; it never changes text, order, roles or tool definitions.
//     A string `system` / message `content` becomes a single text block holding the same text.
//
// Pure (no I/O); returns a new body and never mutates the input.

export const MAX_CACHE_BREAKPOINTS = 4;

const EPHEMERAL = { type: 'ephemeral' } as const;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Whether `cache_control` appears anywhere in the body (bounded walk over plain JSON). */
export function hasCacheControl(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (Array.isArray(value)) return value.some((v) => hasCacheControl(v, depth + 1));
  if (!isObject(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'cache_control')) return true;
  return Object.values(value).some((v) => hasCacheControl(v, depth + 1));
}

/** A block may carry a marker when it is a non-empty text block or any non-thinking block. */
function markable(block: unknown): block is Json {
  if (!isObject(block)) return false;
  // Thinking blocks cannot carry cache_control.
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return false;
  if (block.type === 'text') return typeof block.text === 'string' && block.text !== '';
  return typeof block.type === 'string';
}

/** Copy a block array with a marker on the last markable block; null if none qualifies. */
function markLast(blocks: unknown[]): unknown[] | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (markable(block)) {
      const copy = blocks.slice();
      copy[i] = { ...block, cache_control: { ...EPHEMERAL } };
      return copy;
    }
  }
  return null;
}

/** Normalize string content to a one-text-block array (empty string → null, nothing to mark). */
function asBlocks(content: unknown): unknown[] | null {
  if (typeof content === 'string') return content === '' ? null : [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : null;
}

export interface PromptCacheResult {
  body: Json;
  /** How many breakpoints were added (0 when the body was left unchanged). */
  added: number;
}

/**
 * Add up to four ephemeral cache breakpoints to an Anthropic Messages body. Returns the same
 * object reference with `added: 0` when the body already has breakpoints or nothing qualifies.
 */
export function injectPromptCache(body: Json): PromptCacheResult {
  if (hasCacheControl(body)) return { body, added: 0 };
  const out: Json = { ...body };
  let added = 0;

  // 1. The last tool definition (tools render before system, so this caches all tools).
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = body.tools.slice();
    const last = tools[tools.length - 1];
    if (isObject(last)) {
      tools[tools.length - 1] = { ...last, cache_control: { ...EPHEMERAL } };
      out.tools = tools;
      added++;
    }
  }

  // 2. The last system block.
  const system = asBlocks(body.system);
  if (system) {
    const marked = markLast(system);
    if (marked) {
      out.system = marked;
      added++;
    }
  }

  // 3–4. The last content block of the final two user turns (newest first), so the next
  // request reads the whole history up to the previous turn from the cache.
  if (Array.isArray(body.messages)) {
    const messages = body.messages.slice();
    let userTurns = 0;
    let markedTurns = 0;
    for (let i = messages.length - 1; i >= 0 && userTurns < 2 && added < MAX_CACHE_BREAKPOINTS; i--) {
      const msg = messages[i];
      if (!isObject(msg) || msg.role !== 'user') continue;
      userTurns++;
      const blocks = asBlocks(msg.content);
      const marked = blocks ? markLast(blocks) : null;
      if (!marked) continue;
      messages[i] = { ...msg, content: marked };
      added++;
      markedTurns++;
    }
    if (markedTurns > 0) out.messages = messages;
  }

  return added === 0 ? { body, added: 0 } : { body: out, added };
}
