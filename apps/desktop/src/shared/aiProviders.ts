// AiOpt domain model — the global provider pool and the target-agent registry.
//
// Pure types + constants, no side effects (like shared/appShortcuts.ts): imported
// by both the privileged main process and the untrusted renderer, so it must stay
// free of Node/Electron and of anything secret. API keys are NOT modeled here —
// they live in the main-only secret store, never in a Provider record.
//
// The core idea (vs. cc-switch): a provider is entered ONCE into a global pool and
// declares its wire format; each agent declares which formats it can consume. A
// binding is only legal when the formats are compatible (see isFormatCompatible);
// a cross-format pairing needs the future proxy layer and is refused for now.

/**
 * The wire format a provider speaks / an agent consumes.
 *
 * `openai` and `openai-responses` are DISTINCT dialects that share the OpenAI brand
 * but not the wire shape: `openai` is Chat Completions (`/v1/chat/completions`,
 * stateless `messages[]`), while `openai-responses` is the OpenAI Responses API
 * (`/responses`, `input`/`output` items, reasoning items). Agents that natively speak
 * Responses (codex, grok) must declare `openai-responses` — binding one to a Chat
 * Completions provider is a CROSS-format pairing routed through the translation proxy,
 * not a direct passthrough (codex would otherwise POST to a `/responses` endpoint the
 * Chat provider does not serve).
 */
export type ApiFormat = 'anthropic' | 'openai' | 'openai-responses' | 'gemini';

/** The AI coding agents AiOpt can configure. */
export type AgentId = 'claude' | 'codex' | 'gemini' | 'grok' | 'opencode' | 'pi';

/** Every known API format (runtime allowlist for validation). */
export const API_FORMATS: readonly ApiFormat[] = [
  'anthropic',
  'openai',
  'openai-responses',
  'gemini',
];

/** Every known agent id (runtime allowlist for validation). */
export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'gemini', 'grok', 'opencode', 'pi'];

/**
 * A model a provider offers.
 * - `id` is the canonical/reference model identifier (the provider's real name).
 * - `alias` is an optional "outward" name written to the agent config instead of
 *   `id` — a short or agent-consistent name (e.g. a long model id shortened, or a
 *   gateway's custom name). When set and non-empty, everything written to the agent
 *   (its model catalog and its binding) uses `alias`; otherwise it uses `id`.
 *   See {@link wireModelName} and providerManager.setBinding.
 */
export interface ProviderModel {
  id: string;
  alias?: string;
}

/** The name written into an agent's config for a model: its alias when set, else its id. */
export function wireModelName(model: ProviderModel): string {
  return model.alias !== undefined && model.alias !== '' ? model.alias : model.id;
}

/**
 * A provider in the global pool. The API key is deliberately absent — it is stored
 * encrypted in the main-only secret store under `main_provider_<id>_key` and never
 * appears in this record (which is persisted as plaintext JSON and crosses IPC).
 */
export interface Provider {
  id: string;
  name: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  models: ProviderModel[];
  notes?: string;
  createdAt: number;
}

/**
 * A built-in target agent. `acceptedFormats` gates which providers may bind;
 * `mode` is how its native config is rewritten — `exclusive` overwrites the active
 * provider, `additive` keeps all providers and only moves the default pointer.
 */
export interface AgentDef {
  id: AgentId;
  name: string;
  acceptedFormats: ApiFormat[];
  mode: 'exclusive' | 'additive';
}

/** Which provider+model an agent is currently pointed at. */
export interface AgentBinding {
  providerId: string;
  modelId: string;
}

/**
 * The built-in agent registry. `acceptedFormats` here reflects each agent's native
 * config surface; revisit against upstream docs when wiring that agent's adapter.
 */
