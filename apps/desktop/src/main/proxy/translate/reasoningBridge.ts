// The Responses reasoning-item bridge (pure): how a model's reasoning survives a round
// trip through a stateless Responses client (codex), which echoes back whatever output
// items it received.
//
// The reasoning is folded into the item's opaque `encrypted_content` as base64 JSON of
// {thinking, signature}. base64 is ENCODING, not encryption — a format bridge, not a
// security boundary. The payload is the model's own reasoning (never a key), but per the
// proxy rules it is NEVER logged and never reaches the renderer.
//
// `signature` tells the two producers apart:
//   - an Anthropic upstream's thinking block carries one, and it MUST be replayed
//     verbatim (responsesAnthropic.ts);
//   - a Chat Completions upstream's `reasoning_content` has none (signature ''), and is
//     replayed as `reasoning_content` on the next turn (responsesOpenai.ts).
// Each side replays only its own kind, so one vendor's reasoning is never fed to another.

/** Decoded reasoning payload carried across turns by the bridge. */
export interface ReasoningPayload {
  thinking: string;
  signature: string;
}

/** Fold reasoning into the opaque string a Responses reasoning item carries. */
export function encodeReasoning(payload: ReasoningPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * Recover reasoning from a Responses reasoning item's opaque field. Returns null on any
 * malformed input (missing / non-base64 / wrong shape) so a corrupt echo degrades to "no
 * bridged reasoning" rather than throwing — the turn proceeds without continuity.
 */
export function decodeReasoning(encoded: string | null | undefined): ReasoningPayload | null {
  if (typeof encoded !== 'string' || encoded === '') return null;
  try {
    const obj = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Partial<ReasoningPayload>;
    if (obj && typeof obj.thinking === 'string' && typeof obj.signature === 'string') {
      return { thinking: obj.thinking, signature: obj.signature };
    }
  } catch {
    // fall through
  }
  return null;
}

/** low/medium/high reasoning effort → an Anthropic thinking token budget. */
export function effortToBudget(effort: string | undefined): number {
  switch (effort) {
    case 'low':
      return 1024;
    case 'high':
      return 16384;
    case 'medium':
    default:
      return 8192;
  }
}

/**
 * Anthropic `thinking: {type:'enabled', budget_tokens}` → the closest OpenAI knob,
 * `reasoning_effort` (the inverse of {@link effortToBudget}, by nearest band).
 * Disabled / malformed → undefined, so the upstream's own default applies.
 */
export function thinkingToEffort(thinking: unknown): 'low' | 'medium' | 'high' | undefined {
  if (!thinking || typeof thinking !== 'object') return undefined;
  const t = thinking as { type?: unknown; budget_tokens?: unknown };
  if (t.type !== 'enabled' && t.type !== 'adaptive') return undefined;
  const budget = typeof t.budget_tokens === 'number' ? t.budget_tokens : effortToBudget('medium');
  if (budget <= 2048) return 'low';
  if (budget <= 12288) return 'medium';
  return 'high';
}
