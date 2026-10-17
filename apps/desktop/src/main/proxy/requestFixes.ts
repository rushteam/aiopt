// Outbound body adjustments beyond drop-fields (pure): the per-provider `extraBody` merge,
// and a one-shot auto-fix when an upstream refuses a request for a reason we can repair
// without changing what the user asked for.
//
// AUTO-FIX CONTRACT
//   - Only on a 400 / 422, and only ONE retry per request. A fix that does not help just
//     surfaces the original generic error.
//   - Every fix is semantics-preserving: a limit the upstream itself published, a renamed
//     knob, a system prompt moved to the shape the upstream accepts, or dropping a field
//     the proxy may itself have ADDED (`stream_options`, `reasoning_effort`) or one on the
//     safe drop-list. `tools`, `response_format` and message content are never touched — a
//     silent capability downgrade is worse than an honest error.
//   - The upstream error body is read here to choose a fix and is otherwise discarded: it
//     is never logged and never forwarded (it can reflect the key). Callers log the fix
//     NAME only.

import { DROPPABLE_REQUEST_FIELDS, type ApiFormat } from '../../shared/aiProviders';

/**
 * Deep-merge a provider's `extraBody` into an outbound body (objects merge, anything else
 * replaces). The value was validated by `checkExtraBody` (no request-defining keys, no
 * prototype keys) on its way into the store. Returns the same reference when there is
 * nothing to merge.
 */
export function applyExtraBody(
  body: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): { body: Record<string, unknown>; keys: string[] } {
  if (!extra) return { body, keys: [] };
  const keys = Object.keys(extra);
  if (keys.length === 0) return { body, keys };
  return { body: mergeInto({ ...body }, extra), keys };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeInto(target: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(src)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const cur = target[k];
    target[k] = isObj(v) && isObj(cur) ? mergeInto({ ...cur }, v) : v;
  }
  return target;
}

/** The stable name of an applied fix (logged; never the error text). */
export type AutoFixName =
  | 'clamp_max_tokens'
  | 'max_completion_tokens'
  | 'merge_system'
  | 'drop_param';

/** Fields an auto-fix may drop: the safe drop-list, plus knobs the proxy itself adds. */
const AUTO_DROPPABLE: ReadonlySet<string> = new Set([
  ...DROPPABLE_REQUEST_FIELDS.safe,
  'stream_options',
  'reasoning_effort',
  'parallel_tool_calls',
]);

/** The max-tokens field a body carries in the given outbound format, if any. */
function tokensKey(format: ApiFormat, body: Record<string, unknown>): string | null {
  if (format === 'openai') {
    if (typeof body.max_tokens === 'number') return 'max_tokens';
    if (typeof body.max_completion_tokens === 'number') return 'max_completion_tokens';
    return null;
  }
  if (format === 'anthropic') return typeof body.max_tokens === 'number' ? 'max_tokens' : null;
  if (format === 'openai-responses') return typeof body.max_output_tokens === 'number' ? 'max_output_tokens' : null;
  return null;
}

/**
 * The upper bound an upstream published in its error, e.g. "max_tokens must be in
 * [1, 8192]", "between 1 and 8192", "must be less than or equal to 8192", "maximum
 * value … is 8192". Null when the text names no usable limit.
 */
export function parseTokenLimit(text: string): number | null {
  if (!/max[_\s-]?(?:completion[_\s-]?|output[_\s-]?)?tokens|max_tokens|token/i.test(text)) return null;
  const patterns = [
    /\[\s*\d+\s*,\s*(\d+)\s*\]/,
    /between\s+\d+\s+and\s+(\d+)/i,
    /(?:less than or equal to|<=|at most|not exceed|maximum(?: value)?(?: of| is|:)?)\s*(\d+)/i,
    /(?:range|up to)\s*(?:of\s*)?\d*\s*(?:-|to)\s*(\d+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 1) return n;
    }
  }
  return null;
}

