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

/**
 * Everything one agent's native config surface needs, when a pool provider CAN be
 * pointed at it. `null` binding marks a skills-only agent (see {@link AgentSpec}).
 */
export interface AgentBindingSpec {
  /** Provider formats this agent can consume (the binding compatibility gate). */
  acceptedFormats: readonly ApiFormat[];
  /**
   * How the agent's native config is rewritten: `exclusive` overwrites the active
   * provider, `additive` keeps every provider and only moves the default pointer.
   */
  mode: 'exclusive' | 'additive';
  /** Directory (relative to home) whose existence signals the agent is installed. */
  installDir: string;
  /**
   * The config files this agent reads, keyed by role, relative to home. This map is
   * the sole source of the write allowlist (see agentPaths.AGENT_FILES): only the exact
   * paths declared here may ever be written. Layouts are non-uniform on purpose — pi
   * keeps three files under `.pi/agent`, OpenCode lives under `.config/opencode`.
   */
  files: Readonly<Record<string, string>>;
}

/**
 * The single source of truth for one AI coding agent AiOpt knows about. Adding an
 * agent is one record here (+ its adapter + a line in adapters/registry.ts); the id
 * union, the runtime id list, display names, the binding registry, the skills map,
 * and the write allowlist are all DERIVED from this table below.
 */
export interface AgentSpec {
  /** Canonical display name (the one label used everywhere). */
  name: string;
  /**
   * The agent's global skills dir, relative to home, or `null` when AiOpt has no
   * well-known one (grok) — then it does not participate in Skills sync.
   */
  skillsDir: string | null;
  /**
   * Binding capability, or `null` for a skills-only agent. Not every agent can be
   * POINTED AT A POOL PROVIDER: it must expose a bring-your-own-endpoint surface (a
   * custom base URL + key it will honour). `cursor` is the exception — the Cursor CLI
   * only talks to Cursor's own backend (account login / `CURSOR_API_KEY`, Cursor-hosted
   * models), with no base-URL override — so its `binding` is `null`: it never appears in
   * the binding registry {@link AGENTS} or in Providers, but still joins Skills sync.
   */
  binding: AgentBindingSpec | null;
}

/**
 * The agent catalogue. Keep entries alphabetical by id — {@link AGENT_IDS} and
 * {@link AGENTS} preserve this order. `acceptedFormats` reflects each agent's native
 * config surface; revisit against upstream docs when wiring its adapter.
 */
export const AGENT_SPECS = {
  claude: {
    name: 'Claude Code',
    skillsDir: '.claude/skills',
    binding: {
      acceptedFormats: ['anthropic'],
      mode: 'exclusive',
      installDir: '.claude',
      files: { settings: '.claude/settings.json' },
    },
  },
  // codex/grok speak the OpenAI *Responses* API, not Chat Completions — see ApiFormat.
  codex: {
    name: 'Codex',
    skillsDir: '.codex/skills',
    binding: {
      acceptedFormats: ['openai-responses'],
      mode: 'exclusive',
      installDir: '.codex',
      files: { auth: '.codex/auth.json', config: '.codex/config.toml' },
    },
  },
  // Cursor can't bind a pool provider (no base-URL override), so `binding` is null; its
  // CLI still keeps skills under ~/.cursor/skills, so it joins the sync matrix.
  cursor: {
    name: 'Cursor',
    skillsDir: '.cursor/skills',
    binding: null,
  },
  // dsh (DeepSeek Harness) speaks three wire protocols per provider via its `api` field
  // (openai-completions←openai, openai-responses←openai-responses, anthropic-messages←anthropic;
  // see dshAdapter API_BY_FORMAT). Providers live in a `providers` DICT keyed by id, so like
  // Hermes/OpenCode it is additive; the secret goes in a separate credentials file (mode 0600).
  dsh: {
    name: 'DeepSeek Harness',
    skillsDir: '.dsh/skills',
    binding: {
      acceptedFormats: ['openai', 'openai-responses', 'anthropic'],
      mode: 'additive',
      installDir: '.dsh',
      files: { settings: '.dsh/settings.yaml', credentials: '.dsh/.credentials.yaml' },
    },
  },
  gemini: {
    name: 'Gemini CLI',
    skillsDir: '.gemini/skills',
    binding: {
      acceptedFormats: ['gemini'],
      mode: 'exclusive',
      installDir: '.gemini',
      files: { env: '.gemini/.env', settings: '.gemini/settings.json' },
    },
  },
  // grok has no well-known skills dir (skillsDir null → absent from Skills sync).
  grok: {
    name: 'Grok',
    skillsDir: null,
    binding: {
      acceptedFormats: ['openai-responses'],
      mode: 'exclusive',
      installDir: '.grok',
      files: { config: '.grok/config.toml' },
    },
  },
  // Hermes (Nous Research) picks its wire protocol per provider via an `api_mode` field, so it
  // consumes several formats: chat_completions←openai, anthropic_messages←anthropic,
  // codex_responses←openai-responses (see hermesAdapter API_MODE_BY_FORMAT). Its config holds a
  // list of coexisting providers, so like OpenCode it is additive.
  hermes: {
    name: 'Hermes',
    skillsDir: '.hermes/skills',
    binding: {
      acceptedFormats: ['openai', 'anthropic', 'openai-responses'],
      mode: 'additive',
      installDir: '.hermes',
      files: { config: '.hermes/config.yaml' },
    },
  },
  opencode: {
    name: 'OpenCode',
    skillsDir: '.config/opencode/skills',
    binding: {
      acceptedFormats: ['openai', 'anthropic'],
      mode: 'additive',
      installDir: '.config/opencode',
      files: { config: '.config/opencode/opencode.json' },
    },
  },
  pi: {
    name: 'pi',
    skillsDir: '.pi/agent/skills',
    binding: {
      acceptedFormats: ['anthropic', 'openai', 'gemini'],
      mode: 'exclusive',
      installDir: '.pi',
      files: {
        auth: '.pi/agent/auth.json',
        models: '.pi/agent/models.json',
        settings: '.pi/agent/settings.json',
      },
    },
  },
} as const satisfies Record<string, AgentSpec>;