export const AGENTS: readonly AgentDef[] = [
  { id: 'claude', name: 'Claude Code', acceptedFormats: ['anthropic'], mode: 'exclusive' },
  // codex/grok speak the OpenAI *Responses* API, not Chat Completions — see ApiFormat.
  { id: 'codex', name: 'Codex', acceptedFormats: ['openai-responses'], mode: 'exclusive' },
  { id: 'gemini', name: 'Gemini CLI', acceptedFormats: ['gemini'], mode: 'exclusive' },
  { id: 'grok', name: 'Grok', acceptedFormats: ['openai-responses'], mode: 'exclusive' },
  { id: 'opencode', name: 'OpenCode', acceptedFormats: ['openai', 'anthropic'], mode: 'additive' },
  { id: 'pi', name: 'pi', acceptedFormats: ['anthropic', 'openai', 'gemini'], mode: 'exclusive' },
];

/** Look up an agent definition by id. */
export function getAgentDef(id: AgentId): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** A provider may bind to an agent only when the agent accepts the provider's format. */
export function isFormatCompatible(agent: AgentDef, provider: Provider): boolean {
  return agent.acceptedFormats.includes(provider.apiFormat);
}

/**
 * Whether the cross-format translation proxy can convert an `inbound` agent format
 * into an `outbound` provider format. `inbound` is the agent's format, `outbound` the
 * provider's; for a cross-format binding they differ. This is a pure predicate about
 * the DIRECTED format pair only — it does not check whether an adapter/route exists.
 *
 * Supported (each entry means inbound → outbound is translatable):
 *   - anthropic ⇄ openai (Chat Completions), both directions.
 *   - openai-responses (codex/grok) → openai (Chat Completions).
 *   - openai-responses (codex/grok) → anthropic (with a reasoning bridge).
 *
 * NOT supported: any direction whose OUTBOUND is `openai-responses` (no need to emit
 * the Responses API upstream — a Responses-native provider binds same-format), and any
 * pairing involving `gemini`.
 */
export function translationSupported(inbound: ApiFormat, outbound: ApiFormat): boolean {
  if (inbound === outbound) return false; // same-format is a direct binding, not translation
  if (outbound === 'openai-responses' || inbound === 'gemini' || outbound === 'gemini') {
    return false;
  }
  switch (inbound) {
    case 'anthropic':
      return outbound === 'openai';
    case 'openai':
      return outbound === 'anthropic';
    case 'openai-responses':
      return outbound === 'openai' || outbound === 'anthropic';
    default:
      return false;
  }
}

// --- Built-in provider presets --------------------------------------------
//
// A small set of well-known providers AiOpt knows about. They are NOT seeded into
// the pool — the pool is entirely user-curated. Instead this list is the single
// factory source of truth for the "add provider" presets (see renderer presets.ts):
// picking one quick-fills a NEW custom provider (fresh id) the user then edits.
// Nothing in the pool ever carries this "official" identity or the prefix below.

/**
 * Reserved id prefix these presets use. The pool never contains an id with this
 * prefix (presets mint fresh UUIDs); the store drops any that appear, which also
 * migrates away providers seeded by older builds. Kept here as the single definition.
 */
export const OFFICIAL_PROVIDER_ID_PREFIX = 'official-';

/** The factory config behind one add-provider preset (name + endpoint + models). */
export interface OfficialProviderDef {
  id: string;
  name: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  models: ProviderModel[];
}

/** The known providers offered as add-provider presets. Stable ids + endpoints/models. */
export const OFFICIAL_PROVIDERS: readonly OfficialProviderDef[] = [
  {
    id: 'official-anthropic',
    name: 'Anthropic',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [{ id: 'claude-opus-4-20250514' }, { id: 'claude-sonnet-4-20250514' }],
  },
  {
    id: 'official-openai',
    name: 'OpenAI',
    apiFormat: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-4o' }, { id: 'o3' }],
  },
  {
    id: 'official-deepseek',
    name: 'DeepSeek',
    apiFormat: 'openai',
    baseUrl: 'https://api.deepseek.com',
    models: [{ id: 'deepseek-chat' }],
  },
  {
    id: 'official-moonshot',
    name: 'Moonshot (Kimi)',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    models: [{ id: 'kimi-k2-0711-preview' }],
    // NOTE: `/anthropic` is Moonshot's messages-only compat shim (what Claude binds
    // to); it serves no model catalog, so "Load models" won't work from this preset
    // base — the user edits the URL or enters models by hand. Verify against live docs.
  },
];