/** A parameter an upstream says it does not accept ("Unsupported parameter: 'x'", …). */
export function parseRejectedParam(text: string): string | null {
  const patterns = [
    /unsupported (?:parameter|argument|field)s?\s*[:=]?\s*['"`]?([a-z_][a-z0-9_.]*)/i,
    /unrecogni[sz]ed (?:request )?(?:argument|parameter|field)s?(?: supplied)?\s*[:=]?\s*['"`]?([a-z_][a-z0-9_.]*)/i,
    /unknown (?:parameter|field|name)s?\s*[:=]?\s*['"`]?([a-z_][a-z0-9_.]*)/i,
    /['"`]([a-z_][a-z0-9_]*)['"`]\s*(?:is not supported|is not allowed|not permitted|is unsupported)/i,
    /extra (?:inputs|fields) (?:are|is) not permitted[^a-z]*(?:loc[^a-z]*)?(?:body[^a-z]*)?['"`]?([a-z_][a-z0-9_]*)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1].split('.')[0]!;
  }
  return null;
}

/** OpenAI reasoning-model families that take `max_completion_tokens` instead of `max_tokens`. */
function wantsCompletionTokens(model: unknown): boolean {
  return typeof model === 'string' && /(^|\/)(o\d|gpt-5)/i.test(model);
}

/**
 * Merge every system / developer message into ONE leading system message — for upstreams
 * that refuse multiple system messages, a mid-conversation system turn, or the `developer`
 * role. Text is joined in order, so nothing the agent said is lost. Null when there is
 * nothing to change.
 */
function mergeSystemMessages(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.messages)) return null;
  const msgs = body.messages as { role?: unknown; content?: unknown }[];
  const sys = msgs.filter((m) => m.role === 'system' || m.role === 'developer');
  const firstNonSys = msgs.findIndex((m) => m.role !== 'system' && m.role !== 'developer');
  const leading = firstNonSys === -1 ? msgs.length : firstNonSys;
  const alreadyCanonical = sys.length <= 1 && sys.every((m) => m.role === 'system') && sys.length === leading;
  if (sys.length === 0 || alreadyCanonical) return null;
  const text = sys
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as { text?: unknown }[]).map((p) => (typeof p.text === 'string' ? p.text : '')).join('')
          : '',
    )
    .filter((t) => t !== '')
    .join('\n\n');
  const rest = msgs.filter((m) => m.role !== 'system' && m.role !== 'developer');
  return { ...body, messages: [{ role: 'system', content: text }, ...rest] };
}

/**
 * Choose one fix for a refused request, or null when none applies. `errorText` is the
 * upstream's error body — used ONLY to pick the fix, never returned or logged.
 */
export function autoFixRequest(
  format: ApiFormat,
  body: Record<string, unknown>,
  status: number,
  errorText: string,
): { body: Record<string, unknown>; fix: AutoFixName } | null {
  if (status !== 400 && status !== 422) return null;
  const text = errorText.slice(0, 8192);

  // 1. A token limit the upstream published.
  const key = tokensKey(format, body);
  if (key) {
    const limit = parseTokenLimit(text);
    const current = body[key] as number;
    if (limit !== null && limit < current) return { body: { ...body, [key]: limit }, fix: 'clamp_max_tokens' };
  }

  // 2. OpenAI reasoning models: `max_tokens` → `max_completion_tokens`.
  if (
    format === 'openai' &&
    typeof body.max_tokens === 'number' &&
    /max_tokens/i.test(text) &&
    (/max_completion_tokens/i.test(text) || wantsCompletionTokens(body.model))
  ) {
    const { max_tokens: n, ...rest } = body;
    return { body: { ...rest, max_completion_tokens: n }, fix: 'max_completion_tokens' };
  }

  // 3. A parameter it refuses — only ones safe to drop.
  const param = parseRejectedParam(text);
  if (param && AUTO_DROPPABLE.has(param) && Object.prototype.hasOwnProperty.call(body, param)) {
    const next = { ...body };
    delete next[param];
    return { body: next, fix: 'drop_param' };
  }

  // 4. System-message shape (multiple / mid-conversation / `developer` role).
  if (format === 'openai' && /system|developer/i.test(text)) {
    const merged = mergeSystemMessages(body);
    if (merged) return { body: merged, fix: 'merge_system' };
  }

  return null;
}