/** Every agent id AiOpt knows about — the keys of {@link AGENT_SPECS}. */
export type AgentId = keyof typeof AGENT_SPECS;

/** Every known API format (runtime allowlist for validation). */
export const API_FORMATS: readonly ApiFormat[] = [
  'anthropic',
  'openai',
  'openai-responses',
  'gemini',
];

/** Every known agent id (runtime allowlist for validation) — derived from {@link AGENT_SPECS}. */
export const AGENT_IDS: readonly AgentId[] = Object.keys(AGENT_SPECS) as AgentId[];

/**
 * Canonical display name for every agent — derived from {@link AGENT_SPECS}, so the
 * binding registry (Providers) and the skills matrix can never drift. Covers all of
 * {@link AGENT_IDS}, including skills-only agents that are absent from {@link AGENTS}.
 */
export const AGENT_NAMES: Record<AgentId, string> = Object.fromEntries(
  (Object.entries(AGENT_SPECS) as [AgentId, AgentSpec][]).map(([id, spec]) => [id, spec.name]),
) as Record<AgentId, string>;

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
 * The BINDING registry: agents a pool provider can be bound to — DERIVED from
 * {@link AGENT_SPECS} as exactly those with a non-null `binding`, in table order.
 *
 * This is a subset of {@link AGENT_IDS}: `cursor` is intentionally absent because the Cursor
 * CLI has no bring-your-own-endpoint surface to bind a provider into (see {@link AgentSpec}).
 * Skills enumerates {@link AGENT_IDS} instead, so a skills-only agent still shows up there.
 */
export const AGENTS: readonly AgentDef[] = (Object.entries(AGENT_SPECS) as [AgentId, AgentSpec][])
  .filter(([, spec]) => spec.binding !== null)
  .map(([id, spec]) => ({
    id,
    name: spec.name,
    // Copy so a caller can never mutate the shared spec's readonly array in place.
    acceptedFormats: [...spec.binding!.acceptedFormats],
    mode: spec.binding!.mode,
  }));

/** Look up an agent definition by id. */
export function getAgentDef(id: AgentId): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** A provider may bind to an agent only when the agent accepts the provider's format. */
export function isFormatCompatible(agent: AgentDef, provider: Provider): boolean {
  return agent.acceptedFormats.includes(provider.apiFormat);
}

/**
 * Whether the loopback proxy can carry an `inbound` agent format to an `outbound`
 * provider format. `inbound` is the agent's format, `outbound` the provider's. This is
 * a pure predicate about the DIRECTED format pair only — it does not check whether an
 * adapter/route exists, nor whether proxy mode would route it (default is direct).
 *
 * Two kinds of routes qualify:
 *   - CROSS-format translation:
 *       - anthropic ⇄ openai (Chat Completions), both directions.
 *       - openai-responses (codex/grok) → openai (Chat Completions).
 *       - openai-responses (codex/grok) → anthropic (with a reasoning bridge).
 *   - SAME-format passthrough (identity transform, streamed through unchanged) so the
 *     proxy can still count token usage: anthropic→anthropic, openai→openai,
 *     openai-responses→openai-responses. This is what makes a same-format binding
 *     countable when proxy mode is on; the default (off) chooses a direct config instead.
 *
 * NOT supported: any CROSS-format direction whose OUTBOUND is `openai-responses` (no
 * need to emit the Responses API upstream — a Responses provider is reached by same-
 * format passthrough), and any pairing involving `gemini` (no proxy dialect for it —
 * gemini bindings are always direct, in either mode).
 */
export function translationSupported(inbound: ApiFormat, outbound: ApiFormat): boolean {
  if (inbound === 'gemini' || outbound === 'gemini') return false; // no gemini proxy dialect
  if (inbound === outbound) return true; // same-format passthrough (identity + usage sniff)
  if (outbound === 'openai-responses') return false; // never emit Responses upstream via translation
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
